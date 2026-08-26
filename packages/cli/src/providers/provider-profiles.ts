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
import { OllamaAPIFormat } from "../adapters/ollama-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { getVertexConfig, validateVertexOAuthConfig } from "../auth/vertex-auth.js";
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
 * Only OpenAI-served ids reach this gate — it lives inside `openaiProfile`, so
 * `cx@` (Responses-only by construction) and every other provider are untouched.
 *
 * Pick the verification model carefully. /v1/models is a CATALOGUE, not a served
 * set: of those six ids, only `gpt-5.3-codex` actually answers 200 on
 * /v1/responses for the developer's account — the rest return 404 "Model not
 * found" there, and `gpt-5-codex` is additionally reported DEPRECATED on
 * /v1/chat/completions. Testing against any of them looks exactly like "the
 * routing fix did not work" when the model is simply not being served. Same
 * catalogue-vs-served-set trap the Antigravity and Devin providers document.
 *
 * Still a PER-MODEL constraint and still a TEMPORARY name gate — replaced by
 * the catalog capability record (endpoints.openai.toolsWithReasoning ===
 * "requires-responses") once route-time capability fetch lands.
 */
function requiresResponsesApi(modelName: string): boolean {
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
    if (requiresResponsesApi(ctx.modelName)) {
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
 * OpenCode Zen / Zen Go — two tiers:
 *   zen/  (opencode-zen):    OPENCODE_API_KEY
 *   zgo/  (opencode-zen-go): go-plan models (glm-5, minimax-m2.5, kimi-k2.5) via zen/go/v1/
 *
 * ZEN REQUIRES A REAL KEY (changed 2026-08-22). The catalog used to declare
 * `publicKeyFallback: "public"`, so the credential authority emitted the literal
 * string "public" whenever no real key resolved and `ctx.apiKey` was always
 * populated here. Measured: the endpoint answers `401 — Missing API key` to
 * that token, so the "free anonymous" tier it modelled does not exist (or no
 * longer does). The affordance is removed entirely; `ctx.apiKey` can now be
 * empty here, exactly as for any other keyed provider without a key.
 *
 * Model routing inside the profile:
 *   - GPT-* models    → OpenAIProviderTransport (/v1/responses) + CodexAPIFormat (Responses API)
 *   - All other models → OpenAIProviderTransport (/v1/chat/completions) + OpenAIAPIFormat (delta-aware)
 *
 * MiniMax models take the SAME OpenAI path as everything else. They briefly had
 * their own Anthropic branch (AnthropicProviderTransport + AnthropicAPIFormat),
 * added to cure a `401 {"type":"AuthError","message":"Missing API key."}` — but
 * that 401 was purely an auth-HEADER problem: the Anthropic transport defaults to
 * `x-api-key` and only sends Bearer when the provider declares
 * `authScheme: "bearer"`, which neither Zen definition does (their own OpenAI
 * transport is Bearer-only, so they never needed to). Swapping in an entire
 * transport+format pair to fix a header carried an endpoint assumption that does
 * not hold here: AnthropicProviderTransport builds its URL as
 * `baseUrl + provider.apiPath`, and BOTH Zen tiers declare
 * `apiPath: "/v1/chat/completions"`. So an Anthropic-shaped body was being posted
 * to an OpenAI endpoint.
 *
 * That survived verification because a tool-free Anthropic body is close enough to
 * an OpenAI one to be accepted. Tools are where the shapes diverge: Anthropic tools
 * carry `input_schema` and NO `type` field, and MiniMax validates them OpenAI-style,
 * reporting the missing type as empty. Measured live 2026-08-08 against
 * `opencode.ai/zen/go/v1/chat/completions`:
 *
 *   anthropic body + tools  → 400 "invalid params, invalid tool type:  (2013)"
 *   anthropic body, NO tools → 200        ← why the original fix looked correct
 *   openai body + tools      → 200
 *   openai body + tools + stream → 200, real tool_calls frames (m2.5 and m3)
 *   anthropic body → /v1/messages → 401 AuthError (no usable Anthropic route)
 *
 * Every Claude Code request carries tools, so this failed 100% of real turns. The
 * non-Go tier is structurally identical (same apiPath, same transport) and shares
 * the fix; it could not be re-measured without an OPENCODE_API_KEY.
 */
export const openCodeZenProfile: ProviderProfile = {
  createHandler(ctx) {
    const zenApiKey = ctx.apiKey;
    const isGoProvider = ctx.provider.name === "opencode-zen-go";

    // GPT models are served via the OpenAI Responses API (/v1/responses), not /v1/chat/completions.
    if (ctx.modelName.toLowerCase().startsWith("gpt-")) {
      const responsesProvider = { ...ctx.provider, apiPath: "/v1/responses" };
      const transport = new OpenAIProviderTransport(responsesProvider, ctx.modelName, zenApiKey);
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

    const transport = new OpenAIProviderTransport(ctx.provider, ctx.modelName, zenApiKey);
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
 *   1. Express Mode (VERTEX_API_KEY) — uses the Gemini API endpoint with a Vertex key.
 *      Uses GeminiProviderTransport (with the gemini provider config) + GeminiAPIFormat.
 *   2. OAuth Mode (VERTEX_PROJECT) — full project-based access with OAuth tokens.
 *      Uses VertexProviderTransport + publisher-specific format (Gemini/Anthropic/Default).
 *
 * Returns null if neither key nor project config is available.
 */
export const vertexProfile: ProviderProfile = {
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
