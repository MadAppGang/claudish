import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { log, isLoggingEnabled } from "./logger.js";
import type { ProxyServer } from "./types.js";
import { NativeHandler } from "./handlers/native-handler.js";
import { OpenRouterHandler } from "./handlers/openrouter-handler.js";
import { OllamaCloudHandler } from "./handlers/ollama-handler.js";
import type { ModelHandler } from "./handlers/types.js";

export async function createProxyServer(
  port: number,
  openrouterApiKey?: string,
  model?: string,
  monitorMode: boolean = false,
  anthropicApiKey?: string,
  modelMap?: { opus?: string; sonnet?: string; haiku?: string; subagent?: string },
  ollamaApiKey?: string,
  providerOverride?: "openrouter" | "ollama" | "auto"
): Promise<ProxyServer> {

  // Define handlers for different roles
  const nativeHandler = new NativeHandler(anthropicApiKey);
  const handlers = new Map<string, ModelHandler>(); // Map from "provider:model" -> Handler Instance

  // Helper to get or create OpenRouter handler
  const getOpenRouterHandler = (targetModel: string): ModelHandler => {
      const key = `openrouter:${targetModel}`;
      if (!handlers.has(key)) {
          handlers.set(key, new OpenRouterHandler(targetModel, openrouterApiKey, port));
      }
      return handlers.get(key)!;
  };

  // Helper to get or create OllamaCloud handler
  const getOllamaHandler = (targetModel: string): ModelHandler => {
      const key = `ollama:${targetModel}`;
      if (!handlers.has(key)) {
          handlers.set(key, new OllamaCloudHandler(targetModel, ollamaApiKey, port));
      }
      return handlers.get(key)!;
  };

  // Detect provider based on model name and override
  const detectProvider = (
      requestedModel: string,
      defaultModel?: string,
      modelMap?: typeof modelMap
  ): "openrouter" | "ollama" | "native" => {
      // 1. Override explícito (más alta prioridad)
      if (providerOverride && providerOverride !== "auto") {
          return providerOverride;
      }

      // 2. Resolver modelo target
      let target = defaultModel || requestedModel;
      const req = requestedModel.toLowerCase();
      if (modelMap) {
          if (req.includes("opus") && modelMap.opus) target = modelMap.opus;
          else if (req.includes("sonnet") && modelMap.sonnet) target = modelMap.sonnet;
          else if (req.includes("haiku") && modelMap.haiku) target = modelMap.haiku;
      }

      // 3. Heurística: modelos con "-cloud" o ":cloud" → OllamaCloud
      if (target.includes("-cloud") || target.endsWith(":cloud") || (target.includes(":") && !target.includes("/"))) {
          return "ollama";
      }

      // 4. Heurística: modelos con "/" → OpenRouter
      if (target.includes("/")) {
          return "openrouter";
      }

      // 5. Default: Native
      return "native";
  };

  // Pre-initialize handlers for mapped models
  if (model) {
      const provider = detectProvider(model, model, modelMap);
      if (provider === "openrouter") getOpenRouterHandler(model);
      else if (provider === "ollama") getOllamaHandler(model);
  }
  if (modelMap?.opus) {
      const provider = detectProvider(modelMap.opus, model, modelMap);
      if (provider === "openrouter") getOpenRouterHandler(modelMap.opus);
      else if (provider === "ollama") getOllamaHandler(modelMap.opus);
  }
  if (modelMap?.sonnet) {
      const provider = detectProvider(modelMap.sonnet, model, modelMap);
      if (provider === "openrouter") getOpenRouterHandler(modelMap.sonnet);
      else if (provider === "ollama") getOllamaHandler(modelMap.sonnet);
  }
  if (modelMap?.haiku) {
      const provider = detectProvider(modelMap.haiku, model, modelMap);
      if (provider === "openrouter") getOpenRouterHandler(modelMap.haiku);
      else if (provider === "ollama") getOllamaHandler(modelMap.haiku);
  }
  if (modelMap?.subagent) {
      const provider = detectProvider(modelMap.subagent, model, modelMap);
      if (provider === "openrouter") getOpenRouterHandler(modelMap.subagent);
      else if (provider === "ollama") getOllamaHandler(modelMap.subagent);
  }

  const getHandlerForRequest = (requestedModel: string): ModelHandler => {
      // 1. Monitor Mode Override
      if (monitorMode) return nativeHandler;

      // 2. Detectar proveedor
      const provider = detectProvider(requestedModel, model, modelMap);
      const target = model || requestedModel;

      // 3. Seleccionar handler según proveedor
      if (provider === "ollama") {
          return getOllamaHandler(target);
      } else if (provider === "openrouter") {
          return getOpenRouterHandler(target);
      } else {
          return nativeHandler;
      }
  };

  const app = new Hono();
  app.use("*", cors());

  app.get("/", (c) => c.json({ status: "ok", message: "Claudish Proxy", config: { mode: monitorMode ? "monitor" : "hybrid", mappings: modelMap } }));
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

              const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST", headers, body: JSON.stringify(body) });
              return c.json(await res.json());
          } else {
              // OpenRouter handler logic (estimation)
              const txt = JSON.stringify(body);
              return c.json({ input_tokens: Math.ceil(txt.length / 4) });
          }
      } catch (e) { return c.json({ error: String(e) }, 500); }
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
  const actualPort = typeof addr === 'object' && addr?.port ? addr.port : port;
  if (actualPort !== port) port = actualPort;

  log(`[Proxy] Server started on port ${port}`);

  return {
      port,
      url: `http://127.0.0.1:${port}`,
      shutdown: async () => {
          return new Promise<void>((resolve) => server.close((e) => resolve()));
      }
  };
}
