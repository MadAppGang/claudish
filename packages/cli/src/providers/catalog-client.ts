import { log } from "../logger.js";
import {
  type CachedSubscriptionPlan,
  type DiskCacheV3,
  type SlimModelEntry,
  isCachedSubscriptionPlan,
  isSlimModelEntry,
  readAllModelsCache,
  reconcileWires,
  writeAllModelsCache,
  writeRouteRegistry,
} from "./all-models-cache.js";
import { catalogUrl, plansUrl } from "./catalog-endpoints.js";
import {
  _resetCatalogReachabilityForTest,
  catalogWarmDisabledFor,
  noteCatalogContact,
  noteRefreshSettled,
} from "./catalog-reachability.js";
import { catalogRouteMatchesProvider } from "./catalog-route-bindings.js";
import { CATALOG_V3_ACCEPT, type CatalogV3Envelope, parseCatalogV3Envelope } from "./catalog-v3.js";
import {
  type CachedRouteRegistry,
  type RouteRegistry,
  isRouteRegistry,
} from "./connection-wire.js";
import { allConnections, splitOptInConnections } from "./content-use.js";
import { _clearChatCapabilityIndex } from "./transport/probe-discovery.js";

const MAX_CATALOG_PAGES = 40;
const CATALOG_PAGE_LIMIT = 1000;

/** `queryModels?catalog=routes&generationId=<id>` on the same host as the model list. */
export function buildRoutesUrl(modelsUrl: string, generationId: string): string {
  const url = new URL(modelsUrl);
  url.search = "";
  url.searchParams.set("catalog", "routes");
  url.searchParams.set("generationId", generationId);
  return url.toString();
}

export type DiskCache = DiskCacheV3;

export type RefreshOutcome =
  | { kind: "refreshed"; modelCount: number; catalogGenerationId?: string; pages?: number }
  | {
      kind: "fetch_failed";
      reason:
        | "timeout"
        | "network"
        | "http_error"
        | "empty"
        | "disabled"
        | "generation_mismatch"
        | "incomplete";
    }
  | { kind: "incompatible"; serverContractVersion: number | null };

export interface ModelResolutionResult {
  resolvedId: string;
  wasResolved: boolean;
  sourceLabel: string;
}

let _memCache: SlimModelEntry[] | null = null;
let _catalogEntriesForTest: SlimModelEntry[] | null | undefined;
let _warmPromise: Promise<void> | null = null;

export function getCatalogEntries(): SlimModelEntry[] | null {
  if (_catalogEntriesForTest !== undefined) return _catalogEntriesForTest;
  if (_memCache) return _memCache;

  const cache = readAllModelsCache();
  if (!cache || cache.entries.length === 0) return null;
  _memCache = cache.entries;
  return _memCache;
}

export function latestOpusModelId(): string | null {
  return latestAnthropicTierModelId("opus");
}

export function latestAnthropicTierModelId(tier: "opus" | "sonnet" | "haiku"): string | null {
  const entries = getCatalogEntries();
  if (!entries) return null;
  const family = new RegExp(`^claude-${tier}-`, "i");
  const matches = entries.filter((entry) => family.test(entry.modelId));
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const byDate = (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
    if (byDate !== 0) return byDate;
    const aFast = /-fast$/i.test(a.modelId) ? 1 : 0;
    const bFast = /-fast$/i.test(b.modelId) ? 1 : 0;
    if (aFast !== bFast) return aFast - bFast;
    return b.modelId.localeCompare(a.modelId);
  });
  return matches[0].modelId;
}

export function isCatalogWarm(): boolean {
  return _memCache !== null && _memCache.length > 0;
}

export function _setCatalogEntriesForTest(entries: SlimModelEntry[] | null): void {
  // The same normalisation as every other way entries reach memory, so a test
  // seeds exactly what production reads (`content-use.ts`).
  _catalogEntriesForTest = entries ? entries.map(splitOptInConnections) : entries;
}

export function _resetCatalogClient(): void {
  _catalogEntriesForTest = undefined;
  _memCache = null;
  _warmPromise = null;
  _resetCatalogReachabilityForTest();
}

/** Every wire id the entry publishes, opt-in included: an exact reverse lookup. */
function allExternalIds(entry: SlimModelEntry): string[] {
  return allConnections(entry).flatMap((connection) =>
    typeof connection.externalModelId === "string" ? [connection.externalModelId] : []
  );
}

/**
 * A wire id that redirects over time, e.g. OpenRouter's `~moonshotai/kimi-latest`
 * ("always redirects to the latest model in the Kimi family"). Today it may land on
 * the same model as the exact id; the day the vendor ships a successor it lands
 * somewhere else, silently.
 */
export function isMovingPointer(wireId: string): boolean {
  const lastSegment = wireId.split("/").pop() ?? wireId;
  return wireId.startsWith("~") || /(^|-)latest$/i.test(lastSegment);
}

/**
 * The wire id to send `provider` for a catalog model.
 *
 * The catalog can publish several connections to one provider for one model: the
 * exact id and a moving pointer. A user who asked for a pinned model gets the EXACT
 * id — never a pointer claudish chose for them, because a pointer is the vendor's
 * alias, not the model they named. Taking the first matching row, as this once did,
 * sent `~moonshotai/kimi-latest` for `kimi-k3` because the catalog happened to list
 * the pointer first. With no exact id the answer is null, not the pointer.
 *
 * A model whose own canonical id is pointer-shaped (`chatgpt-4o-latest`) is the one
 * case where a pointer-shaped wire id is exactly what was asked for.
 */
export function externalIdFor(entry: SlimModelEntry, provider: string): string | null {
  const wireIds = (entry.aggregators ?? []).flatMap((candidate) =>
    candidate.routeStatus === "mapped" &&
    catalogRouteMatchesProvider(candidate.route, provider) &&
    typeof candidate.externalModelId === "string"
      ? [candidate.externalModelId]
      : []
  );
  if (wireIds.length === 0) return null;
  if (isMovingPointer(entry.modelId)) return wireIds[0] ?? null;
  return wireIds.find((wireId) => !isMovingPointer(wireId)) ?? null;
}

/** Whether `entry` maps `wireId` exactly on a route bound to `provider`, opt-in rows included. */
function publishesWireIdFor(entry: SlimModelEntry, provider: string, wireId: string): boolean {
  return allConnections(entry).some(
    (connection) =>
      connection.routeStatus === "mapped" &&
      connection.externalModelId === wireId &&
      catalogRouteMatchesProvider(connection.route, provider)
  );
}

export function resolveExternalId(
  userInput: string,
  provider: string,
  cachePath?: string
): string | null {
  const entries = cachePath ? readAllModelsCache(cachePath)?.entries : getCatalogEntries();

  if (userInput.includes("/")) {
    if (entries?.some((entry) => allExternalIds(entry).includes(userInput))) return userInput;
    return userInput;
  }
  if (!entries) return null;

  // An id this provider publishes, typed exactly, is its own answer — opt-in
  // rows included. This is how `meta@muse-spark-1.3-contributor` is sent
  // verbatim: every step below CHOOSES a wire id, and a chosen one is never a
  // content-use opt-in (`content-use.ts`).
  if (entries.some((entry) => publishesWireIdFor(entry, provider, userInput))) return userInput;

  const byModelId = entries.find((entry) => entry.modelId === userInput);
  if (byModelId) return externalIdFor(byModelId, provider);

  const byAlias = entries.find((entry) => entry.aliases.includes(userInput));
  if (byAlias) {
    const resolved = externalIdFor(byAlias, provider);
    if (resolved) return resolved;
  }

  for (const entry of entries) {
    if (allExternalIds(entry).includes(userInput)) {
      const resolved = externalIdFor(entry, provider);
      if (resolved) return resolved;
    }
  }

  const suffix = `/${userInput}`;
  for (const entry of entries) {
    const resolved = externalIdFor(entry, provider);
    if (resolved?.endsWith(suffix)) return resolved;
  }

  const lowerSuffix = suffix.toLowerCase();
  for (const entry of entries) {
    const resolved = externalIdFor(entry, provider);
    if (resolved?.toLowerCase().endsWith(lowerSuffix)) return resolved;
  }
  return null;
}

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

export function resolveTargetForCatalog(
  target: string,
  isExplicitProvider: boolean,
  model: string,
  provider: string,
  resolve: (model: string, provider: string) => ModelResolutionResult = resolveModelNameSync
): { target: string; resolution: ModelResolutionResult | null } {
  if (!isExplicitProvider) return { target, resolution: null };
  const resolution = resolve(model, provider);
  return {
    target: resolution.wasResolved ? `${provider}@${resolution.resolvedId}` : target,
    resolution,
  };
}

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

export { catalogWarmDisabledFor };

function catalogWarmDisabled(): boolean {
  return catalogWarmDisabledFor(process.env.CLAUDISH_DISABLE_CATALOG_WARM);
}

export function buildCatalogPageUrl(
  baseUrl: string,
  cursor: string | undefined,
  limit: number,
  generationId?: string
): string {
  const url = new URL(baseUrl);
  url.searchParams.delete("offset");
  url.searchParams.delete("revision");
  // Plan membership points at deprecated models and at route variants, and the
  // backend returns neither unless asked. Without these two, `kimi-code`'s member
  // `kimi-k3-256k` (a context=256k route variant) had no model row at all. Set here,
  // not only in the default URL, so a CLAUDISH_CATALOG_URL override cannot drop them.
  url.searchParams.set("status", "all");
  url.searchParams.set("includeRouteVariants", "true");
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  else url.searchParams.delete("cursor");
  if (generationId) url.searchParams.set("generationId", generationId);
  else url.searchParams.delete("generationId");
  return url.toString();
}

interface ModelsPageData {
  mode: "slim";
  models: SlimModelEntry[];
  total: number;
  nextCursor?: string;
}

interface PlansPageData {
  plans: CachedSubscriptionPlan[];
  total: number;
  nextCursor?: string;
}

export type FetchFailure =
  | { ok: false; reason: "timeout" | "network" | "http_error" }
  | { ok: false; reason: "incompatible"; serverContractVersion: number | null };

function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** A network error's own code, else its message. Bun's codes read as `ConnectionRefused`. */
function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return error instanceof Error ? error.message : String(error);
}

export async function fetchEnvelope<T>(
  url: string,
  timeoutMs: number
): Promise<{ ok: true; envelope: CatalogV3Envelope<T> } | FetchFailure> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: CATALOG_V3_ACCEPT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    noteCatalogContact(
      "transport",
      timedOut ? `no answer within ${timeoutMs} ms` : errorText(error)
    );
    return { ok: false, reason: timedOut ? "timeout" : "network" };
  }
  noteCatalogContact(
    response.ok ? "ok" : "http-status",
    response.ok ? undefined : `HTTP ${response.status}`
  );

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 426) {
      return { ok: false, reason: "incompatible", serverContractVersion: null };
    }
    return { ok: false, reason: response.ok ? "network" : "http_error" };
  }

  const statedVersion =
    body &&
    typeof body === "object" &&
    typeof (body as { contractVersion?: unknown }).contractVersion === "number"
      ? ((body as { contractVersion: number }).contractVersion ?? null)
      : null;
  if (response.status === 426 || (statedVersion !== null && statedVersion !== 3)) {
    return { ok: false, reason: "incompatible", serverContractVersion: statedVersion };
  }
  if (!response.ok) return { ok: false, reason: "http_error" };

  const envelope = parseCatalogV3Envelope<T>(body);
  if (!envelope) return { ok: false, reason: "network" };
  return { ok: true, envelope };
}

export type ModelPagesResult =
  | {
      ok: true;
      entries: SlimModelEntry[];
      generationId: string;
      generatedAt: string;
      pages: number;
    }
  | Extract<FetchFailure, { reason: "incompatible" }>
  | {
      ok: false;
      reason: "timeout" | "network" | "http_error" | "empty" | "generation_mismatch" | "incomplete";
    };

/**
 * Every slim model page of one generation. Pass `pinnedGenerationId` to require
 * that generation; otherwise the first page's generation pins the rest. The
 * total must hold across pages and match the row count, with no repeated model
 * id or cursor.
 */
export async function fetchAllModelPages(
  base: string,
  pageLimit: number,
  timeoutMs: number,
  pinnedGenerationId?: string
): Promise<ModelPagesResult> {
  const entries: SlimModelEntry[] = [];
  let generationId = pinnedGenerationId;
  let generatedAt: string | undefined;
  let cursor: string | undefined;
  let pages = 0;
  const seenCursors = new Set<string>();
  let expectedTotal: number | undefined;

  for (;;) {
    const result = await fetchEnvelope<ModelsPageData>(
      buildCatalogPageUrl(base, cursor, pageLimit, generationId),
      timeoutMs
    );
    if (!result.ok) {
      if (result.reason === "incompatible") return result;
      return { ok: false, reason: pages === 0 ? result.reason : "incomplete" };
    }

    const { envelope } = result;
    if (generationId !== undefined && envelope.generationId !== generationId) {
      return { ok: false, reason: "generation_mismatch" };
    }
    generationId = envelope.generationId;
    generatedAt ??= envelope.generatedAt;
    if (
      envelope.data.mode !== "slim" ||
      !Array.isArray(envelope.data.models) ||
      !envelope.data.models.every(isSlimModelEntry)
    ) {
      return { ok: false, reason: pages === 0 ? "empty" : "incomplete" };
    }
    if (!Number.isSafeInteger(envelope.data.total) || envelope.data.total < 0) {
      return { ok: false, reason: "incomplete" };
    }
    if (expectedTotal === undefined) expectedTotal = envelope.data.total;
    else if (envelope.data.total !== expectedTotal) {
      return { ok: false, reason: "incomplete" };
    }

    entries.push(...envelope.data.models);
    pages++;
    const nextCursor = envelope.data.nextCursor;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor) || pages >= MAX_CATALOG_PAGES) {
      return { ok: false, reason: "incomplete" };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (!generationId || !generatedAt || entries.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (
    entries.length !== expectedTotal ||
    new Set(entries.map((entry) => entry.modelId)).size !== entries.length
  ) {
    return { ok: false, reason: "incomplete" };
  }
  return { ok: true, entries, generationId, generatedAt, pages };
}

export interface RefreshCatalogOptions {
  cachePath?: string;
}

export async function refreshCatalog(
  timeoutMs: number,
  options: RefreshCatalogOptions = {}
): Promise<RefreshOutcome> {
  if (catalogWarmDisabled()) return { kind: "fetch_failed", reason: "disabled" };
  let outcome: RefreshOutcome;
  try {
    // A generation can activate between the model pages and the registry read.
    // Never mix two: start over once, then report the mismatch.
    outcome = await refreshCatalogOnce(timeoutMs, options);
    if (outcome.kind === "fetch_failed" && outcome.reason === "generation_mismatch") {
      outcome = await refreshCatalogOnce(timeoutMs, options);
    }
  } catch (err) {
    noteRefreshSettled("failed", errorText(err));
    throw err;
  }
  noteRefreshSettled(
    outcome.kind === "refreshed" ? "refreshed" : "failed",
    describeRefreshOutcome(outcome)
  );
  return outcome;
}

/** Why a refresh failed, for the reachability record and the debug log. */
function describeRefreshOutcome(outcome: RefreshOutcome): string | undefined {
  if (outcome.kind === "refreshed") return undefined;
  return outcome.kind === "fetch_failed"
    ? outcome.reason
    : `incompatible contract ${outcome.serverContractVersion ?? "unknown"}`;
}

async function refreshCatalogOnce(
  timeoutMs: number,
  options: RefreshCatalogOptions
): Promise<RefreshOutcome> {
  // Resolved once for the whole refresh, for the same reason `generationId` is
  // pinned across pages: every page, and the route registry fetched after them,
  // has to describe one catalog. Reading the setting again lets a change
  // mid-refresh assemble a single cache out of two services, and the result is
  // indistinguishable from one service that served all of it.
  const base = catalogUrl();

  const modelPages = await fetchAllModelPages(base, CATALOG_PAGE_LIMIT, timeoutMs);
  if (!modelPages.ok) {
    if (modelPages.reason === "incompatible") {
      return { kind: "incompatible", serverContractVersion: modelPages.serverContractVersion };
    }
    return { kind: "fetch_failed", reason: modelPages.reason };
  }
  const { entries, generationId, generatedAt, pages } = modelPages;

  const planResult = await fetchSubscriptionPlans(timeoutMs, generationId);
  if (!planResult.ok) {
    if (planResult.reason === "incompatible") {
      return { kind: "incompatible", serverContractVersion: planResult.serverContractVersion };
    }
    return { kind: "fetch_failed", reason: planResult.reason };
  }

  const registryResult = await fetchRouteRegistry(timeoutMs, generationId, base);
  if (!registryResult.ok) {
    if (registryResult.reason === "incompatible") {
      return { kind: "incompatible", serverContractVersion: registryResult.serverContractVersion };
    }
    return { kind: "fetch_failed", reason: registryResult.reason };
  }
  const routeRegistry: CachedRouteRegistry = { generationId, registry: registryResult.registry };
  const reconciled = reconcileWires(entries, routeRegistry, generationId);
  if (!reconciled) {
    return { kind: "fetch_failed", reason: "incomplete" };
  }

  // The disk keeps the RAW rows, reconciled, so an older build that rejects a
  // cache with one unusable wire still reads it; memory gets them split,
  // exactly as `readAllModelsCache` hands them out.
  const rawEntries = reconciled.entries;
  const normalised = rawEntries.map(splitOptInConnections);
  const models = normalised.flatMap((entry) => {
    const id = externalIdFor(entry, "openrouter");
    return id ? [{ id }] : [];
  });
  const cache: DiskCacheV3 = {
    version: 3,
    lastUpdated: generatedAt,
    entries: rawEntries,
    models,
    plans: planResult.plans,
    catalogGenerationId: generationId,
    routeRegistry,
  };

  // Another process may have published a newer generation while this refresh
  // was paging through an older one. Generation ids are opaque, so publish
  // times decide: a different disk generation published later is kept, models
  // file and routes sidecar both, and becomes the in-process copy. The same id
  // is the same generation and is written as usual.
  const onDisk = readAllModelsCache(options.cachePath);
  if (
    onDisk &&
    onDisk.catalogGenerationId !== generationId &&
    isPublishedLater(onDisk.lastUpdated, generatedAt)
  ) {
    log(
      `[catalog] refresh skipped: disk holds newer generation ${onDisk.catalogGenerationId}, downloaded ${generationId}`
    );
    _clearChatCapabilityIndex();
    _memCache = onDisk.entries;
    _warmPromise = Promise.resolve();
    return {
      kind: "refreshed",
      modelCount: onDisk.entries.length,
      catalogGenerationId: onDisk.catalogGenerationId,
    };
  }

  writeAllModelsCache(cache, options.cachePath);
  // The chat-capability projection is memoized for 60s and keyed by cache path,
  // so without this a refresh leaves it serving the PREVIOUS generation for up
  // to a minute. That was survivable while an unrecognised model was offered
  // anyway; now that admission requires positive evidence, a stale projection
  // withholds models the refresh just described. Its doc comment already said
  // "after a catalog refresh" — nothing had ever called it.
  _clearChatCapabilityIndex();
  _memCache = normalised;
  _warmPromise = Promise.resolve();
  return {
    kind: "refreshed",
    modelCount: entries.length,
    catalogGenerationId: generationId,
    pages,
  };
}

/** True when `candidate` is a valid timestamp strictly later than `reference`. */
function isPublishedLater(candidate: string, reference: string): boolean {
  const candidateMs = Date.parse(candidate);
  const referenceMs = Date.parse(reference);
  return Number.isFinite(candidateMs) && Number.isFinite(referenceMs) && candidateMs > referenceMs;
}

export async function fetchSubscriptionPlans(
  timeoutMs: number,
  generationId: string,
  url: string = plansUrl()
): Promise<
  | { ok: true; plans: CachedSubscriptionPlan[] }
  | FetchFailure
  | { ok: false; reason: "empty" | "generation_mismatch" | "incomplete" }
> {
  const plans: CachedSubscriptionPlan[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const seenCursors = new Set<string>();
  let expectedTotal: number | undefined;

  for (;;) {
    const result = await fetchEnvelope<PlansPageData>(
      buildCatalogPageUrl(url, cursor, 100, generationId),
      timeoutMs
    );
    if (!result.ok) return result;
    if (result.envelope.generationId !== generationId) {
      return { ok: false, reason: "generation_mismatch" };
    }
    if (
      !Array.isArray(result.envelope.data.plans) ||
      !result.envelope.data.plans.every(isCachedSubscriptionPlan)
    ) {
      return { ok: false, reason: plans.length === 0 ? "empty" : "incomplete" };
    }
    if (!Number.isSafeInteger(result.envelope.data.total) || result.envelope.data.total < 0) {
      return { ok: false, reason: "incomplete" };
    }
    if (expectedTotal === undefined) expectedTotal = result.envelope.data.total;
    else if (result.envelope.data.total !== expectedTotal) {
      return { ok: false, reason: "incomplete" };
    }
    plans.push(...result.envelope.data.plans);
    pages++;
    const nextCursor = result.envelope.data.nextCursor;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor) || pages >= MAX_CATALOG_PAGES) {
      return { ok: false, reason: "incomplete" };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (plans.length === 0) return { ok: false, reason: "empty" };
  if (
    plans.length !== expectedTotal ||
    new Set(plans.map((plan) => plan.id)).size !== plans.length
  ) {
    return { ok: false, reason: "incomplete" };
  }
  return { ok: true, plans };
}

export async function fetchRouteRegistry(
  timeoutMs: number,
  generationId: string,
  modelsUrl: string
): Promise<
  | { ok: true; registry: RouteRegistry }
  | FetchFailure
  | { ok: false; reason: "empty" | "generation_mismatch" }
> {
  const result = await fetchEnvelope<{ mode?: string; registry?: unknown }>(
    buildRoutesUrl(modelsUrl, generationId),
    timeoutMs
  );
  if (!result.ok) return result;
  if (result.envelope.generationId !== generationId) {
    return { ok: false, reason: "generation_mismatch" };
  }
  const { registry } = result.envelope.data;
  if (result.envelope.data.mode !== "routes" || !isRouteRegistry(registry)) {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, registry };
}

function startCatalogWarm(): Promise<void> {
  if (_warmPromise) return _warmPromise;
  const promise = refreshCatalog(8000).then(
    (result) => {
      if (result.kind === "refreshed") return;
      // Without this line the reason is lost: callers only see "no snapshot".
      log(`[catalog] refresh failed: ${describeRefreshOutcome(result)}`);
      if (_warmPromise === promise) _warmPromise = null;
    },
    (err: unknown) => {
      // A throw (a cache write refused, a bad CLAUDISH_CATALOG_URL) must not stay
      // the answer for the life of the process: the next caller tries again.
      log(`[catalog] refresh threw: ${err instanceof Error ? err.message : String(err)}`);
      if (_warmPromise === promise) _warmPromise = null;
    }
  );
  _warmPromise = promise;
  return promise;
}

export async function warmCatalog(): Promise<void> {
  await startCatalogWarm();
}

export async function ensureCatalogReady(timeoutMs = 5000): Promise<void> {
  if (isCatalogWarm() || (readAllModelsCache()?.entries.length ?? 0) > 0) return;
  await waitForCatalogWarm(timeoutMs);
}

/**
 * Like {@link ensureCatalogReady}, for the request path: a cache written before
 * claudish read wires has models but no route registry, and no request may be
 * built from it. Such a cache is refreshed rather than accepted.
 */
export async function ensureRouteRegistryReady(timeoutMs = 5000): Promise<void> {
  const cache = readAllModelsCache();
  if (cache?.routeRegistry) return;
  // Models cached, registry missing or of another generation (an older claudish
  // rewrote the models): fetch only the routes of THIS generation — one small
  // request instead of the whole refresh.
  if (cache && !catalogWarmDisabled()) {
    const result = await fetchRouteRegistry(timeoutMs, cache.catalogGenerationId, catalogUrl());
    if (result.ok) {
      const routeRegistry = { generationId: cache.catalogGenerationId, registry: result.registry };
      if (reconcileWires(cache.entries, routeRegistry, cache.catalogGenerationId)) {
        // A refresh may have written another generation while the routes were
        // fetched; its models file and routes sidecar are newer, so keep them.
        const onDisk = readAllModelsCache();
        if (onDisk && onDisk.catalogGenerationId !== cache.catalogGenerationId) return;
        writeRouteRegistry(routeRegistry);
        return;
      }
    }
  }
  await waitForCatalogWarm(timeoutMs);
}

async function waitForCatalogWarm(timeoutMs: number): Promise<void> {
  let timedOut = false;
  await Promise.race([
    startCatalogWarm(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs)
    ),
  ]);
  if (timedOut)
    log(`[catalog] still refreshing after ${timeoutMs} ms; the caller goes on without it`);
}
