/**
 * Model metadata catalog — Firebase slim cache is the sole source of truth.
 *
 * All model facts (contextWindow, supportsVision) come from the slim catalog
 * at ~/.claudish/all-models.json, populated at proxy startup by the OpenRouter
 * catalog resolver.
 *
 * Adapter-specific behavior (temperature ranges, tool name limits, max tool
 * counts) lives in the dialect/format classes themselves — those are CLI
 * constraints, not model metadata.
 */

import { readAllModelsCache, type SlimModelEntry } from "../providers/all-models-cache.js";
import { getMemCatalogEntries } from "../providers/catalog-resolvers/openrouter.js";

export interface ModelEntry {
  /** Model ID as stored in the slim catalog (not lowercased) */
  modelId: string;
  /** Context window in tokens */
  contextWindow: number;
  /** Whether model supports vision/image input (may be undefined if Firebase didn't specify) */
  supportsVision?: boolean;
}

function findEntry(entries: readonly SlimModelEntry[], modelId: string): SlimModelEntry | undefined {
  const lower = modelId.toLowerCase();
  // Vendor-prefixed IDs like "x-ai/grok-beta" — match on segment after "/"
  const unprefixed = lower.includes("/")
    ? lower.substring(lower.lastIndexOf("/") + 1)
    : lower;

  for (const entry of entries) {
    const entryId = entry.modelId.toLowerCase();

    const exactMatch = entryId === unprefixed || entryId === lower;
    const aliasMatch = entry.aliases?.some(
      (a) => a.toLowerCase() === unprefixed || a.toLowerCase() === lower
    );

    if (exactMatch || aliasMatch) return entry;
  }

  return undefined;
}

function toModelEntry(entry: SlimModelEntry): ModelEntry | undefined {
  if (entry.contextWindow === undefined) return undefined;
  return {
    modelId: entry.modelId,
    contextWindow: entry.contextWindow,
    supportsVision: entry.supportsVision,
  };
}

/**
 * Look up model metadata from the Firebase slim catalog cache.
 *
 * Accepts:
 *   - Bare model IDs ("glm-5", "minimax-m2.7")
 *   - Vendor-prefixed IDs ("x-ai/grok-4")
 *
 * Throws if `modelId` contains "@" — callers must strip the provider prefix
 * before calling (contract enforcement).
 *
 * Returns undefined when:
 *   - The cache file doesn't exist (cold start)
 *   - modelId isn't in the cache
 *   - The entry exists but has no `contextWindow`
 *
 * @param cachePath Override cache path. Defaults to `~/.claudish/all-models.json`.
 *                  Only tests should pass this.
 */
export function lookupModel(modelId: string, cachePath?: string): ModelEntry | undefined {
  if (modelId.includes("@")) {
    throw new Error(
      `lookupModel() received provider-routed ID "${modelId}" — callers must strip the "@" prefix before calling`
    );
  }

  // 1. Disk cache — historical primary. An entry found here is authoritative,
  //    including the fail-closed missing-contextWindow case; the memory
  //    fallback only fires on a disk MISS (#222 c).
  const cache = readAllModelsCache(cachePath);
  const diskEntry =
    cache && cache.entries.length > 0 ? findEntry(cache.entries, modelId) : undefined;
  if (diskEntry) return toModelEntry(diskEntry);

  // 2. Memory-catalog fallback: the hub's config bind is read-only, so its
  //    disk cache is structurally absent while the startup `warmAllCatalogs()`
  //    populates the resolver's in-memory catalog. Read-only, fail-closed —
  //    an id absent from both sources still yields undefined.
  const memEntries = getMemCatalogEntries();
  if (memEntries && memEntries.length > 0) {
    const memEntry = findEntry(memEntries, modelId);
    if (memEntry) return toModelEntry(memEntry);
  }

  return undefined;
}

/** Default context window when no catalog match (0 = unknown, shows N/A in status line) */
export const DEFAULT_CONTEXT_WINDOW = 0;

/** Default vision support when no catalog match */
export const DEFAULT_SUPPORTS_VISION = true;
