/**
 * Custom Endpoints Loader — reads `config.customEndpoints` and registers each
 * valid entry as a runtime ProviderDefinition + ProviderProfile.
 *
 * Phase 3 of the LiteLLM-demotion refactor. Users declare custom OpenAI- or
 * Anthropic-compatible endpoints in ~/.claudish/config.json and they become
 * first-class providers that work with `--model my-endpoint@some-model`.
 *
 * Validation: each entry is parsed via `CustomEndpointSchema` (Zod). Invalid
 * entries are collected into `result.errors` and reported to stderr — never
 * fatal, so one typo doesn't crash startup.
 *
 * Idempotency: calling twice with the same config is safe. The runtime
 * registry is a Map keyed on endpoint name, so re-registration overwrites.
 */

import { z } from "zod";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { credentials } from "../auth/credentials/authority.js";
import {
  type CustomEndpoint,
  type CustomEndpointComplex,
  CustomEndpointSchema,
  type CustomEndpointSimple,
} from "../config-schema.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import type { ModelHandler } from "../handlers/types.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import type { ProviderDefinition, TransportType } from "./provider-definitions.js";
import type { ProfileContext, ProviderProfile } from "./provider-profiles.js";
import { registerRuntimeProfile, registerRuntimeProvider } from "./runtime-providers.js";
import { AnthropicProviderTransport } from "./transport/anthropic-compat.js";
import { LiteLLMProviderTransport } from "./transport/litellm.js";
import { OpenAIProviderTransport } from "./transport/openai.js";

/**
 * Result of loading custom endpoints from a config object.
 */
export interface LoadResult {
  /** Number of endpoints successfully registered. */
  registered: number;
  /** Names of endpoints that failed validation, with their error messages. */
  errors: Array<{ name: string; message: string }>;
}

/**
 * Validate and register all customEndpoints from a config.
 * Invalid entries are collected into `result.errors` and skipped.
 */
export function loadCustomEndpoints(config: ClaudishProfileConfig): LoadResult {
  const result: LoadResult = { registered: 0, errors: [] };
  const raw = config.customEndpoints;
  if (!raw || typeof raw !== "object") return result;

  for (const [name, entry] of Object.entries(raw)) {
    try {
      const validated = CustomEndpointSchema.parse(entry);
      const def = buildProviderDefinition(name, validated);
      const profile = buildProviderProfile(validated);
      registerRuntimeProvider(def);
      registerRuntimeProfile(name, profile);
      // Register the custom endpoint in the credential authority too, so its key
      // (CUSTOM_<NAME>_KEY — including op:// values) resolves through the single
      // authority like every other provider, instead of an out-of-band env read.
      //
      // `declaredKey` closes over the endpoint's own `apiKey` field so a literal
      // or `${VAR}` declaration ALSO counts as a credential. The authority is the
      // routing pre-flight's oracle (hasCredentialsForProvider / getRequestAuth);
      // registering only the CUSTOM_<NAME>_KEY env var made every `${VAR}` and
      // literal endpoint look uncredentialed, so it was rejected before its
      // handler — which could have resolved the key — was ever constructed.
      credentials.registerApiKeyProvider({
        name: def.name,
        envVar: def.apiKeyEnvVar,
        authScheme: def.authScheme === "x-api-key" ? "x-api-key" : "bearer",
        declaredKey: () => resolveDeclaredEndpointKey(validated),
      });
      result.registered++;
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((i) => i.message).join(", ")
          : err instanceof Error
            ? err.message
            : String(err);
      result.errors.push({ name, message });
    }
  }

  return result;
}

/**
 * Build a ProviderDefinition for a custom endpoint so it appears in lookups
 * (getProviderByName, getAllProviders, etc.). The definition is minimal —
 * real handler construction happens in the profile.
 */
function buildProviderDefinition(name: string, ep: CustomEndpoint): ProviderDefinition {
  if (ep.kind === "simple") {
    return {
      name,
      displayName: name,
      transport: ep.format as TransportType,
      baseUrl: stripTrailingSlash(ep.url),
      apiPath: "/chat/completions",
      apiKeyEnvVar: `CUSTOM_${sanitizeEnvName(name)}_KEY`,
      apiKeyDescription: `${name} (custom endpoint)`,
      apiKeyUrl: "",
      shortcuts: [name],
      legacyPrefixes: [],
      isDirectApi: true,
      shortestPrefix: name,
      description: `Custom endpoint: ${name}`,
      authScheme: "bearer",
    };
  }

  return {
    name,
    displayName: ep.displayName,
    transport: ep.transport as TransportType,
    baseUrl: stripTrailingSlash(ep.baseUrl),
    apiPath: ep.apiPath ?? "/v1/chat/completions",
    apiKeyEnvVar: `CUSTOM_${sanitizeEnvName(name)}_KEY`,
    apiKeyDescription: `${ep.displayName} (custom endpoint)`,
    apiKeyUrl: "",
    shortcuts: [name],
    legacyPrefixes: [],
    isDirectApi: true,
    shortestPrefix: name,
    description: `Custom endpoint: ${ep.displayName}`,
    headers: ep.headers,
    authScheme: ep.authScheme ?? "bearer",
  };
}

/**
 * Build a ProviderProfile for a custom endpoint that creates a ComposedHandler
 * on demand. Modeled after litellmProfile in provider-profiles.ts.
 */
function buildProviderProfile(ep: CustomEndpoint): ProviderProfile {
  return {
    createHandler(ctx: ProfileContext): ModelHandler | null {
      // The key is resolved through the credential authority (proxy-server passes
      // it as ctx.apiKey via getRequestAuth — env → config → op://, lazy SDK).
      // Fall back to the literal/${VAR} resolver only when the authority yielded
      // nothing (e.g. a plain ${VAR} apiKey the authority's env read also covers,
      // or a non-routed construction path). This is the single source of truth —
      // an op:// custom apiKey now resolves correctly instead of signing the
      // literal "op://…" string.
      const apiKey = ctx.apiKey || resolveCustomEndpointApiKey(ep);
      if (ep.kind === "simple") {
        return buildSimpleHandler(ep, ctx, apiKey);
      }
      return buildComplexHandler(ep, ctx, apiKey);
    },
  };
}

function buildSimpleHandler(
  ep: CustomEndpointSimple,
  ctx: ProfileContext,
  apiKey: string
): ModelHandler | null {
  const finalModel = ep.modelPrefix ? `${ep.modelPrefix}${ctx.modelName}` : ctx.modelName;
  const baseUrl = stripTrailingSlash(ep.url);

  if (ep.format === "openai") {
    const remoteProvider: RemoteProvider = {
      name: ctx.provider.name,
      baseUrl,
      apiPath: "/chat/completions",
      apiKeyEnvVar: ctx.provider.apiKeyEnvVar,
      prefixes: ctx.provider.prefixes ?? [],
      headers: ctx.provider.headers,
      authScheme: "bearer",
    };
    const transport = new OpenAIProviderTransport(remoteProvider, finalModel, apiKey);
    const adapter = new OpenAIAPIFormat(finalModel);
    return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
  }

  // anthropic
  const remoteProvider: RemoteProvider = {
    name: ctx.provider.name,
    baseUrl,
    apiPath: "/v1/messages",
    apiKeyEnvVar: ctx.provider.apiKeyEnvVar,
    prefixes: ctx.provider.prefixes ?? [],
    headers: ctx.provider.headers,
    authScheme: ctx.provider.authScheme ?? "x-api-key",
  };
  const transport = new AnthropicProviderTransport(remoteProvider, apiKey);
  const adapter = new AnthropicAPIFormat(finalModel, ctx.provider.name);
  return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
    adapter,
    ...ctx.sharedOpts,
  });
}

function buildComplexHandler(
  ep: CustomEndpointComplex,
  ctx: ProfileContext,
  apiKey: string
): ModelHandler | null {
  const finalModel = ep.modelPrefix ? `${ep.modelPrefix}${ctx.modelName}` : ctx.modelName;
  const baseUrl = stripTrailingSlash(ep.baseUrl);
  const apiPath = ep.apiPath ?? "/v1/chat/completions";

  switch (ep.transport) {
    case "litellm": {
      const transport = new LiteLLMProviderTransport(baseUrl, apiKey, finalModel);
      const adapter = new LiteLLMAPIFormat(finalModel, baseUrl);
      return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
    }
    case "openai": {
      const remoteProvider: RemoteProvider = {
        name: ctx.provider.name,
        baseUrl,
        apiPath,
        apiKeyEnvVar: ctx.provider.apiKeyEnvVar,
        prefixes: ctx.provider.prefixes ?? [],
        headers: ep.headers,
        authScheme: ep.authScheme ?? "bearer",
        streamFormatOverride: ep.streamFormat,
      };
      const transport = new OpenAIProviderTransport(remoteProvider, finalModel, apiKey);
      const adapter = new OpenAIAPIFormat(finalModel);
      return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
        adapter,
        tokenStrategy: "delta-aware",
        ...ctx.sharedOpts,
      });
    }
    case "anthropic": {
      const remoteProvider: RemoteProvider = {
        name: ctx.provider.name,
        baseUrl,
        apiPath,
        apiKeyEnvVar: ctx.provider.apiKeyEnvVar,
        prefixes: ctx.provider.prefixes ?? [],
        headers: ep.headers,
        authScheme: ep.authScheme ?? "x-api-key",
        streamFormatOverride: ep.streamFormat,
      };
      const transport = new AnthropicProviderTransport(remoteProvider, apiKey);
      const adapter = new AnthropicAPIFormat(finalModel, ctx.provider.name);
      return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
    }
    case "gemini":
    case "ollamacloud": {
      // Phase 3 supports openai/anthropic/litellm transports. Gemini and
      // ollamacloud need dedicated transport classes that accept URL+key
      // directly — those signatures aren't currently available. Deferred.
      console.error(
        `[claudish] Custom endpoint '${ep.displayName}' uses transport='${ep.transport}' which is not yet supported by runtime registration. Use transport in {openai, anthropic, litellm}.`
      );
      return null;
    }
  }
}

/**
 * Resolve a custom endpoint's API key, expanding ${VAR_NAME} env var references.
 *
 * Resolution order:
 *  1. `${VAR_NAME}` → process.env[VAR_NAME] (empty string if unset).
 *  2. Anything else → returned as-is (a literal key).
 *
 * NOTE: `op://...` apiKeys are NOT resolved here. They are pre-resolved at
 * startup (index.ts `applyCustomEndpointOpKeys()`) via the SDK into the
 * `CUSTOM_<NAME>_KEY` env var, which `createHandler` reads FIRST. This keeps
 * this function synchronous (handler construction can't await the async SDK).
 * A bare `op://...` literal that reaches here (no pre-resolved env value) is
 * returned verbatim — which the upstream provider will reject as an invalid key.
 *
 * Exported for unit testing.
 */
export function resolveCustomEndpointApiKey(ep: CustomEndpoint): string {
  const literal = ep.apiKey;
  const match = literal.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/i);
  if (match) {
    return process.env[match[1]] ?? "";
  }
  return literal;
}

/**
 * The endpoint's CONFIG-DECLARED key, shaped for the credential authority's
 * sync chain (env → aliases → config.apiKeys → declared).
 *
 * Returns `undefined` — meaning "no declared key, keep resolving" — for:
 *  - an `op://` ref: the authority's ASYNC op-source step owns those (it resolves
 *    them into CUSTOM_<NAME>_KEY). Returning the literal ref here would satisfy
 *    the sync chain and short-circuit that step, signing requests with the
 *    string "op://…" → 401.
 *  - an unset `${VAR}`: resolveCustomEndpointApiKey yields "" — genuinely no
 *    credential, so the endpoint must stay unavailable.
 *
 * Exported for unit testing.
 */
export function resolveDeclaredEndpointKey(ep: CustomEndpoint): string | undefined {
  const declared = ep.apiKey?.trim();
  if (!declared) return undefined;
  if (declared.startsWith("op://")) return undefined;
  return resolveCustomEndpointApiKey(ep) || undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function sanitizeEnvName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
