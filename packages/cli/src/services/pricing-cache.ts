/**
 * Dynamic pricing cache service
 *
 * Fetches model pricing from OpenRouter's /api/v1/models endpoint
 * (which lists models from all providers) and caches to disk.
 * Falls back to simple per-provider defaults when cache is unavailable.
 *
 * Architecture:
 *   getModelPricing() → in-memory map → disk cache → provider defaults
 *   warmPricingCache() → background: disk cache → OpenRouter API → update both
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { getCachedOpenRouterModels, ensureOpenRouterModelsLoaded } from "../model-loader.js";
import {
  registerDynamicPricingLookup,
  type ModelPricing,
} from "../handlers/shared/remote-provider-types.js";

// In-memory pricing map: OpenRouter model ID → pricing
const pricingMap = new Map<string, ModelPricing>();

// Disk cache path and TTL
const CACHE_DIR = join(homedir(), ".claudish");
const CACHE_FILE = join(CACHE_DIR, "pricing-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Whether the cache has been warmed (to avoid repeated warm attempts)
let cacheWarmed = false;

/**
 * Map from claudish provider names to OpenRouter model ID prefixes.
 * OpenRouter IDs look like "openai/gpt-5", "google/gemini-2.5-pro", etc.
 */
const PROVIDER_TO_OR_PREFIX: Record<string, string[]> = {
  openai: ["openai/"],
  oai: ["openai/"],
  gemini: ["google/"],
  google: ["google/"],
  minimax: ["minimax/"],
  mm: ["minimax/"],
  kimi: ["moonshotai/"],
  moonshot: ["moonshotai/"],
  glm: ["zhipu/"],
  zhipu: ["zhipu/"],
  ollamacloud: ["ollamacloud/", "meta-llama/", "qwen/", "deepseek/"],
  oc: ["ollamacloud/", "meta-llama/", "qwen/", "deepseek/"],
};

/**
 * Synchronous lookup of dynamic pricing for a provider + model.
 * Returns undefined if no dynamic pricing is available (caller should fall back).
 */
export function getDynamicPricingSync(
  provider: string,
  modelName: string
): ModelPricing | undefined {
  // For OpenRouter, the model name IS the full OpenRouter ID (e.g., "openai/gpt-5")
  if (provider === "openrouter") {
    const direct = pricingMap.get(modelName);
    if (direct) return direct;
    // Try prefix match
    for (const [key, pricing] of pricingMap) {
      if (modelName.startsWith(key)) return pricing;
    }
    return undefined;
  }

  const prefixes = PROVIDER_TO_OR_PREFIX[provider.toLowerCase()];
  if (!prefixes) return undefined;

  // Try exact match with each prefix
  for (const prefix of prefixes) {
    const orId = `${prefix}${modelName}`;
    const pricing = pricingMap.get(orId);
    if (pricing) return pricing;
  }

  // Try prefix match (e.g., "gpt-4o-2024-08-06" matches "openai/gpt-4o")
  for (const prefix of prefixes) {
    for (const [key, pricing] of pricingMap) {
      if (!key.startsWith(prefix)) continue;
      const orModelName = key.slice(prefix.length);
      if (modelName.startsWith(orModelName)) return pricing;
    }
  }

  return undefined;
}

/**
 * Warm the pricing cache.
 * 1. Load disk cache into memory
 * 2. If disk cache is stale or missing, fetch from OpenRouter API
 * 3. Update both disk and memory caches
 *
 * Call this at startup (fire-and-forget). Non-blocking.
 */
export async function warmPricingCache(): Promise<void> {
  if (cacheWarmed) return;
  cacheWarmed = true;

  // Register lookup function so getModelPricing() can use dynamic pricing
  registerDynamicPricingLookup(getDynamicPricingSync);

  try {
    // 1. Try loading from disk
    const diskFresh = loadDiskCache();

    if (diskFresh) {
      log("[PricingCache] Loaded pricing from disk cache");
      return;
    }

    // 2. Disk cache stale or missing — fetch from OpenRouter
    log("[PricingCache] Disk cache stale or missing, fetching from OpenRouter API...");
    const models = await ensureOpenRouterModelsLoaded();

    if (models.length === 0) {
      // Also try existing in-memory cache from model-loader
      const cached = getCachedOpenRouterModels();
      if (cached && cached.length > 0) {
        populateFromOpenRouterModels(cached);
        saveDiskCache();
        log(`[PricingCache] Populated from existing model-loader cache (${pricingMap.size} models)`);
        return;
      }
      log("[PricingCache] No models available, will use provider defaults");
      return;
    }

    populateFromOpenRouterModels(models);
    saveDiskCache();
    log(`[PricingCache] Fetched and cached pricing for ${pricingMap.size} models`);
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

/**
 * Save in-memory pricing map to disk cache.
 */
function saveDiskCache(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const data: Record<string, ModelPricing> = {};
    for (const [key, pricing] of pricingMap) {
      data[key] = pricing;
    }
    writeFileSync(CACHE_FILE, JSON.stringify(data), "utf-8");
  } catch (error) {
    log(`[PricingCache] Error saving disk cache: ${error}`);
  }
}

/**
 * Populate in-memory pricing map from OpenRouter models API response.
 * OpenRouter returns pricing as per-token strings:
 *   { pricing: { prompt: "0.000003", completion: "0.000015" } }
 * We convert to per-1M format for consistency with ModelPricing.
 */
function populateFromOpenRouterModels(models: any[]): void {
  for (const model of models) {
    if (!model.id || !model.pricing) continue;

    const promptPrice = parseFloat(model.pricing.prompt || "0");
    const completionPrice = parseFloat(model.pricing.completion || "0");

    // Skip models with invalid pricing
    if (isNaN(promptPrice) || isNaN(completionPrice)) continue;

    // Convert per-token to per-1M tokens
    const inputCostPer1M = promptPrice * 1_000_000;
    const outputCostPer1M = completionPrice * 1_000_000;

    const isFree = inputCostPer1M === 0 && outputCostPer1M === 0;

    pricingMap.set(model.id, {
      inputCostPer1M,
      outputCostPer1M,
      isEstimate: true, // Sourced from OpenRouter, may differ from direct provider pricing
      ...(isFree ? { isFree: true } : {}),
    });
  }
}
