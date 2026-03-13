import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelCatalogResolver } from "../model-catalog-resolver.js";
import { getCachedOpenRouterModels, ensureOpenRouterModelsLoaded } from "../../model-loader.js";
import { staticOpenRouterFallback } from "./static-fallback.js";

/**
 * Module-level memory cache: array of { id: string } objects.
 * id is in "vendor/model" format (OpenRouter canonical form).
 * Populated by warmCache() or lazily by _getModels() reading all-models.json.
 */
let _memCache: Array<{ id: string }> | null = null;

/**
 * Resolution chain for OpenRouter:
 *
 * 1. Exact match: userInput === model.id                (e.g., "qwen/qwen3-coder-next" already in catalog)
 * 2. Exact suffix match: model.id endsWith "/"+userInput (e.g., "qwen3-coder-next" → "qwen/qwen3-coder-next")
 * 3. Case-insensitive suffix match                      (safety net for casing differences)
 * 4. Static fallback: OPENROUTER_VENDOR_MAP             (cold-start only, for known vendor prefixes)
 * 5. Passthrough: return null                           (caller sends userInput unchanged)
 *
 * No fuzzy/normalized matching — model names must match exactly.
 */
export class OpenRouterCatalogResolver implements ModelCatalogResolver {
  readonly provider = "openrouter";

  async resolve(userInput: string): Promise<string | null> {
    // If already vendor-prefixed, check exact match first, then return as-is.
    if (userInput.includes("/")) {
      const models = await this._getModels();
      if (models) {
        const exactMatch = models.find((m) => m.id === userInput);
        return exactMatch ? exactMatch.id : userInput;
      }
      return userInput;
    }

    const models = await this._getModels();
    if (models) {
      // Exact match on the bare model name portion after the vendor prefix
      // e.g., userInput="qwen3-coder-next" matches catalog entry "qwen/qwen3-coder-next"
      const suffix = `/${userInput}`;
      const match = models.find((m) => m.id.endsWith(suffix));
      if (match) return match.id;

      // Case-insensitive exact match (OpenRouter IDs are lowercase, but be safe)
      const lowerSuffix = `/${userInput.toLowerCase()}`;
      const ciMatch = models.find((m) => m.id.toLowerCase().endsWith(lowerSuffix));
      if (ciMatch) return ciMatch.id;
    }

    // Static fallback (cold-start only)
    return staticOpenRouterFallback(userInput);
  }

  async warmCache(): Promise<void> {
    try {
      // Prefer the already-fetched in-process cache from model-loader.ts
      const existing = getCachedOpenRouterModels();
      if (existing && existing.length > 0) {
        _memCache = existing;
        return;
      }

      // Fetch from OpenRouter API (writes all-models.json as side effect)
      const models = await ensureOpenRouterModelsLoaded();
      if (models.length > 0) {
        _memCache = models;
      }
    } catch {
      // Silent — fall back to disk read in resolve
    }
  }

  isCacheWarm(): boolean {
    return _memCache !== null && _memCache.length > 0;
  }

  private async _getModels(): Promise<Array<{ id: string }> | null> {
    // In-memory first
    if (_memCache) return _memCache;

    // Disk fallback: all-models.json
    const diskPath = join(homedir(), ".claudish", "all-models.json");
    try {
      const data = JSON.parse(await readFile(diskPath, "utf-8"));
      if (Array.isArray(data.models) && data.models.length > 0) {
        _memCache = data.models;
        return _memCache;
      }
    } catch {
      // File doesn't exist or parse error — ignore
    }

    return null;
  }
}
