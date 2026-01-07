/**
 * Types for remote API providers (OpenRouter, Gemini, OpenAI)
 *
 * These types define the common interface for cloud API providers
 * that use streaming HTTP APIs.
 */

/**
 * Configuration for a remote API provider
 */
export interface RemoteProviderConfig {
  /** Provider name (e.g., "openrouter", "gemini", "openai") */
  name: string;
  /** Base URL for the API */
  baseUrl: string;
  /** API path (e.g., "/v1/chat/completions") */
  apiPath: string;
  /** Environment variable name for API key */
  apiKeyEnvVar: string;
  /** HTTP headers to include with requests */
  headers?: Record<string, string>;
}

/**
 * Pricing information for a model
 */
export interface ModelPricing {
  /** Cost per 1M input tokens in USD */
  inputCostPer1M: number;
  /** Cost per 1M output tokens in USD */
  outputCostPer1M: number;
}

/**
 * Provider capabilities
 */
export interface ProviderCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  supportsReasoning: boolean;
}

/**
 * Remote provider definition (used by provider registry)
 */
export interface RemoteProvider {
  name: string;
  baseUrl: string;
  apiPath: string;
  apiKeyEnvVar: string;
  /** Prefixes that route to this provider (e.g., ["g/", "gemini/"]) */
  prefixes: string[];
  capabilities: ProviderCapabilities;
  /** Optional custom headers */
  headers?: Record<string, string>;
}

/**
 * Resolved remote provider with model name
 */
export interface ResolvedRemoteProvider {
  provider: RemoteProvider;
  modelName: string;
}

/**
 * Hardcoded pricing data for providers
 * Prices are in USD per 1M tokens
 */
export const GEMINI_PRICING: Record<string, ModelPricing> = {
  // Gemini 2.5 models
  "gemini-2.5-flash": { inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
  "gemini-2.5-flash-preview-05-20": { inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
  "gemini-2.5-pro": { inputCostPer1M: 1.25, outputCostPer1M: 10.0 },
  "gemini-2.5-pro-preview-05-06": { inputCostPer1M: 1.25, outputCostPer1M: 10.0 },
  // Gemini 3.0 models (pricing may vary)
  "gemini-3-pro-preview": { inputCostPer1M: 2.5, outputCostPer1M: 10.0 },
  "gemini-3.0-flash": { inputCostPer1M: 0.1, outputCostPer1M: 0.4 },
  // Gemini 2.0 models
  "gemini-2.0-flash": { inputCostPer1M: 0.1, outputCostPer1M: 0.4 },
  "gemini-2.0-flash-thinking": { inputCostPer1M: 0.1, outputCostPer1M: 0.4 },
  // Default for unknown Gemini models
  default: { inputCostPer1M: 0.5, outputCostPer1M: 2.0 },
};

export const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-5 models
  "gpt-5": { inputCostPer1M: 2.0, outputCostPer1M: 8.0 },
  "gpt-5.2": { inputCostPer1M: 2.5, outputCostPer1M: 10.0 },
  "gpt-5-turbo": { inputCostPer1M: 1.5, outputCostPer1M: 6.0 },
  "gpt-5.1-codex": { inputCostPer1M: 3.0, outputCostPer1M: 12.0 },
  // GPT-4o models
  "gpt-4o": { inputCostPer1M: 2.5, outputCostPer1M: 10.0 },
  "gpt-4o-mini": { inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
  "gpt-4o-audio": { inputCostPer1M: 2.5, outputCostPer1M: 10.0 },
  // Reasoning models (o-series)
  o1: { inputCostPer1M: 15.0, outputCostPer1M: 60.0 },
  "o1-mini": { inputCostPer1M: 3.0, outputCostPer1M: 12.0 },
  "o1-preview": { inputCostPer1M: 15.0, outputCostPer1M: 60.0 },
  o3: { inputCostPer1M: 15.0, outputCostPer1M: 60.0 },
  "o3-mini": { inputCostPer1M: 3.0, outputCostPer1M: 12.0 },
  // GPT-4 models (legacy)
  "gpt-4-turbo": { inputCostPer1M: 10.0, outputCostPer1M: 30.0 },
  "gpt-4-turbo-preview": { inputCostPer1M: 10.0, outputCostPer1M: 30.0 },
  "gpt-4": { inputCostPer1M: 30.0, outputCostPer1M: 60.0 },
  // GPT-3.5 models (legacy)
  "gpt-3.5-turbo": { inputCostPer1M: 0.5, outputCostPer1M: 1.5 },
  // Default for unknown OpenAI models
  default: { inputCostPer1M: 2.0, outputCostPer1M: 8.0 },
};

export const MINIMAX_PRICING: Record<string, ModelPricing> = {
  // MiniMax models
  "minimax-m2.1": { inputCostPer1M: 0.12, outputCostPer1M: 0.48 },
  "minimax-m2": { inputCostPer1M: 0.12, outputCostPer1M: 0.48 },
  // Default for unknown MiniMax models
  default: { inputCostPer1M: 0.12, outputCostPer1M: 0.48 },
};

export const KIMI_PRICING: Record<string, ModelPricing> = {
  // Kimi K2 Thinking models (higher cost due to reasoning)
  "kimi-k2-thinking-turbo": { inputCostPer1M: 0.32, outputCostPer1M: 0.48 },
  "kimi-k2-thinking": { inputCostPer1M: 0.32, outputCostPer1M: 0.48 },
  // Kimi K2 standard models
  "kimi-k2-turbo-preview": { inputCostPer1M: 0.2, outputCostPer1M: 0.4 },
  "kimi-k2-0905-preview": { inputCostPer1M: 0.2, outputCostPer1M: 0.4 },
  "kimi-k2": { inputCostPer1M: 0.2, outputCostPer1M: 0.4 },
  // Default for unknown Kimi models
  default: { inputCostPer1M: 0.32, outputCostPer1M: 0.48 },
};

export const GLM_PRICING: Record<string, ModelPricing> = {
  // GLM-4 models
  "glm-4.7": { inputCostPer1M: 0.16, outputCostPer1M: 0.8 },
  "glm-4": { inputCostPer1M: 0.16, outputCostPer1M: 0.8 },
  "glm-4-plus": { inputCostPer1M: 0.5, outputCostPer1M: 2.0 },
  // Default for unknown GLM models
  default: { inputCostPer1M: 0.16, outputCostPer1M: 0.8 },
};

/**
 * Get pricing for a model
 */
export function getModelPricing(provider: string, modelName: string): ModelPricing {
  let pricingTable: Record<string, ModelPricing>;

  switch (provider) {
    case "gemini":
    case "google":
      pricingTable = GEMINI_PRICING;
      break;
    case "openai":
    case "oai":
      pricingTable = OPENAI_PRICING;
      break;
    case "minimax":
    case "mm":
      pricingTable = MINIMAX_PRICING;
      break;
    case "kimi":
    case "moonshot":
      pricingTable = KIMI_PRICING;
      break;
    case "glm":
    case "zhipu":
      pricingTable = GLM_PRICING;
      break;
    default:
      // Return default pricing for unknown providers
      return { inputCostPer1M: 1.0, outputCostPer1M: 4.0 };
  }

  // Try exact match first
  if (pricingTable[modelName]) {
    return pricingTable[modelName];
  }

  // Try partial match (e.g., "gpt-4o-2024-08-06" matches "gpt-4o")
  for (const [key, pricing] of Object.entries(pricingTable)) {
    if (key !== "default" && modelName.startsWith(key)) {
      return pricing;
    }
  }

  // Return default pricing for the provider
  return pricingTable.default;
}

/**
 * Calculate cost based on token usage
 */
export function calculateCost(
  provider: string,
  modelName: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = getModelPricing(provider, modelName);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return inputCost + outputCost;
}
