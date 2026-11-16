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
 * A non-OpenRouter provider's request (`anthropic`, `openai`, `kimi`, ...) is
 *   priced at its OWN catalog connection's published rate first: the entry is
 *   found by alias, model id, or a mapped connection of that provider whose wire
 *   id is the name, and the provider's mapped connection gives the rate
 *   (`connectionRequestRates`). Only when it publishes none is the model's
 *   OpenRouter row used, through the OpenRouter `externalId` on the same entry,
 *   and with neither the caller falls to a marked estimate. Entries are read
 *   through `getCatalogEntries()`, the disk catalog else the bundled recommended
 *   list, so a launch with no catalog file still prices by the catalog.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ModelPricing,
  registerDynamicPricingLookup,
} from "../handlers/shared/remote-provider-types.js";
import { log } from "../logger.js";
import type { SlimModelEntry } from "../providers/all-models-cache.js";
import { getCatalogEntries } from "../providers/catalog-client.js";
import { catalogRouteMatchesProvider } from "../providers/catalog-route-bindings.js";
import { connectionRequestRates } from "../providers/connection-price.js";

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

/** A mapped connection of `provider` on `entry`: the one whose wire id is `name`, else the first. */
export function ownConnection(entry: SlimModelEntry, provider: string, name: string) {
  const own = (entry.aggregators ?? []).filter(
    (a) => a.routeStatus === "mapped" && catalogRouteMatchesProvider(a.route, provider)
  );
  return own.find((a) => a.externalModelId === name) ?? own[0];
}

/**
 * The catalog entry a request's model name prices from: by alias, then by
 * model id, then by a mapped connection of `provider` whose wire id is the name
 * (a request is priced by the wire id it was sent with, which may be neither).
 * Exported so a reader that must agree with the price (the Claude API meter's
 * model identity and context window) finds the same entry.
 */
export function catalogEntryForRequest(provider: string, name: string): SlimModelEntry | undefined {
  const entries = getCatalogEntries() ?? [];
  return (
    entries.find((e) => e.aliases.includes(name)) ??
    entries.find((e) => e.modelId === name) ??
    entries.find((e) =>
      (e.aggregators ?? []).some(
        (a) =>
          a.routeStatus === "mapped" &&
          a.externalModelId === name &&
          catalogRouteMatchesProvider(a.route, provider)
      )
    )
  );
}

/**
 * Synchronous lookup of dynamic pricing for a provider + model.
 * Returns undefined if no dynamic pricing is available (caller should fall back).
 *
 * For `provider === "openrouter"` the model name IS the full OpenRouter ID
 * (`openai/gpt-5`), so we hit `pricingMap` directly with a prefix-match
 * fallback for variant strings.
 *
 * For all other providers: the provider's own mapped connection's published
 * rate first (for `anthropic`, `anthropic/direct-api`), then the model's
 * OpenRouter row, then undefined.
 */
export function getDynamicPricingSync(
  provider: string,
  modelName: string
): ModelPricing | undefined {
  if (provider === "openrouter") {
    return pricingMap.get(modelName) ?? prefixMatch(modelName);
  }

  const entry = catalogEntryForRequest(provider, modelName);
  if (!entry) return undefined;

  const own = ownConnection(entry, provider, modelName);
  const ownRates = own ? connectionRequestRates(own) : undefined;
  if (ownRates) return ownRates;

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
