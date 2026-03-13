import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { ModelCatalogResolver } from "../model-catalog-resolver.js";

/**
 * Module-level memory cache: array of model_group names.
 * Populated by warmCache() or lazily by _getModelIds() reading the disk cache.
 */
let _memCache: string[] | null = null;

function getCachePath(): string | null {
  const baseUrl = process.env.LITELLM_BASE_URL;
  if (!baseUrl) return null;
  const hash = createHash("sha256").update(baseUrl).digest("hex").substring(0, 16);
  return join(homedir(), ".claudish", `litellm-models-${hash}.json`);
}

/**
 * Resolution chain for LiteLLM:
 *
 * 1. Exact match: userInput === model_group name         (e.g., "gpt-4o" when group is "gpt-4o")
 * 2. Prefix-strip: strip vendor prefix from group name   (e.g., "gpt-4o" → "openai/gpt-4o")
 * 3. Reverse prefix-strip: strip vendor prefix from user input
 *    (e.g., "openai/gpt-4o" → "gpt-4o" when group is "gpt-4o")
 * 4. Passthrough: return null                            (caller sends userInput unchanged)
 *
 * No fuzzy/normalized matching — model names must match exactly.
 */
export class LiteLLMCatalogResolver implements ModelCatalogResolver {
  readonly provider = "litellm";

  async resolve(userInput: string): Promise<string | null> {
    const ids = await this._getModelIds();
    if (!ids || ids.length === 0) return null;

    // Pass 1: exact match (user typed exactly what LiteLLM expects)
    if (ids.includes(userInput)) return userInput;

    // Pass 2: prefix-stripping — find the exact model name behind a vendor prefix
    // LiteLLM model groups can be named "openai/gpt-4o", "azure/gpt-4o-mini", etc.
    // User typing "ll@gpt-4o" should match "openai/gpt-4o" because "gpt-4o" matches exactly
    const prefixMatch = ids.find((id) => {
      if (!id.includes("/")) return false;
      const afterSlash = id.split("/").pop()!;
      return afterSlash === userInput;
    });
    if (prefixMatch) return prefixMatch;

    // Pass 3: reverse prefix strip — user typed "openai/gpt-4o" but group is just "gpt-4o"
    if (userInput.includes("/")) {
      const bare = userInput.split("/").pop()!;
      if (ids.includes(bare)) return bare;
    }

    return null;
  }

  async warmCache(): Promise<void> {
    // LiteLLM cache is written by fetchLiteLLMModels() (in model-loader.ts).
    // We just need to read it into memory here.
    const path = getCachePath();
    if (!path) return;
    try {
      const data = JSON.parse(await readFile(path, "utf-8"));
      if (Array.isArray(data.models)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _memCache = data.models.map((m: any) => m.name ?? m.id?.replace("litellm@", "") ?? "");
      }
    } catch {
      // File doesn't exist or parse error — ignore
    }
  }

  isCacheWarm(): boolean {
    return _memCache !== null && _memCache.length > 0;
  }

  private async _getModelIds(): Promise<string[] | null> {
    if (_memCache) return _memCache;

    // Try disk (litellm-models-{hash}.json)
    const path = getCachePath();
    if (!path) return null;
    try {
      const data = JSON.parse(await readFile(path, "utf-8"));
      if (Array.isArray(data.models)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _memCache = data.models.map((m: any) => m.name ?? m.id?.replace("litellm@", "") ?? "");
        return _memCache;
      }
    } catch {
      // File doesn't exist or parse error — ignore
    }
    return null;
  }
}
