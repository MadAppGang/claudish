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
 * Remote provider definition (used by provider registry)
 */
export interface RemoteProvider {
  name: string;
  baseUrl: string;
  apiPath: string;
  apiKeyEnvVar: string;
  /** Prefixes that route to this provider (e.g., ["g/", "gemini/"]) */
  prefixes: string[];
  /** Optional custom headers */
  headers?: Record<string, string>;
  /** Auth scheme for the API key header (defaults to "x-api-key") */
  authScheme?: "x-api-key" | "bearer";
  /**
   * Optional stream-format override surfaced via ProviderTransport.overrideStreamFormat().
   * When the transport's wire format differs from what the model's dialect would
   * pick (e.g. an Anthropic-compatible endpoint serving a Qwen-named model —
   * QwenModelDialect inherits openai-sse, but the wire is anthropic-sse), this
   * lets the customEndpoint config plumb the truth through to the parser.
   * Mirrors the StreamFormat union declared at providers/transport/types.ts.
   */
  streamFormatOverride?:
    | "anthropic-sse"
    | "openai-sse"
    | "openai-responses-sse"
    | "gemini-sse"
    | "ollama-jsonl";
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
  gemini: { inputCostPer1M: 0.5, outputCostPer1M: 2.0, isEstimate: true },
  openai: { inputCostPer1M: 2.0, outputCostPer1M: 8.0, isEstimate: true },
  minimax: { inputCostPer1M: 0.12, outputCostPer1M: 0.48, isEstimate: true },
  kimi: { inputCostPer1M: 0.32, outputCostPer1M: 0.48, isEstimate: true },
  glm: { inputCostPer1M: 0.16, outputCostPer1M: 0.8, isEstimate: true },
  ollamacloud: { inputCostPer1M: 1.0, outputCostPer1M: 4.0, isEstimate: true },
};

// Free providers — always return free pricing regardless of model
const FREE_PROVIDERS = new Set(["opencode-zen", "zen"]);

// Subscription providers — display "SUB" instead of cost.
//
// Membership is decided by BILLING, not by whether the provider happens to
// declare `modelDiscovery`. That distinction is what let three flat-rate plans
// sit outside this set for so long: a provider WITH discovery renders through
// `buildDiscoveredModelRows`, which asks this question, while a provider
// WITHOUT it renders through the catalog path, which (until now) did not — so a
// missing entry was invisible on one path and merely wrong on the other.
const SUBSCRIPTION_PROVIDERS = new Set([
  "minimax-coding",
  "kimi-coding",
  "glm-coding",
  "qwen-cloud",
  // Devin bills one flat subscription across every vendor's models it serves.
  // Without this the picker prints an invented per-token price and TokenTracker
  // accrues fictional cost.
  "devin",
  // Antigravity is billed by the user's Antigravity plan (free / Pro / Ultra) —
  // the whole reason `ag@` exists as a separate provider from the metered `g@`.
  // It has no `modelDiscovery`, so it rendered the catalog's N/A instead.
  "antigravity",
  // The `-subscription` in the name is the whole point: `sc@` is the flat-rate
  // Sakana plan, distinct from the metered `sakana@`. Left out, the picker
  // showed Sakana's per-token rate against a plan that does not charge one —
  // the same confusion that made sc@ bill PAYG once before.
  "sakana-subscription",
]);

// DELIBERATELY NOT LISTED: `openai-codex`.
//
// It looks like the obvious fourth entry — its own picker row reads "ChatGPT
// Plus/Pro subscription" — and it was briefly added here. But the provider is
// DUAL-MODE: `oauthFallback: "codex-oauth.json"` is the subscription, while
// `apiKeyAliases: ["OPENAI_API_KEY"]` means a plain metered OpenAI key
// authenticates `cx@` just as well. Marking it flat-rate reports SUB and accrues
// ZERO cost for a user OpenAI is billing per token — a silent under-report of
// real money.
//
// The two errors are not symmetric. Quoting a dollar rate to someone on a
// subscription is a cosmetic over-estimate they can ignore; reporting $0 to
// someone being metered is the one that costs them. Until membership can be
// decided from the CREDENTIAL actually in play rather than the provider name,
// the safe answer is to leave it out. `antigravity` (no `apiKeyEnvVar` at all,
// OAuth only) and `sakana-subscription` (whose comment records that it
// deliberately does NOT alias the PAYG `SAKANA_API_KEY`) have no such ambiguity,
// which is why they ARE listed.

/**
 * Whether a provider bills a flat subscription rather than per token.
 *
 * The single sanctioned answer to that question — `getModelPricing` below uses
 * it, and so does the interactive picker, which renders "SUB" instead of a
 * per-token figure. Showing a dollar rate for a flat-rate plan would be
 * actively misleading, so both surfaces must agree on one list.
 */
export function isSubscriptionProvider(provider: string): boolean {
  return SUBSCRIPTION_PROVIDERS.has(provider.toLowerCase());
}

/** Map provider aliases to canonical names used in PROVIDER_DEFAULTS */
const PROVIDER_ALIAS: Record<string, string> = {
  google: "gemini",
  oai: "openai",
  mm: "minimax",
  moonshot: "kimi",
  zhipu: "glm",
  "minimax-coding": "minimax", // Use MiniMax pricing as fallback (though subscription overrides)
  "glm-coding": "glm", // Use GLM pricing as fallback (though subscription overrides)
  oc: "ollamacloud",
};

/**
 * Registered dynamic pricing lookup function.
 * Set by pricing-cache.ts at startup via registerDynamicPricingLookup().
 * This avoids circular ESM imports between this module and pricing-cache.
 */
let _dynamicLookup: ((provider: string, modelName: string) => ModelPricing | undefined) | null =
  null;

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
  if (isSubscriptionProvider(p)) {
    return { inputCostPer1M: 0, outputCostPer1M: 0, isSubscription: true };
  }

  // 2. Dynamic pricing cache
  if (_dynamicLookup) {
    const dynamic = _dynamicLookup(p, modelName);
    if (dynamic) return dynamic;
  }

  // 3. Provider defaults with alias resolution
  const canonical = PROVIDER_ALIAS[p] || p;
  return (
    PROVIDER_DEFAULTS[canonical] || { inputCostPer1M: 1.0, outputCostPer1M: 4.0, isEstimate: true }
  );
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
