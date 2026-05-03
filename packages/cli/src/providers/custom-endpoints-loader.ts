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
      validateResolvedApiKey(name, validated);
      const def = buildProviderDefinition(name, validated);
      const profile = buildProviderProfile(validated);
      registerRuntimeProvider(def);
      registerRuntimeProfile(name, profile);
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
      apiKeyEnvVar: "",
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
    apiKeyEnvVar: "",
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

function validateResolvedApiKey(name: string, ep: CustomEndpoint): void {
  const apiKey = resolveCustomEndpointApiKey(ep);
  if (apiKey.length === 0) {
    throw new Error(`apiKey for custom endpoint '${name}' resolved to an empty value`);
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
