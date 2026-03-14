/**
 * Provider discovery for smoke tests.
 *
 * Imports from the main source tree to reuse base URLs, auth schemes,
 * and capability flags. Applies representative model mapping and
 * wire format classification. Returns only providers with present API keys.
 */

import type { RemoteProvider } from "../../src/handlers/shared/remote-provider-types.js";
import { getRegisteredRemoteProviders } from "../../src/providers/remote-provider-registry.js";
import type { SmokeProviderConfig, WireFormat } from "./types.js";

// Providers to skip in v1 smoke tests
const SKIP_PROVIDERS = new Set([
  "ollamacloud", // Uses /api/chat Ollama JSONL format, not OpenAI-compat
  "gemini-codeassist", // OAuth-only, no API key auth
  "vertex", // Complex auth (VERTEX_PROJECT + OAuth)
  "glm-coding", // Coding PAAS endpoint — valid model IDs not yet confirmed
]);

// Map provider name → representative model for smoke testing
const REPRESENTATIVE_MODELS: Record<string, string> = {
  kimi: "kimi-k2.5",
  "kimi-coding": "kimi-k2.5",
  minimax: "minimax-m2.5",
  "minimax-coding": "minimax-m2.5",
  glm: "glm-5",
  "glm-coding": "codegeex-4", // GLM coding plan representative model
  zai: "glm-5",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini", // stable model always available on OpenRouter
  litellm: "gemini-2.5-flash", // model deployed on the madappgang litellm instance
  "opencode-zen": "minimax-m2.5-free", // Free model that works for tools+reasoning
  "opencode-zen-go": "glm-5", // Only confirmed working model (C2 fix)
  gemini: "gemini-2.0-flash",
};

// Providers that use Anthropic-compat wire format
const ANTHROPIC_COMPAT_PROVIDERS = new Set([
  "kimi",
  "kimi-coding",
  "minimax",
  "minimax-coding",
  "zai",
]);

function getWireFormat(providerName: string): WireFormat {
  return ANTHROPIC_COMPAT_PROVIDERS.has(providerName) ? "anthropic-compat" : "openai-compat";
}

function getAuthScheme(provider: RemoteProvider): SmokeProviderConfig["authScheme"] {
  const wireFormat = getWireFormat(provider.name);
  if (wireFormat === "openai-compat") {
    return "openai"; // Authorization: Bearer
  }
  // Anthropic-compat providers
  return provider.authScheme === "bearer" ? "bearer" : "x-api-key";
}

/**
 * Get the API key for a provider. For opencode-zen providers, fall back to
 * "public" if OPENCODE_API_KEY is not set (zen is free with public access).
 */
function getApiKey(provider: RemoteProvider): string | undefined {
  if (
    (provider.name === "opencode-zen" || provider.name === "opencode-zen-go") &&
    !process.env[provider.apiKeyEnvVar]
  ) {
    return "public";
  }
  return process.env[provider.apiKeyEnvVar];
}

/**
 * Get the correct API path for a provider.
 * Gemini's native path is for streaming; override to the OpenAI-compat path
 * for non-streaming smoke tests (C4 fix).
 */
function getApiPath(provider: RemoteProvider): string {
  if (provider.name === "gemini") {
    return "/v1beta/openai/chat/completions";
  }
  return provider.apiPath;
}

/**
 * Discover providers that have API keys available.
 *
 * @param filterName - If provided, only return the provider with this name.
 * @returns Array of SmokeProviderConfig for providers ready to test.
 */
export function discoverProviders(filterName?: string): SmokeProviderConfig[] {
  const all = getRegisteredRemoteProviders();

  return all
    .filter((p) => {
      // Skip providers not suitable for v1 smoke tests
      if (SKIP_PROVIDERS.has(p.name)) return false;

      // Must have a known representative model
      if (!REPRESENTATIVE_MODELS[p.name]) return false;

      // litellm needs a base URL configured
      if (p.name === "litellm" && !process.env.LITELLM_BASE_URL) return false;

      // Check API key availability
      const key = getApiKey(p);
      if (!key) return false;

      // Apply name filter
      if (filterName && p.name !== filterName) return false;

      return true;
    })
    .map((p) => {
      const apiKey = getApiKey(p)!;
      return {
        name: p.name,
        baseUrl: p.baseUrl,
        apiPath: getApiPath(p),
        apiKey,
        authScheme: getAuthScheme(p),
        extraHeaders: p.headers ?? {},
        wireFormat: getWireFormat(p.name),
        representativeModel: REPRESENTATIVE_MODELS[p.name],
        capabilities: {
          supportsTools: p.capabilities.supportsTools,
          supportsVision: p.capabilities.supportsVision,
          supportsReasoning: p.capabilities.supportsReasoning,
        },
      };
    });
}
