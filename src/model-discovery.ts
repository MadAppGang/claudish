import { ModelInfo } from "./types.js";

/**
 * Smart multi-source model discovery system that works with any combination of API keys
 * Provides graceful fallbacks and clear availability indicators
 */

export interface ApiKeyStatus {
  openrouter: boolean;
  poe: boolean;
  none: boolean;
}

export interface ModelCategories {
  available: ModelInfo[];
  needsOpenRouter: ModelInfo[];
  needsPoe: ModelInfo[];
}

/**
 * Check which API keys are available in the environment
 */
export function getAvailableApiKeys(): ApiKeyStatus {
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const hasPoe = !!process.env.POE_API_KEY;
  const hasNone = !hasOpenRouter && !hasPoe;

  return {
    openrouter: hasOpenRouter,
    poe: hasPoe,
    none: hasNone
  };
}

/**
 * Get models that the user can actually access based on available API keys
 */
export async function getAccessibleModelsForUser(): Promise<ModelInfo[]> {
  // Import dynamically to avoid circular dependencies
  const { getAllModelsForSearch } = await import("./model-selector.js");

  const keys = getAvailableApiKeys();
  const allModels = await getAllModelsForSearch();

  return allModels.filter(model => {
    if (model.id.startsWith("poe/")) {
      return keys.poe;
    }
    return keys.openrouter;
  });
}

/**
 * Categorize models by what the user needs to access them
 */
export function categorizeModelsByAccess(models: ModelInfo[]): ModelCategories {
  const keys = getAvailableApiKeys();

  return {
    available: models.filter(model => {
      if (model.id.startsWith("poe/")) {
        return keys.poe;
      }
      return keys.openrouter;
    }),
    needsOpenRouter: models.filter(model =>
      !model.id.startsWith("poe/") && !keys.openrouter
    ),
    needsPoe: models.filter(model =>
      model.id.startsWith("poe/") && !keys.poe
    )
  };
}

/**
 * Get a human-readable description of available API keys
 */
export function getApiKeyDescription(): string {
  const keys = getAvailableApiKeys();

  if (keys.openrouter && keys.poe) {
    return "Both OpenRouter and Poe API keys available";
  } else if (keys.openrouter) {
    return "OpenRouter API key available";
  } else if (keys.poe) {
    return "Poe API key available";
  } else {
    return "No API keys configured";
  }
}

/**
 * Print setup guidance for missing API keys
 */
export function printSetupGuidance(): void {
  const keys = getAvailableApiKeys();

  console.log("\n💡 Setup Tips:");

  if (!keys.openrouter && !keys.poe) {
    console.log("   Set up API keys to access more models:");
    console.log("   📡 OpenRouter: export OPENROUTER_API_KEY='your-key'");
    console.log("   🟣 Poe: export POE_API_KEY='your-key'");
  } else if (!keys.openrouter) {
    console.log("   Add OpenRouter for more models:");
    console.log("   📡 OpenRouter: export OPENROUTER_API_KEY='your-key'");
  } else if (!keys.poe) {
    console.log("   Add Poe for exclusive models:");
    console.log("   🟣 Poe: export POE_API_KEY='your-key'");
  }

  console.log("   🔗 Get keys at: openrouter.ai and poe.com");
}

/**
 * Filter models by search query with fuzzy matching
 */
export function filterModelsByQuery(models: ModelInfo[], query: string): ModelInfo[] {
  if (!query.trim()) {
    return models;
  }

  const lowerQuery = query.toLowerCase();
  const searchTerms = lowerQuery.split(/\s+/).filter(term => term.length > 0);

  return models.filter(model => {
    const searchText = `${model.id} ${model.name} ${model.description || ""} ${model.provider || ""}`.toLowerCase();

    // All search terms must be present
    return searchTerms.every(term => searchText.includes(term));
  });
}