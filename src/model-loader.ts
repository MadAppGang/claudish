import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { OpenRouterModel } from "./types.js";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ModelMetadata {
  name: string;
  description: string;
  priority: number;
  provider: string;
}

interface RecommendedModelsJSON {
  version: string;
  lastUpdated: string;
  source: string;
  models: Array<{
    id: string;
    name: string;
    description: string;
    provider: string;
    category: string;
    priority: number;
    pricing: {
      input: string;
      output: string;
      average: string;
    };
    context: string;
    recommended: boolean;
  }>;
}

// Cache loaded data to avoid reading file multiple times
let _cachedModelInfo: Record<string, ModelMetadata> | null = null;
let _cachedModelIds: string[] | null = null;
let _cachedRecommendedModels: RecommendedModelsJSON | null = null;

/**
 * Get the path to recommended-models.json
 */
function getRecommendedModelsPath(): string {
  return join(__dirname, "../recommended-models.json");
}

/**
 * Load the raw recommended-models.json data
 */
function loadRecommendedModelsJSON(): RecommendedModelsJSON {
  if (_cachedRecommendedModels) {
    return _cachedRecommendedModels;
  }

  const jsonPath = getRecommendedModelsPath();

  if (!existsSync(jsonPath)) {
    throw new Error(
      `recommended-models.json not found at ${jsonPath}. ` +
      `Run 'claudish --update-models' to fetch the latest model list.`
    );
  }

  try {
    const jsonContent = readFileSync(jsonPath, "utf-8");
    _cachedRecommendedModels = JSON.parse(jsonContent);
    return _cachedRecommendedModels!;
  } catch (error) {
    throw new Error(`Failed to parse recommended-models.json: ${error}`);
  }
}

/**
 * Load model metadata from recommended-models.json
 */
export function loadModelInfo(): Record<OpenRouterModel, ModelMetadata> {
  if (_cachedModelInfo) {
    return _cachedModelInfo as Record<OpenRouterModel, ModelMetadata>;
  }

  const data = loadRecommendedModelsJSON();
  const modelInfo: Record<string, ModelMetadata> = {};

  for (const model of data.models) {
    modelInfo[model.id] = {
      name: model.name,
      description: model.description,
      priority: model.priority,
      provider: model.provider,
    };
  }

  // Add custom option
  modelInfo.custom = {
    name: "Custom Model",
    description: "Enter any OpenRouter model ID manually",
    priority: 999,
    provider: "Custom",
  };

  _cachedModelInfo = modelInfo;
  return modelInfo as Record<OpenRouterModel, ModelMetadata>;
}

/**
 * Get list of available model IDs from recommended-models.json
 */
export function getAvailableModels(): OpenRouterModel[] {
  if (_cachedModelIds) {
    return _cachedModelIds as OpenRouterModel[];
  }

  const data = loadRecommendedModelsJSON();
  const modelIds = data.models
    .sort((a, b) => a.priority - b.priority)
    .map((m) => m.id);

  const result = [...modelIds, "custom"];
  _cachedModelIds = result;
  return result as OpenRouterModel[];
}

// Cache for OpenRouter API response
let _cachedOpenRouterModels: any[] | null = null;

/**
 * Get the cached OpenRouter models list (if already fetched)
 * Returns null if not yet fetched
 */
export function getCachedOpenRouterModels(): any[] | null {
  return _cachedOpenRouterModels;
}

/**
 * Ensure the OpenRouter models list is loaded (fetches if not cached)
 * Returns the models array or empty array on failure
 */
export async function ensureOpenRouterModelsLoaded(): Promise<any[]> {
  if (_cachedOpenRouterModels) return _cachedOpenRouterModels;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (response.ok) {
      const data: any = await response.json();
      _cachedOpenRouterModels = data.data || [];
      return _cachedOpenRouterModels!;
    }
  } catch {
    // Silent fail — caller handles null/empty
  }
  return [];
}

/**
 * Fetch exact context window size from OpenRouter API
 * @param modelId The full OpenRouter model ID (e.g. "anthropic/claude-3-sonnet")
 * @returns Context window size in tokens (default: 200000)
 */
export async function fetchModelContextWindow(modelId: string): Promise<number> {
  // 1. Use cached API data if available
  if (_cachedOpenRouterModels) {
    const model = _cachedOpenRouterModels.find((m: any) => m.id === modelId);
    if (model) {
      return model.context_length || model.top_provider?.context_length || 200000;
    }
  }

  // 2. Try to fetch from OpenRouter API
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (response.ok) {
      const data: any = await response.json();
      _cachedOpenRouterModels = data.data;

      const model = _cachedOpenRouterModels?.find((m: any) => m.id === modelId);
      if (model) {
        return model.context_length || model.top_provider?.context_length || 200000;
      }
    }
  } catch (error) {
    // Silent fail on network error - will use fallback
  }

  // 3. Fallback to recommended-models.json
  try {
    const data = loadRecommendedModelsJSON();
    const model = data.models.find((m) => m.id === modelId);
    if (model && model.context) {
      // Parse "200K" -> 200000, "1M" -> 1000000
      const ctxStr = model.context.toUpperCase();
      if (ctxStr.includes("K")) {
        return parseFloat(ctxStr.replace("K", "")) * 1000;
      }
      if (ctxStr.includes("M")) {
        return parseFloat(ctxStr.replace("M", "")) * 1000000;
      }
      const val = parseInt(ctxStr);
      if (!isNaN(val)) return val;
    }
  } catch (e) {
    // Ignore errors, use default
  }

  // 4. Default fallback
  return 200000;
}

/**
 * Check if a model supports reasoning capabilities based on OpenRouter metadata
 * @param modelId The full OpenRouter model ID
 * @returns True if model supports reasoning/thinking
 */
export async function doesModelSupportReasoning(modelId: string): Promise<boolean> {
  // Ensure cache is populated
  if (!_cachedOpenRouterModels) {
    await fetchModelContextWindow(modelId); // This side-effect populates the cache
  }

  if (_cachedOpenRouterModels) {
    const model = _cachedOpenRouterModels.find((m: any) => m.id === modelId);
    if (model && model.supported_parameters) {
      return (
        model.supported_parameters.includes("include_reasoning") ||
        model.supported_parameters.includes("reasoning") ||
        // Fallback for models we know support it but metadata might lag
        model.id.includes("o1") ||
        model.id.includes("o3") ||
        model.id.includes("r1")
      );
    }
  }

  // Default to false if no metadata available (safe default)
  return false;
}

/**
 * LiteLLM model structure from /public/model_hub API
 */
interface LiteLLMModel {
  model_group: string;
  providers: string[];
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  supports_function_calling?: boolean;
  mode?: string;
}

/**
 * Cache structure for LiteLLM models
 */
interface LiteLLMCache {
  timestamp: string;
  models: any[];
}

const LITELLM_CACHE_MAX_AGE_HOURS = 24;

/**
 * Fetch models from LiteLLM instance with caching
 * @param baseUrl LiteLLM instance base URL
 * @param apiKey LiteLLM API key
 * @returns Array of transformed models compatible with model selector
 */
export async function fetchLiteLLMModels(baseUrl: string, apiKey: string): Promise<any[]> {
  // Create cache key from baseUrl hash
  const hash = createHash('sha256').update(baseUrl).digest('hex').substring(0, 16);
  const cacheDir = join(homedir(), ".claudish");
  const cachePath = join(cacheDir, `litellm-models-${hash}.json`);

  // Check cache
  if (existsSync(cachePath)) {
    try {
      const cacheData: LiteLLMCache = JSON.parse(readFileSync(cachePath, "utf-8"));
      const timestamp = new Date(cacheData.timestamp);
      const now = new Date();
      const ageInHours = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);

      if (ageInHours < LITELLM_CACHE_MAX_AGE_HOURS) {
        return cacheData.models;
      }
    } catch {
      // Cache read error, will fetch fresh data
    }
  }

  // Fetch from LiteLLM API
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/model_group/info`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error(`Failed to fetch LiteLLM models: ${response.status} ${response.statusText}`);
      // Return cached data if available, even if stale
      if (existsSync(cachePath)) {
        try {
          const cacheData: LiteLLMCache = JSON.parse(readFileSync(cachePath, "utf-8"));
          return cacheData.models;
        } catch {
          return [];
        }
      }
      return [];
    }

    const responseData = await response.json();
    const rawModels: LiteLLMModel[] = responseData.data || responseData;

    // Transform to model selector format
    const transformedModels = rawModels
      .filter((m) => m.mode === "chat" && m.supports_function_calling) // Only chat models with tool support
      .map((m) => {
        const inputCostPerM = (m.input_cost_per_token || 0) * 1_000_000;
        const outputCostPerM = (m.output_cost_per_token || 0) * 1_000_000;
        const avgCost = (inputCostPerM + outputCostPerM) / 2;
        const isFree = inputCostPerM === 0 && outputCostPerM === 0;

        const contextLength = m.max_input_tokens || 128000;
        const contextStr =
          contextLength >= 1000000
            ? `${Math.round(contextLength / 1000000)}M`
            : `${Math.round(contextLength / 1000)}K`;

        return {
          id: `litellm@${m.model_group}`,
          name: m.model_group,
          description: `LiteLLM model (providers: ${m.providers.join(", ")})`,
          provider: "LiteLLM",
          pricing: {
            input: isFree ? "FREE" : `$${inputCostPerM.toFixed(2)}`,
            output: isFree ? "FREE" : `$${outputCostPerM.toFixed(2)}`,
            average: isFree ? "FREE" : `$${avgCost.toFixed(2)}/1M`,
          },
          context: contextStr,
          contextLength,
          supportsTools: m.supports_function_calling || false,
          supportsReasoning: m.supports_reasoning || false,
          supportsVision: m.supports_vision || false,
          isFree,
          source: "LiteLLM" as const,
        };
      });

    // Cache results - ensure directory exists
    mkdirSync(cacheDir, { recursive: true });
    const cacheData: LiteLLMCache = {
      timestamp: new Date().toISOString(),
      models: transformedModels,
    };
    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");

    return transformedModels;
  } catch (error) {
    console.error(`Failed to fetch LiteLLM models: ${error}`);
    // Return cached data if available, even if stale
    if (existsSync(cachePath)) {
      try {
        const cacheData: LiteLLMCache = JSON.parse(readFileSync(cachePath, "utf-8"));
        return cacheData.models;
      } catch {
        return [];
      }
    }
    return [];
  }
}
