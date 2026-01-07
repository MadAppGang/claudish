/**
 * Model Selector with Fuzzy Search
 *
 * Uses @inquirer/search for fuzzy search model selection
 */

import { search, select, input, confirm } from "@inquirer/prompts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenRouterModel } from "./types.js";
import { getAvailableModels } from "./model-loader.js";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache paths
const ALL_MODELS_JSON_PATH = join(__dirname, "../all-models.json");
const RECOMMENDED_MODELS_JSON_PATH = join(__dirname, "../recommended-models.json");
const CACHE_MAX_AGE_DAYS = 2;

/**
 * Model data structure
 */
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  provider: string;
  pricing?: {
    input: string;
    output: string;
    average: string;
  };
  context?: string;
  contextLength?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  isFree?: boolean;
}

/**
 * Trusted providers for free models
 */
const TRUSTED_FREE_PROVIDERS = [
  "google",
  "openai",
  "x-ai",
  "deepseek",
  "qwen",
  "alibaba",
  "meta-llama",
  "microsoft",
  "mistralai",
  "nvidia",
  "cohere",
];

/**
 * Load recommended models from JSON
 */
function loadRecommendedModels(): ModelInfo[] {
  if (existsSync(RECOMMENDED_MODELS_JSON_PATH)) {
    try {
      const content = readFileSync(RECOMMENDED_MODELS_JSON_PATH, "utf-8");
      const data = JSON.parse(content);
      return data.models || [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Fetch all models from OpenRouter API
 */
async function fetchAllModels(forceUpdate = false): Promise<any[]> {
  // Check cache
  if (!forceUpdate && existsSync(ALL_MODELS_JSON_PATH)) {
    try {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_JSON_PATH, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const now = new Date();
      const ageInDays = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        return cacheData.models;
      }
    } catch {
      // Cache error, will fetch
    }
  }

  // Fetch from API
  console.log("Fetching models from OpenRouter...");
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`API returned ${response.status}`);

    const data = await response.json();
    const models = data.data;

    // Cache result
    writeFileSync(
      ALL_MODELS_JSON_PATH,
      JSON.stringify({
        lastUpdated: new Date().toISOString(),
        models,
      }),
      "utf-8"
    );

    console.log(`Cached ${models.length} models`);
    return models;
  } catch (error) {
    console.error(`Failed to fetch models: ${error}`);
    return [];
  }
}

/**
 * Convert raw OpenRouter model to ModelInfo
 */
function toModelInfo(model: any): ModelInfo {
  const provider = model.id.split("/")[0];
  const contextLen = model.context_length || model.top_provider?.context_length || 0;
  const promptPrice = parseFloat(model.pricing?.prompt || "0");
  const completionPrice = parseFloat(model.pricing?.completion || "0");
  const isFree = promptPrice === 0 && completionPrice === 0;

  // Format pricing
  let pricingStr = "N/A";
  if (isFree) {
    pricingStr = "FREE";
  } else if (model.pricing) {
    const avgPrice = (promptPrice + completionPrice) / 2;
    if (avgPrice < 0.001) {
      pricingStr = `$${(avgPrice * 1000000).toFixed(2)}/1M`;
    } else {
      pricingStr = `$${avgPrice.toFixed(4)}/1K`;
    }
  }

  return {
    id: model.id,
    name: model.name || model.id,
    description: model.description || "",
    provider: provider.charAt(0).toUpperCase() + provider.slice(1),
    pricing: {
      input: model.pricing?.prompt || "N/A",
      output: model.pricing?.completion || "N/A",
      average: pricingStr,
    },
    context: contextLen > 0 ? `${Math.round(contextLen / 1000)}K` : "N/A",
    contextLength: contextLen,
    supportsTools: (model.supported_parameters || []).includes("tools"),
    supportsReasoning: (model.supported_parameters || []).includes("reasoning"),
    supportsVision: (model.architecture?.input_modalities || []).includes("image"),
    isFree,
  };
}

/**
 * Get free models from cache/API
 */
async function getFreeModels(): Promise<ModelInfo[]> {
  const allModels = await fetchAllModels();

  // Filter for FREE models from TRUSTED providers
  const freeModels = allModels.filter((model) => {
    const promptPrice = parseFloat(model.pricing?.prompt || "0");
    const completionPrice = parseFloat(model.pricing?.completion || "0");
    const isFree = promptPrice === 0 && completionPrice === 0;

    if (!isFree) return false;

    const provider = model.id.split("/")[0].toLowerCase();
    return TRUSTED_FREE_PROVIDERS.includes(provider);
  });

  // Sort by context window (largest first)
  freeModels.sort((a, b) => {
    const contextA = a.context_length || a.top_provider?.context_length || 0;
    const contextB = b.context_length || b.top_provider?.context_length || 0;
    return contextB - contextA;
  });

  // Dedupe: prefer non-:free variant
  const seenBase = new Set<string>();
  const dedupedModels = freeModels.filter((model) => {
    const baseId = model.id.replace(/:free$/, "");
    if (seenBase.has(baseId)) return false;
    seenBase.add(baseId);
    return true;
  });

  return dedupedModels.slice(0, 20).map(toModelInfo);
}

/**
 * Get all models for search
 */
async function getAllModelsForSearch(): Promise<ModelInfo[]> {
  const allModels = await fetchAllModels();
  return allModels.map(toModelInfo);
}

/**
 * Format model for display in selector
 */
function formatModelChoice(model: ModelInfo): string {
  const caps = [
    model.supportsTools ? "T" : "",
    model.supportsReasoning ? "R" : "",
    model.supportsVision ? "V" : "",
  ]
    .filter(Boolean)
    .join("");

  const capsStr = caps ? ` [${caps}]` : "";
  const priceStr = model.pricing?.average || "N/A";
  const ctxStr = model.context || "N/A";

  return `${model.id} (${model.provider}, ${priceStr}, ${ctxStr}${capsStr})`;
}

/**
 * Fuzzy match score
 */
function fuzzyMatch(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Exact match
  if (lowerText === lowerQuery) return 1;

  // Contains match
  if (lowerText.includes(lowerQuery)) return 0.8;

  // Fuzzy character match
  let queryIdx = 0;
  let score = 0;
  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      score++;
      queryIdx++;
    }
  }

  return queryIdx === lowerQuery.length ? (score / lowerQuery.length) * 0.6 : 0;
}

export interface ModelSelectorOptions {
  freeOnly?: boolean;
  recommended?: boolean;
  message?: string;
}

/**
 * Select a model interactively with fuzzy search
 */
export async function selectModel(options: ModelSelectorOptions = {}): Promise<string> {
  const { freeOnly = false, recommended = true, message } = options;

  let models: ModelInfo[];

  if (freeOnly) {
    models = await getFreeModels();
    if (models.length === 0) {
      throw new Error("No free models available");
    }
  } else if (recommended) {
    // Load recommended models first
    const recommendedModels = loadRecommendedModels();
    if (recommendedModels.length > 0) {
      models = recommendedModels;
    } else {
      // Fall back to fetching
      const allModels = await getAllModelsForSearch();
      models = allModels.slice(0, 20);
    }
  } else {
    models = await getAllModelsForSearch();
  }

  const promptMessage =
    message ||
    (freeOnly ? "Select a FREE model (type to search):" : "Select a model (type to search):");

  const selected = await search<string>({
    message: promptMessage,
    source: async (term) => {
      if (!term) {
        // Show all/top models when no search term
        return models.slice(0, 15).map((m) => ({
          name: formatModelChoice(m),
          value: m.id,
          description: m.description?.slice(0, 80),
        }));
      }

      // Fuzzy search
      const results = models
        .map((m) => ({
          model: m,
          score: Math.max(
            fuzzyMatch(m.id, term),
            fuzzyMatch(m.name, term),
            fuzzyMatch(m.provider, term) * 0.5
          ),
        }))
        .filter((r) => r.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);

      return results.map((r) => ({
        name: formatModelChoice(r.model),
        value: r.model.id,
        description: r.model.description?.slice(0, 80),
      }));
    },
  });

  return selected;
}

/**
 * Select multiple models for profile setup
 */
export async function selectModelsForProfile(): Promise<{
  opus?: string;
  sonnet?: string;
  haiku?: string;
  subagent?: string;
}> {
  const allModels = await getAllModelsForSearch();

  console.log("\nConfigure models for each Claude tier:\n");

  // Helper to select a model for a tier
  const selectForTier = async (tier: string, description: string): Promise<string | undefined> => {
    const useCustom = await confirm({
      message: `Configure ${tier} model? (${description})`,
      default: true,
    });

    if (!useCustom) return undefined;

    return search<string>({
      message: `Select model for ${tier}:`,
      source: async (term) => {
        let filtered = allModels;

        if (term) {
          filtered = allModels
            .map((m) => ({
              model: m,
              score: Math.max(
                fuzzyMatch(m.id, term),
                fuzzyMatch(m.name, term),
                fuzzyMatch(m.provider, term) * 0.5
              ),
            }))
            .filter((r) => r.score > 0.1)
            .sort((a, b) => b.score - a.score)
            .slice(0, 15)
            .map((r) => r.model);
        } else {
          filtered = filtered.slice(0, 15);
        }

        return filtered.map((m) => ({
          name: formatModelChoice(m),
          value: m.id,
          description: m.description?.slice(0, 80),
        }));
      },
    });
  };

  const opus = await selectForTier("Opus", "Most capable, used for complex reasoning");
  const sonnet = await selectForTier("Sonnet", "Balanced, used for general tasks");
  const haiku = await selectForTier("Haiku", "Fast & cheap, used for simple tasks");
  const subagent = await selectForTier("Subagent", "Used for spawned sub-agents");

  return { opus, sonnet, haiku, subagent };
}

/**
 * Prompt for API key
 */
export async function promptForApiKey(): Promise<string> {
  console.log("\nOpenRouter API Key Required");
  console.log("Get your free API key from: https://openrouter.ai/keys\n");

  const apiKey = await input({
    message: "Enter your OpenRouter API key:",
    validate: (value) => {
      if (!value.trim()) {
        return "API key cannot be empty";
      }
      if (!value.startsWith("sk-or-")) {
        return 'API key should start with "sk-or-"';
      }
      return true;
    },
  });

  return apiKey;
}

/**
 * Prompt for profile name
 */
export async function promptForProfileName(existing: string[] = []): Promise<string> {
  const name = await input({
    message: "Enter profile name:",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Profile name cannot be empty";
      }
      if (!/^[a-z0-9-_]+$/i.test(trimmed)) {
        return "Profile name can only contain letters, numbers, hyphens, and underscores";
      }
      if (existing.includes(trimmed)) {
        return `Profile "${trimmed}" already exists`;
      }
      return true;
    },
  });

  return name.trim();
}

/**
 * Prompt for profile description
 */
export async function promptForProfileDescription(): Promise<string> {
  const description = await input({
    message: "Enter profile description (optional):",
  });

  return description.trim();
}

/**
 * Select from existing profiles
 */
export async function selectProfile(
  profiles: { name: string; description?: string; isDefault?: boolean }[]
): Promise<string> {
  const selected = await select({
    message: "Select a profile:",
    choices: profiles.map((p) => ({
      name: p.isDefault ? `${p.name} (default)` : p.name,
      value: p.name,
      description: p.description,
    })),
  });

  return selected;
}

/**
 * Confirm action
 */
export async function confirmAction(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}
