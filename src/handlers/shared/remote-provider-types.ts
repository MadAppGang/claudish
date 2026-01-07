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
  "gemini-2.5-flash": { inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
  "gemini-2.5-flash-preview-05-20": { inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
  "gemini-2.5-pro": { inputCostPer1M: 1.25, outputCostPer1M: 10.00 },
  "gemini-2.5-pro-preview-05-06": { inputCostPer1M: 1.25, outputCostPer1M: 10.00 },
  // Gemini 3.0 models (pricing may vary)
  "gemini-3-pro-preview": { inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
  "gemini-3.0-flash": { inputCostPer1M: 0.10, outputCostPer1M: 0.40 },
  // Gemini 2.0 models
  "gemini-2.0-flash": { inputCostPer1M: 0.10, outputCostPer1M: 0.40 },
  "gemini-2.0-flash-thinking": { inputCostPer1M: 0.10, outputCostPer1M: 0.40 },
  // Default for unknown Gemini models
  "default": { inputCostPer1M: 0.50, outputCostPer1M: 2.00 },
};

export const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-5 models
  "gpt-5": { inputCostPer1M: 2.00, outputCostPer1M: 8.00 },
  "gpt-5.2": { inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
  "gpt-5-turbo": { inputCostPer1M: 1.50, outputCostPer1M: 6.00 },
  "gpt-5.1-codex": { inputCostPer1M: 3.00, outputCostPer1M: 12.00 },
  // GPT-4o models
  "gpt-4o": { inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
  "gpt-4o-mini": { inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
  "gpt-4o-audio": { inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
  // Reasoning models (o-series)
  "o1": { inputCostPer1M: 15.00, outputCostPer1M: 60.00 },
  "o1-mini": { inputCostPer1M: 3.00, outputCostPer1M: 12.00 },
  "o1-preview": { inputCostPer1M: 15.00, outputCostPer1M: 60.00 },
  "o3": { inputCostPer1M: 15.00, outputCostPer1M: 60.00 },
  "o3-mini": { inputCostPer1M: 3.00, outputCostPer1M: 12.00 },
  // GPT-4 models (legacy)
  "gpt-4-turbo": { inputCostPer1M: 10.00, outputCostPer1M: 30.00 },
  "gpt-4-turbo-preview": { inputCostPer1M: 10.00, outputCostPer1M: 30.00 },
  "gpt-4": { inputCostPer1M: 30.00, outputCostPer1M: 60.00 },
  // GPT-3.5 models (legacy)
  "gpt-3.5-turbo": { inputCostPer1M: 0.50, outputCostPer1M: 1.50 },
  // Default for unknown OpenAI models
  "default": { inputCostPer1M: 2.00, outputCostPer1M: 8.00 },
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
    default:
      // Return default pricing for unknown providers
      return { inputCostPer1M: 1.00, outputCostPer1M: 4.00 };
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
  return pricingTable["default"];
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
