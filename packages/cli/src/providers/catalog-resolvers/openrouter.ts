import type { ModelCatalogResolver, RefreshOutcome } from "../model-catalog-resolver.js";
import type { AggregatorEntry } from "../../model-loader.js";
import {
  readAllModelsCache,
  writeAllModelsCache,
  type SlimModelEntry,
  type DiskCacheV2,
} from "../all-models-cache.js";
import { logStderr } from "../../logger.js";

/** Default slim-catalog endpoint (the models-index cloud function). */
const DEFAULT_CATALOG_URL =
  "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000";

/**
 * The slim-catalog endpoint, resolved at each refresh. Overrides, preferred
 * spelling first:
 *   - `CLAUDISH_CATALOG_URL`
 *   - `FIREBASE_CATALOG_URL` (backwards-compat alias)
 *
 * `||`, not `??`, deliberately: compose injects CLAUDISH_CATALOG_URL as ""
 * (#310 review), "" is not nullish, and the ?? chain fetched "" on every
 * recreated container — refresh failed, the dynamic catalog (documented
 * PRIMARY) fell back to the cold-start vendor map, and native-pin-auto
 * (#219), which reads the same in-memory catalog, went blind with it. A
 * function, not a module const, so the resolution is testable per call and
 * a flip needs no re-import.
 *
 * Used both by the proxy bg warm and the launcher's `refreshCatalog`. Chiefly
 * useful for integration tests that point at a local server to force fetch
 * failures (V4/V5 in `validation-criteria.md`).
 */
export function firebaseCatalogUrl(): string {
  return process.env.CLAUDISH_CATALOG_URL || process.env.FIREBASE_CATALOG_URL || DEFAULT_CATALOG_URL;
}

// Re-export so existing imports of DiskCache type from this module continue to work.
export type DiskCache = DiskCacheV2;

/**
 * Catalog contract v3 content negotiation (#222). The models-index endpoint
 * went v3-only on 2026-09-23: a bare GET answers HTTP 426
 * (`catalog_client_upgrade_required`) and the model list moved from a
 * top-level `models` array to a `data.models` envelope. We declare v3 via
 * Accept but still parse the legacy envelope, so an endpoint rollback cannot
 * leave the resolver dead.
 */
const CATALOG_ACCEPT_V3 = "application/vnd.models-index.catalog+json; version=3";

/**
 * Upper bound on catalog pages followed per refresh (#635 AC4).
 *
 * The live v3 endpoint pages at `limit=1000` and, on 2026-10-24, answered
 * `data.total = 1002` with a `nextCursor` — the resolver read page 1 and wrote
 * it out as the whole catalog, so the last two models were permanently
 * invisible AND the file could not say so. Ten pages is 10 000 models: far
 * above the real catalog, low enough that a server which mints a fresh cursor
 * for ever costs a bounded number of requests.
 */
const CATALOG_MAX_PAGES = 10;

/** Outcome of one page fetch. Never thrown — every failure is a value. */
type CatalogPageResult =
  | { ok: true; models: SlimModelEntry[]; serverTotal: number | null; nextCursor: string | null }
  | { ok: false; reason: "timeout" | "network" | "http_error" | "empty" };

/**
 * Append the continuation cursor to the catalog URL. Returns null when the
 * configured URL cannot be parsed — a caller treats that as a network-class
 * failure of the page, never as a silent fall-through to page 1.
 */
function appendCursor(url: string, cursor: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("cursor", cursor);
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Normalize one raw catalog entry (v3 or legacy) into the shape the resolver
 * dereferences. Shared by every page of a walk — a second page must be
 * indistinguishable from the first.
 */
function normalizeRawEntry(raw: unknown): SlimModelEntry {
  if ((raw as V3CatalogEntry)?.contractVersion === 3) {
    return mapV3Entry(raw as V3CatalogEntry);
  }
  // Legacy slim entry. Normalize only the fields resolveSync dereferences
  // (`sources` in steps 3/_getOpenRouterExternalId, `aliases` in step 2): an
  // entry from an unknown future contract would otherwise throw there.
  const legacy = raw as SlimModelEntry;
  if (legacy.sources && Array.isArray(legacy.aliases)) return legacy;
  return {
    ...legacy,
    sources: legacy.sources ?? {},
    aliases: Array.isArray(legacy.aliases) ? legacy.aliases : [],
  };
}

/** Wire shape of a contract-v3 catalog entry (measured live 2026-09-24). */
interface V3CatalogEntry {
  contractVersion: number;
  modelId: string;
  aliases?: unknown;
  releaseDate?: unknown;
  contextWindow?: unknown;
  inputModalities?: unknown;
  aggregators?: Array<{
    sourceProviderId?: unknown;
    sourceCollectorId?: unknown;
    externalModelId?: unknown;
    confidence?: unknown;
  }>;
}

/**
 * Map a v3 entry onto the SlimModelEntry the resolver consumes. The v3-native
 * `aggregators[]` index replaces the legacy `sources` record: each entry's
 * `sourceCollectorId` is the same key the old record used (e.g.
 * "openrouter-api"), so resolution steps 1-4 and the backward-compat `{id}`
 * array keep working unchanged.
 */
function mapV3Entry(raw: V3CatalogEntry): SlimModelEntry {
  const sources: SlimModelEntry["sources"] = {};
  const aggregators: AggregatorEntry[] = [];
  for (const agg of raw.aggregators ?? []) {
    const collectorId = typeof agg.sourceCollectorId === "string" ? agg.sourceCollectorId : null;
    const externalId = typeof agg.externalModelId === "string" ? agg.externalModelId : null;
    if (!collectorId || !externalId) continue;
    sources[collectorId] = { externalId };
    if (typeof agg.sourceProviderId === "string") {
      aggregators.push({
        provider: agg.sourceProviderId,
        externalId,
        confidence: agg.confidence as AggregatorEntry["confidence"],
      });
    }
  }
  return {
    modelId: raw.modelId,
    aliases: Array.isArray(raw.aliases)
      ? raw.aliases.filter((a): a is string => typeof a === "string")
      : [],
    sources,
    ...(aggregators.length ? { aggregators } : {}),
    ...(typeof raw.releaseDate === "string" ? { releaseDate: raw.releaseDate } : {}),
    ...(typeof raw.contextWindow === "number" ? { contextWindow: raw.contextWindow } : {}),
    // Absent modality data stays undefined, not false — the fail-closed
    // decision at the dialect layer (`?? false`) belongs to the data.
    ...(Array.isArray(raw.inputModalities)
      ? { supportsVision: raw.inputModalities.includes("image") }
      : {}),
  };
}

/**
 * Module-level memory cache of slim catalog entries.
 */
let _memCache: SlimModelEntry[] | null = null;

/**
 * Read-only access to the module-level memory catalog (#222 c).
 * `lookupModel()` falls back to this when the disk cache misses — the hub's
 * config bind is read-only, so its disk cache is structurally absent while the
 * startup `warmAllCatalogs()` populates memory. Callers must not mutate;
 * the array is replaced atomically, never written in place.
 */
export function getMemCatalogEntries(): SlimModelEntry[] | null {
  return _memCache;
}

/**
 * Test seam (same convention as resetOverflowCapsForTests): seed or clear the
 * module-level catalog without a fetch. `null`/`[]` restores cold state.
 */
export function setMemCatalogForTests(entries: SlimModelEntry[] | null): void {
  _memCache = entries;
}

/**
 * Promise that resolves when the cache is warm (from warmCache or lazy load).
 * Stored so multiple callers can await the same in-flight fetch.
 */
let _warmPromise: Promise<void> | null = null;

/**
 * Resolution chain for OpenRouter model names, powered by Firebase model catalog.
 *
 * 1. Exact match on modelId           (e.g., "grok-4.20" → sources["openrouter-api"].externalId)
 * 2. Match in aliases array            (e.g., "grok-4-20" alias → same model)
 * 3. Match in sources[*].externalId    (e.g., "x-ai/grok-4.20" found directly)
 * 4. Suffix match on externalIds       (backward compat: "/grok-4.20" endsWith match)
 * 5. Passthrough: return null          (caller sends userInput unchanged)
 */
export class OpenRouterCatalogResolver implements ModelCatalogResolver {
  readonly provider = "openrouter";

  resolveSync(userInput: string): string | null {
    const entries = this._getEntries();

    // If already vendor-prefixed, check for exact externalId match, else passthrough
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

    if (entries) {
      // Step 1: Exact modelId match
      const byModelId = entries.find((e) => e.modelId === userInput);
      if (byModelId) {
        const orId = this._getOpenRouterExternalId(byModelId);
        if (orId) return orId;
      }

      // Step 2: Match in aliases
      const byAlias = entries.find((e) => e.aliases.includes(userInput));
      if (byAlias) {
        const orId = this._getOpenRouterExternalId(byAlias);
        if (orId) return orId;
      }

      // Step 3: Match in any sources[*].externalId
      for (const entry of entries) {
        for (const src of Object.values(entry.sources)) {
          if (src.externalId === userInput) {
            const orId = this._getOpenRouterExternalId(entry);
            if (orId) return orId;
          }
        }
      }

      // Step 4: Suffix match on OpenRouter externalIds (backward compat)
      const suffix = `/${userInput}`;
      for (const entry of entries) {
        const orId = this._getOpenRouterExternalId(entry);
        if (orId && orId.endsWith(suffix)) return orId;
      }

      // Step 4b: Case-insensitive suffix match
      const lowerSuffix = `/${userInput.toLowerCase()}`;
      for (const entry of entries) {
        const orId = this._getOpenRouterExternalId(entry);
        if (orId && orId.toLowerCase().endsWith(lowerSuffix)) return orId;
      }
    }

    // Cold-start passthrough — the proxy-server warm + launcher warm cover this case.
    return null;
  }

  async warmCache(): Promise<void> {
    if (!_warmPromise) {
      _warmPromise = this._fetchAndCache();
    }
    await _warmPromise;
  }

  isCacheWarm(): boolean {
    return _memCache !== null && _memCache.length > 0;
  }

  async ensureReady(timeoutMs: number): Promise<void> {
    if (this.isCacheWarm()) return;

    // Start warming if not already in flight
    if (!_warmPromise) {
      _warmPromise = this._fetchAndCache();
    }

    // Race against timeout — never throw
    await Promise.race([
      _warmPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /**
   * One-shot catalog fetch with explicit success/failure return.
   *
   * - On success: replaces `_memCache` atomically AFTER the HTTP body parses,
   *   writes the disk cache, sets `_warmPromise = Promise.resolve()` so the
   *   proxy-server background warm short-circuits and doesn't double-fetch,
   *   and returns `{ kind: "refreshed", modelCount }`.
   * - On any failure: leaves `_memCache` and disk cache untouched, returns
   *   `{ kind: "fetch_failed", reason }`. Never throws.
   *
   * The launcher (`warmCatalogIfNeeded`) calls this directly and makes a
   * policy decision based on the outcome. `warmCache()`/`ensureReady()`
   * keep their fire-and-forget semantics for the proxy-server bg warm.
   */
  async refreshCatalog(timeoutMs: number): Promise<RefreshOutcome> {
    // ONE deadline for the whole walk, not a fresh timeout per page: callers
    // pass a budget they mean for the refresh (the launcher's hard-fail policy
    // is built on it), and a per-page timeout would multiply it by the page
    // count. Page 1 spends what it needs; later pages get the remainder.
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const base = firebaseCatalogUrl();
    const remainingBudget = () => Math.max(1, Math.ceil(deadline - Date.now()));

    const first = await this._fetchCatalogPage(base, null, remainingBudget());
    if (!first.ok) {
      // Page 1 is the catalog: its failure is the refresh's failure, unchanged.
      return { kind: "fetch_failed", reason: first.reason };
    }

    // Dedup across pages: the server paginates a moving collection, and an
    // entry can legitimately appear on two consecutive pages when the catalog
    // shifts under the walk. First occurrence wins.
    const models: SlimModelEntry[] = [];
    const seenIds = new Set<string>();
    const collect = (page: SlimModelEntry[]): void => {
      for (const entry of page) {
        const id = entry.modelId;
        if (typeof id === "string") {
          if (seenIds.has(id)) continue;
          seenIds.add(id);
        }
        models.push(entry);
      }
    };
    collect(first.models);

    let pages = 1;
    let serverTotal: number | null = first.serverTotal;
    let cursor: string | null = first.nextCursor;
    const seenCursors = new Set<string>();
    // "Complete" means the walk reached the server's own end, in either of its
    // two forms: the cursor ran out, or the server's own total was reached
    // while a cursor was still offered (both pinned). Every other exit (page
    // failure, replayed cursor, page cap, deadline) is a partial fetch, and
    // the persisted coverage says so.
    let complete = cursor === null;

    while (cursor !== null) {
      // The server's own count outranks the page cap (checked BEFORE it): a
      // walk that collected serverTotal distinct models on its last allowed
      // page reached the end and must not read as truncated.
      if (serverTotal !== null && models.length >= serverTotal) {
        complete = true;
        break;
      }
      if (pages >= CATALOG_MAX_PAGES) break;
      if (seenCursors.has(cursor)) break; // a server replaying a cursor must not loop us
      seenCursors.add(cursor);
      if (deadline - Date.now() <= 0) break;

      const page = await this._fetchCatalogPage(base, cursor, remainingBudget());
      if (!page.ok) break; // pages 2..N are enrichment: never discard what page 1 gave (#270)

      pages += 1;
      collect(page.models);
      if (serverTotal === null) serverTotal = page.serverTotal;
      cursor = page.nextCursor;
      if (cursor === null) complete = true;
    }

    const coverage = { pages, fetched: models.length, serverTotal, complete };

    // Build the disk-cache backward-compat models array locally before mutating
    // any shared state. If anything below were to throw, _memCache and the disk
    // file are still untouched (R5 in architecture.md).
    const backwardCompatModels: Array<{ id: string }> = [];
    for (const entry of models) {
      const orSource = entry.sources["openrouter-api"];
      if (orSource?.externalId) {
        backwardCompatModels.push({ id: orSource.externalId });
      }
    }

    // Atomic swap: only after we've successfully parsed and built the new payload.
    _memCache = models;

    // Persist to disk for cold-start fallback paths. Best-effort: on an
    // unwritable home (container read-only rootfs) this throws EROFS, and the
    // fallback must never fail the refresh that already succeeded in memory (#270).
    try {
      writeAllModelsCache({
        entries: models,
        models: backwardCompatModels,
        coverage,
      });
    } catch (err) {
      logStderr(`[Catalog] cache write skipped (unwritable path): ${(err as Error).message}`);
    }

    if (!complete) {
      // Not an error: a partial catalog still serves. It is a FACT worth a
      // line, because a truncated catalog that reports itself as whole is a
      // real hazard — it hides what the coverage now exposes. (The measured
      // #635 incident was next to this one, not it: `kimi-k3.1-pro` sat at
      // index 652 of page 1 and was hidden by a STALE disk cache, while this
      // walk's own gap starts past `limit=1000`.)
      logStderr(
        `[Catalog] partial fetch: pages=${pages} fetched=${models.length} serverTotal=${
          serverTotal ?? "unknown"
        }`
      );
    }

    // Short-circuit the proxy-server bg warm at proxy-server.ts:535. Resolves F2.
    // _warmPromise is read by warmCache()/ensureReady() — setting it here means
    // those methods see "already warmed" and return immediately without re-fetching.
    _warmPromise = Promise.resolve();

    return { kind: "refreshed", modelCount: models.length, coverage };
  }

  /**
   * Fetch ONE page of the slim catalog. Never throws: every failure mode is a
   * value, because a walk must be able to keep what it already holds.
   */
  private async _fetchCatalogPage(
    base: string,
    cursor: string | null,
    timeoutMs: number
  ): Promise<CatalogPageResult> {
    const target = cursor === null ? base : appendCursor(base, cursor);
    if (target === null) return { ok: false, reason: "network" };

    let response: Response;
    try {
      response = await fetch(target, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: CATALOG_ACCEPT_V3 },
      });
    } catch (err) {
      // AbortSignal.timeout fires a DOMException (or AbortError) named "TimeoutError"
      // when the deadline is exceeded. Anything else (DNS, ECONNREFUSED, TLS, etc.)
      // is treated as a generic network error.
      const name = (err as { name?: string } | null | undefined)?.name;
      const reason: "timeout" | "network" =
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      return { ok: false, reason };
    }

    if (!response.ok) {
      return { ok: false, reason: "http_error" };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // Body unparseable — treat as network-class failure (we got a response but
      // couldn't read it). Distinct from "empty" which is a parseable but empty body.
      return { ok: false, reason: "network" };
    }

    // v3 answers `{data: {models, total, nextCursor}}`; legacy answered `{models}`.
    const envelope = payload as {
      data?: { models?: unknown; total?: unknown; nextCursor?: unknown };
      models?: unknown;
    };
    const rawModels = (
      Array.isArray(envelope.data?.models) ? envelope.data.models : envelope.models
    ) as unknown[];
    if (!Array.isArray(rawModels) || rawModels.length === 0) {
      return { ok: false, reason: "empty" };
    }

    const declaredTotal = envelope.data?.total;
    const declaredCursor = envelope.data?.nextCursor;

    return {
      ok: true,
      models: rawModels.map(normalizeRawEntry),
      serverTotal:
        typeof declaredTotal === "number" && Number.isFinite(declaredTotal) ? declaredTotal : null,
      nextCursor:
        typeof declaredCursor === "string" && declaredCursor.length > 0 ? declaredCursor : null,
    };
  }

  /**
   * Extract the OpenRouter externalId from a catalog entry.
   * Checks "openrouter-api" source first (most common), then any source with a "/" in externalId.
   */
  private _getOpenRouterExternalId(entry: SlimModelEntry): string | null {
    // Prefer the OpenRouter collector's externalId
    const orSource = entry.sources["openrouter-api"];
    if (orSource?.externalId) return orSource.externalId;

    // Fallback: any source with a vendor-prefixed externalId
    for (const src of Object.values(entry.sources)) {
      if (src.externalId.includes("/")) return src.externalId;
    }

    return null;
  }

  private _getEntries(): SlimModelEntry[] | null {
    if (_memCache) return _memCache;

    const cache = readAllModelsCache();
    if (!cache) return null;

    // Prefer Firebase slim entries when present
    if (cache.entries.length > 0) {
      _memCache = cache.entries;
      return _memCache;
    }

    // Backward-compat: synthesize entries from a legacy v1 models array
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
   * Legacy fire-and-forget fetch entry point used by `warmCache`/`ensureReady`.
   *
   * Now a thin wrapper over `refreshCatalog(8000)` so the wire-format and
   * disk-write logic lives in exactly one place. The outcome is intentionally
   * discarded — these callers don't make policy decisions, they just want the
   * cache populated when possible. Failures fall through to the disk-read
   * fallback in `resolveSync`, matching the original silent-failure semantics.
   */
  private async _fetchAndCache(): Promise<void> {
    await this.refreshCatalog(8000);
  }
}
