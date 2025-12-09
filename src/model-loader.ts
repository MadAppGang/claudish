import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenRouterModel, RecommendedModel, UnifiedModel } from "./types.js";
import { OPENROUTER_MODELS } from "./types.js";
import { PoeProvider, selectTopPoeModels } from "./providers/poe-provider.js";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// User preferences cache
const _cachedUserModels: UserModelPreferences | null = null;

interface UserModelData {
  id: string;
  name: string;
  description: string;
  provider: string;
  category?: string;
  priority: number;
  custom: boolean;
}

interface UserModelPreferences {
  customModels: UserModelData[];
  lastUpdated: string;
  version: string;
}

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

/**
 * Load model metadata from recommended-models.json if available,
 * otherwise fall back to build-time generated config
 */
export function loadModelInfo(): Record<OpenRouterModel, ModelMetadata> {
  // Return cached data if available
  if (_cachedModelInfo) {
    return _cachedModelInfo as Record<OpenRouterModel, ModelMetadata>;
  }

  const jsonPath = join(__dirname, "../recommended-models.json");

  // Try to load from JSON first (runtime, latest)
  if (existsSync(jsonPath)) {
    try {
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const data: RecommendedModelsJSON = JSON.parse(jsonContent);

      const modelInfo: Record<string, ModelMetadata> = {};

      // Convert JSON models to MODEL_INFO format
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
    } catch (error) {
      console.warn("⚠️  Failed to load recommended-models.json, falling back to build-time config");
      console.warn(`   Error: ${error}`);
    }
  }

  // Fallback to build-time generated config
  const { MODEL_INFO } = require("./config.js");
  _cachedModelInfo = MODEL_INFO;
  return MODEL_INFO;
}

/**
 * Get list of available model IDs from recommended-models.json if available
 */
export function getAvailableModels(): OpenRouterModel[] {
  // Return cached data if available
  if (_cachedModelIds) {
    return _cachedModelIds as OpenRouterModel[];
  }

  const jsonPath = join(__dirname, "../recommended-models.json");

  // Try to load from JSON first
  if (existsSync(jsonPath)) {
    try {
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const data: RecommendedModelsJSON = JSON.parse(jsonContent);

      // Extract model IDs sorted by priority
      if (!data.models || !Array.isArray(data.models)) {
        throw new Error("Invalid models data structure");
      }
      const modelIds = data.models.sort((a, b) => a.priority - b.priority).map((m) => m.id);

      const result = [...modelIds, "custom"];
      _cachedModelIds = result;
      return result as OpenRouterModel[];
    } catch (error) {
      console.warn("⚠️  Failed to load model list from JSON, falling back to build-time config");
    }
  }

  // Fallback to build-time generated config
  _cachedModelIds = [...OPENROUTER_MODELS];
  return [...OPENROUTER_MODELS];
}

// Cache for OpenRouter API response
let _cachedOpenRouterModels: any[] | null = null;

/**
 * Fetch exact context window size from OpenRouter API
 * @param modelId The full OpenRouter model ID (e.g. "anthropic/claude-3-sonnet")
 * @returns Context window size in tokens (default: 128000)
 */
export async function fetchModelContextWindow(modelId: string): Promise<number> {
  // 1. Use cached API data if available
  if (_cachedOpenRouterModels) {
    const model = _cachedOpenRouterModels.find((m: any) => m.id === modelId);
    if (model) {
      return model.context_length || model.top_provider?.context_length || 128000;
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
        return model.context_length || model.top_provider?.context_length || 128000;
      }
    }
  } catch (error) {
    // Silent fail on network error - will assume default
  }

  // 3. Fallback to recommended-models.json cache
  try {
    const modelMetadata = loadModelInfo();
    // modelMetadata uses our internal structure, logic ...
    // Wait, recommended-models.json doesn't store context as number but as string "200K"
    // We need to parse it if we rely on it.
    // But loadModelInfo returns ModelMetadata which might not have context field (it has name, description, etc).
    // Let's check RecommendedModelsJSON interface.
  } catch (e) {}

  // Let's re-read the file to parse context string
  const jsonPath = join(__dirname, "../recommended-models.json");
  if (existsSync(jsonPath)) {
    try {
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const data: RecommendedModelsJSON = JSON.parse(jsonContent);
      const model = data.models.find((m) => m.id === modelId);
      if (model?.context) {
        // Parse "200K" -> 200000, "1M" -> 1000000
        const ctxStr = model.context.toUpperCase();
        if (ctxStr.includes("K")) return Number.parseFloat(ctxStr.replace("K", "")) * 1024; // Usually 1K=1000 or 1024? OpenRouter uses 1000 often but binary is standard. Let's use 1000 for simplicity or 1024.
        // Actually, standard is usually 1000 for LLM context "200k" = 200,000.
        if (ctxStr.includes("M")) return Number.parseFloat(ctxStr.replace("M", "")) * 1000000;
        const val = Number.parseInt(ctxStr);
        if (!Number.isNaN(val)) return val;
      }
    } catch (e) {}
  }

  // 4. Absolute fallback
  return 200000; // 200k is a reasonable modern default (Claude Sonnet/Opus)
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
    if (model?.supported_parameters) {
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

// Multi-provider model loading functions

/**
 * Get top models from multiple providers
 */
export async function getMultiProviderModels(): Promise<{openrouter: RecommendedModel[], poe: RecommendedModel[]}> {
  try {
    // Load OpenRouter models (existing logic)
    const openrouterModels = await getOpenRouterTopModels();

    // Load Poe models (new selection logic)
    const poeModels = await getPoeTopModels();

    return {
      openrouter: openrouterModels,
      poe: poeModels
    };
  } catch (error) {
    console.error('❌ Error loading multi-provider models:', error);
    // Fallback to empty arrays
    return { openrouter: [], poe: [] };
  }
}

/**
 * Get top OpenRouter models as RecommendedModel[]
 */
async function getOpenRouterTopModels(): Promise<RecommendedModel[]> {
  const modelInfo = loadModelInfo();
  const availableModels = getAvailableModels();

  // Get recommended models (excluding custom)
  const recommendedModels = availableModels
    .filter(modelId => modelId !== 'custom')
    .slice(0, 10) // Limit to top 10
    .map((modelId, index) => {
      const info = modelInfo[modelId];
      if (!info) return null;

      return {
        id: modelId,
        name: info.name,
        description: info.description,
        provider: 'openrouter',
        context_length: 200000, // Default, will be updated if available
        pricing: {
          prompt: '$1.00/1M', // Default pricing
          completion: '$3.00/1M'
        },
        providerSection: 'openrouter',
        sectionPriority: index + 1,
        globalPriority: index + 1,
        supportsTools: true, // Default assumptions
        supportsReasoning: false,
        supportsVision: false,
        priority: info.priority
      } as RecommendedModel;
    })
    .filter(Boolean) as RecommendedModel[];

  // Try to enhance with actual pricing and context info if available
  await enrichOpenRouterModels(recommendedModels);

  return recommendedModels;
}

/**
 * Get top Poe models as RecommendedModel[]
 */
async function getPoeTopModels(): Promise<RecommendedModel[]> {
  try {
    const poeProvider = new PoeProvider();
    const allPoeModels = await poeProvider.fetchModels();

    // Select top models using our smart selection
    const topPoeModels = selectTopPoeModels(allPoeModels, 10);

    // Convert to RecommendedModel format
    return topPoeModels.map((model, index) => ({
      ...model,
      providerSection: 'poe',
      sectionPriority: index + 1,
      globalPriority: 100 + index, // Start after OpenRouter
      supportsTools: true, // Poe models generally support tools
      supportsReasoning: model.id.includes('o1') || model.id.includes('o3') || model.id.includes('reasoning'),
      supportsVision: model.id.includes('vision') || model.id.includes('image') || model.id.includes('multimodal')
    } as RecommendedModel));

  } catch (error) {
    console.error('❌ Error fetching Poe models:', error);
    return [];
  }
}

/**
 * Enrich OpenRouter models with real pricing and context data
 */
async function enrichOpenRouterModels(models: RecommendedModel[]): Promise<void> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (response.ok) {
      const data = await response.json();

      for (const model of models) {
        const openRouterModel = data.data?.find((m: any) => m.id === model.id);
        if (openRouterModel) {
          model.context_length = openRouterModel.context_length || model.context_length;
          model.pricing = {
            prompt: openRouterModel.pricing?.prompt || model.pricing.prompt,
            completion: openRouterModel.pricing?.completion || model.pricing.completion
          };
          model.supportsVision = openRouterModel.architecture?.modality === 'multimodal' ||
                                openRouterModel.architecture?.modality?.includes('image');
          model.supportsReasoning = openRouterModel.top_provider?.supports_reasoning ||
                                   model.id.includes('o1') || model.id.includes('o3') || model.id.includes('reasoning');
        }
      }
    }
  } catch (error) {
    console.warn('⚠️  Could not enrich OpenRouter models with latest data');
  }
}
