/**
 * Provider Component Selector: assembles ProviderComponents from a ProviderDefinition.
 *
 * Selection helpers:
 *   selectTransport()       by transport type
 *   selectFormatAdapter()   by transport type
 *   selectModelAdapter()    by model name (inline matching via parseModelSpec)
 *
 * Metadata (tokenStrategy) lives on the ProviderDefinition, not here.
 * Transport-specific behavior (unwrapResponse) lives on the transport.
 */

import type { ProviderDefinition } from "./provider-definitions.js";
import type { ProviderTransport } from "./transport/types.js";
import type { FormatAdapter } from "../adapters/format-adapter.js";
import type { TransportConfig } from "./transport/base.js";
import { getEffectiveBaseUrl, getProviderByName } from "./provider-definitions.js";
import { parseModelSpec } from "./model-parser.js";
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
}

// ─── Transport selection ─────────────────────────────────

function selectTransport(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
  concurrency?: number,
): ProviderTransport | null {
  const config: TransportConfig = {
    name: def.name,
    displayName: def.displayName,
    baseUrl: getEffectiveBaseUrl(def),
    apiPath: def.apiPath,
    apiKey: apiKey || (def.publicKeyFallback ? "public" : ""),
    modelName,
    authScheme: def.authScheme,
    headers: def.headers,
  };

  switch (def.transport) {
    case "gemini":       return new GeminiApiKeyTransport(config);
    case "gemini-oauth": return new GeminiCodeAssistTransport(modelName);
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
      const parsed = parseVertexModel(modelName);
      return new VertexOAuthTransport(vertexConfig, parsed);
    }
    case "ollama":       return new OllamaTransport(config, { concurrency });
    case "local":        return new LocalTransport(config, { concurrency });
    default: return null;
  }
}

// ─── Format adapter selection ────────────────────────────

function selectFormatAdapter(
  def: ProviderDefinition,
  modelName: string,
): FormatAdapter | null {
  const model = parseModelSpec(modelName).model.toLowerCase();
  const baseUrl = getEffectiveBaseUrl(def);
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
    case "local":
      if (model.includes("qwen") || model.includes("alibaba")) return new LocalQwenFormatAdapter(modelName, def.name, def.capabilities);
      if (model.includes("deepseek")) return new LocalDeepSeekFormatAdapter(modelName, def.name, def.capabilities);
      if (model.includes("llama")) return new LocalLlamaFormatAdapter(modelName, def.name, def.capabilities);
      if (model.includes("mistral") || model.includes("codestral")) return new LocalMistralFormatAdapter(modelName, def.name, def.capabilities);
      return new LocalFormatAdapter(modelName, def.name, def.capabilities);
    default: return null;
  }
}

// ─── Model adapter selection ─────────────────────────────

function selectModelAdapter(modelName: string): ModelAdapter {
  const model = parseModelSpec(modelName).model.toLowerCase();
  if (model.includes("grok")) return new GrokAdapter(modelName);
  if (model.includes("gemini")) return new GeminiModelAdapter(modelName);
  if (model.includes("qwen") || model.includes("alibaba")) return new QwenAdapter(modelName);
  if (model.includes("minimax")) return new MiniMaxAdapter(modelName);
  if (model.includes("deepseek")) return new DeepSeekAdapter(modelName);
  if (model.startsWith("glm-")) return new GLMAdapter(modelName);
  return new ModelAdapter(modelName);
}

// ─── Selector ────────────────────────────────────────────

/**
 * Select transport, format adapter, and model adapter for a provider definition.
 *
 * Returns null when required configuration is missing
 * (litellm without base URL, vertex without OAuth config).
 */
export function selectProviderComponents(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
  concurrency?: number,
): ProviderComponents | null {
  // Zen minimax models use anthropic transport; redirect to the matching definition
  const model = parseModelSpec(modelName).model.toLowerCase();
  if (model.includes("minimax")) {
    if (def.name === "opencode-zen") {
      def = getProviderByName("opencode-zen-minimax") ?? def;
    } else if (def.name === "opencode-zen-go") {
      def = getProviderByName("opencode-zen-go-minimax") ?? def;
    }
  }

  const transport = selectTransport(def, modelName, apiKey, concurrency);
  if (!transport) return null;

  const formatAdapter = selectFormatAdapter(def, modelName);
  if (!formatAdapter) return null;

  const modelAdapter = selectModelAdapter(modelName);

  return { transport, formatAdapter, modelAdapter };
}

// Re-export for tests
export { selectModelAdapter };
