/**
 * createHandlerForProvider — construct a ComposedHandler for a resolved provider.
 *
 * Single function, flat switch. All transport + format + handler construction
 * in one place. No profile objects, no lookup tables, no indirection.
 */

import type { ComposedHandlerOptions } from "../handlers/composed-handler.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
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
import { DefaultAPIFormat } from "../adapters/base-api-format.js";
import { getRegisteredRemoteProviders } from "./remote-provider-registry.js";
import { getVertexConfig, validateVertexOAuthConfig } from "../auth/vertex-auth.js";
import { log, logStderr } from "../logger.js";
import { resolveApiKeyProvenance, formatProvenanceLog } from "./api-key-provenance.js";
import type { ModelHandler } from "../handlers/types.js";

export interface ProfileContext {
  provider: RemoteProvider;
  modelName: string;
  apiKey: string;
  targetModel: string;
  port: number;
  sharedOpts: Pick<ComposedHandlerOptions, "isInteractive" | "invocationMode">;
}

function compose(ctx: ProfileContext, transport: any, adapter: any): ComposedHandler {
  return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
    adapter,
    ...ctx.sharedOpts,
  });
}

/** Provider names handled by createHandlerForProvider. For test coverage verification. */
export const SUPPORTED_PROVIDERS = new Set([
  "gemini", "gemini-codeassist", "openai",
  "minimax", "minimax-coding", "kimi", "kimi-coding", "zai",
  "glm", "glm-coding",
  "opencode-zen", "opencode-zen-go",
  "ollamacloud", "litellm", "vertex",
]);

export function createHandlerForProvider(ctx: ProfileContext): ModelHandler | null {
  const { provider, modelName, apiKey, port } = ctx;
  const name = provider.name;

  if (provider.apiKeyEnvVar) {
    const provenance = resolveApiKeyProvenance(provider.apiKeyEnvVar);
    log(`[Proxy] API key: ${formatProvenanceLog(provenance)}`);
  }
  log(`[Proxy] Handler: provider=${name}, model=${modelName}`);

  switch (name) {
    case "gemini":
      return compose(ctx,
        new GeminiProviderTransport(provider, modelName, apiKey),
        new GeminiAPIFormat(modelName));

    case "gemini-codeassist":
      return compose(ctx,
        new GeminiCodeAssistProviderTransport(modelName),
        new GeminiAPIFormat(modelName));

    case "openai":
      return compose(ctx,
        new OpenAIProviderTransport(provider, modelName, apiKey),
        new OpenAIAPIFormat(modelName));

    case "minimax":
    case "minimax-coding":
    case "kimi":
    case "kimi-coding":
    case "zai":
      return compose(ctx,
        new AnthropicProviderTransport(provider, apiKey),
        new AnthropicAPIFormat(modelName, name));

    case "glm":
    case "glm-coding":
      return compose(ctx,
        new OpenAIProviderTransport(provider, modelName, apiKey),
        new OpenAIAPIFormat(modelName));

    case "opencode-zen":
    case "opencode-zen-go": {
      const zenKey = apiKey || "public";
      const lower = modelName.toLowerCase();
      if (lower.includes("minimax"))
        return compose(ctx,
          new AnthropicProviderTransport(provider, zenKey),
          new AnthropicAPIFormat(modelName, name));
      if (lower.startsWith("gpt-"))
        return compose(ctx,
          new OpenAIProviderTransport({ ...provider, apiPath: "/v1/responses" }, modelName, zenKey),
          new CodexAPIFormat(modelName));
      return compose(ctx,
        new OpenAIProviderTransport(provider, modelName, zenKey),
        new OpenAIAPIFormat(modelName));
    }

    case "ollamacloud":
      return compose(ctx,
        new OllamaProviderTransport(provider, apiKey),
        new OllamaAPIFormat(modelName));

    case "litellm":
      if (!provider.baseUrl) {
        logStderr("Error: LITELLM_BASE_URL or --litellm-url is required for LiteLLM provider.");
        return null;
      }
      return compose(ctx,
        new LiteLLMProviderTransport(provider.baseUrl, apiKey, modelName),
        new LiteLLMAPIFormat(modelName, provider.baseUrl));

    case "vertex": {
      if (process.env.VERTEX_API_KEY) {
        const geminiConfig = getRegisteredRemoteProviders().find((p) => p.name === "gemini");
        return compose(ctx,
          new GeminiProviderTransport(geminiConfig || provider, modelName, process.env.VERTEX_API_KEY),
          new GeminiAPIFormat(modelName));
      }
      const vertexConfig = getVertexConfig();
      if (!vertexConfig) {
        log(`[Proxy] Vertex AI requires either VERTEX_API_KEY or VERTEX_PROJECT`);
        return null;
      }
      const oauthError = validateVertexOAuthConfig();
      if (oauthError) { log(`[Proxy] Vertex OAuth config error: ${oauthError}`); return null; }
      const parsed = parseVertexModel(modelName);
      const transport = new VertexProviderTransport(vertexConfig, parsed);
      let adapter;
      if (parsed.publisher === "google") adapter = new GeminiAPIFormat(modelName);
      else if (parsed.publisher === "anthropic") adapter = new AnthropicAPIFormat(parsed.model, "vertex");
      else {
        const id = parsed.publisher === "mistralai" ? parsed.model : `${parsed.publisher}/${parsed.model}`;
        adapter = new DefaultAPIFormat(id);
      }
      return compose(ctx, transport, adapter);
    }

    default:
      return null;
  }
}
