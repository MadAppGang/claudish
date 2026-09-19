import {
  type CachedSubscriptionPlan,
  type DiskCacheV3,
  type SlimModelEntry,
  isCachedSubscriptionPlan,
  isSlimModelEntry,
  readAllModelsCache,
  writeAllModelsCache,
} from "./all-models-cache.js";
import { catalogRouteMatchesProvider } from "./catalog-route-bindings.js";
import { CATALOG_V3_ACCEPT, type CatalogV3Envelope, parseCatalogV3Envelope } from "./catalog-v3.js";

const DEFAULT_CATALOG_URL =
  "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=all&catalog=slim&limit=1000";
const MAX_CATALOG_PAGES = 40;
const CATALOG_PAGE_LIMIT = 1000;

function catalogUrl(): string {
  return process.env.CLAUDISH_CATALOG_URL ?? DEFAULT_CATALOG_URL;
}

function derivePlansUrl(modelsUrl: string): string {
  try {
    const url = new URL(modelsUrl);
    url.pathname = url.pathname.replace(/\/queryModels$/, "/queryPlans");
    url.search = "";
    return url.toString();
  } catch {
    return "https://us-central1-claudish-6da10.cloudfunctions.net/queryPlans";
  }
}

function plansUrl(): string {
  return process.env.CLAUDISH_PLANS_URL ?? derivePlansUrl(catalogUrl());
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
  _catalogEntriesForTest = entries;
}

export function _resetCatalogClient(): void {
  _catalogEntriesForTest = undefined;
  _memCache = null;
  _warmPromise = null;
}

function allExternalIds(entry: SlimModelEntry): string[] {
  return (entry.aggregators ?? []).flatMap((connection) =>
    typeof connection.externalModelId === "string" ? [connection.externalModelId] : []
  );
}

export function externalIdFor(entry: SlimModelEntry, provider: string): string | null {
  const connection = entry.aggregators?.find(
    (candidate) =>
      candidate.routeStatus === "mapped" &&
      catalogRouteMatchesProvider(candidate.route, provider) &&
      typeof candidate.externalModelId === "string"
  );
  return connection?.externalModelId ?? null;
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

export function catalogWarmDisabledFor(value: string | undefined): boolean {
  return value === "1";
}

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

type FetchFailure =
  | { ok: false; reason: "timeout" | "network" | "http_error" }
  | { ok: false; reason: "incompatible"; serverContractVersion: number | null };

async function fetchEnvelope<T>(
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
    const name = (error as { name?: string } | null)?.name;
    return {
      ok: false,
      reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
    };
  }

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

export interface RefreshCatalogOptions {
  cachePath?: string;
}

export async function refreshCatalog(
  timeoutMs: number,
  options: RefreshCatalogOptions = {}
): Promise<RefreshOutcome> {
  if (catalogWarmDisabled()) return { kind: "fetch_failed", reason: "disabled" };

  const entries: SlimModelEntry[] = [];
  let generationId: string | undefined;
  let generatedAt: string | undefined;
  let cursor: string | undefined;
  let pages = 0;
  const seenCursors = new Set<string>();
  let expectedTotal: number | undefined;

  for (;;) {
    const result = await fetchEnvelope<ModelsPageData>(
      buildCatalogPageUrl(catalogUrl(), cursor, CATALOG_PAGE_LIMIT, generationId),
      timeoutMs
    );
    if (!result.ok) {
      if (result.reason === "incompatible") {
        return { kind: "incompatible", serverContractVersion: result.serverContractVersion };
      }
      return { kind: "fetch_failed", reason: pages === 0 ? result.reason : "incomplete" };
    }

    const { envelope } = result;
    if (generationId === undefined) {
      generationId = envelope.generationId;
      generatedAt = envelope.generatedAt;
    } else if (envelope.generationId !== generationId) {
      return { kind: "fetch_failed", reason: "generation_mismatch" };
    }
    if (
      envelope.data.mode !== "slim" ||
      !Array.isArray(envelope.data.models) ||
      !envelope.data.models.every(isSlimModelEntry)
    ) {
      return { kind: "fetch_failed", reason: pages === 0 ? "empty" : "incomplete" };
    }
    if (!Number.isSafeInteger(envelope.data.total) || envelope.data.total < 0) {
      return { kind: "fetch_failed", reason: "incomplete" };
    }
    if (expectedTotal === undefined) expectedTotal = envelope.data.total;
    else if (envelope.data.total !== expectedTotal) {
      return { kind: "fetch_failed", reason: "incomplete" };
    }

    entries.push(...envelope.data.models);
    pages++;
    const nextCursor = envelope.data.nextCursor;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor) || pages >= MAX_CATALOG_PAGES) {
      return { kind: "fetch_failed", reason: "incomplete" };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (!generationId || !generatedAt || entries.length === 0) {
    return { kind: "fetch_failed", reason: "empty" };
  }
  if (
    entries.length !== expectedTotal ||
    new Set(entries.map((entry) => entry.modelId)).size !== entries.length
  ) {
    return { kind: "fetch_failed", reason: "incomplete" };
  }

  const planResult = await fetchSubscriptionPlans(timeoutMs, generationId);
  if (!planResult.ok) {
    if (planResult.reason === "incompatible") {
      return { kind: "incompatible", serverContractVersion: planResult.serverContractVersion };
    }
    return { kind: "fetch_failed", reason: planResult.reason };
  }

  const models = entries.flatMap((entry) => {
    const id = externalIdFor(entry, "openrouter");
    return id ? [{ id }] : [];
  });
  const cache: DiskCacheV3 = {
    version: 3,
    lastUpdated: generatedAt,
    entries,
    models,
    plans: planResult.plans,
    catalogGenerationId: generationId,
  };

  writeAllModelsCache(cache, options.cachePath);
  _memCache = entries;
  _warmPromise = Promise.resolve();
  return {
    kind: "refreshed",
    modelCount: entries.length,
    catalogGenerationId: generationId,
    pages,
  };
}

async function fetchSubscriptionPlans(
  timeoutMs: number,
  generationId: string
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
      buildCatalogPageUrl(plansUrl(), cursor, 100, generationId),
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

function startCatalogWarm(): Promise<void> {
  if (_warmPromise) return _warmPromise;
  const promise = refreshCatalog(8000).then((result) => {
    if (result.kind !== "refreshed" && _warmPromise === promise) _warmPromise = null;
  });
  _warmPromise = promise;
  return promise;
}

export async function warmCatalog(): Promise<void> {
  await startCatalogWarm();
}

export async function ensureCatalogReady(timeoutMs = 5000): Promise<void> {
  if (isCatalogWarm() || (readAllModelsCache()?.entries.length ?? 0) > 0) return;
  await Promise.race([
    startCatalogWarm(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
