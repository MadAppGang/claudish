import { catalogRouteMatchesProvider } from "../providers/catalog-route-bindings.js";
/**
 * Dynamic pricing cache service
 *
 * Loads model pricing from the on-disk cache populated by prior sessions
 * and falls back to simple per-provider defaults when the cache is unavailable.
 *
 * Pricing data is considered an estimate (isEstimate: true). Fresh pricing
 * now flows through Firebase `ModelDoc.pricing` on a per-model basis —
 * there is no bulk pricing endpoint, so we no longer try to pre-populate
 * from the OpenRouter catalog.
 *
 * Architecture:
 *   getModelPricing() → in-memory map → disk cache → provider defaults
 *   warmPricingCache() → background: disk cache (no network fetch)
 *
 * Provider → OpenRouter ID resolution:
 *   Non-OpenRouter providers (`openai`, `google`, `kimi`, `glm`, ...) need
 *   their `(provider, modelName)` mapped to an OpenRouter `vendor/model` ID
 *   to consult the pricing map. We do this by reading the slim catalog's
 *   `aggregators[]` field via `catalog-query.ts` — each entry already lists
 *   `{provider: "openrouter", externalId: "vendor/model"}` for its OR
 *   listing, so we look up the entry by alias/modelId and use the
 *   `externalId` directly. Replaces the static `PROVIDER_TO_OR_PREFIX` map
 *   that was deleted in commit 6 (architecture §6.C). The `glm → zhipu/`
 *   bug noted in F6 is fixed by construction since the catalog has the
 *   correct vendor (`z-ai/`) on its `aggregators` array.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ModelPricing,
  registerDynamicPricingLookup,
} from "../handlers/shared/remote-provider-types.js";
import { log } from "../logger.js";
import { findEntryByAlias, findEntryByModelId } from "../providers/catalog-query.js";

// In-memory pricing map: OpenRouter model ID → pricing
const pricingMap = new Map<string, ModelPricing>();

// Disk cache path and TTL
const CACHE_DIR = join(homedir(), ".claudish");
const CACHE_FILE = join(CACHE_DIR, "pricing-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Whether the cache has been warmed (to avoid repeated warm attempts)
let cacheWarmed = false;

/**
 * Find pricing for an OpenRouter model ID using prefix-match fallback.
 *
 * The pricing map is keyed by full OR IDs like `openai/gpt-5`. For requests
 * that supply a more specific variant (e.g., `gpt-4o-2024-08-06`), we walk
 * the map and return the first entry whose key the request starts with.
 *
 * Returns `undefined` on miss.
 */
function prefixMatch(modelName: string): ModelPricing | undefined {
  for (const [key, pricing] of pricingMap) {
    if (modelName.startsWith(key)) return pricing;
  }
  return undefined;
}

/**
 * Synchronous lookup of dynamic pricing for a provider + model.
 * Returns undefined if no dynamic pricing is available (caller should fall back).
 *
 * For `provider === "openrouter"` the model name IS the full OpenRouter ID
 * (`openai/gpt-5`), so we hit `pricingMap` directly with a prefix-match
 * fallback for variant strings.
 *
 * For all other providers we consult the slim catalog's `aggregators[]`
 * field (architecture §6.C): find the entry by alias or modelId, locate its
 * OpenRouter aggregator entry, then look up the `externalId` in the
 * pricing map. This replaces the legacy `PROVIDER_TO_OR_PREFIX` map and
 * inherits whatever vendor prefix the catalog reports.
 */
export function getDynamicPricingSync(
  provider: string,
  modelName: string
): ModelPricing | undefined {
  if (provider === "openrouter") {
    return pricingMap.get(modelName) ?? prefixMatch(modelName);
  }

  const entry = findEntryByAlias(modelName) ?? findEntryByModelId(modelName);
  if (!entry) return undefined;

  const orAgg = entry.aggregators?.find((a) => catalogRouteMatchesProvider(a.route, "openrouter"));
  if (!orAgg) return undefined;

  return orAgg.externalModelId ? pricingMap.get(orAgg.externalModelId) : undefined;
}

/**
 * Warm the pricing cache by loading disk cache into memory.
 * Does NOT do any network fetches — the OpenRouter bulk catalog path was
 * removed when claudish switched to Firebase for model information.
 *
 * Call this at startup (fire-and-forget). Non-blocking.
 */
export async function warmPricingCache(): Promise<void> {
  if (cacheWarmed) return;
  cacheWarmed = true;

  // Register lookup function so getModelPricing() can use dynamic pricing
  registerDynamicPricingLookup(getDynamicPricingSync);

  try {
    const diskFresh = loadDiskCache();
    if (diskFresh) {
      log("[PricingCache] Loaded pricing from disk cache");
    } else {
      // Stale or missing — use provider defaults until a future version
      // repopulates per-model via Firebase `ModelDoc.pricing`.
      log("[PricingCache] Disk cache stale or missing, using provider defaults");
    }
  } catch (error) {
    log(`[PricingCache] Error warming cache: ${error}`);
  }
}

/**
 * Load disk cache into memory. Returns true if cache is fresh (within TTL).
 */
function loadDiskCache(): boolean {
  try {
    if (!existsSync(CACHE_FILE)) return false;

    const stat = statSync(CACHE_FILE);
    const age = Date.now() - stat.mtimeMs;
    const isFresh = age < CACHE_TTL_MS;

    const raw = readFileSync(CACHE_FILE, "utf-8");
    const data: Record<string, ModelPricing> = JSON.parse(raw);

    // Populate in-memory map
    for (const [key, pricing] of Object.entries(data)) {
      pricingMap.set(key, pricing);
    }

    return isFresh;
  } catch {
    // Cache corruption or read error — treat as miss
    return false;
  }
}

// NOTE: The previous OpenRouter bulk-catalog fetchers (`saveDiskCache`,
// `populateFromOpenRouterModels`) were removed when claudish moved to
// Firebase for model information. The pricing cache is now read-only
// for existing disk caches and relies on provider-default fallbacks
// for missing entries. A future version can repopulate the map per-model
// from `ModelDoc.pricing` via `getModelByIdFromFirebase()`.
