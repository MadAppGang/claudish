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
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { AnthropicProviderTransport } from "./transport/anthropic-compat.js";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { OllamaProviderTransport } from "./transport/ollamacloud.js";
import { OllamaAPIFormat } from "../adapters/ollama-api-format.js";
import { LiteLLMProviderTransport } from "./transport/litellm.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";
import { VertexProviderTransport, parseVertexModel } from "./transport/vertex-oauth.js";
import { DefaultAPIFormat } from "../adapters/base-api-format.js";
import { OpenRouterProvider } from "./transport/openrouter.js";
import { getRegisteredRemoteProviders } from "./remote-provider-registry.js";
import { getVertexConfig, validateVertexOAuthConfig } from "../auth/vertex-auth.js";
import { log, logStderr } from "../logger.js";
import { resolveApiKeyProvenance, formatProvenanceLog } from "./api-key-provenance.js";
import type { ModelHandler } from "../handlers/types.js";
import { isOpenAIResponsesModel } from "../adapters/openai-reasoning.js";

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
  /**
   * Attempt to create a ModelHandler for this provider.
   *
   * Returns null if the provider config is invalid (e.g. missing LITELLM_BASE_URL).
   * Returning null causes proxy-server.ts to skip caching and fall through.
   */
  createHandler(ctx: ProfileContext): ModelHandler | null;
}

// ---------------------------------------------------------------------------
// Profile implementations
// ---------------------------------------------------------------------------

function createOpenAIAdapter(modelName: string): BaseModelAdapter {
  const usesResponsesAPI =
    isOpenAIResponsesModel(modelName) || modelName.toLowerCase().includes("codex");
  return usesResponsesAPI ? new CodexAPIFormat(modelName) : new OpenAIAPIFormat(modelName);
}

const geminiProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new GeminiProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey);
    const adapter = new GeminiAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created Gemini handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

const geminiCodeAssistProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new GeminiCodeAssistProviderTransport(ctx.modelName);
    const adapter = new GeminiAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      unwrapGeminiResponse: true,
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created Gemini Code Assist handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

const openaiProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new OpenAIProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey);
    const adapter = createOpenAIAdapter(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created OpenAI handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

/** Shared profile for MiniMax, Kimi, Kimi Coding, and Z.AI (all Anthropic-compatible APIs) */
const anthropicCompatProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new AnthropicProviderTransport(ctx.provider, ctx.apiKey);
    const adapter = new AnthropicAPIFormat(ctx.modelName, ctx.provider.name);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created ${ctx.provider.name} handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

/** GLM and GLM Coding Plan use the OpenAI-compatible API */
const glmProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new OpenAIProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey);
    const adapter = new OpenAIAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created ${ctx.provider.name} handler (composed): ${ctx.modelName}`);
    return handler;
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
 *   - MiniMax models → AnthropicProviderTransport + AnthropicAPIFormat
 *   - All other models → OpenAIProviderTransport + OpenAI/Codex adapter (delta-aware)
 */
const openCodeZenProfile: ProviderProfile = {
  createHandler(ctx) {
    const zenApiKey = ctx.apiKey || "public";
    const isGoProvider = ctx.provider.name === "opencode-zen-go";

    if (ctx.modelName.toLowerCase().includes("minimax")) {
      const transport = new AnthropicProviderTransport(ctx.provider, zenApiKey);
      const adapter = new AnthropicAPIFormat(ctx.modelName, ctx.provider.name);
      const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
      log(
        `[Proxy] Created OpenCode Zen${isGoProvider ? " Go" : ""} (Anthropic composed): ${ctx.modelName}`
      );
      return handler;
    }

    const transport = new OpenAIProviderTransport(ctx.provider, ctx.modelName, zenApiKey);
    const adapter = createOpenAIAdapter(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
    log(
      `[Proxy] Created OpenCode Zen${isGoProvider ? " Go" : ""} (composed): ${ctx.modelName}`
    );
    return handler;
  },
};

const ollamaCloudProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new OllamaProviderTransport(ctx.provider, ctx.apiKey);
    const adapter = new OllamaAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "accumulate-both",
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created OllamaCloud handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

const litellmProfile: ProviderProfile = {
  createHandler(ctx) {
    if (!ctx.provider.baseUrl) {
      logStderr("Error: LITELLM_BASE_URL or --litellm-url is required for LiteLLM provider.");
      logStderr("Set it with: export LITELLM_BASE_URL='https://your-litellm-instance.com'");
      logStderr(
        "Or use: claudish --litellm-url https://your-instance.com --model litellm@model 'task'"
      );
      return null;
    }
    const transport = new LiteLLMProviderTransport(ctx.provider.baseUrl, ctx.apiKey, ctx.modelName);
    const adapter = new LiteLLMAPIFormat(ctx.modelName, ctx.provider.baseUrl);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      ...ctx.sharedOpts,
    });
    log(
      `[Proxy] Created LiteLLM handler (composed): ${ctx.modelName} (${ctx.provider.baseUrl})`
    );
    return handler;
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
  createHandler(ctx) {
    const hasApiKey = !!process.env.VERTEX_API_KEY;
    const vertexConfig = getVertexConfig();

    if (hasApiKey) {
      // Express Mode — Vertex Express uses the standard Gemini API endpoint
      // but with VERTEX_API_KEY instead of GEMINI_API_KEY.
      // Must use the Gemini provider config (which has the correct baseUrl/apiPath)
      // because the vertex provider config has empty baseUrl/apiPath (designed for OAuth mode).
      const geminiConfig = getRegisteredRemoteProviders().find((p) => p.name === "gemini");
      const expressProvider = geminiConfig || ctx.provider;
      const transport = new GeminiProviderTransport(
        expressProvider,
        ctx.modelName,
        process.env.VERTEX_API_KEY!
      );
      const adapter = new GeminiAPIFormat(ctx.modelName);
      const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
      log(`[Proxy] Created Vertex AI Express handler (composed): ${ctx.modelName}`);
      return handler;
    }

    if (vertexConfig) {
      // OAuth Mode — ComposedHandler with publisher-specific adapter
      const oauthError = validateVertexOAuthConfig();
      if (oauthError) {
        log(`[Proxy] Vertex OAuth config error: ${oauthError}`);
        return null;
      }
      const parsed = parseVertexModel(ctx.modelName);
      const transport = new VertexProviderTransport(vertexConfig, parsed);

      let adapter: BaseModelAdapter;
      if (parsed.publisher === "google") {
        adapter = new GeminiAPIFormat(ctx.modelName);
      } else if (parsed.publisher === "anthropic") {
        adapter = new AnthropicAPIFormat(parsed.model, "vertex");
      } else {
        // Mistral/Meta use OpenAI format; Mistral rawPredict uses bare model name
        const modelId =
          parsed.publisher === "mistralai"
            ? parsed.model
            : `${parsed.publisher}/${parsed.model}`;
        adapter = new DefaultAPIFormat(modelId);
      }

      const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
      log(
        `[Proxy] Created Vertex AI OAuth handler (composed): ${ctx.modelName} [${parsed.publisher}] (project: ${vertexConfig.projectId})`
      );
      return handler;
    }

    log(`[Proxy] Vertex AI requires either VERTEX_API_KEY or VERTEX_PROJECT`);
    return null;
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
