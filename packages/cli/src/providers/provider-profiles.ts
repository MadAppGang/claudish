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
import { KimiCodingTransport } from "./transport/kimi-coding.js";
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
import { OpenRouterProviderTransport } from "./transport/openrouter.js";
import { OpenRouterAPIFormat } from "../adapters/openrouter-api-format.js";
import { PoeProvider } from "./transport/poe.js";
import { LocalTransport } from "./transport/local.js";
import { LocalModelAdapter } from "../adapters/local-adapter.js";
import { LocalQwenFormatAdapter } from "../adapters/local-qwen-format-adapter.js";
import { LocalDeepSeekFormatAdapter } from "../adapters/local-deepseek-format-adapter.js";
import { LocalLlamaFormatAdapter } from "../adapters/local-llama-format-adapter.js";
import { LocalMistralFormatAdapter } from "../adapters/local-mistral-format-adapter.js";
import {
  resolveProvider,
  parseUrlModel,
  createUrlProvider,
} from "./provider-registry.js";
import { getProviderByName } from "./provider-definitions.js";
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
      return new KimiCodingTransport(rp, apiKey);

    case "openrouter":
      return new OpenRouterProviderTransport(apiKey, modelName);

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
        const geminiDef = getProviderByName("google");
        const geminiConfig = geminiDef ? toRemoteProvider(geminiDef) : rp;
        return new GeminiProviderTransport(geminiConfig, modelName, process.env.VERTEX_API_KEY);
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

    case "poe": {
      const poeApiKey = process.env.POE_API_KEY;
      if (!poeApiKey) {
        log(`[Proxy] POE_API_KEY not set, cannot use Poe model: ${modelName}`);
        return null;
      }
      return new PoeProvider(poeApiKey);
    }

    case "local":
      // Handled separately in createHandlerForProvider (needs LocalProvider config)
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
      return new OpenRouterAPIFormat(modelName);

    case "poe":
      return new OpenAIAPIFormat(modelName);

    case "local":
      return null; // Handled separately in createHandlerForProvider

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
 * Resolve the effective definition and API key for special cases.
 *
 * Handles:
 * - OpenCode Zen minimax variant swap (zen + minimax model -> zen-minimax def)
 * - publicKeyFallback for providers that allow auth-less access (e.g. Zen "public")
 */
function resolveEffective(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
): { def: ProviderDefinition; apiKey: string } {
  // Zen + minimax: the opencode-zen def uses OpenAI transport, but minimax models
  // need Anthropic transport. The zen transport code already handles this in
  // resolveTransport, so no definition swap is needed here. But we do need to
  // ensure the publicKeyFallback is applied.
  if (def.publicKeyFallback && !apiKey) {
    return { def, apiKey: def.publicKeyFallback };
  }
  return { def, apiKey };
}

/**
 * Create a ModelHandler for a given ProviderDefinition.
 *
 * Resolves transport + format adapter + model dialect, composes into ComposedHandler.
 * Returns null if the provider cannot be wired (missing config, unsupported transport).
 *
 * Handles all provider types including OpenRouter, Poe, and local providers.
 */
export function createHandlerForProvider(
  def: ProviderDefinition,
  modelName: string,
  apiKey: string,
  targetModel: string,
  port: number,
  opts?: Pick<ComposedHandlerOptions, "isInteractive" | "invocationMode" | "summarizeTools"> & {
    concurrency?: number;
  },
): ModelHandler | null {
  const effective = resolveEffective(def, modelName, apiKey);

  // Strip "poe:" prefix from model name (native pattern match preserves it)
  let effectiveModelName = modelName;
  if (effective.def.transport === "poe") {
    effectiveModelName = modelName.replace(/^poe:/, "");
  }

  if (effective.def.apiKeyEnvVar) {
    const provenance = resolveApiKeyProvenance(effective.def.apiKeyEnvVar);
    log(`[Proxy] API key: ${formatProvenanceLog(provenance)}`);
  }
  log(`[Proxy] Handler: provider=${effective.def.name}, model=${effectiveModelName}`);

  // Local providers need special handling: LocalTransport takes a LocalProvider config
  if (effective.def.transport === "local") {
    return createLocalHandler(effective.def, effectiveModelName, targetModel, port, opts);
  }

  const transport = resolveTransport(effective.def, effectiveModelName, effective.apiKey);
  if (!transport) return null;

  const adapter = resolveAPIFormat(effective.def, effectiveModelName);
  const dialect = resolveModelDialect(effectiveModelName);

  return new ComposedHandler(transport, targetModel, effectiveModelName, port, {
    adapter: adapter ?? undefined,
    modelDialect: dialect,
    isInteractive: opts?.isInteractive,
    invocationMode: opts?.invocationMode,
  });
}

/**
 * Create a handler for a local provider (ollama, lmstudio, vllm, mlx, custom URL).
 *
 * Local providers use the provider-registry to resolve the LocalProvider config,
 * which includes the correct base URL (with env var overrides) and API path.
 */
/**
 * Select the right LocalModelAdapter subclass based on model family.
 */
function createLocalAdapter(modelName: string, providerName: string): LocalModelAdapter {
  const m = matchesModelFamily;
  if (m(modelName, "qwen")) return new LocalQwenFormatAdapter(modelName, providerName);
  if (m(modelName, "deepseek")) return new LocalDeepSeekFormatAdapter(modelName, providerName);
  if (m(modelName, "llama")) return new LocalLlamaFormatAdapter(modelName, providerName);
  if (m(modelName, "mistral")) return new LocalMistralFormatAdapter(modelName, providerName);
  return new LocalModelAdapter(modelName, providerName);
}

function createLocalHandler(
  def: ProviderDefinition,
  modelName: string,
  targetModel: string,
  port: number,
  opts?: Pick<ComposedHandlerOptions, "isInteractive" | "invocationMode" | "summarizeTools"> & {
    concurrency?: number;
  },
): ModelHandler | null {
  // Try prefix-based local provider resolution (ollama/, lmstudio/, etc.)
  const resolved = resolveProvider(targetModel);
  if (resolved) {
    const provider = new LocalTransport(resolved.provider, resolved.modelName, {
      concurrency: opts?.concurrency ?? resolved.concurrency,
    });
    const adapter = createLocalAdapter(resolved.modelName, resolved.provider.name);
    const handler = new ComposedHandler(provider, resolved.modelName, resolved.modelName, port, {
      adapter,
      tokenStrategy: "local",
      summarizeTools: opts?.summarizeTools,
      isInteractive: opts?.isInteractive,
      invocationMode: opts?.invocationMode,
    });
    log(
      `[Proxy] Created local provider handler: ${resolved.provider.name}/${resolved.modelName}${(opts?.concurrency ?? resolved.concurrency) !== undefined ? ` (concurrency: ${opts?.concurrency ?? resolved.concurrency})` : ""}`
    );
    return handler;
  }

  // Try URL-based model (http://localhost:11434/llama3)
  const urlParsed = parseUrlModel(targetModel);
  if (urlParsed) {
    const providerConfig = createUrlProvider(urlParsed);
    const provider = new LocalTransport(providerConfig, urlParsed.modelName);
    const adapter = createLocalAdapter(urlParsed.modelName, providerConfig.name);
    const handler = new ComposedHandler(
      provider,
      urlParsed.modelName,
      urlParsed.modelName,
      port,
      {
        adapter,
        tokenStrategy: "local",
        summarizeTools: opts?.summarizeTools,
        isInteractive: opts?.isInteractive,
        invocationMode: opts?.invocationMode,
      }
    );
    log(
      `[Proxy] Created URL-based local provider handler: ${urlParsed.baseUrl}/${urlParsed.modelName}`
    );
    return handler;
  }

  return null;
}
