/**
 * The model catalog client — fetch, cache, and resolve, for ALL providers.
 *
 * This is the single source of truth for model facts. It fetches the Firebase
 * slim catalog, keeps it in memory and on disk (`~/.claudish/all-models.json`),
 * and answers "what does provider P call model M?" from `aggregators[]`.
 *
 * ## Why this file exists
 *
 * All of this previously lived inside `catalog-resolvers/openrouter.ts` behind
 * an `OpenRouterCatalogResolver` class, which made the app-wide catalog loader
 * look like an OpenRouter feature. It was not: `writeAllModelsCache` had exactly
 * one caller in the codebase, and every catalog read — context windows,
 * reasoning capability, tokenParam, routeVariant — depended on that class
 * having run. The name hid the dependency and made "why is there only one
 * resolver?" unanswerable.
 *
 * The per-provider resolver interface is gone with it. Name resolution was
 * never provider-specific logic — it is one lookup, `aggregators[]`, which the
 * catalog now populates for 18 providers. A registry of classes to perform one
 * table lookup per provider is a registry of one thing repeated.
 *
 * ## The two data sources, and which owns what
 *
 * - **This catalog (cloud, TTL'd)** owns model IDENTITY: what a model is, what
 *   it can do, what each provider calls it, what it costs. Same for everyone.
 * - **A provider's own live endpoint** (`model-discovery.ts`) owns ENTITLEMENT:
 *   which subset of those models THIS key may use, and the context window for
 *   THIS subscription tier. Per-user, and impossible to hold statically.
 *
 * They are joined on model id, not chained as fallbacks. There is deliberately
 * NO per-model cloud lookup for gaps: re-querying the same cloud one model at a
 * time returns the same answer N times more slowly. A field missing here is a
 * models-index gap to fix there.
 */

import {
  type CachedSubscriptionPlan,
  type DiskCacheV2,
  type SlimModelEntry,
  readAllModelsCache,
  writeAllModelsCache,
} from "./all-models-cache.js";
import {
  type ContractEnvelope,
  clearCatalogIncompatibility,
  isIncompatibleContractVersion,
  markCatalogIncompatible,
  parseContractEnvelope,
  readCatalogIncompatibility,
} from "./catalog-compatibility.js";

/**
 * Firebase slim catalog endpoint. Override via:
 *   - `CLAUDISH_CATALOG_URL` (preferred, documented spelling)
 *   - `FIREBASE_CATALOG_URL` (backwards-compat alias)
 *
 * Chiefly useful for integration tests that point at a local server to force
 * fetch failures.
 */
const FIREBASE_CATALOG_URL =
  process.env.CLAUDISH_CATALOG_URL ??
  process.env.FIREBASE_CATALOG_URL ??
  "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000";

const FIREBASE_PLANS_URL = process.env.CLAUDISH_PLANS_URL ?? derivePlansUrl(FIREBASE_CATALOG_URL);

function derivePlansUrl(catalogUrl: string): string {
  try {
    const url = new URL(catalogUrl);
    url.pathname = url.pathname.replace(/\/queryModels$/, "/queryPlans");
    url.search = "";
    return url.toString();
  } catch {
    return "https://us-central1-claudish-6da10.cloudfunctions.net/queryPlans";
  }
}

// Re-export so existing imports of the DiskCache type keep working.
export type DiskCache = DiskCacheV2;

/**
 * Outcome of an explicit `refreshCatalog()` call.
 *
 * Unlike `warmCatalog()` (fire-and-forget, silent on failure), this returns
 * ground truth so the launcher can make a policy decision.
 */
export type RefreshOutcome =
  | { kind: "refreshed"; modelCount: number }
  | { kind: "fetch_failed"; reason: "timeout" | "network" | "http_error" | "empty" }
  /**
   * The server answered, and its answer is in a contract this build cannot
   * read. Deliberately NOT a `fetch_failed`: every caller of that variant
   * degrades to the cached file, which is the exact wrong move here — the cache
   * is v2 data whose subscription joins the server has since redefined, and
   * trusting it is what bills a flat-rate user per token. A refresh that ends
   * here has already written the persistent sentinel.
   */
  | { kind: "incompatible"; serverContractVersion: number | null };

/** Result of resolving a user-typed model name for a provider. */
export interface ModelResolutionResult {
  /** The resolved model ID (e.g. "qwen/qwen3-coder-next"). */
  resolvedId: string;
  /** Whether resolution changed the input (false = passthrough unchanged). */
  wasResolved: boolean;
  /** Human-readable source label for the log line. */
  sourceLabel: string;
}

/** Module-level memory cache of slim catalog entries. */
let _memCache: SlimModelEntry[] | null = null;

/** Explicit tri-state catalog override for hermetic tests. */
let _catalogEntriesForTest: SlimModelEntry[] | null | undefined;

/** In-flight warm, so concurrent callers await one fetch rather than N. */
let _warmPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Cache access
// ---------------------------------------------------------------------------

/**
 * All catalog entries: memory first, then the disk cache, then null.
 *
 * Null means "cold" — never "empty catalog". Callers must degrade to
 * passthrough rather than concluding a model does not exist.
 */
export function getCatalogEntries(): SlimModelEntry[] | null {
  if (_catalogEntriesForTest !== undefined) return _catalogEntriesForTest;

  // Contract gate — BEFORE `_memCache`, and that ordering is the non-obvious
  // part. The obvious placement (next to the disk read below) would protect a
  // fresh process and no one else: a long-running session that warmed its
  // memory cache MINUTES BEFORE the server cut over keeps answering every
  // lookup from `_memCache` forever, and the sentinel it just wrote would never
  // be consulted. That session is the dangerous one — it is mid-conversation,
  // already routing requests, and its v2 entries are precisely the stale
  // subscription joins that send a flat-rate user to a metered provider. So the
  // gate goes ahead of every cache in the chain, and a warm process starts
  // refusing the moment the incompatibility is recorded.
  //
  // `_catalogEntriesForTest` still wins, above: it is an explicit tri-state
  // override, so a test that hands over entries is stating the catalog's
  // contents outright and must stay hermetic from the machine's sentinel file.
  //
  // Null keeps this function's existing contract — "cold", never "empty
  // catalog" — so every caller degrades to passthrough exactly as it does for a
  // missing cache file. The loud half of the response lives in `routing-rules`,
  // which is where a bare name would otherwise be silently re-billed.
  if (readCatalogIncompatibility()) return null;

  if (_memCache) return _memCache;

  const cache = readAllModelsCache();
  if (!cache) return null;

  if (cache.entries.length > 0) {
    _memCache = cache.entries;
    return _memCache;
  }

  // Backward-compat: synthesize entries from a legacy v1 models array.
  if (cache.models.length > 0) {
    _memCache = cache.models.map((m) => ({
      modelId: m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id,
      aliases: [],
      sources: { "openrouter-api": { externalId: m.id } },
    }));
    return _memCache;
  }

  return null;
}

/**
 * The newest Anthropic Opus id the catalog knows, or null when the catalog is
 * cold. For the `--probe` native-Claude-Code link, which must send a REAL
 * API-valid model id because it hits api.anthropic.com directly.
 *
 * Derived rather than pinned, because a pinned id here rots into a hard failure
 * and did: `claude-opus-4-1` sat in `cli.ts` under a comment asserting it was
 * "the current Opus alias the API accepts (verified against api.anthropic.com)".
 * Measured 2026-08-18, that id returns **404 not_found_error**, while the same
 * comment's claim that the API rejects `claude-opus-4-8` is also false — it
 * returns 200. A verification note has no expiry date, so the comment stayed
 * confident long after the fact changed.
 *
 * The rule is "newest released `claude-opus-*` the catalog lists", so a new Opus
 * is picked up by the next catalog refresh with no code change. `-fast` variants
 * are deprioritised only as a tiebreak within the same release date: either
 * serves a probe, and preferring the base id keeps the choice deterministic.
 */
export function latestOpusModelId(): string | null {
  return latestAnthropicTierModelId("opus");
}

/**
 * The newest Anthropic model id for a Claude Code tier, or null when the catalog
 * is cold or lists none. Same rule as `latestOpusModelId` (which delegates here),
 * generalised because `--probe sonnet` and `--probe haiku` need the same answer
 * for their own tiers — substituting an Opus id for `sonnet` would report a
 * different model than the one asked about.
 */
export function latestAnthropicTierModelId(tier: "opus" | "sonnet" | "haiku"): string | null {
  const entries = getCatalogEntries();
  if (!entries) return null;
  const family = new RegExp(`^claude-${tier}-`, "i");
  const opus = entries.filter((e) => family.test(e.modelId));
  if (opus.length === 0) return null;
  opus.sort((a, b) => {
    const byDate = (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
    if (byDate !== 0) return byDate;
    const aFast = /-fast$/i.test(a.modelId) ? 1 : 0;
    const bFast = /-fast$/i.test(b.modelId) ? 1 : 0;
    if (aFast !== bFast) return aFast - bFast;
    return b.modelId.localeCompare(a.modelId);
  });
  return opus[0].modelId;
}

/** Whether the in-memory catalog is populated. */
export function isCatalogWarm(): boolean {
  return _memCache !== null && _memCache.length > 0;
}

/** Test seam: override catalog entries without reading disk or fetching. @internal */
export function _setCatalogEntriesForTest(entries: SlimModelEntry[] | null): void {
  _catalogEntriesForTest = entries;
}

/** Test seam: drop the in-memory catalog and any in-flight warm. @internal */
export function _resetCatalogClient(): void {
  _catalogEntriesForTest = undefined;
  _memCache = null;
  _warmPromise = null;
}

// ---------------------------------------------------------------------------
// Name resolution — generic over aggregators[]
// ---------------------------------------------------------------------------

/**
 * What `provider` calls `entry`, or null if it does not serve it.
 *
 * `aggregators[]` is the typed multi-provider routing index and the primary
 * source. The `sources` fallbacks below exist only for OpenRouter, whose
 * catalog rows predate `aggregators[]`; without them a cold or partially
 * ingested row would stop resolving vendor prefixes that used to work.
 */
export function externalIdFor(entry: SlimModelEntry, provider: string): string | null {
  const agg = entry.aggregators?.find((a) => a.provider === provider);
  if (agg?.externalId) return agg.externalId;

  if (provider !== "openrouter") return null;

  const orSource = entry.sources["openrouter-api"];
  if (orSource?.externalId) return orSource.externalId;

  // Last resort: any source carrying a vendor-prefixed id.
  for (const src of Object.values(entry.sources)) {
    if (src.externalId.includes("/")) return src.externalId;
  }
  return null;
}

/**
 * Resolve a user-typed model name to the id `provider` accepts.
 *
 * Chain (first hit wins):
 *  1. Already vendor-prefixed → exact `externalId` match, else passthrough.
 *  2. Exact `modelId` match.
 *  3. `aliases[]` match.
 *  4. Any provider's `externalId` matches the input (cross-provider hop).
 *  5. Suffix match on this provider's external ids (`/name`).
 *  6. Case-insensitive suffix match.
 *
 * Returns null on a cold cache or no match — the caller sends the input
 * unchanged.
 */
export function resolveExternalId(userInput: string, provider: string): string | null {
  const entries = getCatalogEntries();

  // Step 1: already vendor-prefixed.
  if (userInput.includes("/")) {
    if (entries) {
      for (const entry of entries) {
        for (const src of Object.values(entry.sources)) {
          if (src.externalId === userInput) return userInput;
        }
      }
    }
    return userInput;
  }

  if (!entries) return null;

  // Step 2: exact modelId. AUTHORITATIVE — if the user named a canonical
  // catalog id, that row's answer is final, including "this provider does not
  // serve it" (null). Falling through to the alias/suffix steps below would
  // resolve to a DIFFERENT model that merely shares the name.
  //
  // Not hypothetical: the catalog currently lists `mistral-medium-3.5` as a
  // canonical id AND as an alias of `mistral-medium-2604`. Without this early
  // return, asking OpenRouter for 3.5 silently answered with
  // `mistralai/mistral-medium-3` — a real model, so no error, just the wrong
  // one. Serving a different model than the user asked for is worse than
  // failing to route.
  const byModelId = entries.find((e) => e.modelId === userInput);
  if (byModelId) return externalIdFor(byModelId, provider);

  // Step 3: aliases.
  const byAlias = entries.find((e) => e.aliases.includes(userInput));
  if (byAlias) {
    const id = externalIdFor(byAlias, provider);
    if (id) return id;
  }

  // Step 4: the input is some other provider's external id.
  for (const entry of entries) {
    for (const src of Object.values(entry.sources)) {
      if (src.externalId === userInput) {
        const id = externalIdFor(entry, provider);
        if (id) return id;
      }
    }
  }

  // Step 5: suffix match.
  const suffix = `/${userInput}`;
  for (const entry of entries) {
    const id = externalIdFor(entry, provider);
    if (id?.endsWith(suffix)) return id;
  }

  // Step 6: case-insensitive suffix match.
  const lowerSuffix = `/${userInput.toLowerCase()}`;
  for (const entry of entries) {
    const id = externalIdFor(entry, provider);
    if (id?.toLowerCase().endsWith(lowerSuffix)) return id;
  }

  return null;
}

/**
 * Synchronous resolution entry point, called before handler construction.
 *
 * OpenRouter is the one provider that resolves even an already-prefixed name,
 * because the vendor part users type is frequently wrong.
 */
export function resolveModelNameSync(
  userInput: string,
  targetProvider: string
): ModelResolutionResult {
  if (targetProvider !== "openrouter" && userInput.includes("/")) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  const resolved = resolveExternalId(userInput, targetProvider);
  if (!resolved || resolved === userInput) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  return { resolvedId: resolved, wasResolved: true, sourceLabel: `${targetProvider} catalog` };
}

/**
 * Decide what a request's target string becomes after catalog resolution.
 *
 * The rule this encodes: catalog resolution rewrites a target into an
 * `provider@model` string, and that shape MEANS "the user named this provider".
 * So it may only be applied to a spec that was already explicit. For a BARE name
 * the `provider` field is merely auto-DETECTED from the model id, and emitting
 * `detected@canonicalId` manufactures a user intent that was never expressed —
 * downstream, `parseModelSpec().isExplicitProvider` then reads true and the whole
 * routing chain (subscription tiers first) is skipped.
 *
 * Pulled out of proxy-server's request path as a pure function precisely because
 * the failure it prevents is invisible in situ: the bug only fires when the
 * canonical id DIFFERS from the typed name, which across the whole catalog was
 * true for exactly one family (MiniMax, which differs only in case). A live test
 * of any other model passes whether or not the guard exists.
 *
 * `resolve` is injected so callers can test without a warm catalog.
 */
export function resolveTargetForCatalog(
  target: string,
  isExplicitProvider: boolean,
  model: string,
  provider: string,
  resolve: (m: string, p: string) => ModelResolutionResult = resolveModelNameSync
): { target: string; resolution: ModelResolutionResult | null } {
  if (!isExplicitProvider) return { target, resolution: null };
  const resolution = resolve(model, provider);
  return {
    target: resolution.wasResolved ? `${provider}@${resolution.resolvedId}` : target,
    resolution,
  };
}

/** Emit a resolution notice to stderr (after `wasResolved=true`). */
export function logResolution(
  userInput: string,
  result: ModelResolutionResult,
  quiet = false
): void {
  if (result.wasResolved && !quiet) {
    process.stderr.write(
      `[Model] Resolved "${userInput}" → "${result.resolvedId}" (${result.sourceLabel})\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Fetch / warm
// ---------------------------------------------------------------------------

/**
 * One-shot catalog fetch with explicit success/failure return.
 *
 * On success replaces `_memCache` atomically AFTER the body parses, writes the
 * disk cache, and marks the warm as settled. On any failure leaves both caches
 * untouched and returns the reason. Never throws.
 */
export async function refreshCatalog(timeoutMs: number): Promise<RefreshOutcome> {
  const plansPromise = fetchSubscriptionPlans(timeoutMs);
  let response: Response;
  try {
    response = await fetch(FIREBASE_CATALOG_URL, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string } | null | undefined)?.name;
    const reason: "timeout" | "network" =
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    return { kind: "fetch_failed", reason };
  }

  // Contract check on the ERROR path, ahead of the generic http_error return —
  // this is the branch that actually fires at cutover. See
  // `contractVerdictForError` for why, and for why it tests two things.
  if (!response.ok) {
    return (
      (await contractVerdictForError(response)) ?? { kind: "fetch_failed", reason: "http_error" }
    );
  }

  let data: { models: SlimModelEntry[]; total?: number; contractVersion?: number };
  try {
    data = (await response.json()) as {
      models: SlimModelEntry[];
      total?: number;
      contractVersion?: number;
    };
  } catch {
    // Got a response but could not read it — network-class, distinct from "empty".
    return { kind: "fetch_failed", reason: "network" };
  }

  // Contract check on the SUCCESS path. Unreachable while negotiation is by
  // Accept header (a v3 server 426s this build rather than serving it a v3
  // 200), and kept anyway because it costs one comparison and covers the day
  // negotiation changes. Placed HERE — after the parse, before `_memCache` and
  // before `writeAllModelsCache` — so a v3 body is never written into our v2
  // cache file, where it would outlive this process as a catalog that looks
  // present and reads as empty.
  const bodyEnvelope = parseContractEnvelope(data);
  if (isIncompatibleContractVersion(bodyEnvelope.contractVersion)) {
    return recordIncompatibility(bodyEnvelope);
  }

  if (!Array.isArray(data.models) || data.models.length === 0) {
    return { kind: "fetch_failed", reason: "empty" };
  }

  // Build the backward-compat models array BEFORE mutating shared state, so a
  // throw below leaves _memCache and the disk file untouched.
  const backwardCompatModels: Array<{ id: string }> = [];
  for (const entry of data.models) {
    const id = externalIdFor(entry, "openrouter");
    if (id) backwardCompatModels.push({ id });
  }

  // Settle queryPlans BEFORE mutating shared state. The two requests were
  // issued together and a staged cutover can move them independently, so
  // queryModels answering in v2 does not prove queryPlans did. A plans 426 is
  // the more dangerous half of that pair: it is the endpoint that answers
  // "which plan covers this model", and taking the model refresh as proof of
  // health would clear the sentinel the plans fetch had just written and put
  // the user straight back on a metered route.
  const plansResult = await plansPromise;
  if (plansResult.incompatible) return plansResult.incompatible;
  const plans = plansResult.plans;

  // A complete, parseable, non-empty refresh in a contract this build reads is
  // the only proof that an earlier incompatibility is over. Clearing on that and
  // not on any 200 is what makes the sentinel self-healing without making it
  // flappy: every partial outcome — bad body, empty roster, plans mismatch —
  // returned above and left the flag standing.
  //
  // Before the write, not after: `writeAllModelsCache`'s merge is gated on the
  // flag through `readAllModelsCache`, so clearing afterwards would have this
  // refresh merge against a catalog it was told to ignore.
  clearCatalogIncompatibility();

  _memCache = data.models;
  writeAllModelsCache({
    entries: data.models,
    models: backwardCompatModels,
    ...(plans !== undefined ? { plans } : {}),
  });

  // Short-circuit the proxy-server background warm.
  _warmPromise = Promise.resolve();

  return { kind: "refreshed", modelCount: data.models.length };
}

/**
 * The contract verdict for a NON-2xx response, or null when the failure is an
 * ordinary one this build should just retry or report.
 *
 * Shared by both endpoints because both negotiate the same version and both go
 * wrong at the same instant. Two checks, deliberately:
 *
 *   - **status 426** is the documented signal, and the one that actually fires
 *     at cutover. Every v3 endpoint negotiates on
 *     `Accept: application/vnd.models-index.catalog+json;version=3`, and this
 *     build sends no Accept header at all, so post-cutover it gets 426 and never
 *     once sees a v3 200 body. (Not sending that header is deliberate: it
 *     belongs to the v3 READER work. Asking for a contract we cannot parse would
 *     be worse than not asking.)
 *   - **a body `contractVersion` above ours**, because that field rides on every
 *     v3 error body — 410 and 503 included — so this catches a cutover that
 *     arrives wearing a status nobody wrote down.
 *
 * A body-less 426 still counts: the status alone is enough, and the sentinel
 * then records `serverContractVersion: null`, which the message renders as "a
 * newer catalog contract" rather than inventing a number.
 */
async function contractVerdictForError(
  response: Response
): Promise<Extract<RefreshOutcome, { kind: "incompatible" }> | null> {
  const envelope = parseContractEnvelope(await readJsonBody(response));
  if (response.status === 426 || isIncompatibleContractVersion(envelope.contractVersion)) {
    return recordIncompatibility(envelope);
  }
  return null;
}

/**
 * Read a response body as JSON, or undefined. Never throws.
 *
 * An error response may legitimately carry no body at all, an HTML proxy page,
 * or a truncated one — none of which is a reason for a catalog refresh to
 * explode. Returning undefined lets {@link parseContractEnvelope} answer "no
 * version stated", which is the same as no evidence.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * queryPlans is additive to the model cache. A plan-endpoint failure must not
 * discard a valid model refresh or erase the last-known-good routing join.
 *
 * The one failure that is NOT merely additive is a contract mismatch. queryPlans
 * negotiates the same version as queryModels, so it 426s at the same instant —
 * and it is the endpoint that answers "which plan covers this model", which is
 * the exact question a mis-billed user needed answered. It still returns
 * undefined (the caller must not lose a model refresh over it), but it records
 * the sentinel on its way out, so whichever of the two requests lands first
 * protects the process.
 */
async function fetchSubscriptionPlans(timeoutMs: number): Promise<PlansFetch> {
  try {
    const response = await fetch(FIREBASE_PLANS_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const verdict = await contractVerdictForError(response);
      return verdict ? { incompatible: verdict } : {};
    }
    const data = (await response.json()) as {
      plans?: CachedSubscriptionPlan[];
      contractVersion?: number;
    };
    const envelope = parseContractEnvelope(data);
    if (isIncompatibleContractVersion(envelope.contractVersion)) {
      return { incompatible: recordIncompatibility(envelope) };
    }
    return { plans: Array.isArray(data.plans) ? data.plans : undefined };
  } catch {
    return {};
  }
}

/** Outcome of the additive queryPlans fetch. */
interface PlansFetch {
  /** The plans, when the endpoint answered with a readable list. */
  plans?: CachedSubscriptionPlan[];
  /** Set when THIS fetch recorded a contract incompatibility. */
  incompatible?: Extract<RefreshOutcome, { kind: "incompatible" }>;
}

/**
 * Write the sentinel for a contract mismatch and shape the outcome.
 *
 * One helper for all three detection sites — both in `refreshCatalog` and the
 * one in `fetchSubscriptionPlans` — because they must record IDENTICAL facts.
 * `minimumContractVersion` is the field a hand-inlined copy drops, since it sits
 * nested under `error` while `contractVersion` is top-level, and dropping it is
 * invisible in testing: the guard still fires, the message just stops naming the
 * version the user needs to reach.
 */
function recordIncompatibility(
  envelope: ContractEnvelope
): Extract<RefreshOutcome, { kind: "incompatible" }> {
  markCatalogIncompatible({
    serverContractVersion: envelope.contractVersion,
    ...(envelope.minimumContractVersion !== undefined
      ? { minimumContractVersion: envelope.minimumContractVersion }
      : {}),
  });
  return { kind: "incompatible", serverContractVersion: envelope.contractVersion };
}

/** Fire-and-forget warm. Failures fall through to the disk-read fallback. */
export async function warmCatalog(): Promise<void> {
  if (!_warmPromise) {
    _warmPromise = refreshCatalog(8000).then(() => undefined);
  }
  await _warmPromise;
}

/**
 * Wait for the catalog to be usable, bounded by `timeoutMs`. Never throws —
 * on timeout the caller proceeds with whatever the disk cache holds.
 */
export async function ensureCatalogReady(timeoutMs = 5000): Promise<void> {
  if (isCatalogWarm()) return;

  if (!_warmPromise) {
    _warmPromise = refreshCatalog(8000).then(() => undefined);
  }

  await Promise.race([
    _warmPromise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
