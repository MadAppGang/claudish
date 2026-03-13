/**
 * Provider Factory — assembles ProviderComponents from a ProviderDefinition.
 *
 * Selection helpers:
 *   selectTransport()          — by transport type
 *   selectFormatAdapter()      — by transport type, with local model-family sub-selection
 *   selectModelAdapter()       — by model name (shouldHandle iteration)
 *   selectLocalFormatAdapter() — by model name (shouldHandle iteration, local only)
 *
 * Metadata (tokenStrategy) comes directly from the ProviderDefinition.
 * Transport-specific behavior (unwrapResponse) lives on the transport.
 */

import type { ProviderDefinition } from "./provider-definitions.js";
import type { ProviderTransport } from "./transport/types.js";
import type { FormatAdapter } from "../adapters/format-adapter.js";
import type { TransportConfig } from "./transport/base.js";
import type { ProviderCapabilities } from "../handlers/shared/remote-provider-types.js";
import { getEffectiveBaseUrl } from "./provider-definitions.js";
import { logStderr } from "../logger.js";

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
import { OpenRouterTransport } from "./transport/openrouter.js";
import { VertexOAuthTransport, parseVertexModel } from "./transport/vertex-oauth.js";
import { getVertexConfig } from "../auth/vertex-auth.js";

// Format adapter imports
import { GeminiFormatAdapter } from "../adapters/gemini-format-adapter.js";
import { OpenAIFormatAdapter } from "../adapters/openai-format-adapter.js";
import { AnthropicPassthroughAdapter } from "../adapters/anthropic-passthrough-adapter.js";
import { OllamaCloudAdapter } from "../adapters/ollamacloud-adapter.js";
import { OpenRouterAdapter } from "../adapters/openrouter-adapter.js";
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
  /** Summarize tool descriptions (for local models with small context) */
  summarizeTools?: boolean;
  /** Log message for debug output */
  logMessage: string;
}

// ─── Transport selection ─────────────────────────────────

function selectTransport(
  def: ProviderDefinition,
  config: TransportConfig,
  concurrency?: number,
): ProviderTransport | null {
  switch (def.transport) {
    case "gemini":       return new GeminiApiKeyTransport(config);
    case "gemini-oauth": return new GeminiCodeAssistTransport(config.modelName);
    case "openai":       return new OpenAITransport(config);
    case "anthropic":    return new AnthropicCompatTransport(config);
    case "kimi-coding":  return new KimiCodingTransport(config);
    case "openrouter":   return new OpenRouterTransport(config);
    case "ollamacloud":  return new OllamaCloudTransport(config);
    case "litellm":
      if (!config.baseUrl) {
        logStderr("Error: LITELLM_BASE_URL or --litellm-url is required for LiteLLM provider.");
        return null;
      }
      return new LiteLLMTransport(config);
    case "vertex": {
      const vertexConfig = getVertexConfig();
      if (!vertexConfig) {
        logStderr("Error: VERTEX_PROJECT is required for Vertex AI OAuth mode.");
        return null;
      }
      const parsed = parseVertexModel(config.modelName);
      return new VertexOAuthTransport(vertexConfig, parsed);
    }
    case "ollama":       return new OllamaTransport(config, { concurrency });
    case "local":        return new LocalTransport(config, { concurrency });
    case "zen":
      return config.modelName.toLowerCase().includes("minimax")
        ? new AnthropicCompatTransport(config)
        : new OpenAITransport(config);
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
  baseUrl: string,
): FormatAdapter | null {
  switch (def.transport) {
    case "gemini":
    case "gemini-oauth":  return new GeminiFormatAdapter(modelName);
    case "openai":        return new OpenAIFormatAdapter(modelName, def.capabilities);
    case "openrouter":    return new OpenRouterAdapter(modelName);
    case "anthropic":
    case "kimi-coding":   return new AnthropicPassthroughAdapter(modelName, def.name);
    case "ollamacloud":   return new OllamaCloudAdapter(modelName);
    case "litellm":       return baseUrl ? new LiteLLMAdapter(modelName, baseUrl) : null;
    case "vertex": {
      const parsed = parseVertexModel(modelName);
      if (parsed.publisher === "google") return new GeminiFormatAdapter(modelName);
      if (parsed.publisher === "anthropic") return new AnthropicPassthroughAdapter(parsed.model, "vertex");
      const modelId = parsed.publisher === "mistralai" ? parsed.model : `${parsed.publisher}/${parsed.model}`;
      return new OpenAIFormatAdapter(modelId, {
        supportsTools: true, supportsVision: true, supportsStreaming: true,
        supportsJsonMode: false, supportsReasoning: false,
      });
    }
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

// ─── Factory ─────────────────────────────────────────────

/**
 * Create transport + format adapter + model adapter for a provider definition.
 *
 * Returns null when:
 * - Required configuration is missing (litellm without base URL, vertex without OAuth config)
 */
export function createTransportForProvider(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
  concurrency?: number,
  summarizeTools?: boolean,
): ProviderComponents | null {
  const baseUrl = getEffectiveBaseUrl(def);
  const config: TransportConfig = {
    name: def.name,
    displayName: def.displayName,
    baseUrl,
    apiPath: def.apiPath,
    apiKey: apiKey || (def.publicKeyFallback ? "public" : ""),
    modelName,
    authScheme: def.authScheme,
    headers: def.headers,
  };

  const transport = selectTransport(def, config, concurrency);
  if (!transport) return null;

  const formatAdapter = selectFormatAdapter(def, modelName, baseUrl);
  if (!formatAdapter) return null;

  const modelAdapter = selectModelAdapter(modelName);
  const tokenStrategy = def.tokenStrategy;
  const logMessage = `Created ${def.displayName} handler: ${modelName}`;

  return { transport, formatAdapter, modelAdapter, tokenStrategy, summarizeTools, logMessage };
}

// Re-export for tests
export { selectModelAdapter };
