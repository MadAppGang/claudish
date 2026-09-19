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

import type { BaseAPIFormat } from "../adapters/base-api-format.js";
import type { ComposedHandlerOptions } from "../handlers/composed-handler.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
// Alias for readability within this file
type BaseModelAdapter = BaseAPIFormat;
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { DefaultAPIFormat } from "../adapters/base-api-format.js";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { DevinAPIFormat } from "../adapters/devin-api-format.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";
import { lookupModelEndpoint } from "../adapters/model-catalog.js";
import { OllamaAPIFormat } from "../adapters/ollama-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import {
  getVertexConfig,
  selectVertexAuthMode,
  validateVertexOAuthConfig,
} from "../auth/vertex-auth.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import type { ModelHandler } from "../handlers/types.js";
import { log, logStderr } from "../logger.js";
import { formatProvenanceLog, resolveApiKeyProvenance } from "./api-key-provenance.js";
import { getProviderByName } from "./provider-definitions.js";
import { getRegisteredRemoteProviders } from "./remote-provider-registry.js";
import { getRuntimeProfiles } from "./runtime-providers.js";
import { AnthropicProviderTransport } from "./transport/anthropic-compat.js";
import { AntigravityProviderTransport } from "./transport/antigravity.js";
import { DevinProviderTransport } from "./transport/devin.js";
import { GeminiProviderTransport } from "./transport/gemini-apikey.js";
import { GrokSubscriptionProviderTransport } from "./transport/grok-subscription.js";
import { LiteLLMProviderTransport } from "./transport/litellm.js";
import { OllamaProviderTransport } from "./transport/ollamacloud.js";
import { OpenAICodexTransport } from "./transport/openai-codex.js";
import { OpenAIProviderTransport } from "./transport/openai.js";
import { OpenCodeZenMessagesTransport, OpenCodeZenTransport } from "./transport/opencode-zen.js";
import { PoeProvider } from "./transport/poe.js";
import { VertexProviderTransport, parseVertexModel } from "./transport/vertex-oauth.js";

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
  /**
   * Catalog cache path override — a TEST SEAM, unset in production.
   *
   * `requiresResponsesApi` reads the model catalog, which made the composition
   * table in `provider-profiles.test.ts` depend on whichever
   * `~/.claudish/all-models.json` the machine happened to have. That is the
   * v7.43.0 trap: green on every dev box, and a different answer on a cold CI
   * runner. Passing a fixture path here keeps that table hermetic.
   */
  catalogCachePath?: string;
  /**
   * Shared ComposedHandler options from the outer scope.
   *
   * Every profile spreads this verbatim, so widening this Pick is how a new
   * handler option reaches all ~25 profile and custom-endpoint construction
   * sites at once. An option added to ComposedHandlerOptions but NOT listed
   * here is dropped by the spread with no error — the feature then works on
   * the direct proxy-server routes and silently not on any profile.
   */
  sharedOpts: Pick<
    ComposedHandlerOptions,
    "isInteractive" | "invocationMode" | "effortOverride" | "modelParams" | "proOnUltracode"
  >;
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

export const geminiProfile: ProviderProfile = {
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

export const antigravityProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new AntigravityProviderTransport(ctx.modelName);
    const adapter = new GeminiAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      unwrapGeminiResponse: true,
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created Antigravity handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

export const devinProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new DevinProviderTransport(ctx.modelName);
    const adapter = new DevinAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      // Devin serves uids like `claude-sonnet-5-medium`, which match the
      // behavior engine's `^claude-` "native Anthropic" test — so without this
      // the Layer 4 supervisor would switch OFF for exactly the models most
      // likely to need it, on the strength of a name. The 87/87 plan-mode
      // measurement behind that rule is about Claude reached through
      // Anthropic's own harness, and says nothing about a `claude-*` uid
      // re-served by a third party over a reverse-engineered protobuf endpoint.
      forceForeignModel: true,
      ...ctx.sharedOpts,
    });
    // No tokenStrategy: Devin reports the FULL input each turn in field 28,
    // which is "standard" (assignment) semantics — the default.
    log(`[Proxy] Created Devin handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

/**
 * Models OpenAI will not serve over /v1/chat/completions.
 *
 * Two different reasons, one remedy. `gpt-5.6` rejects function tools together
 * with reasoning_effort ("use /v1/responses or set reasoning_effort to 'none'").
 * A `*codex*` model rejects the endpoint outright, and says so in as many words
 * — measured 2026-08-10 straight against api.openai.com with `gpt-5.3-codex`:
 *
 *   POST /v1/chat/completions → 404 "This model is not supported in the
 *                                    v1/chat/completions endpoint. Use the
 *                                    v1/responses endpoint instead."
 *   POST /v1/responses        → 200
 *
 * So this is not the tools-plus-reasoning constraint wearing a second face; it
 * is a flatly Responses-only model. Claude Code sends tools on essentially every
 * request, which made every codex id unusable through `oai@` rather than merely
 * degraded.
 *
 * THE SUBSTRING TEST IS LOAD-BEARING, and it is not a style choice.
 * `OpenAIProviderTransport` has carried the same rule since long before this —
 * `modelName.toLowerCase().includes("codex")` decides both its stream format
 * (openai.ts:31) and its endpoint (openai.ts:37) — so Layer 3 was ALREADY
 * sending every codex id to /v1/responses. Only Layer 1 disagreed: this gate
 * matched `gpt-5.6` alone, so `openaiProfile` built an OpenAIAPIFormat and put
 * a Chat Completions body on a Responses endpoint. That mismatch is the whole
 * failure, and it is exactly what OpenAI reported back:
 *
 *   400 unsupported_parameter — "Unsupported parameter: 'messages'. In the
 *   Responses API, this parameter has moved to 'input'."
 *
 * Right endpoint, wrong body. Any narrowing of this test (a `/^gpt-.*codex/`
 * prefix, an explicit id list) silently re-opens the split, because the
 * transport will keep routing ids this function no longer claims. The two tests
 * must stay identical; a test pins their agreement.
 *
 * THE GATE IS HOST-BLIND, and the comment here used to say otherwise ("only
 * OpenAI-served ids reach this gate"). `openaiProfile` is many-to-one — it also
 * serves x-ai, qwen, deepseek and mistralai (`provider-definitions.ts:228`) — so
 * every one of those hosts reaches this function. `endpoints.openai` is keyed by
 * TRANSPORT FAMILY, not by host, so the catalog cannot say "responses on OpenAI,
 * chat completions on x-ai" about one model id.
 *
 * Measured 2026-09-09 against the live catalog, nothing is mis-served by that:
 * all 8 Responses-only ids are `gpt-*`, which no other host under this profile
 * carries. The exposure is a future id served by two hosts on different APIs.
 *
 * `cx@` really is untouched, for a different reason than the old comment gave:
 * `openaiCodexProfile` builds `CodexAPIFormat` unconditionally and never calls
 * this function at all.
 *
 * Pick the verification model carefully. /v1/models is a CATALOGUE, not a served
 * set: of those six ids, only `gpt-5.3-codex` actually answers 200 on
 * /v1/responses for the developer's account — the rest return 404 "Model not
 * found" there, and `gpt-5-codex` is additionally reported DEPRECATED on
 * /v1/chat/completions. Testing against any of them looks exactly like "the
 * routing fix did not work" when the model is simply not being served. Same
 * catalogue-vs-served-set trap the Antigravity and Devin providers document.
 *
 * THE CATALOG MAY ONLY WIDEN THIS GATE, NEVER NARROW IT. The name rule stays an
 * unconditional `||` below for the reason above: the transport routes every
 * `*codex*` id to /v1/responses on its own, so a catalog record that said "chat
 * completions" for one would restore the split in the other direction —
 * OpenAIAPIFormat's body on a Responses endpoint.
 *
 * The name rule alone could not stay correct, which is what this comment
 * predicted and what then happened. `gpt-6-astra` shipped 2026-09-03, matches
 * neither pattern, and is Responses-only. Its Chat Completions body carried the
 * catalog's own `tokenParam` and was rejected:
 *
 *   400 unknown_parameter — "Unknown parameter: 'max_output_tokens'."
 *
 * `max_output_tokens` is the Responses spelling. claudish was already reading
 * half of the catalog's endpoint contract — `tokenParam`, via
 * `OpenAIAPIFormat.tokenParamName` — while ignoring the sibling field that says
 * which wire API that spelling belongs to. Reading both is the fix. The name
 * rule survives only as the cold-cache fallback, where the catalog has no
 * opinion to read.
 *
 * @param cachePath Test seam. Points the catalog lookup at a fixture, so a test
 *   never depends on a warm `~/.claudish/all-models.json`.
 */
export function requiresResponsesApi(modelName: string, cachePath?: string): boolean {
  const endpoint = lookupModelEndpoint(modelName, "openai", cachePath);
  if (endpoint?.api === "responses" || endpoint?.toolsWithReasoning === "requires-responses") {
    return true;
  }

  const name = modelName.toLowerCase();
  return /^gpt-5\.6/.test(name) || name.includes("codex");
}

/**
 * Grok Build subscription.
 *
 * Ordinary OpenAI Chat Completions on the wire, so this is the standard
 * OpenAIAPIFormat composition — the only substitution is the transport, which
 * signs from the credential authority (6-hour token, refreshed) and adds the two
 * client-identity headers the proxy requires.
 *
 * The empty api key is intentional: `GrokSubscriptionProviderTransport`
 * overrides `getHeaders()` entirely, so the base class's key is never consulted.
 */
export const grokSubscriptionProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new GrokSubscriptionProviderTransport(ctx.provider, ctx.modelName, "");
    const adapter = new OpenAIAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created Grok subscription handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

export const openaiProfile: ProviderProfile = {
  createHandler(ctx) {
    // Claude Code always sends tools, so requires-responses models must get the
    // whole Responses-API slice (endpoint + CodexAPIFormat payload + responses
    // SSE) swapped together — same composition the Zen profile uses for gpt-*.
    if (requiresResponsesApi(ctx.modelName, ctx.catalogCachePath)) {
      const responsesProvider = { ...ctx.provider, apiPath: "/v1/responses" };
      const transport = new OpenAIProviderTransport(responsesProvider, ctx.modelName, ctx.apiKey);
      const adapter = new CodexAPIFormat(ctx.modelName);
      const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
        adapter,
        tokenStrategy: "delta-aware",
        ...ctx.sharedOpts,
      });
      log(`[Proxy] Created OpenAI handler (Responses API composed): ${ctx.modelName}`);
      return handler;
    }

    const transport = new OpenAIProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey);
    const adapter = new OpenAIAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created OpenAI handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

export const poeProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new PoeProvider();
    const adapter = new OpenAIAPIFormat(ctx.modelName);
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
  },
};

/** OpenAI Codex — uses the Responses API (/v1/responses) with CodexAPIFormat.
 *  Uses OpenAICodexTransport which checks for OAuth credentials first (ChatGPT subscription),
 *  falling back to API key (OPENAI_CODEX_API_KEY). */
export const openaiCodexProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new OpenAICodexTransport(ctx.provider, ctx.modelName, ctx.apiKey);
    const adapter = new CodexAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created OpenAI Codex handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

/** Shared profile for MiniMax, Kimi, Kimi Coding, and Z.AI (all Anthropic-compatible APIs) */
export const anthropicCompatProfile: ProviderProfile = {
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
export const glmProfile: ProviderProfile = {
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
 * OpenCode Zen and Go use model-specific wire APIs. The official endpoint tables
 * assign Qwen to Messages on both products, MiniMax to Messages on Go, GPT to
 * Responses, and most other listed families to Chat Completions. All paths
 * carry a stable per-conversation session header and the resolved product key.
 */
export const openCodeZenProfile: ProviderProfile = {
  createHandler(ctx) {
    const zenApiKey = ctx.apiKey;
    const isGoProvider = ctx.provider.name === "opencode-zen-go";
    const model = ctx.modelName.toLowerCase();

    // OpenCode serves these model families over its Anthropic Messages endpoint.
    // The Go MiniMax route differs from the metered Zen route.
    if (
      model.startsWith("qwen3") ||
      (!isGoProvider && model.startsWith("claude-")) ||
      (isGoProvider && model.startsWith("minimax-"))
    ) {
      const messagesProvider = {
        ...ctx.provider,
        apiPath: "/v1/messages",
        authScheme: "x-api-key" as const,
      };
      const transport = new OpenCodeZenMessagesTransport(messagesProvider, zenApiKey);
      const adapter = new AnthropicAPIFormat(ctx.modelName, ctx.provider.name);
      return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
    }

    // GPT models are served via the OpenAI Responses API (/v1/responses), not /v1/chat/completions.
    if (model.startsWith("gpt-") || (!isGoProvider && model.startsWith("grok-"))) {
      const responsesProvider = { ...ctx.provider, apiPath: "/v1/responses" };
      const transport = new OpenCodeZenTransport(responsesProvider, ctx.modelName, zenApiKey);
      const adapter = new CodexAPIFormat(ctx.modelName);
      const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
        adapter,
        tokenStrategy: "delta-aware",
        ...ctx.sharedOpts,
      });
      log(
        `[Proxy] Created OpenCode Zen${isGoProvider ? " Go" : ""} (Responses API composed): ${ctx.modelName}`
      );
      return handler;
    }

    const transport = new OpenCodeZenTransport(ctx.provider, ctx.modelName, zenApiKey);
    const adapter = new OpenAIAPIFormat(ctx.modelName);
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created OpenCode Zen${isGoProvider ? " Go" : ""} (composed): ${ctx.modelName}`);
    return handler;
  },
};

export const ollamaCloudProfile: ProviderProfile = {
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

export const litellmProfile: ProviderProfile = {
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
    log(`[Proxy] Created LiteLLM handler (composed): ${ctx.modelName} (${ctx.provider.baseUrl})`);
    return handler;
  },
};

/**
 * Vertex AI — supports two modes:
 *   1. OAuth Mode (VERTEX_PROJECT) — full project-based access with OAuth tokens.
 *      Uses VertexProviderTransport + publisher-specific format (Gemini/Anthropic/Default).
 *   2. Express Mode (VERTEX_API_KEY) — used when no project is configured.
 *      Uses GeminiProviderTransport (with the gemini provider config) + GeminiAPIFormat.
 *
 * Returns null if neither key nor project config is available.
 */
export const vertexProfile: ProviderProfile = {
  createHandler(ctx) {
    const mode = selectVertexAuthMode();
    const vertexConfig = getVertexConfig();

    if (mode === "project" && vertexConfig) {
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
        const modelId =
          parsed.publisher === "mistralai" ? parsed.model : `${parsed.publisher}/${parsed.model}`;
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

    if (mode === "express") {
      // Express Mode — Vertex Express uses the standard Gemini API endpoint
      // but with VERTEX_API_KEY instead of GEMINI_API_KEY.
      // Must use the Gemini provider config (which has the correct baseUrl/apiPath)
      // because the vertex provider config has empty baseUrl/apiPath (designed for OAuth mode).
      const geminiConfig = getRegisteredRemoteProviders().find((p) => p.name === "gemini");
      const expressProvider = geminiConfig || ctx.provider;
      // ctx.apiKey is the authority-resolved Vertex credential (Express key when
      // VERTEX_API_KEY is set) — single source of truth, no raw env read here.
      const transport = new GeminiProviderTransport(expressProvider, ctx.modelName, ctx.apiKey);
      const adapter = new GeminiAPIFormat(ctx.modelName);
      const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
      log(`[Proxy] Created Vertex AI Express handler (composed): ${ctx.modelName}`);
      return handler;
    }

    log("[Proxy] Vertex AI requires either VERTEX_API_KEY or VERTEX_PROJECT");
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
export async function createHandlerForProvider(ctx: ProfileContext): Promise<ModelHandler | null> {
  // `ctx.provider` is a RemoteProvider, so its name is the RUNTIME one, and
  // toRemoteProvider renames exactly one provider on the way through:
  // google -> gemini. Reversing it here keeps that rename in the two places
  // that perform it, instead of forcing a second handler table keyed by the
  // post-rename name — which is what the old PROVIDER_PROFILES map was, and why
  // it carried a `gemini` key for a builtin called `google`.
  const definitionName = ctx.provider.name === "gemini" ? "google" : ctx.provider.name;
  const factory =
    getProviderByName(definitionName)?.createHandler ??
    getRuntimeProfiles().get(ctx.provider.name)?.createHandler;

  if (!factory) {
    return null; // Unknown provider — caller should fall through to OpenRouter or return null
  }
  if (typeof factory !== "function") {
    // A documented "builds nothing here" — local, virtual, dedicated handler or
    // an unimplemented transport. Returning null is the same answer the missing
    // map entry used to give, except now the reason is recorded next to it.
    log(`[Proxy] ${ctx.provider.name} builds no handler here (${factory.reason}): ${factory.note}`);
    return null;
  }

  // Log API key provenance so debug logs show exactly which key is used and where it came from
  if (ctx.provider.apiKeyEnvVar) {
    const provenance = resolveApiKeyProvenance(ctx.provider.apiKeyEnvVar);
    log(`[Proxy] API key: ${formatProvenanceLog(provenance)}`);
  }
  log(`[Proxy] Handler: provider=${ctx.provider.name}, model=${ctx.modelName}`);

  return factory(ctx);
}
