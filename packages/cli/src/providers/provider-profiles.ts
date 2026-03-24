/**
 * ProviderProfile — declares how to construct a ComposedHandler for a specific remote provider.
 *
 * Maps provider name → transport class + adapter class + handler options.
 * Replaces the 250-line if/else chain in proxy-server.ts with a data-driven table.
 *
 * Design rules:
 * - Exact behaviour match — every profile must produce the same transport+adapter+options as the
 *   original if/else branch. No behaviour changes.
 * - Special cases (opencode-zen, vertex) keep their branching logic inside the profile's factory
 *   methods rather than cluttering the lookup code.
 * - Resolution (looking up the profile and calling createHandlerForProvider) happens in
 *   proxy-server.ts. Profiles do not know about caching or invocationMode.
 */

import type { ComposedHandlerOptions } from "../handlers/composed-handler.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import type { ProviderTransport } from "./transport/types.js";
import type { BaseAPIFormat } from "../adapters/base-api-format.js";
// Alias for readability within this file
type BaseModelAdapter = BaseAPIFormat;
import { ComposedHandler } from "../handlers/composed-handler.js";
import { GeminiProviderTransport } from "./transport/gemini-apikey.js";
import { GeminiCodeAssistProviderTransport } from "./transport/gemini-codeassist.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { OpenAIProviderTransport } from "./transport/openai.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { AnthropicProviderTransport } from "./transport/anthropic-compat.js";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { OllamaProviderTransport } from "./transport/ollamacloud.js";
import { OllamaAPIFormat } from "../adapters/ollama-api-format.js";
import { LiteLLMProviderTransport } from "./transport/litellm.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { VertexProviderTransport, parseVertexModel } from "./transport/vertex-oauth.js";
import { DefaultAPIFormat } from "../adapters/base-api-format.js";
import { OpenRouterProvider } from "./transport/openrouter.js";
import { getRegisteredRemoteProviders } from "./remote-provider-registry.js";
import { getVertexConfig, validateVertexOAuthConfig } from "../auth/vertex-auth.js";
import { log, logStderr } from "../logger.js";
import { resolveApiKeyProvenance, formatProvenanceLog } from "./api-key-provenance.js";
import type { ModelHandler } from "../handlers/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context passed to profile factory methods at handler-creation time.
 * All values come from the already-resolved provider and the outer createProxyServer closure.
 */
export interface ProfileContext {
  /** The resolved RemoteProvider config (baseUrl, headers, authScheme, etc.) */
  provider: RemoteProvider;
  /** The model name after stripping the provider prefix (e.g. "gemini-2.5-flash") */
  modelName: string;
  /** The API key resolved from env (empty string for auth-less providers) */
  apiKey: string;
  /** The original targetModel string passed by the caller */
  targetModel: string;
  /** The listening port of the proxy server */
  port: number;
  /** Shared ComposedHandler options from the outer scope */
  sharedOpts: Pick<ComposedHandlerOptions, "isInteractive" | "invocationMode">;
}

/**
 * ProviderProfile — describes how to construct a ModelHandler for a provider.
 *
 * The simplest profiles just implement createHandler() and log a message.
 * Complex ones (opencode-zen, vertex) may contain branching logic internally.
 */
export interface ProviderProfile {
  /** Create the Layer 1 APIFormat for this provider. */
  createFormat(modelName: string, providerName?: string): BaseAPIFormat;
  /** Create the Layer 3 ProviderTransport for this provider. Returns null if config invalid. */
  createTransport(ctx: ProfileContext): ProviderTransport | null;
  /** Create a full ModelHandler composing transport + format + dialect. Returns null if config invalid. */
  createHandler(ctx: ProfileContext): ModelHandler | null;
}

// ---------------------------------------------------------------------------
// Profile implementations
// ---------------------------------------------------------------------------

const geminiProfile: ProviderProfile = {
  createFormat: (m) => new GeminiAPIFormat(m),
  createTransport: (ctx) => new GeminiProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey),
  createHandler(ctx) {
    const transport = this.createTransport(ctx)!;
    const adapter = this.createFormat(ctx.modelName);
    log(`[Proxy] Created Gemini handler (composed): ${ctx.modelName}`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

const geminiCodeAssistProfile: ProviderProfile = {
  createFormat: (m) => new GeminiAPIFormat(m),
  createTransport: (ctx) => new GeminiCodeAssistProviderTransport(ctx.modelName),
  createHandler(ctx) {
    const transport = this.createTransport(ctx)!;
    const adapter = this.createFormat(ctx.modelName);
    log(`[Proxy] Created Gemini Code Assist handler (composed): ${ctx.modelName}`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

const openaiProfile: ProviderProfile = {
  createFormat: (m) => new OpenAIAPIFormat(m),
  createTransport: (ctx) => new OpenAIProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey),
  createHandler(ctx) {
    const transport = this.createTransport(ctx)!;
    const adapter = this.createFormat(ctx.modelName);
    log(`[Proxy] Created OpenAI handler (composed): ${ctx.modelName}`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

/** Shared profile for MiniMax, Kimi, Kimi Coding, and Z.AI (all Anthropic-compatible APIs) */
const anthropicCompatProfile: ProviderProfile = {
  createFormat: (m, p) => new AnthropicAPIFormat(m, p),
  createTransport: (ctx) => new AnthropicProviderTransport(ctx.provider, ctx.apiKey),
  createHandler(ctx) {
    const transport = this.createTransport(ctx)!;
    const adapter = this.createFormat(ctx.modelName, ctx.provider.name);
    log(`[Proxy] Created ${ctx.provider.name} handler (composed): ${ctx.modelName}`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

/** GLM and GLM Coding Plan use the OpenAI-compatible API */
const glmProfile: ProviderProfile = {
  createFormat: (m) => new OpenAIAPIFormat(m),
  createTransport: (ctx) => new OpenAIProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey),
  createHandler(ctx) {
    const transport = this.createTransport(ctx)!;
    const adapter = this.createFormat(ctx.modelName);
    log(`[Proxy] Created ${ctx.provider.name} handler (composed): ${ctx.modelName}`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

/**
 * OpenCode Zen / Zen Go — two tiers:
 *   zen/  (opencode-zen):    free anonymous models + full paid access (OPENCODE_API_KEY)
 *   zgo/  (opencode-zen-go): go-plan models (glm-5, minimax-m2.5, kimi-k2.5) via zen/go/v1/
 *
 * Free anonymous models work without a key; uses "public" as fallback for consistent
 * rate-limit bucketing.
 *
 * Model routing inside the profile:
 *   - MiniMax models  → AnthropicProviderTransport + AnthropicAPIFormat
 *   - GPT-* models    → OpenAIProviderTransport (/v1/responses) + CodexAPIFormat (Responses API)
 *   - All other models → OpenAIProviderTransport (/v1/chat/completions) + OpenAIAPIFormat (delta-aware)
 */
const openCodeZenProfile: ProviderProfile = {
  createFormat(m, _p) {
    if (m.toLowerCase().includes("minimax")) return new AnthropicAPIFormat(m, "opencode-zen");
    if (m.toLowerCase().startsWith("gpt-")) return new CodexAPIFormat(m);
    return new OpenAIAPIFormat(m);
  },
  createTransport(ctx) {
    const zenApiKey = ctx.apiKey || "public";
    if (ctx.modelName.toLowerCase().includes("minimax"))
      return new AnthropicProviderTransport(ctx.provider, zenApiKey);
    if (ctx.modelName.toLowerCase().startsWith("gpt-"))
      return new OpenAIProviderTransport({ ...ctx.provider, apiPath: "/v1/responses" }, ctx.modelName, zenApiKey);
    return new OpenAIProviderTransport(ctx.provider, ctx.modelName, zenApiKey);
  },
  createHandler(ctx) {
    const transport = this.createTransport(ctx)!;
    const adapter = this.createFormat(ctx.modelName);
    const label = ctx.provider.name === "opencode-zen-go" ? "Zen Go" : "Zen";
    log(`[Proxy] Created OpenCode ${label} handler (composed): ${ctx.modelName}`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

const ollamaCloudProfile: ProviderProfile = {
  createFormat: (m) => new OllamaAPIFormat(m),
  createTransport: (ctx) => new OllamaProviderTransport(ctx.provider, ctx.apiKey),
  createHandler(ctx) {
    const transport = this.createTransport(ctx)!;
    const adapter = this.createFormat(ctx.modelName);
    log(`[Proxy] Created OllamaCloud handler (composed): ${ctx.modelName}`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

const litellmProfile: ProviderProfile = {
  createFormat: (m) => new LiteLLMAPIFormat(m, process.env.LITELLM_BASE_URL ?? ""),
  createTransport(ctx) {
    if (!ctx.provider.baseUrl) {
      logStderr("Error: LITELLM_BASE_URL or --litellm-url is required for LiteLLM provider.");
      return null;
    }
    return new LiteLLMProviderTransport(ctx.provider.baseUrl, ctx.apiKey, ctx.modelName);
  },
  createHandler(ctx) {
    const transport = this.createTransport(ctx);
    if (!transport) return null;
    const adapter = this.createFormat(ctx.modelName);
    log(`[Proxy] Created LiteLLM handler (composed): ${ctx.modelName} (${ctx.provider.baseUrl})`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

/**
 * Vertex AI — supports two modes:
 *   1. Express Mode (VERTEX_API_KEY) — uses the Gemini API endpoint with a Vertex key.
 *      Uses GeminiProviderTransport (with the gemini provider config) + GeminiAPIFormat.
 *   2. OAuth Mode (VERTEX_PROJECT) — full project-based access with OAuth tokens.
 *      Uses VertexProviderTransport + publisher-specific format (Gemini/Anthropic/Default).
 *
 * Returns null if neither key nor project config is available.
 */
const vertexProfile: ProviderProfile = {
  createFormat(m) {
    const parsed = parseVertexModel(m);
    if (parsed.publisher === "google") return new GeminiAPIFormat(m);
    if (parsed.publisher === "anthropic") return new AnthropicAPIFormat(parsed.model, "vertex");
    const modelId = parsed.publisher === "mistralai" ? parsed.model : `${parsed.publisher}/${parsed.model}`;
    return new DefaultAPIFormat(modelId);
  },
  createTransport(ctx) {
    if (process.env.VERTEX_API_KEY) {
      const geminiConfig = getRegisteredRemoteProviders().find((p) => p.name === "gemini");
      return new GeminiProviderTransport(geminiConfig || ctx.provider, ctx.modelName, process.env.VERTEX_API_KEY);
    }
    const vertexConfig = getVertexConfig();
    if (vertexConfig) {
      const oauthError = validateVertexOAuthConfig();
      if (oauthError) { log(`[Proxy] Vertex OAuth config error: ${oauthError}`); return null; }
      return new VertexProviderTransport(vertexConfig, parseVertexModel(ctx.modelName));
    }
    log(`[Proxy] Vertex AI requires either VERTEX_API_KEY or VERTEX_PROJECT`);
    return null;
  },
  createHandler(ctx) {
    const transport = this.createTransport(ctx);
    if (!transport) return null;
    const adapter = process.env.VERTEX_API_KEY
      ? new GeminiAPIFormat(ctx.modelName)
      : this.createFormat(ctx.modelName);
    log(`[Proxy] Created Vertex AI handler (composed): ${ctx.modelName}`);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, { adapter, ...ctx.sharedOpts });
  },
};

// ---------------------------------------------------------------------------
// Profile table
// ---------------------------------------------------------------------------

/**
 * Maps provider name (as returned by resolveRemoteProvider().provider.name) to its profile.
 *
 * Lookup is O(1). Add new providers here — no changes to proxy-server.ts needed.
 */
export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  gemini: geminiProfile,
  "gemini-codeassist": geminiCodeAssistProfile,
  openai: openaiProfile,
  minimax: anthropicCompatProfile,
  "minimax-coding": anthropicCompatProfile,
  kimi: anthropicCompatProfile,
  "kimi-coding": anthropicCompatProfile,
  zai: anthropicCompatProfile,
  glm: glmProfile,
  "glm-coding": glmProfile,
  "opencode-zen": openCodeZenProfile,
  "opencode-zen-go": openCodeZenProfile,
  ollamacloud: ollamaCloudProfile,
  litellm: litellmProfile,
  vertex: vertexProfile,
};

// ---------------------------------------------------------------------------
// Granular factory functions for non-streaming callers (MCP server, batch)
// ---------------------------------------------------------------------------

/** Resolve the APIFormat (Layer 1) for a provider + model without constructing a handler. */
export function resolveAPIFormat(providerName: string, modelName: string): BaseAPIFormat | null {
  const profile = PROVIDER_PROFILES[providerName];
  return profile ? profile.createFormat(modelName, providerName) : null;
}

/** Resolve the ProviderTransport (Layer 3) for a provider + model + key without constructing a handler. */
export function resolveTransport(ctx: ProfileContext): ProviderTransport | null {
  const profile = PROVIDER_PROFILES[ctx.provider.name];
  return profile ? profile.createTransport(ctx) : null;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a ModelHandler for the given resolved provider using the profile table.
 *
 * Returns null when:
 * - The provider name is not in PROVIDER_PROFILES (unknown provider)
 * - The profile's createHandler() returns null (e.g. missing config)
 */
export function createHandlerForProvider(ctx: ProfileContext): ModelHandler | null {
  const profile = PROVIDER_PROFILES[ctx.provider.name];
  if (!profile) {
    return null; // Unknown provider — caller should fall through to OpenRouter or return null
  }

  // Log API key provenance so debug logs show exactly which key is used and where it came from
  if (ctx.provider.apiKeyEnvVar) {
    const provenance = resolveApiKeyProvenance(ctx.provider.apiKeyEnvVar);
    log(`[Proxy] API key: ${formatProvenanceLog(provenance)}`);
  }
  log(`[Proxy] Handler: provider=${ctx.provider.name}, model=${ctx.modelName}`);

  return profile.createHandler(ctx);
}
