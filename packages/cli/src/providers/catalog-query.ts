/**
 * Read-only accessor module over the slim model catalog cache
 * (`~/.claudish/cloud-models-catalog-v3.json`).
 *
 * Used by feature code that needs to look up catalog entries without going
 * through the full `OpenRouterCatalogResolver` resolution chain. The resolver
 * is concerned with vendor-prefix translation for outbound API calls; this
 * module is concerned with answering "what does the catalog say about model
 * X / alias Y?" for cleanup-side consumers (vision proxy, advisor tier
 * resolution, pricing lookup).
 *
 * Architecture reference: §6.B in
 * `ai-docs/sessions/dev-feature-catalog-warm-hardcoded-cleanup-20260508-202624-9f3f45b8/architecture.md`.
 *
 * Design notes:
 *   - Sync. Reads through `readAllModelsCache()` (file read + JSON parse).
 *     A mtime-keyed memo (`getCachedEntries`) keeps the per-request hot path
 *     cheap — repeated calls within the same proxy request hit the in-memory
 *     cache and only re-read the disk file when its mtime changes (resolves
 *     review finding F8 in commit 6).
 *   - All accessors return `null` when the disk cache is missing OR when no
 *     matching entry exists. They never throw.
 *   - Aliases are matched case-sensitive (the slim catalog stores them in
 *     canonical form; case-insensitive lookups are the resolver's job, not
 *     this module's).
 *   - We expose a minimal `CatalogEntryQueryResult` shape rather than the
 *     full `SlimModelEntry` so callers don't depend on internal slim-cache
 *     structure (e.g., `sources`). The `aggregators[]` array IS surfaced
 *     because the pricing-cache lookup needs to read each entry's
 *     `(provider, externalId)` routing index without re-fetching the entry.
 */

import { statSync } from "node:fs";
import type { AggregatorEntry } from "../model-loader.js";
import {
  ALL_MODELS_CACHE_PATH,
  type SlimModelEntry,
  readAllModelsCache,
} from "./all-models-cache.js";

/**
 * Minimal projection of a slim catalog entry for query consumers.
 *
 * Intentionally narrower than `SlimModelEntry` — only fields current callers
 * (advisor tier resolution, vision proxy, pricing cache) need. New callers
 * should add fields here explicitly with a doc comment rather than reach into
 * the raw `SlimModelEntry` shape.
 */
export interface CatalogEntryQueryResult {
  modelId: string;
  aliases: string[];
  /** Whether the model supports vision/image input. Optional — may be absent on older entries. */
  supportsVision?: boolean;
  /** Context window in tokens. Optional — may be absent on older entries. */
  contextWindow?: number;
  /**
   * ISO release date (`YYYY-MM-DD`) the catalog publishes for this model.
   *
   * Surfaced for Vertex probe discovery: Vertex's publisher listing reports no
   * date at all, so a dynamic models catalog built from it would rank by the
   * version digits in the id alone and put a 2-year-old `gemma`-style row above
   * the newest Gemini. The date is a property of the MODEL, which the catalog
   * already publishes, so reading it here asserts nothing about the project.
   * Optional — older cache files and unlisted models carry none.
   */
  releaseDate?: string;
  /**
   * Multi-aggregator routing index. Each entry is `{provider, externalId, confidence}`.
   * Surfaced for the pricing-cache lookup (item 6.2) which needs to find the
   * `openrouter` aggregator's `externalId` to consult `pricingMap`. Optional —
   * older cache files may not include this field.
   */
  aggregators?: AggregatorEntry[];
}

function project(entry: SlimModelEntry): CatalogEntryQueryResult {
  return {
    modelId: entry.modelId,
    aliases: entry.aliases,
    supportsVision: entry.supportsVision,
    contextWindow: entry.contextWindow,
    releaseDate: entry.releaseDate,
    aggregators: entry.aggregators,
  };
}

// ---------------------------------------------------------------------------
// Mtime-keyed memo (commit 6 — resolves review finding F8)
// ---------------------------------------------------------------------------
//
// The pricing-cache lookup runs on every proxied request. Re-reading and
// JSON-parsing `~/.claudish/cloud-models-catalog-v3.json` each call adds non-trivial
// overhead (the slim catalog can hold hundreds of entries). We cache the
// parsed entries in module scope and invalidate whenever the file's `mtimeMs`
// changes — that catches both writes from `OpenRouterCatalogResolver`'s
// `refreshCatalog` and out-of-band edits.
//
// Tests reset the memo between cases via `_resetMemo` so synthetic
// `mockReadResult` swaps take effect immediately.

let _memoEntries: SlimModelEntry[] | null = null;
let _memoMtimeMs = -1;

/**
 * Test-only hook: clear the mtime memo so the next call re-reads the disk
 * cache from scratch. Used by `catalog-query.test.ts` (and any future
 * consumer that mocks `readAllModelsCache`) so synthetic fixtures swap in
 * cleanly.
 *
 * @internal
 */
export function _resetMemo(): void {
  _memoEntries = null;
  _memoMtimeMs = -1;
}

/**
 * Return the current slim entries, reading through the mtime memo.
 *
 * Returns `null` when:
 *   - `statSync(ALL_MODELS_CACHE_PATH)` throws (file missing) — does NOT cache.
 *   - `readAllModelsCache()` returns null (corrupt JSON) — does NOT cache.
 *
 * Caches successful reads keyed by `mtimeMs`. A subsequent call sees the
 * cache hit when the file hasn't changed.
 */
function getCachedEntries(): SlimModelEntry[] | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(ALL_MODELS_CACHE_PATH).mtimeMs;
  } catch {
    return null;
  }

  if (mtimeMs === _memoMtimeMs && _memoEntries !== null) {
    return _memoEntries;
  }

  const cache = readAllModelsCache();
  if (!cache) return null;

  _memoEntries = cache.entries;
  _memoMtimeMs = mtimeMs;
  return _memoEntries;
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/**
 * Find a slim entry whose `aliases[]` includes the given alias (case-sensitive).
 *
 * Returns `null` when:
 *   - the disk cache is missing or unparseable (`readAllModelsCache` → null), OR
 *   - the cache has no entries, OR
 *   - no entry's `aliases` array contains `alias`.
 *
 * Never throws.
 */
export function findEntryByAlias(alias: string): CatalogEntryQueryResult | null {
  const entries = getCachedEntries();
  if (!entries || entries.length === 0) return null;

  for (const entry of entries) {
    if (entry.aliases.includes(alias)) {
      return project(entry);
    }
  }
  return null;
}

/**
 * Find a slim entry by exact `modelId` match (case-sensitive).
 *
 * Returns `null` when:
 *   - the disk cache is missing or unparseable, OR
 *   - the cache has no entries, OR
 *   - no entry's `modelId` equals `modelId`.
 *
 * Never throws.
 */
export function findEntryByModelId(modelId: string): CatalogEntryQueryResult | null {
  const entries = getCachedEntries();
  if (!entries || entries.length === 0) return null;

  for (const entry of entries) {
    if (entry.modelId === modelId) {
      return project(entry);
    }
  }
  return null;
}

/**
 * Find an entry whose `aliases[]` includes `alias` AND whose
 * `supportsVision === true`.
 *
 * The catalog may have multiple entries that share a common alias (e.g., two
 * models tagged "sonnet"); only ones with `supportsVision === true` qualify.
 * The first match wins — entries are searched in the order they appear in the
 * cache, which matches the order Firebase returns them.
 *
 * Returns `null` when:
 *   - the disk cache is missing or unparseable, OR
 *   - the cache has no entries, OR
 *   - no entry both contains the alias and has `supportsVision === true`.
 *
 * Never throws.
 */
export function findVisionAlias(alias: string): CatalogEntryQueryResult | null {
  const entries = getCachedEntries();
  if (!entries || entries.length === 0) return null;

  for (const entry of entries) {
    if (entry.supportsVision === true && entry.aliases.includes(alias)) {
      return project(entry);
    }
  }
  return null;
}
