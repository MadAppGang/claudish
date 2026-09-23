import type { ModelCatalogResolver, RefreshOutcome } from "../model-catalog-resolver.js";
import {
  readAllModelsCache,
  writeAllModelsCache,
  type SlimModelEntry,
  type DiskCacheV2,
} from "../all-models-cache.js";

/**
 * Firebase slim catalog endpoint. Override via:
 *   - `CLAUDISH_CATALOG_URL` (preferred, documented spelling)
 *   - `FIREBASE_CATALOG_URL` (backwards-compat alias)
 *
 * Used both by the proxy bg warm and the launcher's `refreshCatalog`. Chiefly
 * useful for integration tests that point at a local server to force fetch
 * failures (V4/V5 in `validation-criteria.md`).
 */
const FIREBASE_CATALOG_URL =
  process.env.CLAUDISH_CATALOG_URL ??
  process.env.FIREBASE_CATALOG_URL ??
  "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000";

// Re-export so existing imports of DiskCache type from this module continue to work.
export type DiskCache = DiskCacheV2;

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
    let response: Response;
    try {
      response = await fetch(FIREBASE_CATALOG_URL, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // AbortSignal.timeout fires a DOMException (or AbortError) named "TimeoutError"
      // when the deadline is exceeded. Anything else (DNS, ECONNREFUSED, TLS, etc.)
      // is treated as a generic network error.
      const name = (err as { name?: string } | null | undefined)?.name;
      const reason: "timeout" | "network" =
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      return { kind: "fetch_failed", reason };
    }

    if (!response.ok) {
      return { kind: "fetch_failed", reason: "http_error" };
    }

    let data: { models: SlimModelEntry[]; total?: number };
    try {
      data = (await response.json()) as { models: SlimModelEntry[]; total?: number };
    } catch {
      // Body unparseable — treat as network-class failure (we got a response but
      // couldn't read it). Distinct from "empty" which is a parseable but empty body.
      return { kind: "fetch_failed", reason: "network" };
    }

    if (!Array.isArray(data.models) || data.models.length === 0) {
      return { kind: "fetch_failed", reason: "empty" };
    }

    // Build the disk-cache backward-compat models array locally before mutating
    // any shared state. If anything below were to throw, _memCache and the disk
    // file are still untouched (R5 in architecture.md).
    const backwardCompatModels: Array<{ id: string }> = [];
    for (const entry of data.models) {
      const orSource = entry.sources["openrouter-api"];
      if (orSource?.externalId) {
        backwardCompatModels.push({ id: orSource.externalId });
      }
    }

    // Atomic swap: only after we've successfully parsed and built the new payload.
    _memCache = data.models;

    // Persist to disk for cold-start fallback paths.
    writeAllModelsCache({
      entries: data.models,
      models: backwardCompatModels,
    });

    // Short-circuit the proxy-server bg warm at proxy-server.ts:535. Resolves F2.
    // _warmPromise is read by warmCache()/ensureReady() — setting it here means
    // those methods see "already warmed" and return immediately without re-fetching.
    _warmPromise = Promise.resolve();

    return { kind: "refreshed", modelCount: data.models.length };
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
