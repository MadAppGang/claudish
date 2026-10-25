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
import {
  CustomEndpointSchema,
  type CustomEndpoint,
  type CustomEndpointSimple,
  type CustomEndpointComplex,
} from "../config-schema.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import type {
  ProviderDefinition,
  TransportType,
} from "./provider-definitions.js";
import type { ProviderProfile, ProfileContext } from "./provider-profiles.js";
import type { ModelHandler } from "../handlers/types.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import {
  registerRuntimeProvider,
  registerRuntimeProfile,
  registerDeclaredContextLimit,
  getDeclaredContextLimit,
  getDerivedContextLimit,
} from "./runtime-providers.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import { OpenAIProviderTransport } from "./transport/openai.js";
import { AnthropicProviderTransport } from "./transport/anthropic-compat.js";
import { LiteLLMProviderTransport } from "./transport/litellm.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";

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
      // #565 — the admission census weighs every candidate on the request's
      // path before a handler exists, so the declared window is recorded here,
      // at the single site that knows it, rather than dug back out of an
      // endpoint the request may never resolve.
      registerDeclaredContextLimit(name, validated.contextLimit);
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
function buildProviderDefinition(
  name: string,
  ep: CustomEndpoint
): ProviderDefinition {
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
      const apiKey = resolveCustomEndpointApiKey(ep);
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
      // #686 — opt-in, OpenAI wire only (see client-attribution.ts)
      clientAttribution: ep.clientAttribution === true,
    };
    const transport = new OpenAIProviderTransport(remoteProvider, finalModel, apiKey, ep.maxConcurrency);
    const adapter = new OpenAIAPIFormat(finalModel);
    return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      omitReasoningContent: ep.omitReasoningContent,
      effortTarget: ep.effortTarget,
      maxOutputTokens: ep.maxOutputTokens,
      contextLimit: getDeclaredContextLimit(ctx.provider.name),
      derivedContextLimit: getDerivedContextLimit(ctx.provider.name),
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
  const transport = new AnthropicProviderTransport(remoteProvider, apiKey, ep.maxConcurrency);
  const adapter = new AnthropicAPIFormat(finalModel, ctx.provider.name);
  return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
    adapter,
    maxOutputTokens: ep.maxOutputTokens,
    contextLimit: getDeclaredContextLimit(ctx.provider.name),
    derivedContextLimit: getDerivedContextLimit(ctx.provider.name),
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
        effortTarget: ep.effortTarget,
        maxOutputTokens: ep.maxOutputTokens,
        contextLimit: getDeclaredContextLimit(ctx.provider.name),
        derivedContextLimit: getDerivedContextLimit(ctx.provider.name),
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
        // #686 — opt-in, OpenAI wire only (see client-attribution.ts)
        clientAttribution: ep.clientAttribution === true,
      };
      const transport = new OpenAIProviderTransport(remoteProvider, finalModel, apiKey, ep.maxConcurrency);
      const adapter = new OpenAIAPIFormat(finalModel);
      return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
        adapter,
        tokenStrategy: "delta-aware",
        omitReasoningContent: ep.omitReasoningContent,
        effortTarget: ep.effortTarget,
        maxOutputTokens: ep.maxOutputTokens,
        contextLimit: getDeclaredContextLimit(ctx.provider.name),
        derivedContextLimit: getDerivedContextLimit(ctx.provider.name),
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
      const transport = new AnthropicProviderTransport(remoteProvider, apiKey, ep.maxConcurrency);
      const adapter = new AnthropicAPIFormat(finalModel, ctx.provider.name);
      return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
        adapter,
        maxOutputTokens: ep.maxOutputTokens,
        contextLimit: getDeclaredContextLimit(ctx.provider.name),
        derivedContextLimit: getDerivedContextLimit(ctx.provider.name),
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
 * Returns the literal apiKey if not a template, or empty string if the env var
 * is unset.
 *
 * Exported for unit testing.
 */
export function resolveCustomEndpointApiKey(ep: CustomEndpoint): string {
  const literal = ep.apiKey;
  const match = literal.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/i);
  if (!match) return literal;
  return process.env[match[1]] ?? "";
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * #660 r2 — the key a handler records overflow caps under for this endpoint.
 *
 * `ComposedHandler` records and looks up learned caps under
 * `transport.displayName` (composed-handler.ts, `rememberOverflowCap` /
 * `getOverflowCap` sites) — NOT under the `customEndpoints` config key. For a
 * custom endpoint the transport's displayName is computed from the CONFIG KEY
 * by the transport's own `formatDisplayName` (or is the LiteLLM class
 * constant), so "vllm-myia" records as "Vllm-myia". The startup purge that
 * derivation runs must derive the same key, or it purges nothing (#660 r2:
 * measured, 0 purged on a lowercase name).
 *
 * Lives HERE, next to the transport switch in buildSimpleHandler /
 * buildComplexHandler it mirrors: the two must select the same transport for
 * the same endpoint shape, or the key and the recording handler part ways.
 * The call-site pin in context-limit-derivation.test.ts records a cap under a
 * REAL transport's displayName and asserts the purge drops it.
 */
export function customEndpointCapKey(name: string, ep: CustomEndpoint): string {
  if (ep.kind === "complex" && ep.transport === "litellm") {
    // LiteLLMProviderTransport hardcodes displayName = "LiteLLM" for every
    // endpoint it serves — the config name never reaches the key.
    return "LiteLLM";
  }
  const isAnthropicWire =
    (ep.kind === "simple" && ep.format === "anthropic") ||
    (ep.kind === "complex" && ep.transport === "anthropic");
  return isAnthropicWire
    ? AnthropicProviderTransport.formatDisplayName(name)
    : OpenAIProviderTransport.formatDisplayName(name);
}

function sanitizeEnvName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
