/**
 * Model Selector with Fuzzy Search
 *
 * Uses @inquirer/search for fuzzy search model selection
 */

import { search, select, input, confirm } from "@inquirer/prompts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { OpenRouterModel } from "./types.js";
import { getAvailableModels, fetchLiteLLMModels } from "./model-loader.js";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache paths - use ~/.claudish/ for writable cache (binaries can't write to __dirname)
const CLAUDISH_CACHE_DIR = join(homedir(), ".claudish");
const ALL_MODELS_JSON_PATH = join(CLAUDISH_CACHE_DIR, "all-models.json");
const RECOMMENDED_MODELS_JSON_PATH = join(__dirname, "../recommended-models.json");
const CACHE_MAX_AGE_DAYS = 2;
const FREE_MODELS_CACHE_MAX_AGE_HOURS = 3; // Free models change frequently, refresh every 3 hours

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
  source?: "OpenRouter" | "Zen" | "xAI" | "Gemini" | "OpenAI" | "GLM" | "GLM Coding" | "OllamaCloud" | "LiteLLM"; // Which platform the model is from
}

// OpenRouter free models are routed with openrouter@ prefix for explicit routing

/**
 * Load recommended models from JSON
 * Adds openrouter@ prefix for explicit routing
 */
function loadRecommendedModels(): ModelInfo[] {
  if (existsSync(RECOMMENDED_MODELS_JSON_PATH)) {
    try {
      const content = readFileSync(RECOMMENDED_MODELS_JSON_PATH, "utf-8");
      const data = JSON.parse(content);
      // Add openrouter@ prefix to all recommended models for explicit routing
      return (data.models || []).map((model: ModelInfo) => ({
        ...model,
        id: model.id.startsWith("openrouter@") ? model.id : `openrouter@${model.id}`,
        source: "OpenRouter" as const,
      }));
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

    // Cache result - ensure directory exists
    mkdirSync(CLAUDISH_CACHE_DIR, { recursive: true });
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
    // Add openrouter@ prefix for explicit routing
    id: `openrouter@${model.id}`,
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
    source: "OpenRouter",
  };
}

/**
 * Fetch free models from OpenCode Zen
 */
async function fetchZenFreeModels(): Promise<ModelInfo[]> {
  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const opencode = data.opencode;
    if (!opencode?.models) return [];

    // Get free models with tool support
    return Object.entries(opencode.models)
      .filter(([_, m]: [string, any]) => {
        const isFree = m.cost?.input === 0 && m.cost?.output === 0;
        const supportsTools = m.tool_call === true;
        return isFree && supportsTools;
      })
      .map(([id, m]: [string, any]) => {
        // Check vision support from modalities
        const inputModalities = m.modalities?.input || [];
        const supportsVision = inputModalities.includes("image") || inputModalities.includes("video");

        return {
          id: `zen@${id}`,
          name: m.name || id,
          description: `OpenCode Zen free model`,
          provider: "Zen",
          pricing: {
            input: "FREE",
            output: "FREE",
            average: "FREE",
          },
          context: m.limit?.context ? `${Math.round(m.limit.context / 1000)}K` : "128K",
          contextLength: m.limit?.context || 128000,
          supportsTools: true,
          supportsReasoning: m.reasoning || false,
          supportsVision,
          isFree: true,
          source: "Zen" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Get context window for xAI model (not returned by API, hardcoded from docs)
 */
function getXAIContextWindow(modelId: string): { context: string; contextLength: number } {
  const id = modelId.toLowerCase();
  if (id.includes("grok-4.1-fast") || id.includes("grok-4-1-fast")) {
    return { context: "2M", contextLength: 2000000 };
  }
  if (id.includes("grok-4-fast")) {
    return { context: "2M", contextLength: 2000000 };
  }
  if (id.includes("grok-code-fast")) {
    return { context: "256K", contextLength: 256000 };
  }
  if (id.includes("grok-4")) {
    return { context: "256K", contextLength: 256000 };
  }
  if (id.includes("grok-3")) {
    return { context: "131K", contextLength: 131072 };
  }
  if (id.includes("grok-2")) {
    return { context: "131K", contextLength: 131072 };
  }
  return { context: "131K", contextLength: 131072 }; // Default for older models
}

/**
 * Fetch models from xAI using /v1/language-models endpoint
 * This endpoint returns pricing info (but not context_length)
 */
async function fetchXAIModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const response = await fetch("https://api.x.ai/v1/language-models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    if (!data.models || !Array.isArray(data.models)) {
      return [];
    }

    return data.models
      .filter((model: any) => !model.id.includes("image") && !model.id.includes("imagine")) // Skip image models
      .map((model: any) => {
        // Pricing from API: prompt_text_token_price is in nano-dollars (10^-9) per token
        // Convert to $/1M tokens: price * 1M / 10^9 = price / 1000
        const inputPricePerM = (model.prompt_text_token_price || 0) / 1000;
        const outputPricePerM = (model.completion_text_token_price || 0) / 1000;
        const avgPrice = (inputPricePerM + outputPricePerM) / 2;

        const { context, contextLength } = getXAIContextWindow(model.id);
        const supportsVision = (model.input_modalities || []).includes("image");
        const supportsReasoning = model.id.includes("reasoning");

        return {
          id: `xai@${model.id}`,
          name: model.id,
          description: `xAI ${supportsReasoning ? "reasoning " : ""}model`,
          provider: "xAI",
          pricing: {
            input: `$${inputPricePerM.toFixed(2)}`,
            output: `$${outputPricePerM.toFixed(2)}`,
            average: `$${avgPrice.toFixed(2)}/1M`,
          },
          context,
          contextLength,
          supportsTools: true,
          supportsReasoning,
          supportsVision,
          isFree: false,
          source: "xAI" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fetch models from Google Gemini
 */
async function fetchGeminiModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    if (!data.models || !Array.isArray(data.models)) {
      return [];
    }

    // Filter for models that support generateContent
    return data.models
      .filter((model: any) => {
        const methods = model.supportedGenerationMethods || [];
        return methods.includes("generateContent");
      })
      .map((model: any) => {
        // Extract model name from "models/gemini-..." format
        const modelName = model.name.replace("models/", "");
        return {
          id: `google@${modelName}`,
          name: model.displayName || modelName,
          description: model.description || `Google Gemini model`,
          provider: "Gemini",
          pricing: {
            input: "$0.50",
            output: "$2.00",
            average: "$1.25/1M",
          },
          context: "128K",
          contextLength: 128000,
          supportsTools: true,
          supportsReasoning: false,
          supportsVision: true,
          isFree: false,
          source: "Gemini" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fetch models from OpenAI using models.dev API for accurate context windows and pricing
 */
async function fetchOpenAIModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const openaiData = data.openai;
    if (!openaiData?.models) return [];

    // Filter for chat models (GPT, o1, o3, chatgpt)
    return Object.entries(openaiData.models)
      .filter(([id, _]: [string, any]) => {
        const lowerId = id.toLowerCase();
        return (
          lowerId.startsWith("gpt-") ||
          lowerId.startsWith("o1-") ||
          lowerId.startsWith("o3-") ||
          lowerId.startsWith("o4-") ||
          lowerId.startsWith("chatgpt-")
        );
      })
      .map(([id, m]: [string, any]) => {
        // Calculate average price from input/output costs
        const inputCost = m.cost?.input || 2;
        const outputCost = m.cost?.output || 8;
        const avgCost = (inputCost + outputCost) / 2;

        // Get context window from models.dev data
        const contextLength = m.limit?.context || 128000;
        const contextStr =
          contextLength >= 1000000
            ? `${Math.round(contextLength / 1000000)}M`
            : `${Math.round(contextLength / 1000)}K`;

        // Check vision support from modalities
        const inputModalities = m.modalities?.input || [];
        const supportsVision =
          inputModalities.includes("image") || inputModalities.includes("video");

        return {
          id: `oai@${id}`,
          name: m.name || id,
          description: `OpenAI model`,
          provider: "OpenAI",
          pricing: {
            input: `$${inputCost.toFixed(2)}`,
            output: `$${outputCost.toFixed(2)}`,
            average: `$${avgCost.toFixed(2)}/1M`,
          },
          context: contextStr,
          contextLength,
          supportsTools: m.tool_call === true,
          supportsReasoning: m.reasoning === true,
          supportsVision,
          isFree: false,
          source: "OpenAI" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fetch GLM Coding Plan models from models.dev
 */
async function fetchGLMCodingModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.GLM_CODING_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const codingPlan = data["zai-coding-plan"];
    if (!codingPlan?.models) return [];

    return Object.entries(codingPlan.models)
      .filter(([_, m]: [string, any]) => m.tool_call === true)
      .map(([id, m]: [string, any]) => {
        const inputModalities = m.modalities?.input || [];
        const supportsVision = inputModalities.includes("image") || inputModalities.includes("video");
        const contextLength = m.limit?.context || 131072;

        return {
          id: `gc@${id}`,
          name: m.name || id,
          description: `GLM Coding Plan (subscription)`,
          provider: "GLM Coding",
          pricing: {
            input: "SUB",
            output: "SUB",
            average: "SUB",
          },
          context: contextLength >= 1000000
            ? `${Math.round(contextLength / 1000000)}M`
            : `${Math.round(contextLength / 1000)}K`,
          contextLength,
          supportsTools: true,
          supportsReasoning: m.reasoning || false,
          supportsVision,
          isFree: false,
          source: "GLM Coding" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fetch GLM/Zhipu direct API models from models.dev
 * Uses the zai-coding-plan data (same models, different API endpoint)
 * No API key needed to browse - models.dev is a public catalog
 */
async function fetchGLMDirectModels(): Promise<ModelInfo[]> {
  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const codingPlan = data["zai-coding-plan"];
    if (!codingPlan?.models) return [];

    return Object.entries(codingPlan.models)
      .filter(([_, m]: [string, any]) => m.tool_call === true)
      .map(([id, m]: [string, any]) => {
        const inputModalities = m.modalities?.input || [];
        const supportsVision = inputModalities.includes("image") || inputModalities.includes("video");
        const contextLength = m.limit?.context || 131072;
        const inputCost = m.cost?.input || 0;
        const outputCost = m.cost?.output || 0;
        const isFree = inputCost === 0 && outputCost === 0;

        return {
          id: `glm@${id}`,
          name: m.name || id,
          description: `GLM/Zhipu direct API`,
          provider: "GLM",
          pricing: {
            input: isFree ? "FREE" : `$${inputCost.toFixed(2)}`,
            output: isFree ? "FREE" : `$${outputCost.toFixed(2)}`,
            average: isFree ? "FREE" : `$${((inputCost + outputCost) / 2).toFixed(2)}/1M`,
          },
          context: contextLength >= 1000000
            ? `${Math.round(contextLength / 1000000)}M`
            : `${Math.round(contextLength / 1000)}K`,
          contextLength,
          supportsTools: true,
          supportsReasoning: m.reasoning || false,
          supportsVision,
          isFree,
          source: "GLM" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fetch OllamaCloud models from models.dev
 * Cloud-hosted models accessible with OLLAMA_API_KEY
 * No API key needed to browse - models.dev is a public catalog
 */
async function fetchOllamaCloudModels(): Promise<ModelInfo[]> {
  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const ollamaCloud = data["ollama-cloud"];
    if (!ollamaCloud?.models) return [];

    return Object.entries(ollamaCloud.models)
      .filter(([_, m]: [string, any]) => m.tool_call === true)
      .map(([id, m]: [string, any]) => {
        const inputModalities = m.modalities?.input || [];
        const supportsVision = inputModalities.includes("image") || inputModalities.includes("video");
        const contextLength = m.limit?.context || 131072;

        return {
          id: `oc@${id}`,
          name: m.name || id,
          description: `OllamaCloud`,
          provider: "OllamaCloud",
          pricing: {
            input: "N/A",
            output: "N/A",
            average: "N/A",
          },
          context: contextLength >= 1000000
            ? `${Math.round(contextLength / 1000000)}M`
            : `${Math.round(contextLength / 1000)}K`,
          contextLength,
          supportsTools: true,
          supportsReasoning: m.reasoning || false,
          supportsVision,
          source: "OllamaCloud" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Check if cache needs refresh for free models (more frequent updates)
 */
function shouldRefreshForFreeModels(): boolean {
  if (!existsSync(ALL_MODELS_JSON_PATH)) {
    return true;
  }
  try {
    const cacheData = JSON.parse(readFileSync(ALL_MODELS_JSON_PATH, "utf-8"));
    const lastUpdated = new Date(cacheData.lastUpdated);
    const now = new Date();
    const ageInHours = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60);
    return ageInHours > FREE_MODELS_CACHE_MAX_AGE_HOURS;
  } catch {
    return true;
  }
}

/**
 * Get free models from OpenRouter API + Zen
 * Uses 3-hour cache refresh for free models since they change frequently
 */
async function getFreeModels(): Promise<ModelInfo[]> {
  // Fetch OpenRouter models and Zen models in parallel
  const forceUpdate = shouldRefreshForFreeModels();
  const [allModels, zenModels] = await Promise.all([
    fetchAllModels(forceUpdate),
    fetchZenFreeModels(),
  ]);

  // Filter OpenRouter for FREE models with :free suffix and TOOL SUPPORT
  const openRouterFreeModels = allModels.filter((model) => {
    // Must have :free suffix (these are the actual free tier models)
    if (!model.id?.endsWith(":free")) return false;

    // Must support tool calling (required by Claude Code)
    const supportsTools = (model.supported_parameters || []).includes("tools");
    if (!supportsTools) return false;

    return true;
  });

  // Sort by context window (largest first)
  openRouterFreeModels.sort((a, b) => {
    const contextA = a.context_length || a.top_provider?.context_length || 0;
    const contextB = b.context_length || b.top_provider?.context_length || 0;
    return contextB - contextA;
  });

  // Convert to ModelInfo (adds openrouter@ prefix for explicit routing)
  const openRouterModels = openRouterFreeModels.slice(0, 20).map(toModelInfo);

  // Combine: Zen models first (most reliable), then OpenRouter
  const combined = [...zenModels, ...openRouterModels];

  // Sort: Zen first, then by context window
  combined.sort((a, b) => {
    if (a.source === "Zen" && b.source !== "Zen") return -1;
    if (a.source !== "Zen" && b.source === "Zen") return 1;
    return (b.contextLength || 0) - (a.contextLength || 0);
  });

  return combined;
}

/**
 * Get all models for search
 * Fetches from all available providers in parallel
 */
async function getAllModelsForSearch(forceUpdate = false): Promise<ModelInfo[]> {
  // Check for LiteLLM configuration
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const litellmApiKey = process.env.LITELLM_API_KEY;

  // Build named fetch entries for robust error handling
  const fetchEntries: Array<{ name: string; promise: Promise<ModelInfo[]> }> = [
    { name: "OpenRouter", promise: fetchAllModels(forceUpdate).then((models) => models.map(toModelInfo)) },
    { name: "xAI", promise: fetchXAIModels() },
    { name: "Gemini", promise: fetchGeminiModels() },
    { name: "OpenAI", promise: fetchOpenAIModels() },
    { name: "GLM", promise: fetchGLMDirectModels() },
    { name: "GLM Coding", promise: fetchGLMCodingModels() },
    { name: "OllamaCloud", promise: fetchOllamaCloudModels() },
    { name: "Zen", promise: fetchZenFreeModels() },
  ];

  // Add LiteLLM fetch if configured
  if (litellmBaseUrl && litellmApiKey) {
    fetchEntries.push({ name: "LiteLLM", promise: fetchLiteLLMModels(litellmBaseUrl, litellmApiKey, forceUpdate) });
  }

  // Use allSettled so one failing provider can't break the whole list
  const settled = await Promise.allSettled(fetchEntries.map((e) => e.promise));

  const fetchResults: Record<string, ModelInfo[]> = {};
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    fetchResults[fetchEntries[i].name] = result.status === "fulfilled" ? result.value : [];
  }

  // Combine results: Zen first (free), then OllamaCloud, then direct providers, then LiteLLM, then OpenRouter
  const directApiModels = [
    ...fetchResults["xAI"],
    ...fetchResults["Gemini"],
    ...fetchResults["OpenAI"],
    ...fetchResults["GLM"],
    ...fetchResults["GLM Coding"],
  ];
  const allModels = [
    ...fetchResults["Zen"],
    ...fetchResults["OllamaCloud"],
    ...directApiModels,
    ...(fetchResults["LiteLLM"] || []),
    ...fetchResults["OpenRouter"],
  ];

  return allModels;
}

/**
 * Format model for display in selector
 */
function formatModelChoice(model: ModelInfo, showSource = false): string {
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

  // Show source for free models list (OpenRouter vs Zen)
  if (showSource && model.source) {
    const sourceTagMap: Record<string, string> = {
      Zen: "Zen",
      OpenRouter: "OR",
      xAI: "xAI",
      Gemini: "Gem",
      OpenAI: "OAI",
      GLM: "GLM",
      "GLM Coding": "GC",
      OllamaCloud: "OC",
      LiteLLM: "LL",
    };
    const sourceTag = sourceTagMap[model.source] || model.source;
    return `${sourceTag} ${model.id} (${priceStr}, ${ctxStr}${capsStr})`;
  }

  return `${model.id} (${model.provider}, ${priceStr}, ${ctxStr}${capsStr})`;
}

/**
 * Provider filter aliases for @prefix search syntax
 * Maps user-typed aliases to the ModelInfo.source value
 */
const PROVIDER_FILTER_ALIASES: Record<string, string> = {
  // Full names
  zen: "Zen",
  openrouter: "OpenRouter",
  or: "OpenRouter",
  xai: "xAI",
  gemini: "Gemini",
  gem: "Gemini",
  google: "Gemini",
  openai: "OpenAI",
  oai: "OpenAI",
  glm: "GLM",
  "glm-coding": "GLM Coding",
  gc: "GLM Coding",
  ollamacloud: "OllamaCloud",
  oc: "OllamaCloud",
  litellm: "LiteLLM",
  ll: "LiteLLM",
};

/**
 * Parse search term for @provider filter prefix
 * Returns { provider: source string or null, searchTerm: remaining text }
 *
 * Examples:
 *   "@xai"        → { provider: "xAI", searchTerm: "" }
 *   "@xai grok"   → { provider: "xAI", searchTerm: "grok" }
 *   "@ll gemini"  → { provider: "LiteLLM", searchTerm: "gemini" }
 *   "grok"        → { provider: null, searchTerm: "grok" }
 */
function parseProviderFilter(term: string): { provider: string | null; searchTerm: string } {
  if (!term.startsWith("@")) {
    return { provider: null, searchTerm: term };
  }

  const withoutAt = term.slice(1);
  const spaceIdx = withoutAt.indexOf(" ");

  let prefix: string;
  let rest: string;
  if (spaceIdx === -1) {
    prefix = withoutAt;
    rest = "";
  } else {
    prefix = withoutAt.slice(0, spaceIdx);
    rest = withoutAt.slice(spaceIdx + 1).trim();
  }

  const source = PROVIDER_FILTER_ALIASES[prefix.toLowerCase()];
  if (source) {
    return { provider: source, searchTerm: rest };
  }

  // Partial match: find aliases that start with the typed prefix
  const partialMatch = Object.entries(PROVIDER_FILTER_ALIASES).find(([alias]) =>
    alias.startsWith(prefix.toLowerCase())
  );
  if (partialMatch) {
    return { provider: partialMatch[1], searchTerm: rest };
  }

  // No match — treat the whole thing as a regular search term
  return { provider: null, searchTerm: term };
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

  // Separator-normalized match: treat spaces, hyphens, dots, underscores as equivalent
  // This lets "glm 5" match "glm-5", "gpt4o" match "gpt-4o", etc.
  const normSep = (s: string) => s.replace(/[\s\-_.]/g, "");
  const tn = normSep(lowerText);
  const qn = normSep(lowerQuery);
  if (tn === qn) return 0.95;
  if (tn.includes(qn)) return 0.75;

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
  forceUpdate?: boolean;
}

/**
 * Select a model interactively with fuzzy search
 */
export async function selectModel(options: ModelSelectorOptions = {}): Promise<string> {
  const { freeOnly = false, recommended = true, message, forceUpdate = false } = options;

  let models: ModelInfo[];

  if (freeOnly) {
    models = await getFreeModels();
    if (models.length === 0) {
      throw new Error("No free models available");
    }
  } else {
    // Fetch all models from all providers (Zen, xAI, Gemini, OpenAI, OpenRouter)
    const [allModels, recommendedModels] = await Promise.all([
      getAllModelsForSearch(forceUpdate),
      Promise.resolve(recommended ? loadRecommendedModels() : []),
    ]);

    // Build prioritized list: Zen (free) -> Recommended -> All others
    const seenIds = new Set<string>();
    models = [];

    // 1. Add Zen models first (they're free)
    for (const m of allModels.filter((m) => m.source === "Zen")) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        models.push(m);
      }
    }

    // 2. Add recommended models
    for (const m of recommendedModels) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        models.push(m);
      }
    }

    // 3. Add direct API models (xAI, Gemini, OpenAI, LiteLLM) - user has keys for these
    for (const m of allModels.filter((m) => m.source && m.source !== "Zen" && m.source !== "OpenRouter")) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        models.push(m);
      }
    }

    // 4. Add remaining OpenRouter models
    for (const m of allModels.filter((m) => m.source === "OpenRouter")) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        models.push(m);
      }
    }
  }

  // Build provider filter choices from actually loaded models
  const providerCounts = new Map<string, number>();
  for (const m of models) {
    if (m.source) {
      providerCounts.set(m.source, (providerCounts.get(m.source) || 0) + 1);
    }
  }

  // Provider selection step (skip if freeOnly or custom message — those are special flows)
  let filteredModels = models;
  if (!freeOnly && !message && providerCounts.size > 1) {
    const providerChoices = [
      { name: `All providers (${models.length} models)`, value: "__all__" },
      ...Array.from(providerCounts.entries())
        .sort((a, b) => b[1] - a[1]) // Sort by model count descending
        .map(([source, count]) => ({
          name: `${source} (${count})`,
          value: source,
        })),
    ];

    const selectedProvider = await select({
      message: "Filter by provider:",
      choices: providerChoices,
    });

    if (selectedProvider !== "__all__") {
      filteredModels = models.filter((m) => m.source === selectedProvider);
    }
  }

  const promptMessage =
    message ||
    (freeOnly
      ? "Select a FREE model:"
      : "Select a model (type to search):");

  const selected = await search<string>({
    message: promptMessage,
    pageSize: 20, // Show more models in the list
    source: async (term) => {
      if (!term) {
        // Show all/top models when no search term (up to 30)
        return filteredModels.slice(0, 30).map((m) => ({
          name: formatModelChoice(m, true), // Always show source
          value: m.id,
          description: m.description?.slice(0, 80),
        }));
      }

      // Also support @provider prefix as power-user shortcut
      const { provider: filterProvider, searchTerm } = parseProviderFilter(term);

      let pool = filteredModels;
      if (filterProvider) {
        pool = models.filter((m) => m.source === filterProvider);
      }

      if (!searchTerm) {
        return pool.slice(0, 30).map((m) => ({
          name: formatModelChoice(m, true),
          value: m.id,
          description: m.description?.slice(0, 80),
        }));
      }

      // Fuzzy search within the (possibly filtered) pool
      const results = pool
        .map((m) => ({
          model: m,
          score: Math.max(
            fuzzyMatch(m.id, searchTerm),
            fuzzyMatch(m.name, searchTerm),
            fuzzyMatch(m.provider, searchTerm) * 0.5
          ),
        }))
        .filter((r) => r.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);

      return results.map((r) => ({
        name: formatModelChoice(r.model, true), // Always show source
        value: r.model.id,
        description: r.model.description?.slice(0, 80),
      }));
    },
  });

  return selected;
}

/**
 * Provider choices for profile model configuration
 */
const PROVIDER_CHOICES = [
  { name: "Skip (keep Claude default)", value: "skip", description: "Use native Claude model for this tier" },
  { name: "OpenRouter", value: "openrouter", description: "580+ models via unified API" },
  { name: "OpenCode Zen", value: "zen", description: "Free models, no API key needed" },
  { name: "Google Gemini", value: "google", description: "Direct API (GEMINI_API_KEY)" },
  { name: "OpenAI", value: "openai", description: "Direct API (OPENAI_API_KEY)" },
  { name: "xAI / Grok", value: "xai", description: "Direct API (XAI_API_KEY)" },
  { name: "MiniMax", value: "minimax", description: "Direct API (MINIMAX_API_KEY)" },
  { name: "Kimi / Moonshot", value: "kimi", description: "Direct API (MOONSHOT_API_KEY)" },
  { name: "GLM / Zhipu", value: "glm", description: "Direct API (ZHIPU_API_KEY)" },
  { name: "Z.AI", value: "zai", description: "Z.AI API (ZAI_API_KEY)" },
  { name: "OllamaCloud", value: "ollamacloud", description: "Cloud models (OLLAMA_API_KEY)" },
  { name: "Ollama (local)", value: "ollama", description: "Local Ollama instance" },
  { name: "LM Studio (local)", value: "lmstudio", description: "Local LM Studio instance" },
  { name: "Enter custom model", value: "custom", description: "Type a provider@model specification" },
];

/**
 * Model ID prefix for each provider
 */
const PROVIDER_MODEL_PREFIX: Record<string, string> = {
  google: "google@",
  openai: "oai@",
  xai: "xai@",
  minimax: "mm@",
  kimi: "kimi@",
  glm: "glm@",
  zai: "zai@",
  ollamacloud: "oc@",
  ollama: "ollama@",
  lmstudio: "lmstudio@",
  zen: "zen@",
  openrouter: "openrouter@",
};

/**
 * Map provider value to ModelInfo source field for filtering fetched models
 */
const PROVIDER_SOURCE_FILTER: Record<string, string> = {
  openrouter: "OpenRouter",
  google: "Gemini",
  openai: "OpenAI",
  xai: "xAI",
  glm: "GLM",
  ollamacloud: "OllamaCloud",
  zen: "Zen",
};

/**
 * Well-known models per provider (fallback when API fetch returns no results)
 */
function getKnownModels(provider: string): ModelInfo[] {
  const known: Record<string, Array<{ id: string; name: string; context?: string; description?: string }>> = {
    google: [
      { id: "google@gemini-2.5-pro", name: "Gemini 2.5 Pro", context: "1M" },
      { id: "google@gemini-2.5-flash", name: "Gemini 2.5 Flash", context: "1M" },
      { id: "google@gemini-2.0-flash", name: "Gemini 2.0 Flash", context: "1M" },
    ],
    openai: [
      { id: "oai@gpt-5.3-codex", name: "GPT-5.3 Codex", context: "400K", description: "Latest coding model" },
      { id: "oai@gpt-5.2-codex", name: "GPT-5.2 Codex", context: "400K", description: "Coding model" },
      { id: "oai@gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", context: "400K", description: "Fast coding model" },
      { id: "oai@o3", name: "o3", context: "200K", description: "Reasoning model" },
      { id: "oai@o4-mini", name: "o4-mini", context: "200K", description: "Fast reasoning model" },
      { id: "oai@gpt-4.1", name: "GPT-4.1", context: "1M", description: "Large context model" },
    ],
    xai: [
      { id: "xai@grok-4", name: "Grok 4", context: "256K" },
      { id: "xai@grok-4-fast", name: "Grok 4 Fast", context: "2M" },
      { id: "xai@grok-code-fast-1", name: "Grok Code Fast 1", context: "256K", description: "Optimized for coding" },
    ],
    minimax: [
      { id: "mm@minimax-m2.1", name: "MiniMax M2.1", context: "196K", description: "Lightweight coding model" },
    ],
    kimi: [
      { id: "kimi@kimi-k2-thinking-turbo", name: "Kimi K2 Thinking Turbo", context: "128K" },
      { id: "kimi@moonshot-v1-128k", name: "Moonshot V1 128K", context: "128K" },
    ],
    glm: [
      { id: "glm@glm-5", name: "GLM-5", context: "200K", description: "Latest GLM model with reasoning" },
      { id: "glm@glm-4.7", name: "GLM-4.7", context: "200K", description: "GLM 4.7 with reasoning" },
      { id: "glm@glm-4.7-flash", name: "GLM-4.7 Flash", context: "200K", description: "Fast GLM 4.7" },
      { id: "glm@glm-4.6", name: "GLM-4.6", context: "200K" },
      { id: "glm@glm-4.5-flash", name: "GLM-4.5 Flash", context: "128K" },
    ],
    zai: [
      { id: "zai@glm-4.7", name: "GLM 4.7 (Z.AI)", context: "128K" },
    ],
    ollamacloud: [
      { id: "oc@glm-5", name: "GLM-5", context: "203K", description: "GLM-5 on OllamaCloud" },
      { id: "oc@deepseek-v3.2", name: "DeepSeek V3.2", context: "164K", description: "DeepSeek V3.2 on OllamaCloud" },
      { id: "oc@gemini-3-pro-preview", name: "Gemini 3 Pro Preview", context: "1M", description: "Gemini 3 Pro on OllamaCloud" },
      { id: "oc@kimi-k2.5", name: "Kimi K2.5", context: "262K", description: "Kimi K2.5 on OllamaCloud" },
      { id: "oc@qwen3-coder-next", name: "Qwen3 Coder Next", context: "262K", description: "Qwen3 Coder on OllamaCloud" },
      { id: "oc@minimax-m2.1", name: "MiniMax M2.1", context: "205K", description: "MiniMax M2.1 on OllamaCloud" },
    ],
  };

  const providerDisplay = provider.charAt(0).toUpperCase() + provider.slice(1);
  return (known[provider] || []).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description || `${providerDisplay} model`,
    provider: providerDisplay,
    context: m.context,
    supportsTools: true,
  }));
}

/**
 * Filter models by provider using source tag or ID prefix
 */
function filterModelsByProvider(allModels: ModelInfo[], provider: string): ModelInfo[] {
  const source = PROVIDER_SOURCE_FILTER[provider];
  if (source) {
    return allModels.filter((m) => m.source === source);
  }

  const prefix = PROVIDER_MODEL_PREFIX[provider];
  if (prefix) {
    return allModels.filter((m) => m.id.startsWith(prefix));
  }

  return [];
}

/**
 * Select a model from a specific provider with filterable search
 */
async function selectModelFromProvider(
  provider: string,
  tierName: string,
  allModels: ModelInfo[],
  recommendedModels: ModelInfo[],
): Promise<string> {
  const LOCAL_INPUT_PROVIDERS = new Set(["ollama", "lmstudio"]);
  const prefix = PROVIDER_MODEL_PREFIX[provider] || `${provider}@`;

  // Local providers: just ask for model name
  if (LOCAL_INPUT_PROVIDERS.has(provider)) {
    const modelName = await input({
      message: `Enter ${provider} model name for ${tierName}:`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  // Get fetched models for this provider
  let providerModels = filterModelsByProvider(allModels, provider);

  // For OpenRouter, prioritize recommended models
  if (provider === "openrouter") {
    const seenIds = new Set<string>();
    const merged: ModelInfo[] = [];
    for (const m of recommendedModels) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        merged.push(m);
      }
    }
    for (const m of providerModels) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        merged.push(m);
      }
    }
    providerModels = merged;
  }

  // Add known fallback models if not already present
  const knownModels = getKnownModels(provider);
  if (knownModels.length > 0) {
    const seenIds = new Set(providerModels.map((m) => m.id));
    for (const m of knownModels) {
      if (!seenIds.has(m.id)) {
        providerModels.unshift(m);
      }
    }
  }

  // No models at all: fall back to text input
  if (providerModels.length === 0) {
    const modelName = await input({
      message: `Enter ${provider} model name for ${tierName} (prefix ${prefix} will be added):`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  // Show filterable search with custom entry option
  const CUSTOM_VALUE = "__custom_model__";

  const selected = await search<string>({
    message: `Select model for ${tierName} (type to filter):`,
    pageSize: 15,
    source: async (term) => {
      let filtered: ModelInfo[];

      if (term) {
        filtered = providerModels
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
          .slice(0, 20)
          .map((r) => r.model);
      } else {
        filtered = providerModels.slice(0, 25);
      }

      const choices = filtered.map((m) => ({
        name: formatModelChoice(m, true),
        value: m.id,
        description: m.description?.slice(0, 80),
      }));

      // Always add custom option at the end
      choices.push({
        name: ">> Enter custom model ID",
        value: CUSTOM_VALUE,
        description: `Type a custom ${provider} model name`,
      });

      return choices;
    },
  });

  if (selected === CUSTOM_VALUE) {
    const modelName = await input({
      message: `Enter model name (will be prefixed with ${prefix}):`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  return selected;
}

/**
 * Select multiple models for profile setup
 * Interactive flow: provider selection -> filterable model list for each tier
 */
export async function selectModelsForProfile(): Promise<{
  opus?: string;
  sonnet?: string;
  haiku?: string;
  subagent?: string;
}> {
  console.log("\nLoading available models...");
  const [fetchedModels, recommendedModels] = await Promise.all([
    getAllModelsForSearch(),
    Promise.resolve(loadRecommendedModels()),
  ]);

  const tiers = [
    { key: "opus" as const, name: "Opus", description: "Most capable, used for complex reasoning" },
    { key: "sonnet" as const, name: "Sonnet", description: "Balanced, used for general tasks" },
    { key: "haiku" as const, name: "Haiku", description: "Fast & cheap, used for simple tasks" },
    { key: "subagent" as const, name: "Subagent", description: "Used for spawned sub-agents" },
  ];

  const result: { opus?: string; sonnet?: string; haiku?: string; subagent?: string } = {};
  let lastProvider: string | undefined;

  console.log("\nConfigure models for each Claude tier:");

  for (const tier of tiers) {
    console.log(""); // Spacing between tiers

    // Step 1: Select provider
    const provider = await select({
      message: `Select provider for ${tier.name} tier (${tier.description}):`,
      choices: PROVIDER_CHOICES,
      default: lastProvider,
    });

    if (provider === "skip") {
      result[tier.key] = undefined;
      continue;
    }

    lastProvider = provider;

    if (provider === "custom") {
      const customModel = await input({
        message: `Enter custom model for ${tier.name} (e.g., provider@model):`,
        validate: (v) => (v.trim() ? true : "Model cannot be empty"),
      });
      result[tier.key] = customModel.trim();
      continue;
    }

    // Step 2: Select model from the chosen provider
    result[tier.key] = await selectModelFromProvider(
      provider,
      tier.name,
      fetchedModels,
      recommendedModels,
    );
  }

  return result;
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
