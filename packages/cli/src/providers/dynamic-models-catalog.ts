/**
 * The dynamic models catalog, bound to the account that answered it.
 *
 * `model-discovery.ts` asks a provider's own endpoint which models THIS
 * credential may call, and holds the answer in memory for five minutes. This
 * module keeps that answer across processes: after a successful, complete
 * answer it writes the list to `dynamic-models-catalog-store.ts` under an
 * account key, an HMAC of the credential that would sign. A list is only ever
 * read back for the same account key, so a changed credential misses by
 * construction and a logged-out provider reads nothing.
 *
 * ## What a stored list may say
 *
 * | age              | confirm `serves` | deny (`not-served`) |
 * |------------------|------------------|---------------------|
 * | `live` ≤ 5 min   | yes              | yes                 |
 * | `fresh` ≤ 24 h   | yes              | no                  |
 * | `stale` ≤ 72 h   | yes              | no                  |
 * | older            | treated as absent                      |
 *
 * Only a `live` list may deny, from any process: it is the same fact the
 * in-memory list has always been allowed to state. An older list that would
 * deny is asked again (`refreshAccountModelsList`), and the live answer decides.
 *
 * ## What is never written or logged
 *
 * Identity material comes from `credentials.accountIdentity` and lives only in
 * a local variable long enough to derive the key. Log lines name the provider,
 * the trigger, the count and the age; never the material, never the key.
 *
 * Which providers keep a stored list: `isPersistedListProvider`.
 */

import { createHmac, randomBytes } from "node:crypto";
import { credentials } from "../auth/credentials/authority.js";
import { log } from "../logger.js";
import {
  type AccountKeyResult,
  LIVE_MS,
  type ListAge,
  type StoreOptions,
  classifyListAge,
  deleteStoredModelsList,
  deriveAccountKey,
  dynamicCatalogKeyPath,
  listStoredProviders,
  readStoredModelsList,
  writeStoredModelsList,
} from "./dynamic-models-catalog-store.js";
import {
  type DiscoveredModel,
  type ModelsCatalogOutcome,
  fetchEveryServedModel,
  invalidateModelDiscovery,
} from "./model-discovery.js";
import { BUILTIN_PROVIDERS, getProviderByName } from "./provider-definitions.js";

/**
 * Whether `provider` keeps a stored list: it declares `modelDiscovery`, its tier
 * is `subscription` or `dynamic-subscription`, and it is not local. Pure.
 */
export function isPersistedListProvider(provider: string): boolean {
  const def = getProviderByName(provider);
  return (
    def !== undefined &&
    def.modelDiscovery !== undefined &&
    !def.isLocal &&
    (def.tier === "subscription" || def.tier === "dynamic-subscription")
  );
}

export interface AccountModelsList {
  provider: string;
  /** Unsplit: content-use opt-in ids included, exactly as discovery answered. */
  models: DiscoveredModel[];
  fetchedAt: number;
  age: Exclude<ListAge, "expired">;
  /** True only for age "live": the one list that may deny. */
  mayDeny: boolean;
}

/** What gathering reads synchronously. */
export type AccountModelsListSnapshot = ReadonlyMap<string, AccountModelsList>;

export type RefreshTrigger =
  | "route-bare"
  | "route-candidate"
  | "route-explicit"
  | "availability"
  | "cold-account"
  | "picker-open"
  | "picker-provider"
  | "search-all";

export type RefreshResult =
  | { kind: "refreshed"; outcome: ModelsCatalogOutcome }
  | { kind: "skipped"; reason: "too-recent" | "no-credential" | "not-persisted-provider" };

type ReadOptions = StoreOptions & { allowOpPrompt?: boolean };

/**
 * The account key a list is bound to. `persist` is false when the disk secret
 * cannot be trusted: the key then comes from a secret that lives only in this
 * process, so memory still binds to the account and nothing reaches disk.
 */
type AccountBinding = { accountKey: string; persist: boolean };

/** How long a derived identity is reused before the credential is asked again. */
const IDENTITY_MEMO_MS = 30_000;

/** Secret for the memory-only binding; never written anywhere. */
const processSecret = randomBytes(32);

const identityMemo = new Map<
  string,
  { keyPath: string; binding: AccountBinding | null; checkedAt: number }
>();
/** Lists this process fetched, bound to the account key they were fetched under. */
const liveMemory = new Map<
  string,
  { accountKey: string; fetchedAt: number; models: DiscoveredModel[] }
>();
const inFlight = new Map<string, Promise<ModelsCatalogOutcome>>();
const listeners = new Set<(provider: string, list: AccountModelsList | null) => void>();

credentials.onInvalidate((name) => {
  if (name) {
    identityMemo.delete(name);
    liveMemory.delete(name);
  } else {
    identityMemo.clear();
    liveMemory.clear();
  }
});

function nowOf(opts?: StoreOptions): number {
  return opts?.now ? opts.now() : Date.now();
}

function bindingFrom(
  provider: string,
  material: string | undefined,
  opts?: StoreOptions
): AccountBinding | null {
  const derived: AccountKeyResult = deriveAccountKey(provider, material, opts);
  if (derived.ok) return { accountKey: derived.accountKey, persist: true };
  if (derived.reason === "no-identity" || !material) return null;
  const accountKey = createHmac("sha256", processSecret)
    .update(`claudish-dmc-memory\n${provider}\n${material}`)
    .digest("hex");
  return { accountKey, persist: false };
}

/**
 * The current account's binding. `fresh` skips the memo, which a refresh needs
 * on both sides of its fetch: the credential may change while the fetch runs.
 */
async function accountBinding(
  provider: string,
  opts: ReadOptions | undefined,
  fresh: boolean
): Promise<AccountBinding | null> {
  const keyPath = dynamicCatalogKeyPath(opts);
  const now = Date.now();
  const memo = identityMemo.get(provider);
  if (!fresh && memo && memo.keyPath === keyPath && now - memo.checkedAt < IDENTITY_MEMO_MS) {
    return memo.binding;
  }
  let material: string | undefined;
  try {
    material = await credentials.accountIdentity(provider, {
      allowOpPrompt: opts?.allowOpPrompt ?? false,
    });
  } catch {
    material = undefined;
  }
  const binding = bindingFrom(provider, material, opts);
  identityMemo.set(provider, { keyPath, binding, checkedAt: now });
  return binding;
}

function toAccountList(
  provider: string,
  fetchedAt: number,
  models: DiscoveredModel[],
  now: number
): AccountModelsList | null {
  const age = classifyListAge(fetchedAt, now);
  if (age === "expired") return null;
  return { provider, models, fetchedAt, age, mayDeny: age === "live" };
}

/** The newer of this process's list and the stored one, for `binding`. Sync. */
function listFor(
  provider: string,
  binding: AccountBinding,
  opts?: StoreOptions
): AccountModelsList | null {
  const now = nowOf(opts);
  const memory = liveMemory.get(provider);
  let best =
    memory && memory.accountKey === binding.accountKey
      ? { fetchedAt: memory.fetchedAt, models: memory.models }
      : undefined;
  if (binding.persist) {
    const stored = readStoredModelsList(provider, binding.accountKey, opts);
    if (stored && (!best || stored.fetchedAt > best.fetchedAt)) best = stored;
  }
  return best ? toAccountList(provider, best.fetchedAt, best.models, now) : null;
}

function emit(provider: string, list: AccountModelsList | null): void {
  for (const listener of listeners) {
    try {
      listener(provider, list);
    } catch {
      // One listener's fault must not keep the others from hearing the change.
    }
  }
}

/** Live memory first, then disk for the CURRENT account. No network. Never throws. null: no credential, no list, or expired. */
export async function readAccountModelsList(
  provider: string,
  opts?: ReadOptions
): Promise<AccountModelsList | null> {
  try {
    if (!isPersistedListProvider(provider)) return null;
    const binding = await accountBinding(provider, opts, false);
    return binding ? listFor(provider, binding, opts) : null;
  } catch {
    return null;
  }
}

/** Every persisted-list provider claudish defines, in definition order. */
function persistedListProviders(): string[] {
  return BUILTIN_PROVIDERS.map((def) => def.name).filter(isPersistedListProvider);
}

/**
 * Lists for every provider in `providers` (default: listStoredProviders() ∩ isPersistedListProvider),
 * bound to the current account. No network. Never throws.
 */
export async function loadAccountModelsLists(
  providers?: readonly string[],
  opts?: ReadOptions
): Promise<AccountModelsListSnapshot> {
  const names = (providers ?? listStoredProviders(opts)).filter(isPersistedListProvider);
  const lists = await Promise.all(names.map((name) => readAccountModelsList(name, opts)));
  const snapshot = new Map<string, AccountModelsList>();
  names.forEach((name, i) => {
    const list = lists[i];
    if (list) snapshot.set(name, list);
  });
  return snapshot;
}

/**
 * One fetch and its write-through. The list is stored only when the account
 * derived after the fetch is the account derived before it: a login that
 * landed mid-fetch must not file the old account's answer under the new key.
 */
async function fetchAndStore(
  provider: string,
  before: AccountBinding,
  trigger: RefreshTrigger,
  opts?: ReadOptions
): Promise<ModelsCatalogOutcome> {
  const outcome = await fetchEveryServedModel(provider);
  if (outcome.kind === "served") {
    const after = await accountBinding(provider, opts, true);
    if (!after || after.accountKey !== before.accountKey) {
      log(
        `[dynamic-models-catalog:${provider}] ${trigger}: credential changed during the fetch; not stored`
      );
      return outcome;
    }
    const fetchedAt = nowOf(opts);
    liveMemory.set(provider, { accountKey: before.accountKey, fetchedAt, models: outcome.models });
    const written =
      before.persist &&
      writeStoredModelsList(provider, before.accountKey, outcome.models, {
        ...opts,
        now: () => fetchedAt,
      });
    log(
      `[dynamic-models-catalog:${provider}] ${trigger}: ${outcome.models.length} models, ` +
        (written ? "stored" : "kept in memory")
    );
    const list = toAccountList(provider, fetchedAt, outcome.models, fetchedAt);
    if (list) emit(provider, list);
    return outcome;
  }
  if (outcome.kind === "failed" && outcome.failure.kind === "unauthorized") {
    // The account itself was refused, so its list no longer describes anything
    // it may call. Every other failure is a failure to ASK and leaves it alone.
    const memory = liveMemory.get(provider);
    if (memory?.accountKey === before.accountKey) liveMemory.delete(provider);
    if (before.persist) deleteStoredModelsList(provider, before.accountKey, opts);
    log(`[dynamic-models-catalog:${provider}] ${trigger}: unauthorized; stored list removed`);
    emit(provider, null);
  }
  return outcome;
}

/**
 * Fetch now unless the current account's stored list is younger than `minAgeMs`
 * (default LIVE_MS). Single-flight per provider. On success writes through to disk
 * under the account key derived BEFORE the fetch, and only if the key derived after
 * it is the same. On `unauthorized` deletes that account's entry. Never rejects.
 */
export async function refreshAccountModelsList(
  provider: string,
  trigger: RefreshTrigger,
  opts?: { minAgeMs?: number; allowOpPrompt?: boolean } & StoreOptions
): Promise<RefreshResult> {
  try {
    if (!isPersistedListProvider(provider)) {
      return { kind: "skipped", reason: "not-persisted-provider" };
    }
    const before = await accountBinding(provider, opts, true);
    if (!before) return { kind: "skipped", reason: "no-credential" };
    const minAgeMs = opts?.minAgeMs ?? LIVE_MS;
    const current = listFor(provider, before, opts);
    if (current && nowOf(opts) - current.fetchedAt < minAgeMs) {
      return { kind: "skipped", reason: "too-recent" };
    }
    let flight = inFlight.get(provider);
    if (!flight) {
      const started = fetchAndStore(provider, before, trigger, opts);
      flight = started;
      inFlight.set(provider, started);
      void started.finally(() => {
        if (inFlight.get(provider) === started) inFlight.delete(provider);
      });
    }
    return { kind: "refreshed", outcome: await flight };
  } catch (err) {
    return {
      kind: "refreshed",
      outcome: {
        kind: "failed",
        failure: {
          kind: "unreachable",
          provider,
          detail: err instanceof Error ? err.message : String(err),
        },
      },
    };
  }
}

/**
 * Fire-and-forget refresh of every persisted-list provider whose credential reads
 * `present` WITHOUT a 1Password prompt, each gated by `minAgeMs`. Returns at once.
 */
export function sweepAccountModelsLists(
  trigger: RefreshTrigger,
  opts?: { minAgeMs?: number } & StoreOptions
): void {
  const run = async (provider: string): Promise<void> => {
    const readiness = await credentials.describeReadiness(provider, { allowOpPrompt: false });
    if (readiness.readiness !== "present") return;
    await refreshAccountModelsList(provider, trigger, { ...opts, allowOpPrompt: false });
  };
  void Promise.allSettled(persistedListProviders().map(run));
}

/** Called after every successful write and every delete. Returns an unsubscribe. */
export function onAccountModelsListChanged(
  listener: (provider: string, list: AccountModelsList | null) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop memory (live layer, identity memo) and the provider's file(s). No name: every provider. */
export function forgetAccountModelsLists(provider?: string, opts?: StoreOptions): void {
  const names = provider
    ? [provider]
    : [...new Set([...listStoredProviders(opts), ...liveMemory.keys(), ...identityMemo.keys()])];
  for (const name of names) {
    identityMemo.delete(name);
    liveMemory.delete(name);
    invalidateModelDiscovery(name);
    deleteStoredModelsList(name, undefined, opts);
    emit(name, null);
  }
  if (!provider) invalidateModelDiscovery();
}

/** Test seam: reset module memos (not disk). */
export function _resetAccountModelsListsForTest(): void {
  identityMemo.clear();
  liveMemory.clear();
  inFlight.clear();
}
