/**
 * Provider Factory — creates transport + format adapter + model adapter
 * for a ProviderDefinition.
 *
 * Three symmetric helpers select each component:
 *   selectTransport()        — by transport type (from provider definition)
 *   selectFormatAdapter()    — by transport type, with model-family sub-selection for local
 *   selectModelAdapter()     — by model name (shouldHandle pattern)
 *
 * The main factory assembles them into ProviderComponents.
 */

import type { ProviderDefinition } from "./provider-definitions.js";
import type { ProviderTransport } from "./transport/types.js";
import type { FormatAdapter } from "../adapters/format-adapter.js";
import type { TransportConfig } from "./transport/base.js";
import type { ProviderCapabilities } from "../handlers/shared/remote-provider-types.js";
import { getEffectiveBaseUrl } from "./provider-definitions.js";

// Transport imports
import { GeminiApiKeyTransport } from "./transport/gemini-apikey.js";
import { GeminiCodeAssistTransport } from "./transport/gemini-codeassist.js";
import { OpenAITransport } from "./transport/openai.js";
import { AnthropicCompatTransport } from "./transport/anthropic-compat.js";
import { OllamaCloudTransport } from "./transport/ollamacloud.js";
import { LiteLLMTransport } from "./transport/litellm.js";
import { LocalTransport } from "./transport/local.js";
import { OllamaTransport } from "./transport/ollama.js";
import { KimiCodingTransport } from "./transport/kimi-coding.js";

// Format adapter imports
import { GeminiFormatAdapter } from "../adapters/gemini-format-adapter.js";
import { OpenAIFormatAdapter } from "../adapters/openai-format-adapter.js";
import { AnthropicPassthroughAdapter } from "../adapters/anthropic-passthrough-adapter.js";
import { OllamaCloudAdapter } from "../adapters/ollamacloud-adapter.js";
import { LiteLLMAdapter } from "../adapters/litellm-adapter.js";
import { LocalFormatAdapter } from "../adapters/local-format-adapter.js";
import { LocalQwenFormatAdapter } from "../adapters/local-qwen-format-adapter.js";
import { LocalDeepSeekFormatAdapter } from "../adapters/local-deepseek-format-adapter.js";
import { LocalLlamaFormatAdapter } from "../adapters/local-llama-format-adapter.js";
import { LocalMistralFormatAdapter } from "../adapters/local-mistral-format-adapter.js";

// Model adapter imports
import { ModelAdapter } from "../adapters/model-adapter.js";
import { GrokAdapter } from "../adapters/grok-adapter.js";
import { GeminiModelAdapter } from "../adapters/gemini-model-adapter.js";
import { QwenAdapter } from "../adapters/qwen-adapter.js";
import { MiniMaxAdapter } from "../adapters/minimax-adapter.js";
import { DeepSeekAdapter } from "../adapters/deepseek-adapter.js";
import { GLMAdapter } from "../adapters/glm-adapter.js";

// ─── ProviderComponents ──────────────────────────────────

export interface ProviderComponents {
  transport: ProviderTransport;
  formatAdapter: FormatAdapter;
  modelAdapter: ModelAdapter;
  /** Token strategy override for ProviderHandler */
  tokenStrategy?: "delta-aware" | "accumulate-both" | "local";
  /** Whether to unwrap Gemini response envelope (Code Assist) */
  unwrapGeminiResponse?: boolean;
  /** Summarize tool descriptions (for local models with small context) */
  summarizeTools?: boolean;
  /** Log message for debug output */
  logMessage: string;
}

// ─── Transport selection ─────────────────────────────────

function selectTransport(
  def: ProviderDefinition,
  config: TransportConfig,
  options?: { concurrency?: number },
): ProviderTransport | null {
  switch (def.transport) {
    case "gemini":       return new GeminiApiKeyTransport(config);
    case "gemini-oauth": return new GeminiCodeAssistTransport(config.modelName);
    case "openai":       return new OpenAITransport(config);
    case "anthropic":    return new AnthropicCompatTransport(config);
    case "kimi-coding":  return new KimiCodingTransport(config);
    case "ollamacloud":  return new OllamaCloudTransport(config);
    case "litellm":      return config.baseUrl ? new LiteLLMTransport(config) : null;
    case "ollama":       return new OllamaTransport(config, { concurrency: options?.concurrency });
    case "local":        return new LocalTransport(config, { concurrency: options?.concurrency });
    case "zen": {
      const zenConfig = { ...config, apiKey: config.apiKey || (def.publicKeyFallback ? "public" : "") };
      return config.modelName.toLowerCase().includes("minimax")
        ? new AnthropicCompatTransport(zenConfig)
        : new OpenAITransport(zenConfig);
    }
    default: return null;
  }
}

// ─── Format adapter selection ────────────────────────────

const LOCAL_FORMAT_ADAPTERS = [
  LocalQwenFormatAdapter,
  LocalDeepSeekFormatAdapter,
  LocalLlamaFormatAdapter,
  LocalMistralFormatAdapter,
];

function selectFormatAdapter(
  def: ProviderDefinition,
  modelName: string,
  config: TransportConfig,
): FormatAdapter | null {
  switch (def.transport) {
    case "gemini":
    case "gemini-oauth":  return new GeminiFormatAdapter(modelName);
    case "openai":        return new OpenAIFormatAdapter(modelName, def.capabilities);
    case "anthropic":
    case "kimi-coding":   return new AnthropicPassthroughAdapter(modelName, def.name);
    case "ollamacloud":   return new OllamaCloudAdapter(modelName);
    case "litellm":       return config.baseUrl ? new LiteLLMAdapter(modelName, config.baseUrl) : null;
    case "ollama":
    case "local":         return selectLocalFormatAdapter(modelName, def.name, def.capabilities);
    case "zen":
      return modelName.toLowerCase().includes("minimax")
        ? new AnthropicPassthroughAdapter(modelName, def.name)
        : new OpenAIFormatAdapter(modelName, def.capabilities);
    default: return null;
  }
}

function selectLocalFormatAdapter(
  modelName: string,
  providerName: string,
  capabilities: ProviderCapabilities,
): LocalFormatAdapter {
  for (const Adapter of LOCAL_FORMAT_ADAPTERS) {
    const adapter = new Adapter(modelName, providerName, capabilities);
    if (adapter.shouldHandle(modelName)) return adapter;
  }
  return new LocalFormatAdapter(modelName, providerName, capabilities);
}

// ─── Model adapter selection ─────────────────────────────

const MODEL_ADAPTERS = [
  GrokAdapter,
  GeminiModelAdapter,
  QwenAdapter,
  MiniMaxAdapter,
  DeepSeekAdapter,
  GLMAdapter,
];

function selectModelAdapter(modelName: string): ModelAdapter {
  for (const Adapter of MODEL_ADAPTERS) {
    const adapter = new Adapter(modelName);
    if (adapter.shouldHandle(modelName)) return adapter;
  }
  return new ModelAdapter(modelName);
}

// ─── Token strategy selection ─────────────────────────────

type TokenStrategy = ProviderComponents["tokenStrategy"];

function selectTokenStrategy(def: ProviderDefinition): TokenStrategy {
  switch (def.transport) {
    case "ollama":
    case "local":        return "local";
    case "ollamacloud":  return def.tokenStrategy || "accumulate-both";
    case "openai":
    case "zen":          return def.tokenStrategy || "delta-aware";
    default:             return def.tokenStrategy;
  }
}

// ─── Metadata selection ───────────────────────────────────

function selectUnwrapGeminiResponse(def: ProviderDefinition): boolean | undefined {
  switch (def.transport) {
    case "gemini-oauth": return true;
    default:             return undefined;
  }
}

function selectSummarizeTools(
  def: ProviderDefinition,
  options?: { summarizeTools?: boolean },
): boolean | undefined {
  switch (def.transport) {
    case "ollama":
    case "local":  return options?.summarizeTools;
    default:       return undefined;
  }
}

// ─── Factory ─────────────────────────────────────────────

/**
 * Create transport + format adapter + model adapter for a provider definition.
 *
 * Returns null when:
 * - Transport type requires custom routing (openrouter, vertex)
 * - Required configuration is missing (litellm without base URL)
 */
export function createTransportForProvider(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
  options?: { concurrency?: number; summarizeTools?: boolean },
): ProviderComponents | null {
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

  const transport = selectTransport(def, config, options);
  if (!transport) return null;

  const formatAdapter = selectFormatAdapter(def, modelName, config);
  if (!formatAdapter) return null;

  const modelAdapter = selectModelAdapter(modelName);
  const tokenStrategy = selectTokenStrategy(def);
  const unwrapGeminiResponse = selectUnwrapGeminiResponse(def);
  const summarizeTools = selectSummarizeTools(def, options);
  const logMessage = `Created ${def.displayName} handler: ${modelName}`;

  return { transport, formatAdapter, modelAdapter, tokenStrategy, unwrapGeminiResponse, summarizeTools, logMessage };
}

// Re-export for call sites that construct handlers manually (URL providers, OpenRouter, Vertex)
export { selectModelAdapter, selectLocalFormatAdapter };
