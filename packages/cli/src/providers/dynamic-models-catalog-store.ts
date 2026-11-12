/**
 * The on-disk half of the dynamic models catalog: one JSON file per claudish
 * provider, holding the list each ACCOUNT's discovery endpoint last answered.
 *
 * Disk only. This module makes no network call and reads no credential: the
 * caller hands it an account key, which `deriveAccountKey` computes from
 * identity material the caller holds in memory.
 *
 * ```
 * ~/.claudish/
 *   dynamic-models-catalog.key        0600  32 random bytes, hex
 *   dynamic-models-catalog/           0700
 *     <provider>.json                 0600  { schema, provider, accounts: { <key>: entry } }
 * ```
 *
 * The secret lives OUTSIDE the directory on purpose: copying the directory into
 * a bug report or a dotfiles repo does not carry the secret with it, and without
 * the secret an account key cannot be tested against a guessed credential. The
 * key is `HMAC-SHA256(secret, "claudish-dmc-v1\n" + provider + "\n" + material)`,
 * so neither the material nor its plain hash is ever on disk.
 *
 * Every function here is fail-soft and never throws. A missing, malformed or
 * future-dated entry reads as absent; an I/O failure on write returns `false`.
 * A secret that is unreadable, not ours or readable by anyone else is refused
 * and never rewritten: the store fails toward "no cache", never toward a weaker
 * secret.
 */

import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../auth/accounts/atomic-write.js";
import { log } from "../logger.js";
import type { DiscoveredModel } from "./model-discovery.js";

export const DYNAMIC_CATALOG_SCHEMA = 1;
/** A list at most this old may deny a model. Equal to the in-memory discovery TTL. */
export const LIVE_MS = 5 * 60 * 1000;
/** Plans change on billing events, days apart; within a day a list needs no caption. */
export const FRESH_MS = 24 * 60 * 60 * 1000;
/** A weekend gap still starts the week with the account's own list. Older is ignored. */
export const MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** An entry dated further ahead than this is clock skew or tampering, and is ignored. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Absorbs a user switching between two credentials (project `.env` vs CLI file). */
export const MAX_ACCOUNTS_PER_PROVIDER = 4;

const KEY_DOMAIN = "claudish-dmc-v1";
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;
/** A provider name becomes a file name, so it may not carry a path. */
const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export interface StoreOptions {
  /** Directory holding `<provider>.json`. Default: env CLAUDISH_DYNAMIC_CATALOG_DIR, else ~/.claudish/dynamic-models-catalog */
  dir?: string;
  /** HMAC secret file. Default: env CLAUDISH_DYNAMIC_CATALOG_KEY, else ~/.claudish/dynamic-models-catalog.key */
  keyPath?: string;
  /** Clock, ms since epoch. Default Date.now. */
  now?: () => number;
}

export type ListAge = "live" | "fresh" | "stale" | "expired";

export type AccountKeyResult =
  | { ok: true; accountKey: string }
  | { ok: false; reason: "no-identity" | "secret-unavailable" };

export interface StoredModelsList {
  provider: string;
  accountKey: string;
  fetchedAt: number;
  age: Exclude<ListAge, "expired">;
  models: DiscoveredModel[];
  /** Served ids the endpoint declares not selectable; see `ModelsCatalogOutcome`. */
  excludedIds?: string[];
}

/**
 * `excludedIds` is optional: an entry written before it existed, or for a
 * provider whose endpoint declares no exclusions, reads as having none.
 */
interface StoredEntry {
  fetchedAt: number;
  models: DiscoveredModel[];
  excludedIds?: string[];
}

interface StoredDocument {
  schema: typeof DYNAMIC_CATALOG_SCHEMA;
  provider: string;
  accounts: Record<string, StoredEntry>;
}

/**
 * Both defaults are read at CALL time: Bun's `os.homedir()` ignores a `HOME`
 * assigned in-process, so the env pair is how a test or a child moves the store.
 */
export function dynamicCatalogDir(opts?: StoreOptions): string {
  return (
    opts?.dir ??
    (process.env.CLAUDISH_DYNAMIC_CATALOG_DIR ||
      join(homedir(), ".claudish", "dynamic-models-catalog"))
  );
}

export function dynamicCatalogKeyPath(opts?: StoreOptions): string {
  return (
    opts?.keyPath ??
    (process.env.CLAUDISH_DYNAMIC_CATALOG_KEY ||
      join(homedir(), ".claudish", "dynamic-models-catalog.key"))
  );
}

function nowOf(opts?: StoreOptions): number {
  return opts?.now ? opts.now() : Date.now();
}

/** Pure. Boundaries are inclusive: age === LIVE_MS is "live"; age === MAX_AGE_MS is "stale". */
export function classifyListAge(fetchedAt: number, now: number): ListAge {
  const age = now - fetchedAt;
  if (age <= LIVE_MS) return "live";
  if (age <= FRESH_MS) return "fresh";
  if (age <= MAX_AGE_MS) return "stale";
  return "expired";
}

/** Secret files already reported as unusable, so the debug log says it once per path. */
const reportedSecretProblems = new Set<string>();

function reportSecretProblem(path: string, problem: string): void {
  const marker = `${path}\0${problem}`;
  if (reportedSecretProblems.has(marker)) return;
  reportedSecretProblems.add(marker);
  log(
    `[dynamic-models-catalog] secret file ${path} is unusable (${problem}); ` +
      "model lists stay in memory for this process"
  );
}

/**
 * The secret bytes, or null when the file cannot be trusted. Never rewrites an
 * existing file: one with a broad mode or a stranger's uid may be someone
 * else's, and replacing it would silently orphan every stored entry anyway.
 */
function readSecret(path: string): Buffer | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    reportSecretProblem(path, "not a regular file");
    return null;
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    reportSecretProblem(path, "owned by another user");
    return null;
  }
  if ((stat.mode & 0o077) !== 0) {
    reportSecretProblem(path, "mode is broader than 0600");
    return null;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    reportSecretProblem(path, "unreadable");
    return null;
  }
  if (!SECRET_PATTERN.test(text)) {
    reportSecretProblem(path, "not 64 hex characters");
    return null;
  }
  return Buffer.from(text, "hex");
}

/**
 * Create the secret exclusively: write a private temp file, then `link` it into
 * place, which fails when the name exists. A concurrent creator therefore never
 * sees a half-written secret, and the loser reads the winner's.
 */
function createSecret(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(
    dir,
    `.dynamic-models-catalog.key.${process.pid}.${randomBytes(6).toString("hex")}`
  );
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(32).toString("hex"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  } finally {
    rmSync(temp, { force: true });
  }
}

function loadOrCreateSecret(path: string): Buffer | null {
  let exists = true;
  try {
    lstatSync(path);
  } catch {
    exists = false;
  }
  if (!exists) {
    try {
      createSecret(path);
    } catch {
      reportSecretProblem(path, "could not be created");
      return null;
    }
  }
  return readSecret(path);
}

/** Creates the secret on first use (0600, O_EXCL). Never throws. Empty `material` → no-identity. */
export function deriveAccountKey(
  provider: string,
  material: string | undefined,
  opts?: StoreOptions
): AccountKeyResult {
  if (!material) return { ok: false, reason: "no-identity" };
  try {
    const secret = loadOrCreateSecret(dynamicCatalogKeyPath(opts));
    if (!secret) return { ok: false, reason: "secret-unavailable" };
    const accountKey = createHmac("sha256", secret)
      .update(`${KEY_DOMAIN}\n${provider}\n${material}`)
      .digest("hex");
    return { ok: true, accountKey };
  } catch {
    return { ok: false, reason: "secret-unavailable" };
  }
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalIdList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim().length > 0))
  );
}

function isAxis(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const axis = value as Record<string, unknown>;
  return (
    typeof axis.key === "string" &&
    isOptionalString(axis.label) &&
    typeof axis.enabled === "boolean"
  );
}

function isOffer(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const offer = value as Record<string, unknown>;
  return (offer.kind === "promo" || offer.kind === "included") && isOptionalNumber(offer.expiresAt);
}

/** One row as `DiscoveredModel` declares it. A row that fails invalidates its whole entry. */
function isDiscoveredModel(value: unknown): value is DiscoveredModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.trim().length > 0 &&
    isOptionalString(row.displayName) &&
    isOptionalNumber(row.contextWindow) &&
    isOptionalString(row.releaseDate) &&
    isOptionalBoolean(row.ignoreCatalogReleaseDate) &&
    isOptionalNumber(row.providerOrder) &&
    (row.reported === undefined || row.reported === "chat" || row.reported === "not-chat") &&
    isOptionalString(row.groupLabel) &&
    isOptionalString(row.family) &&
    isOptionalNumber(row.costFactor) &&
    isOptionalNumber(row.costTier) &&
    isOptionalBoolean(row.isFamilyDefault) &&
    isOptionalBoolean(row.isRecommended) &&
    (row.axes === undefined || (Array.isArray(row.axes) && row.axes.every(isAxis))) &&
    isOffer(row.offer) &&
    isOptionalBoolean(row.supportsTools)
  );
}

function isValidEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.fetchedAt === "number" &&
    Number.isFinite(entry.fetchedAt) &&
    Array.isArray(entry.models) &&
    entry.models.length > 0 &&
    entry.models.every(isDiscoveredModel) &&
    isOptionalIdList(entry.excludedIds)
  );
}

function providerFile(provider: string, opts?: StoreOptions): string | null {
  if (!PROVIDER_NAME_PATTERN.test(provider) || provider.includes("..")) return null;
  return join(dynamicCatalogDir(opts), `${provider}.json`);
}

/** The parsed document, or null when absent, unparseable, of another schema or provider. */
function readDocument(provider: string, path: string): StoredDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const doc = parsed as Record<string, unknown>;
  if (doc.schema !== DYNAMIC_CATALOG_SCHEMA || doc.provider !== provider) return null;
  if (!doc.accounts || typeof doc.accounts !== "object" || Array.isArray(doc.accounts)) {
    return null;
  }
  return doc as unknown as StoredDocument;
}

/** Whether an entry may be read at `now`: not future-dated beyond the skew, not expired. */
function isReadable(entry: StoredEntry, now: number): boolean {
  if (entry.fetchedAt > now + MAX_FUTURE_SKEW_MS) return false;
  return classifyListAge(entry.fetchedAt, now) !== "expired";
}

/** null when absent, expired, future-dated, malformed, wrong schema, or any row invalid. Never throws. */
export function readStoredModelsList(
  provider: string,
  accountKey: string,
  opts?: StoreOptions
): StoredModelsList | null {
  try {
    if (!ACCOUNT_KEY_PATTERN.test(accountKey)) return null;
    const path = providerFile(provider, opts);
    if (!path) return null;
    const doc = readDocument(provider, path);
    if (!doc || !Object.hasOwn(doc.accounts, accountKey)) return null;
    const entry: unknown = doc.accounts[accountKey];
    if (!isValidEntry(entry)) return null;
    const now = nowOf(opts);
    if (!isReadable(entry, now)) return null;
    const age = classifyListAge(entry.fetchedAt, now) as Exclude<ListAge, "expired">;
    return {
      provider,
      accountKey,
      fetchedAt: entry.fetchedAt,
      age,
      models: entry.models,
      ...(entry.excludedIds?.length ? { excludedIds: entry.excludedIds } : {}),
    };
  } catch {
    return null;
  }
}

/** Keep only entries that are valid and readable now. */
function liveAccounts(doc: StoredDocument | null, now: number): Record<string, StoredEntry> {
  const kept: Record<string, StoredEntry> = {};
  if (!doc) return kept;
  for (const [key, entry] of Object.entries(doc.accounts)) {
    if (!ACCOUNT_KEY_PATTERN.test(key)) continue;
    if (!isValidEntry(entry) || !isReadable(entry, now)) continue;
    kept[key] = entry;
  }
  return kept;
}

function writeDocument(
  provider: string,
  path: string,
  accounts: Record<string, StoredEntry>
): void {
  const doc: StoredDocument = { schema: DYNAMIC_CATALOG_SCHEMA, provider, accounts };
  atomicWriteFileSync(path, `${JSON.stringify(doc)}\n`, { mode: 0o600, dirMode: 0o700 });
}

/**
 * Atomic, 0600. Evicts beyond MAX_ACCOUNTS_PER_PROVIDER and prunes expired. Returns false on any I/O failure; never throws. `models` must be non-empty (an empty list is rejected → false).
 * `excludedIds` (served, declared not selectable) is stored beside the list when non-empty.
 */
export function writeStoredModelsList(
  provider: string,
  accountKey: string,
  models: DiscoveredModel[],
  opts?: StoreOptions,
  excludedIds?: readonly string[]
): boolean {
  try {
    if (!ACCOUNT_KEY_PATTERN.test(accountKey)) return false;
    if (!Array.isArray(models) || models.length === 0 || !models.every(isDiscoveredModel)) {
      return false;
    }
    if (!isOptionalIdList(excludedIds)) return false;
    const path = providerFile(provider, opts);
    if (!path) return false;
    const now = nowOf(opts);
    const accounts = liveAccounts(readDocument(provider, path), now);
    // A JSON round trip, so what is stored is exactly what a later read returns.
    accounts[accountKey] = {
      fetchedAt: now,
      models: JSON.parse(JSON.stringify(models)),
      ...(excludedIds?.length ? { excludedIds: [...excludedIds] } : {}),
    };
    const others = Object.keys(accounts)
      .filter((key) => key !== accountKey)
      .sort((a, b) => accounts[a].fetchedAt - accounts[b].fetchedAt);
    while (others.length > MAX_ACCOUNTS_PER_PROVIDER - 1) {
      const evicted = others.shift();
      if (evicted) delete accounts[evicted];
    }
    writeDocument(provider, path, accounts);
    return true;
  } catch {
    return false;
  }
}

/** With accountKey: remove that entry (and the file if it was the last). Without: remove the provider's file. Never throws. */
export function deleteStoredModelsList(
  provider: string,
  accountKey?: string,
  opts?: StoreOptions
): void {
  try {
    const path = providerFile(provider, opts);
    if (!path) return;
    if (accountKey === undefined) {
      rmSync(path, { force: true });
      return;
    }
    const doc = readDocument(provider, path);
    if (!doc || !Object.hasOwn(doc.accounts, accountKey)) return;
    const accounts = liveAccounts(doc, nowOf(opts));
    delete accounts[accountKey];
    if (Object.keys(accounts).length === 0) rmSync(path, { force: true });
    else writeDocument(provider, path, accounts);
  } catch {
    // Fail-soft: a delete that cannot run leaves an entry the key binding still guards.
  }
}

/** Provider names that have a file in the directory. Sync, no parsing. */
export function listStoredProviders(opts?: StoreOptions): string[] {
  try {
    return readdirSync(dynamicCatalogDir(opts))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((name) => PROVIDER_NAME_PATTERN.test(name) && !name.includes(".."));
  } catch {
    return [];
  }
}
