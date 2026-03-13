/**
 * Provider Factory — creates transport + adapter for a ProviderDefinition.
 *
 * Separated from provider-definitions.ts so that the definitions module
 * has no concrete adapter imports, breaking the circular dependency that
 * prevented adapters from importing model-parser utilities.
 */

import type { ProviderDefinition } from "./provider-definitions.js";
import type { ProviderTransport } from "./transport/types.js";
import type { FormatAdapter } from "../adapters/format-adapter.js";
import type { TransportConfig } from "./transport/base.js";
import { getEffectiveBaseUrl } from "./provider-definitions.js";

// Transport imports
import { GeminiApiKeyTransport } from "./transport/gemini-apikey.js";
import { GeminiCodeAssistTransport } from "./transport/gemini-codeassist.js";
import { OpenAITransport } from "./transport/openai.js";
import { AnthropicCompatTransport } from "./transport/anthropic-compat.js";
import { OllamaCloudTransport } from "./transport/ollamacloud.js";
import { LiteLLMTransport } from "./transport/litellm.js";
import { LocalTransport } from "./transport/local.js";

// Format adapter imports
import { GeminiFormatAdapter } from "../adapters/gemini-format-adapter.js";
import { OpenAIFormatAdapter } from "../adapters/openai-format-adapter.js";
import { AnthropicPassthroughAdapter } from "../adapters/anthropic-passthrough-adapter.js";
import { OllamaCloudAdapter } from "../adapters/ollamacloud-adapter.js";
import { LiteLLMAdapter } from "../adapters/litellm-adapter.js";
import { LocalModelAdapter } from "../adapters/local-adapter.js";

// ─── ProviderComponents ──────────────────────────────────

export interface ProviderComponents {
  transport: ProviderTransport;
  formatAdapter: FormatAdapter;
  /** Token strategy override for ProviderHandler */
  tokenStrategy?: "delta-aware" | "accumulate-both" | "local";
  /** Whether to unwrap Gemini response envelope (Code Assist) */
  unwrapGeminiResponse?: boolean;
  /** Summarize tool descriptions (for local models with small context) */
  summarizeTools?: boolean;
  /** Log message for debug output */
  logMessage: string;
}

// ─── Factory ─────────────────────────────────────────────

/**
 * Create transport + adapter for a provider definition.
 *
 * Returns null when the caller must handle construction itself:
 * - "openrouter": uses OpenRouterHandler with its own transport/adapter
 * - "vertex": requires express vs OAuth mode selection at the call site
 * - "litellm" without LITELLM_BASE_URL: missing required configuration
 */
export function createTransportForProvider(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
  options?: { concurrency?: number; summarizeTools?: boolean },
): ProviderComponents | null {
  // Build transport config once; used by all BaseTransport subclasses
  const config: TransportConfig = {
    name: def.name,
    displayName: def.displayName,
    baseUrl: getEffectiveBaseUrl(def),
    apiPath: def.apiPath,
    apiKey,
    modelName,
    authScheme: def.authScheme,
    headers: def.headers,
  };

  switch (def.transport) {
    case "gemini":
      return {
        transport: new GeminiApiKeyTransport(config),
        formatAdapter: new GeminiFormatAdapter(modelName),
        tokenStrategy: def.tokenStrategy,
        logMessage: `Created ${def.displayName} handler: ${modelName}`,
      };

    // GeminiCodeAssistTransport manages its own OAuth credentials and endpoint
    // URLs internally, so it ignores the shared TransportConfig.
    case "gemini-oauth":
      return {
        transport: new GeminiCodeAssistTransport(modelName),
        formatAdapter: new GeminiFormatAdapter(modelName),
        tokenStrategy: def.tokenStrategy,
        unwrapGeminiResponse: true,
        logMessage: `Created ${def.displayName} handler: ${modelName}`,
      };

    case "openai":
      return {
        transport: new OpenAITransport(config),
        formatAdapter: new OpenAIFormatAdapter(modelName, def.capabilities),
        tokenStrategy: def.tokenStrategy || "delta-aware",
        logMessage: `Created ${def.displayName} handler: ${modelName}`,
      };

    case "anthropic":
      return {
        transport: new AnthropicCompatTransport(config),
        formatAdapter: new AnthropicPassthroughAdapter(modelName, def.name),
        tokenStrategy: def.tokenStrategy,
        logMessage: `Created ${def.displayName} handler: ${modelName}`,
      };

    case "ollama":
      return {
        transport: new OllamaCloudTransport(config),
        formatAdapter: new OllamaCloudAdapter(modelName),
        tokenStrategy: def.tokenStrategy || "accumulate-both",
        logMessage: `Created ${def.displayName} handler: ${modelName}`,
      };

    case "litellm": {
      // LITELLM_BASE_URL is required — without it we can't construct a transport
      if (!config.baseUrl) return null;
      return {
        transport: new LiteLLMTransport(config),
        formatAdapter: new LiteLLMAdapter(modelName, config.baseUrl),
        tokenStrategy: def.tokenStrategy,
        logMessage: `Created ${def.displayName} handler: ${modelName} (${config.baseUrl})`,
      };
    }

    // Zen backends multiple API formats: MiniMax models use Anthropic wire
    // format, everything else uses OpenAI. This is provider-level routing
    // (not a model quirk), so the decision lives here in the factory.
    case "zen": {
      const effectiveKey = apiKey || (def.publicKeyFallback ? "public" : "");
      const zenConfig = { ...config, apiKey: effectiveKey };
      if (modelName.toLowerCase().includes("minimax")) {
        return {
          transport: new AnthropicCompatTransport(zenConfig),
          formatAdapter: new AnthropicPassthroughAdapter(modelName, def.name),
          tokenStrategy: def.tokenStrategy,
          logMessage: `Created ${def.displayName} handler (Anthropic): ${modelName}`,
        };
      }
      return {
        transport: new OpenAITransport(zenConfig),
        formatAdapter: new OpenAIFormatAdapter(modelName, def.capabilities),
        tokenStrategy: def.tokenStrategy || "delta-aware",
        logMessage: `Created ${def.displayName} handler: ${modelName}`,
      };
    }

    // LocalTransport has a different config shape (no auth, health checks
    // instead) so it builds its own config rather than using TransportConfig.
    case "local": {
      const localConfig = {
        name: def.name,
        baseUrl: config.baseUrl,
        apiPath: def.apiPath,
        envVar: def.baseUrlEnvVars?.[0] || "",
        prefixes: def.legacyPrefixes,
        capabilities: def.capabilities,
      };
      const transport = new LocalTransport(localConfig, modelName, {
        concurrency: options?.concurrency,
      });
      const formatAdapter = new LocalModelAdapter(modelName, def.name, def.capabilities);
      return {
        transport,
        formatAdapter,
        tokenStrategy: "local",
        summarizeTools: options?.summarizeTools,
        logMessage: `Created ${def.displayName} handler: ${modelName}`,
      };
    }

    // Caller must handle these — they require custom routing logic:
    // - openrouter: uses OpenRouterHandler with its own queue and adapter
    // - vertex: selects between express (API key) and OAuth mode at call site
    case "openrouter":
    case "vertex":
      return null;

    default:
      return null;
  }
}
