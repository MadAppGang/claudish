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
import { OpenAIHandler } from "./handlers/openai-handler.js";
import { AnthropicCompatHandler } from "./handlers/anthropic-compat-handler.js";
import type { ModelHandler } from "./handlers/types.js";
import {
  resolveProvider,
  parseUrlModel,
  createUrlProvider,
} from "./providers/provider-registry.js";
import {
  resolveRemoteProvider,
  validateRemoteProviderApiKey,
} from "./providers/remote-provider-registry.js";

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

  // Helper to get or create OpenRouter handler for a target model
  const getOpenRouterHandler = (targetModel: string): ModelHandler => {
    if (!openRouterHandlers.has(targetModel)) {
      openRouterHandlers.set(
        targetModel,
        new OpenRouterHandler(targetModel, openrouterApiKey, port)
      );
    }
    return openRouterHandlers.get(targetModel)!;
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
      const handler = new LocalProviderHandler(
        resolved.provider,
        resolved.modelName,
        port,
        localProviderOptions
      );
      localProviderHandlers.set(targetModel, handler);
      log(
        `[Proxy] Created local provider handler: ${resolved.provider.name}/${resolved.modelName}`
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
  const getRemoteProviderHandler = (targetModel: string): ModelHandler | null => {
    if (remoteProviderHandlers.has(targetModel)) {
      return remoteProviderHandlers.get(targetModel)!;
    }

    // Check for remote provider prefix (g/, gemini/, oai/, openai/, mmax/, mm/, kimi/, moonshot/, glm/, zhipu/, or/)
    const resolved = resolveRemoteProvider(targetModel);
    if (!resolved) {
      return null;
    }

    // Skip 'openrouter' provider here - it uses the existing OpenRouterHandler
    if (resolved.provider.name === "openrouter") {
      return null; // Will fall through to OpenRouterHandler
    }

    // Validate API key
    const apiKeyError = validateRemoteProviderApiKey(resolved.provider);
    if (apiKeyError) {
      throw new Error(apiKeyError);
    }

    const apiKey = process.env[resolved.provider.apiKeyEnvVar]!;

    let handler: ModelHandler;
    if (resolved.provider.name === "gemini") {
      handler = new GeminiHandler(resolved.provider, resolved.modelName, apiKey, port);
      log(`[Proxy] Created Gemini handler: ${resolved.modelName}`);
    } else if (resolved.provider.name === "openai") {
      handler = new OpenAIHandler(resolved.provider, resolved.modelName, apiKey, port);
      log(`[Proxy] Created OpenAI handler: ${resolved.modelName}`);
    } else if (resolved.provider.name === "minimax" || resolved.provider.name === "kimi") {
      // MiniMax and Kimi use Anthropic-compatible APIs
      handler = new AnthropicCompatHandler(resolved.provider, resolved.modelName, apiKey, port);
      log(`[Proxy] Created ${resolved.provider.name} handler: ${resolved.modelName}`);
    } else if (resolved.provider.name === "glm") {
      // GLM uses OpenAI-compatible API
      handler = new OpenAIHandler(resolved.provider, resolved.modelName, apiKey, port);
      log(`[Proxy] Created GLM handler: ${resolved.modelName}`);
    } else {
      return null; // Unknown provider
    }

    remoteProviderHandlers.set(targetModel, handler);
    return handler;
  };

  // Handlers are created lazily on first request - no pre-warming needed

  const getHandlerForRequest = (requestedModel: string): ModelHandler => {
    // 1. Monitor Mode Override
    if (monitorMode) return nativeHandler;

    // 2. Resolve target model based on mappings or defaults
    let target = model || requestedModel; // Start with global default or request

    const req = requestedModel.toLowerCase();
    if (modelMap) {
      if (req.includes("opus") && modelMap.opus) target = modelMap.opus;
      else if (req.includes("sonnet") && modelMap.sonnet) target = modelMap.sonnet;
      else if (req.includes("haiku") && modelMap.haiku) target = modelMap.haiku;
      // Note: We don't verify "subagent" string because we don't know what Claude sends for subagents
      // unless it's "claude-3-haiku" (which is covered above) or specific.
      // Assuming Haiku mapping covers subagent unless custom logic added.
    }

    // 3. Check for Remote Provider (g/, gemini/, oai/, openai/, mmax/, mm/, kimi/, moonshot/, glm/, zhipu/)
    const remoteHandler = getRemoteProviderHandler(target);
    if (remoteHandler) return remoteHandler;

    // 4. Check for Local Provider (ollama/, lmstudio/, vllm/, or URL)
    const localHandler = getLocalProviderHandler(target);
    if (localHandler) return localHandler;

    // 5. Native vs OpenRouter Decision
    // Heuristic: OpenRouter models have "/", Native ones don't.
    const isNative = !target.includes("/");

    if (isNative) {
      // If we mapped to a native string (unlikely) or passed through
      return nativeHandler;
    }

    // 6. OpenRouter Handler (default for any model with "/" not matched above)
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

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    shutdown: async () => {
      return new Promise<void>((resolve) => server.close((e) => resolve()));
    },
  };
}
