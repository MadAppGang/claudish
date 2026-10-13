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
import { GrokModelDialect } from "../adapters/grok-model-dialect.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";
import { OllamaAPIFormat } from "../adapters/ollama-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import {
  resolveVertexConfig,
  selectVertexAuthMode,
  validateVertexOAuthConfig,
} from "../auth/vertex-auth.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import type { ModelHandler } from "../handlers/types.js";
import { log, logStderr } from "../logger.js";
import { formatProvenanceLog, resolveCredentialProvenance } from "./api-key-provenance.js";
import { declaredConnection, declaredWire } from "./declared-wire.js";
import { getProviderByName } from "./provider-definitions.js";
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
import { OpenCodeZenTransport } from "./transport/opencode-zen.js";
import { PoeProvider } from "./transport/poe.js";
import { VertexProviderTransport, parseVertexModel } from "./transport/vertex-oauth.js";
import { RefusingHandler, buildWireHandler } from "./wire-handler.js";

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
   * `buildWireHandler` reads the model catalog, which made the composition
   * table in `provider-profiles.test.ts` depend on whichever
   * `~/.claudish/cloud-models-catalog-v3.json` the machine happened to have. That is the
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
    | "isInteractive"
    | "invocationMode"
    | "effortOverride"
    | "modelParams"
    | "proOnUltracode"
    | "wireMode"
    | "wireSpeed"
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

/**
 * A profile whose construction needs I/O before it can build anything.
 *
 * Only Vertex needs this: its endpoint is built from a project that may have to
 * be read out of the ADC file or `gcloud config`. Kept as a SEPARATE type rather
 * than widening `ProviderProfile.createHandler` to a union, because a union
 * return type would force every existing caller of a sync profile to disambiguate
 * a Promise it will never receive.
 *
 * `LazyHandlerFactory` (provider-definitions.ts) already returns a Promise, so a
 * definition wires this exactly like a sync profile and nothing downstream
 * changes.
 */
export interface AsyncProviderProfile {
  createHandler(ctx: ProfileContext): Promise<ModelHandler | null>;
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
      // The subscription serves Grok models only and publishes no catalog wire
      // (its account decides what it serves), so the profile names the Grok
      // dialect: its effort encoding with learn-on-400 recovery.
      dialect: new GrokModelDialect(ctx.modelName, adapter.getStreamFormat()),
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
    log(`[Proxy] Created Grok subscription handler (composed): ${ctx.modelName}`);
    return handler;
  },
};

/**
 * OpenAI-compatible Chat Completions, for a provider the catalog does not route.
 * A catalog connection never reaches this profile: `buildWireHandler` builds it
 * from `wire.api` and the registry (Responses included), so no model name here
 * decides an API.
 */
export const openaiProfile: ProviderProfile = {
  createHandler(ctx) {
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
 * OpenCode Zen and Go. Each model's API (Chat, Responses or Messages) is its
 * catalog connection's `wire.api`, built by `buildWireHandler`; this profile
 * runs only when the catalog does not route the provider, and then speaks
 * Chat Completions. The model-family list that used to choose the API here
 * (qwen3/claude-/minimax- → Messages, gpt-/grok- → Responses) is gone.
 */
export const openCodeZenProfile: ProviderProfile = {
  createHandler(ctx) {
    const transport = new OpenCodeZenTransport(ctx.provider, ctx.modelName, ctx.apiKey);
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
    // LiteLLM has no catalog connection; the documented default wire applies
    // (chat, max_tokens, no reasoning field) rather than a name-picked dialect.
    const connection = declaredConnection(
      "litellm",
      ctx.modelName,
      ctx.provider.baseUrl,
      declaredWire("chat-completions", undefined)
    );
    const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      adapter,
      ...ctx.sharedOpts,
      connection,
    });
    log(`[Proxy] Created LiteLLM handler (composed): ${ctx.modelName} (${ctx.provider.baseUrl})`);
    return handler;
  },
};

/**
 * Vertex AI — ONE mode: OAuth over a Google Cloud project.
 *
 * Uses VertexProviderTransport + a publisher-specific format
 * (Gemini/Anthropic/Default). The project comes from `resolveVertexConfig`
 * (VERTEX_PROJECT, the ADC file's quota_project_id, or `gcloud config`), and the
 * token from the credential authority via the transport.
 *
 * The Express API-key mode (VERTEX_API_KEY on the plain Gemini endpoint) was
 * deleted on 2026-09-21. Returns null when no project resolves or no ADC /
 * service-account credential is present, having logged which of the two it was.
 *
 * ASYNC because project resolution is: it may read the ADC file or shell out to
 * gcloud. That is why this is an AsyncProviderProfile rather than a
 * ProviderProfile — the sync contract every other provider meets cannot express
 * an I/O-backed endpoint.
 */
export const vertexProfile: AsyncProviderProfile = {
  async createHandler(ctx) {
    const configError = await validateVertexOAuthConfig();
    const vertexConfig = await resolveVertexConfig();
    if (
      configError ||
      !vertexConfig ||
      selectVertexAuthMode({ project: vertexConfig.projectId }) !== "project"
    ) {
      log(`[Proxy] Vertex AI is not usable: ${configError ?? "no Google Cloud project resolved"}`);
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

  // Log credential provenance so debug logs show exactly which credential is in
  // use and where it came from. Provider-aware: Vertex's `apiKeyEnvVar` holds a
  // PROJECT id, which may come from the ADC file or `gcloud config`, so the
  // env-only reading logged "VERTEX_PROJECT=(not set)" for a working install.
  if (ctx.provider.apiKeyEnvVar) {
    const provenance = resolveCredentialProvenance(definitionName, ctx.provider.apiKeyEnvVar);
    log(`[Proxy] Credential: ${formatProvenanceLog(provenance)}`);
  }
  log(`[Proxy] Handler: provider=${ctx.provider.name}, model=${ctx.modelName}`);

  // A catalog connection is built from its wire and the route registry; the
  // provider's own profile only for providers the catalog does not route.
  const wired = await buildWireHandler(ctx, definitionName);
  switch (wired.kind) {
    case "handler":
      return wired.handler;
    case "refused":
      return new RefusingHandler(wired.message);
    case "not-wire-routed":
      break;
  }

  return factory(ctx);
}
