/**
 * createHandlerForProvider — construct a ComposedHandler for a ProviderDefinition.
 *
 * Single function, flat switch on def.transport. All transport + format + handler
 * construction in one place. No profile objects, no lookup tables, no indirection.
 */

import type { ComposedHandlerOptions } from "../handlers/composed-handler.js";
import type { ProviderTransport } from "./transport/types.js";
import type { BaseAPIFormat } from "../adapters/base-api-format.js";
import type { ProviderDefinition } from "./provider-definitions.js";
import type { ModelHandler } from "../handlers/types.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import { toRemoteProvider } from "./provider-definitions.js";
import { GeminiProviderTransport } from "./transport/gemini-apikey.js";
import { GeminiCodeAssistProviderTransport } from "./transport/gemini-codeassist.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { OpenAIProviderTransport } from "./transport/openai.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { AnthropicProviderTransport } from "./transport/anthropic-compat.js";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { OllamaProviderTransport } from "./transport/ollamacloud.js";
import { OllamaAPIFormat } from "../adapters/ollama-api-format.js";
import { LiteLLMProviderTransport } from "./transport/litellm.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { VertexProviderTransport, parseVertexModel } from "./transport/vertex-oauth.js";
import { DefaultAPIFormat, matchesModelFamily } from "../adapters/base-api-format.js";
import { GrokModelDialect } from "../adapters/grok-model-dialect.js";
import { QwenModelDialect } from "../adapters/qwen-model-dialect.js";
import { MiniMaxModelDialect } from "../adapters/minimax-model-dialect.js";
import { DeepSeekModelDialect } from "../adapters/deepseek-model-dialect.js";
import { GLMModelDialect } from "../adapters/glm-model-dialect.js";
import { XiaomiModelDialect } from "../adapters/xiaomi-model-dialect.js";
import { getRegisteredRemoteProviders } from "./remote-provider-registry.js";
import { getVertexConfig, validateVertexOAuthConfig } from "../auth/vertex-auth.js";
import { log, logStderr } from "../logger.js";
import { resolveApiKeyProvenance, formatProvenanceLog } from "./api-key-provenance.js";

// ---------------------------------------------------------------------------
// Transport resolution
// ---------------------------------------------------------------------------

function resolveTransport(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
): ProviderTransport | null {
  const rp = toRemoteProvider(def);

  switch (def.transport) {
    case "gemini":
      return new GeminiProviderTransport(rp, modelName, apiKey);

    case "gemini-oauth":
      return new GeminiCodeAssistProviderTransport(modelName);

    case "openai": {
      // OpenCode Zen: GPT models go through Responses API
      if (
        (def.name === "opencode-zen" || def.name === "opencode-zen-go") &&
        modelName.toLowerCase().startsWith("gpt-")
      ) {
        return new OpenAIProviderTransport(
          { ...rp, apiPath: "/v1/responses" },
          modelName,
          apiKey || def.publicKeyFallback || "",
        );
      }
      // OpenCode Zen: MiniMax models go through Anthropic transport
      if (
        (def.name === "opencode-zen" || def.name === "opencode-zen-go") &&
        modelName.toLowerCase().includes("minimax")
      ) {
        return new AnthropicProviderTransport(rp, apiKey || def.publicKeyFallback || "");
      }
      return new OpenAIProviderTransport(
        rp,
        modelName,
        apiKey || def.publicKeyFallback || "",
      );
    }

    case "anthropic":
      return new AnthropicProviderTransport(rp, apiKey);

    case "kimi-coding":
      // Kimi Coding uses Anthropic-compatible transport
      return new AnthropicProviderTransport(rp, apiKey);

    case "openrouter":
      // OpenRouter has its own dedicated handler, not ComposedHandler
      return null;

    case "ollamacloud":
      return new OllamaProviderTransport(rp, apiKey);

    case "litellm":
      if (!rp.baseUrl) {
        logStderr("Error: LITELLM_BASE_URL or --litellm-url is required for LiteLLM provider.");
        return null;
      }
      return new LiteLLMProviderTransport(rp.baseUrl, apiKey, modelName);

    case "vertex": {
      if (process.env.VERTEX_API_KEY) {
        // Express mode: use Gemini transport with VERTEX_API_KEY
        const geminiConfig = getRegisteredRemoteProviders().find((p) => p.name === "gemini");
        return new GeminiProviderTransport(geminiConfig || rp, modelName, process.env.VERTEX_API_KEY);
      }
      const vertexConfig = getVertexConfig();
      if (!vertexConfig) {
        log("[Proxy] Vertex AI requires either VERTEX_API_KEY or VERTEX_PROJECT");
        return null;
      }
      const oauthError = validateVertexOAuthConfig();
      if (oauthError) {
        log(`[Proxy] Vertex OAuth config error: ${oauthError}`);
        return null;
      }
      const parsed = parseVertexModel(modelName);
      return new VertexProviderTransport(vertexConfig, parsed);
    }

    case "poe":
      // Poe has its own handler in proxy-server.ts
      return null;

    case "local":
      // Local providers have their own handler in proxy-server.ts
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Format adapter resolution
// ---------------------------------------------------------------------------

function resolveAPIFormat(
  def: ProviderDefinition,
  modelName: string,
): BaseAPIFormat | null {
  switch (def.transport) {
    case "gemini":
    case "gemini-oauth":
      return new GeminiAPIFormat(modelName);

    case "openai": {
      // OpenCode Zen: MiniMax models use Anthropic format
      if (
        (def.name === "opencode-zen" || def.name === "opencode-zen-go") &&
        modelName.toLowerCase().includes("minimax")
      ) {
        return new AnthropicAPIFormat(modelName, def.name);
      }
      // OpenCode Zen: GPT models use Codex format (Responses API)
      if (
        (def.name === "opencode-zen" || def.name === "opencode-zen-go") &&
        modelName.toLowerCase().startsWith("gpt-")
      ) {
        return new CodexAPIFormat(modelName);
      }
      return new OpenAIAPIFormat(modelName);
    }

    case "anthropic":
      return new AnthropicAPIFormat(modelName, def.name);

    case "kimi-coding":
      return new AnthropicAPIFormat(modelName, def.name);

    case "ollamacloud":
      return new OllamaAPIFormat(modelName);

    case "litellm": {
      const rp = toRemoteProvider(def);
      return new LiteLLMAPIFormat(modelName, rp.baseUrl);
    }

    case "vertex": {
      if (process.env.VERTEX_API_KEY) {
        // Express mode uses Gemini format
        return new GeminiAPIFormat(modelName);
      }
      const parsed = parseVertexModel(modelName);
      if (parsed.publisher === "google") return new GeminiAPIFormat(modelName);
      if (parsed.publisher === "anthropic") return new AnthropicAPIFormat(parsed.model, "vertex");
      const id = parsed.publisher === "mistralai"
        ? parsed.model
        : `${parsed.publisher}/${parsed.model}`;
      return new DefaultAPIFormat(id);
    }

    case "openrouter":
    case "poe":
    case "local":
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Model dialect resolution
// ---------------------------------------------------------------------------

export function resolveModelDialect(modelId: string): BaseAPIFormat {
  const m = matchesModelFamily;

  if (m(modelId, "grok") || modelId.toLowerCase().includes("x-ai/"))
    return new GrokModelDialect(modelId);
  if (m(modelId, "gemini") || modelId.toLowerCase().includes("google/"))
    return new GeminiAPIFormat(modelId);
  if (m(modelId, "codex"))
    return new CodexAPIFormat(modelId);
  if (modelId.startsWith("oai/") || modelId.includes("o1") || modelId.includes("o3"))
    return new OpenAIAPIFormat(modelId);
  if (m(modelId, "qwen") || m(modelId, "alibaba"))
    return new QwenModelDialect(modelId);
  if (m(modelId, "minimax"))
    return new MiniMaxModelDialect(modelId);
  if (m(modelId, "deepseek"))
    return new DeepSeekModelDialect(modelId);
  if (m(modelId, "glm-") || m(modelId, "chatglm-") || modelId.toLowerCase().includes("zhipu/"))
    return new GLMModelDialect(modelId);
  if (m(modelId, "xiaomi") || m(modelId, "mimo"))
    return new XiaomiModelDialect(modelId);

  return new DefaultAPIFormat(modelId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a ModelHandler for a given ProviderDefinition.
 *
 * Resolves transport + format adapter + model dialect, composes into ComposedHandler.
 * Returns null if the provider cannot be wired (missing config, unsupported transport).
 */
export function createHandlerForProvider(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
  targetModel: string,
  port: number,
  opts?: Pick<ComposedHandlerOptions, "isInteractive" | "invocationMode">,
): ModelHandler | null {
  if (def.apiKeyEnvVar) {
    const provenance = resolveApiKeyProvenance(def.apiKeyEnvVar);
    log(`[Proxy] API key: ${formatProvenanceLog(provenance)}`);
  }
  log(`[Proxy] Handler: provider=${def.name}, model=${modelName}`);

  const transport = resolveTransport(def, modelName, apiKey);
  if (!transport) return null;

  const adapter = resolveAPIFormat(def, modelName);
  const dialect = resolveModelDialect(modelName);

  return new ComposedHandler(transport, targetModel, modelName, port, {
    adapter: adapter ?? undefined,
    modelDialect: dialect,
    ...opts,
  });
}
