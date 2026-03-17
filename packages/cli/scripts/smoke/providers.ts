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
  "gemini-codeassist", // OAuth-only, no API key auth
]);

// Map provider name → representative model for smoke testing
const REPRESENTATIVE_MODELS: Record<string, string> = {
  kimi: "kimi-k2.5",
  "kimi-coding": "kimi-k2.5",
  minimax: "minimax-m2.5",
  "minimax-coding": "minimax-m2.5",
  glm: "glm-5",
  "glm-coding": "glm-5", // GLM coding plan — codegeex-4 removed from API
  zai: "glm-5",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini", // stable model always available on OpenRouter
  litellm: "gemini-2.5-flash", // model deployed on the madappgang litellm instance
  "opencode-zen": "minimax-m2.5-free", // Free model that works for tools+reasoning
  "opencode-zen-go": "glm-5", // Only confirmed working model (C2 fix)
  gemini: "gemini-2.0-flash",
  ollamacloud: "ministral-3:8b",
  vertex: "google/gemini-2.0-flash",
};

// Per-model capability map for smoke testing.
// Capabilities are model-specific, not provider-specific.
const SMOKE_MODEL_CAPABILITIES: Record<
  string,
  { supportsTools: boolean; supportsVision: boolean; supportsReasoning: boolean }
> = {
  "gemini-2.0-flash": { supportsTools: true, supportsVision: true, supportsReasoning: true },
  "gpt-4o-mini": { supportsTools: true, supportsVision: true, supportsReasoning: true },
  "openai/gpt-4o-mini": { supportsTools: true, supportsVision: true, supportsReasoning: true },
  "minimax-m2.5": { supportsTools: true, supportsVision: false, supportsReasoning: true },
  "minimax-m2.5-free": { supportsTools: true, supportsVision: false, supportsReasoning: true },
  "kimi-k2.5": { supportsTools: true, supportsVision: true, supportsReasoning: true },
  "glm-5": { supportsTools: true, supportsVision: false, supportsReasoning: true },
  "ministral-3:8b": { supportsTools: true, supportsVision: false, supportsReasoning: true },
  "google/gemini-2.0-flash": { supportsTools: true, supportsVision: true, supportsReasoning: true },
  "gemini-2.5-flash": { supportsTools: true, supportsVision: true, supportsReasoning: true },
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
  if (providerName === "ollamacloud") return "ollama";
  return ANTHROPIC_COMPAT_PROVIDERS.has(providerName) ? "anthropic-compat" : "openai-compat";
}

function getAuthScheme(provider: RemoteProvider): SmokeProviderConfig["authScheme"] {
  const wireFormat = getWireFormat(provider.name);
  if (wireFormat === "openai-compat" || wireFormat === "ollama") {
    return "openai"; // Authorization: Bearer
  }
  // Anthropic-compat providers
  return provider.authScheme === "bearer" ? "bearer" : "x-api-key";
}

// Cached Vertex OAuth token (fetched once per run via gcloud)
let _vertexToken: string | undefined;

/**
 * Get a Vertex OAuth token via `gcloud auth print-access-token`.
 * Returns undefined if gcloud is not available or fails.
 */
function getVertexToken(): string | undefined {
  if (_vertexToken) return _vertexToken;
  try {
    const result = Bun.spawnSync(["gcloud", "auth", "print-access-token"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const token = result.stdout.toString().trim();
    if (token && !token.includes("ERROR")) {
      _vertexToken = token;
      return token;
    }
  } catch {
    // gcloud not available
  }
  return undefined;
}

/**
 * Get the API key for a provider. For opencode-zen providers, fall back to
 * "public" if OPENCODE_API_KEY is not set (zen is free with public access).
 * For vertex, obtain an OAuth token via gcloud.
 */
function getApiKey(provider: RemoteProvider): string | undefined {
  if (
    (provider.name === "opencode-zen" || provider.name === "opencode-zen-go") &&
    !process.env[provider.apiKeyEnvVar]
  ) {
    return "public";
  }
  if (provider.name === "vertex") {
    return getVertexToken();
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
  if (provider.name === "vertex") {
    const project = process.env.VERTEX_PROJECT || "gen-lang-client-0934119819";
    const location = process.env.VERTEX_LOCATION || "us-central1";
    return `/v1beta1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`;
  }
  return provider.apiPath;
}

/**
 * Get the base URL for a provider.
 * Vertex needs a dynamically constructed regional endpoint.
 */
function getBaseUrl(provider: RemoteProvider): string {
  if (provider.name === "vertex") {
    const location = process.env.VERTEX_LOCATION || "us-central1";
    return `https://${location}-aiplatform.googleapis.com`;
  }
  return provider.baseUrl;
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
      const repModel = REPRESENTATIVE_MODELS[p.name];
      const modelCaps = SMOKE_MODEL_CAPABILITIES[repModel] ?? {
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: true,
      };
      return {
        name: p.name,
        baseUrl: getBaseUrl(p),
        apiPath: getApiPath(p),
        apiKey,
        authScheme: getAuthScheme(p),
        extraHeaders: p.headers ?? {},
        wireFormat: getWireFormat(p.name),
        representativeModel: repModel,
        capabilities: modelCaps,
      };
    });
}
