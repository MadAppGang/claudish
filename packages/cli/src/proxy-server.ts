import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { log, isLoggingEnabled } from "./logger.js";
import type { ProxyServer } from "./types.js";
import { NativeHandler } from "./handlers/native-handler.js";
import { OpenRouterHandler } from "./handlers/openrouter-handler.js";
import {
  LocalProviderHandler,
  type LocalProviderOptions,
} from "./handlers/local-provider-handler.js";
import { GeminiHandler } from "./handlers/gemini-handler.js";
import { GeminiCodeAssistHandler } from "./handlers/gemini-codeassist-handler.js";
import { OpenAIHandler } from "./handlers/openai-handler.js";
import { AnthropicCompatHandler } from "./handlers/anthropic-compat-handler.js";
import { VertexOAuthHandler } from "./handlers/vertex-oauth-handler.js";
import { PoeHandler } from "./handlers/poe-handler.js";
import { OllamaCloudHandler } from "./handlers/ollamacloud-handler.js";
import { LiteLLMHandler } from "./handlers/litellm-handler.js";
import type { ModelHandler } from "./handlers/types.js";
import {
  resolveProvider,
  parseUrlModel,
  createUrlProvider,
} from "./providers/provider-registry.js";
import { parseModelSpec } from "./providers/model-parser.js";
import {
  resolveRemoteProvider,
  validateRemoteProviderApiKey,
} from "./providers/remote-provider-registry.js";
import { getVertexConfig, validateVertexOAuthConfig } from "./auth/vertex-auth.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import { warmPricingCache } from "./services/pricing-cache.js";

export interface ProxyServerOptions {
  summarizeTools?: boolean; // Summarize tool descriptions for local models
}

export async function createProxyServer(
  port: number,
  openrouterApiKey?: string,
  model?: string,
  monitorMode: boolean = false,
  anthropicApiKey?: string,
  modelMap?: { opus?: string; sonnet?: string; haiku?: string; subagent?: string },
  options: ProxyServerOptions = {}
): Promise<ProxyServer> {
  // Define handlers for different roles
  const nativeHandler = new NativeHandler(anthropicApiKey);
  const openRouterHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> OpenRouter Handler
  const localProviderHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Local Provider Handler
  const remoteProviderHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Gemini/OpenAI Handler
  const poeHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Poe Handler

  // Helper to get or create OpenRouter handler for a target model
  const getOpenRouterHandler = (targetModel: string): ModelHandler => {
    // Strip any provider prefix (e.g., openrouter@google/gemini -> google/gemini, glm@glm-5 -> glm-5)
    const parsed = parseModelSpec(targetModel);
    const modelId = parsed.provider !== "native-anthropic" ? parsed.model : targetModel;

    if (!openRouterHandlers.has(modelId)) {
      openRouterHandlers.set(modelId, new OpenRouterHandler(modelId, openrouterApiKey, port));
    }
    return openRouterHandlers.get(modelId)!;
  };

  // Helper to get or create Poe handler for a target model
  const getPoeHandler = (targetModel: string): ModelHandler | null => {
    const poeApiKey = process.env.POE_API_KEY;
    if (!poeApiKey) {
      log(`[Proxy] POE_API_KEY not set, cannot use Poe model: ${targetModel}`);
      return null;
    }
    if (!poeHandlers.has(targetModel)) {
      poeHandlers.set(targetModel, new PoeHandler(poeApiKey));
    }
    return poeHandlers.get(targetModel)!;
  };

  // Check if model is a Poe model (has poe: prefix)
  const isPoeModel = (model: string): boolean => {
    return model.startsWith("poe:");
  };

  // Local provider options
  const localProviderOptions: LocalProviderOptions = {
    summarizeTools: options.summarizeTools,
  };

  // Helper to get or create Local Provider handler for a target model
  const getLocalProviderHandler = (targetModel: string): ModelHandler | null => {
    if (localProviderHandlers.has(targetModel)) {
      return localProviderHandlers.get(targetModel)!;
    }

    // Check for prefix-based local provider (ollama/, lmstudio/, etc.)
    const resolved = resolveProvider(targetModel);
    if (resolved) {
      const handlerOptions: LocalProviderOptions = {
        ...localProviderOptions,
        concurrency: resolved.concurrency,
      };
      const handler = new LocalProviderHandler(
        resolved.provider,
        resolved.modelName,
        port,
        handlerOptions
      );
      localProviderHandlers.set(targetModel, handler);
      log(
        `[Proxy] Created local provider handler: ${resolved.provider.name}/${resolved.modelName}${resolved.concurrency !== undefined ? ` (concurrency: ${resolved.concurrency})` : ""}`
      );
      return handler;
    }

    // Check for URL-based model (http://localhost:11434/llama3)
    const urlParsed = parseUrlModel(targetModel);
    if (urlParsed) {
      const provider = createUrlProvider(urlParsed);
      const handler = new LocalProviderHandler(
        provider,
        urlParsed.modelName,
        port,
        localProviderOptions
      );
      localProviderHandlers.set(targetModel, handler);
      log(
        `[Proxy] Created URL-based local provider handler: ${urlParsed.baseUrl}/${urlParsed.modelName}`
      );
      return handler;
    }

    return null;
  };

  // Helper to get or create remote provider handler (Gemini, OpenAI)
  // TODO: Consolidate src/ and packages/core/src/ - they're manually synced duplicates
  const getRemoteProviderHandler = (targetModel: string): ModelHandler | null => {
    if (remoteProviderHandlers.has(targetModel)) {
      return remoteProviderHandlers.get(targetModel)!;
    }

    // Use centralized resolver with fallback logic
    const resolution = resolveModelProvider(targetModel);

    // If resolver says use OpenRouter (including fallback cases), return null
    // to let the OpenRouter handler take over
    if (resolution.category === "openrouter") {
      return null;
    }

    // If resolver says use direct-api and key is available, create handler
    if (resolution.category === "direct-api" && resolution.apiKeyAvailable) {
      const resolved = resolveRemoteProvider(targetModel);
      if (!resolved) return null;

      // Skip 'openrouter' provider here - it uses the existing OpenRouterHandler
      if (resolved.provider.name === "openrouter") {
        return null; // Will fall through to OpenRouterHandler
      }

      // Get API key - empty string for providers that don't require auth (like zen/ free models)
      const apiKey = resolved.provider.apiKeyEnvVar
        ? process.env[resolved.provider.apiKeyEnvVar] || ""
        : "";

      let handler: ModelHandler;
      if (resolved.provider.name === "gemini") {
        handler = new GeminiHandler(resolved.provider, resolved.modelName, apiKey, port);
        log(`[Proxy] Created Gemini handler: ${resolved.modelName}`);
      } else if (resolved.provider.name === "gemini-codeassist") {
        handler = new GeminiCodeAssistHandler(resolved.modelName, port);
        log(`[Proxy] Created Gemini Code Assist handler: ${resolved.modelName}`);
      } else if (resolved.provider.name === "openai") {
        handler = new OpenAIHandler(resolved.provider, resolved.modelName, apiKey, port);
        log(`[Proxy] Created OpenAI handler: ${resolved.modelName}`);
      } else if (
        resolved.provider.name === "minimax" ||
        resolved.provider.name === "kimi" ||
        resolved.provider.name === "kimi-coding" ||
        resolved.provider.name === "zai"
      ) {
        // MiniMax, Kimi, Kimi Coding, and Z.AI use Anthropic-compatible APIs
        handler = new AnthropicCompatHandler(resolved.provider, resolved.modelName, apiKey, port);
        log(`[Proxy] Created ${resolved.provider.name} handler: ${resolved.modelName}`);
      } else if (resolved.provider.name === "glm" || resolved.provider.name === "glm-coding") {
        // GLM and GLM Coding Plan use OpenAI-compatible API
        handler = new OpenAIHandler(resolved.provider, resolved.modelName, apiKey, port);
        log(`[Proxy] Created ${resolved.provider.name} handler: ${resolved.modelName}`);
      } else if (resolved.provider.name === "opencode-zen") {
        // OpenCode Zen uses OpenAI-compatible API for most models
        // MiniMax models on Zen use Anthropic-compatible API
        if (resolved.modelName.toLowerCase().includes("minimax")) {
          handler = new AnthropicCompatHandler(resolved.provider, resolved.modelName, apiKey, port);
          log(`[Proxy] Created OpenCode Zen (Anthropic) handler: ${resolved.modelName}`);
        } else {
          handler = new OpenAIHandler(resolved.provider, resolved.modelName, apiKey, port);
          log(`[Proxy] Created OpenCode Zen (OpenAI) handler: ${resolved.modelName}`);
        }
      } else if (resolved.provider.name === "ollamacloud") {
        // OllamaCloud uses Ollama native API (NOT OpenAI-compatible)
        handler = new OllamaCloudHandler(resolved.provider, resolved.modelName, apiKey, port);
        log(`[Proxy] Created OllamaCloud handler: ${resolved.modelName}`);
      } else if (resolved.provider.name === "litellm") {
        // LiteLLM uses OpenAI-compatible API format
        if (!resolved.provider.baseUrl) {
          console.error("Error: LITELLM_BASE_URL or --litellm-url is required for LiteLLM provider.");
          console.error("Set it with: export LITELLM_BASE_URL='https://your-litellm-instance.com'");
          console.error("Or use: claudish --litellm-url https://your-instance.com --model litellm@model 'task'");
          return null;
        }
        handler = new LiteLLMHandler(targetModel, resolved.modelName, apiKey, port, resolved.provider.baseUrl);
        log(`[Proxy] Created LiteLLM handler: ${resolved.modelName} (${resolved.provider.baseUrl})`);
      } else if (resolved.provider.name === "vertex") {
        // Vertex AI supports two modes:
        // 1. Express Mode (API key) - for Gemini models
        // 2. OAuth Mode (project/service account) - for all models including partners
        const hasApiKey = !!process.env.VERTEX_API_KEY;
        const vertexConfig = getVertexConfig();

        if (hasApiKey) {
          // Express Mode - use GeminiHandler with API key
          handler = new GeminiHandler(resolved.provider, resolved.modelName, apiKey, port);
          log(`[Proxy] Created Vertex AI Express handler: ${resolved.modelName}`);
        } else if (vertexConfig) {
          // OAuth Mode - use VertexOAuthHandler
          const oauthError = validateVertexOAuthConfig();
          if (oauthError) {
            log(`[Proxy] Vertex OAuth config error: ${oauthError}`);
            return null;
          }
          handler = new VertexOAuthHandler(resolved.modelName, port);
          log(
            `[Proxy] Created Vertex AI OAuth handler: ${resolved.modelName} (project: ${vertexConfig.projectId})`
          );
        } else {
          log(`[Proxy] Vertex AI requires either VERTEX_API_KEY or VERTEX_PROJECT`);
          return null;
        }
      } else {
        return null; // Unknown provider
      }

      remoteProviderHandlers.set(targetModel, handler);
      return handler;
    }

    // If we get here, either category is not direct-api or key is not available
    // Both cases should fall through to OpenRouter or return null
    return null;
  };

  // Handlers are created lazily on first request - no pre-warming needed

  const getHandlerForRequest = (requestedModel: string): ModelHandler => {
    // 1. Monitor Mode Override
    if (monitorMode) return nativeHandler;

    // 2. Resolve target model based on mappings or defaults
    // Priority: role mappings > default model (--model) > requested model (native)
    let target = requestedModel;

    const req = requestedModel.toLowerCase();
    if (modelMap) {
      // Role-specific mappings take highest priority
      if (req.includes("opus") && modelMap.opus) target = modelMap.opus;
      else if (req.includes("sonnet") && modelMap.sonnet) target = modelMap.sonnet;
      else if (req.includes("haiku") && modelMap.haiku) target = modelMap.haiku;
      // Default model (--model) is fallback for all roles
      else if (model) target = model;
    } else if (model) {
      // No role mappings at all - use default model
      target = model;
    }

    // 3. Check for Poe Model (poe: prefix)
    if (isPoeModel(target)) {
      const poeHandler = getPoeHandler(target);
      if (poeHandler) {
        log(`[Proxy] Routing to Poe: ${target}`);
        return poeHandler;
      }
    }

    // 4. Check for Remote Provider (g/, gemini/, oai/, openai/, mmax/, mm/, kimi/, moonshot/, glm/, zhipu/)
    const remoteHandler = getRemoteProviderHandler(target);
    if (remoteHandler) return remoteHandler;

    // 5. Check for Local Provider (ollama/, lmstudio/, vllm/, or URL)
    const localHandler = getLocalProviderHandler(target);
    if (localHandler) return localHandler;

    // 6. Native vs OpenRouter Decision
    // Models with explicit provider prefix (@) should never fall to native Anthropic handler.
    // They were explicitly routed to a provider - if the handler wasn't created above,
    // it's because the API key is missing, not because it's a native model.
    const hasExplicitProvider = target.includes("@");
    const isNative = !target.includes("/") && !hasExplicitProvider;

    if (isNative) {
      // If we mapped to a native string (unlikely) or passed through
      return nativeHandler;
    }

    // 7. OpenRouter Handler (default for any model with "/" or explicit provider not matched above)
    return getOpenRouterHandler(target);
  };

  const app = new Hono();
  app.use("*", cors());

  app.get("/", (c) =>
    c.json({
      status: "ok",
      message: "Claudish Proxy",
      config: { mode: monitorMode ? "monitor" : "hybrid", mappings: modelMap },
    })
  );
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Token counting
  app.post("/v1/messages/count_tokens", async (c) => {
    try {
      const body = await c.req.json();
      const reqModel = body.model || "claude-3-opus-20240229";
      const handler = getHandlerForRequest(reqModel);

      // If native, we just forward. OpenRouter needs estimation.
      if (handler instanceof NativeHandler) {
        const headers: any = { "Content-Type": "application/json" };
        if (anthropicApiKey) headers["x-api-key"] = anthropicApiKey;

        const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        return c.json(await res.json());
      } else {
        // OpenRouter handler logic (estimation)
        const txt = JSON.stringify(body);
        return c.json({ input_tokens: Math.ceil(txt.length / 4) });
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/v1/messages", async (c) => {
    try {
      const body = await c.req.json();
      const handler = getHandlerForRequest(body.model);

      // Route
      return handler.handle(c, body);
    } catch (e) {
      log(`[Proxy] Error: ${e}`);
      return c.json({ error: { type: "server_error", message: String(e) } }, 500);
    }
  });

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

  // Port resolution
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr?.port ? addr.port : port;
  if (actualPort !== port) port = actualPort;

  log(`[Proxy] Server started on port ${port}`);

  // Warm pricing cache in background (non-blocking)
  warmPricingCache().catch(() => {});

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    shutdown: async () => {
      return new Promise<void>((resolve) => server.close((e) => resolve()));
    },
  };
}
