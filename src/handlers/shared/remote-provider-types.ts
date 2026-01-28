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
  /** Whether this pricing is an estimate (not from official sources) */
  isEstimate?: boolean;
  /** Whether this model is free (e.g., OAuth-based Code Assist sessions) */
  isFree?: boolean;
  /** Whether this model uses a subscription service (e.g., Kimi Coding) */
  isSubscription?: boolean;
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
  /** Whether this used legacy prefix syntax (for deprecation warnings) */
  isLegacySyntax?: boolean;
}

/**
 * Per-provider default pricing (fallback when dynamic cache has no data).
 * These are rough estimates — dynamic pricing from OpenRouter is preferred.
 * Prices are in USD per 1M tokens.
 */
export const PROVIDER_DEFAULTS: Record<string, ModelPricing> = {
  gemini:      { inputCostPer1M: 0.5,  outputCostPer1M: 2.0,  isEstimate: true },
  openai:      { inputCostPer1M: 2.0,  outputCostPer1M: 8.0,  isEstimate: true },
  minimax:     { inputCostPer1M: 0.12, outputCostPer1M: 0.48, isEstimate: true },
  kimi:        { inputCostPer1M: 0.32, outputCostPer1M: 0.48, isEstimate: true },
  glm:         { inputCostPer1M: 0.16, outputCostPer1M: 0.8,  isEstimate: true },
  ollamacloud: { inputCostPer1M: 1.0,  outputCostPer1M: 4.0,  isEstimate: true },
};

// Free providers — always return free pricing regardless of model
const FREE_PROVIDERS = new Set(["opencode-zen", "zen"]);

// Subscription providers — display "SUB" instead of cost
const SUBSCRIPTION_PROVIDERS = new Set(["kimi-coding"]);

/** Map provider aliases to canonical names used in PROVIDER_DEFAULTS */
const PROVIDER_ALIAS: Record<string, string> = {
  google: "gemini",
  oai: "openai",
  mm: "minimax",
  moonshot: "kimi",
  zhipu: "glm",
  oc: "ollamacloud",
};

/**
 * Registered dynamic pricing lookup function.
 * Set by pricing-cache.ts at startup via registerDynamicPricingLookup().
 * This avoids circular ESM imports between this module and pricing-cache.
 */
let _dynamicLookup: ((provider: string, modelName: string) => ModelPricing | undefined) | null = null;

/**
 * Register a dynamic pricing lookup function.
 * Called by pricing-cache.ts during warmup to inject its lookup.
 */
export function registerDynamicPricingLookup(
  fn: (provider: string, modelName: string) => ModelPricing | undefined
): void {
  _dynamicLookup = fn;
}

/**
 * Get pricing for a model.
 * Lookup order:
 *   1. Free providers → free pricing
 *   2. Dynamic pricing cache (if registered, populated from OpenRouter API)
 *   3. Provider default (isEstimate: true)
 */
export function getModelPricing(provider: string, modelName: string): ModelPricing {
  const p = provider.toLowerCase();

  // 1. Free providers
  if (FREE_PROVIDERS.has(p)) {
    return { inputCostPer1M: 0, outputCostPer1M: 0, isFree: true };
  }

  // 1b. Subscription providers
  if (SUBSCRIPTION_PROVIDERS.has(p)) {
    return { inputCostPer1M: 0, outputCostPer1M: 0, isSubscription: true };
  }

  // 2. Dynamic pricing cache
  if (_dynamicLookup) {
    const dynamic = _dynamicLookup(p, modelName);
    if (dynamic) return dynamic;
  }

  // 3. Provider defaults with alias resolution
  const canonical = PROVIDER_ALIAS[p] || p;
  return PROVIDER_DEFAULTS[canonical] || { inputCostPer1M: 1.0, outputCostPer1M: 4.0, isEstimate: true };
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
