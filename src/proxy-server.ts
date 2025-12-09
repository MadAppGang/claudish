import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { NativeHandler } from "./handlers/native-handler.js";
import { OpenRouterHandler } from "./handlers/openrouter-handler.js";
import { PoeHandler } from "./handlers/poe-handler.js";
import type { ModelHandler } from "./handlers/types.js";
import { isLoggingEnabled, log } from "./logger.js";
import type { ProxyServer } from "./types.js";

/**
 * Check if model is a Poe model (has poe: prefix).
 */
function isPoeModel(model: string): boolean {
  return model.startsWith("poe:");
}

export async function createProxyServer(
  port: number,
  openrouterApiKey?: string,
  model?: string,
  monitorMode = false,
  anthropicApiKey?: string,
  modelMap?: { opus?: string; sonnet?: string; haiku?: string; subagent?: string },
  poeApiKey?: string
): Promise<ProxyServer> {
  // Define handlers for different roles
  const nativeHandler = new NativeHandler(anthropicApiKey);
  const openrouterHandlers = new Map<string, ModelHandler>();
  const poeHandlers = new Map<string, ModelHandler>();

  // Helper to get or create OpenRouter handler for a target model
  const getOpenRouterHandler = (targetModel: string): ModelHandler => {
    if (!openrouterHandlers.has(targetModel)) {
      openrouterHandlers.set(
        targetModel,
        new OpenRouterHandler(targetModel, openrouterApiKey, port)
      );
    }
    return openrouterHandlers.get(targetModel)!;
  };

  // Helper to get or create Poe handler for a target model
  const getPoeHandler = (targetModel: string): ModelHandler => {
    if (!poeHandlers.has(targetModel)) {
      if (!poeApiKey) {
        throw new Error("POE_API_KEY is required for Poe models");
      }
      poeHandlers.set(targetModel, new PoeHandler(poeApiKey));
    }
    return poeHandlers.get(targetModel)!;
  };

  // Pre-initialize handlers for mapped models to ensure warm-up
  const initHandler = (m: string | undefined) => {
    if (!m) return;
    if (isPoeModel(m)) {
      getPoeHandler(m);
    } else if (m.includes("/")) {
      getOpenRouterHandler(m);
    }
  };

  initHandler(model);
  initHandler(modelMap?.opus);
  initHandler(modelMap?.sonnet);
  initHandler(modelMap?.haiku);
  initHandler(modelMap?.subagent);

  const getHandlerForRequest = (requestedModel: string): ModelHandler => {
    log(`[Proxy] getHandlerForRequest called with: ${requestedModel}`);

    // 1. Monitor Mode Override
    if (monitorMode) return nativeHandler;

    // 2. Poe Model Detection (poe/ prefix) - Check original request first
    if (isPoeModel(requestedModel)) {
      log(`[Proxy] Routing to Poe: ${requestedModel}`);
      return getPoeHandler(requestedModel);
    }

    // 3. Resolve target model based on mappings or defaults (for non-Poe models)
    let target = model || requestedModel; // Start with global default or request
    log(`[Proxy] Initial target: ${target}, global model: ${model}`);

    const req = requestedModel.toLowerCase();
    if (modelMap) {
      if (req.includes("opus") && modelMap.opus) target = modelMap.opus;
      else if (req.includes("sonnet") && modelMap.sonnet) target = modelMap.sonnet;
      else if (req.includes("haiku") && modelMap.haiku) target = modelMap.haiku;
      // Note: We don't verify "subagent" string because we don't know what Claude sends for subagents
      // unless it's "claude-3-haiku" (which is covered above) or specific.
      // Assuming Haiku mapping covers subagent unless custom logic added.
    }

    log(`[Proxy] After mapping check, target: ${target}`);

    // 4. Native vs OpenRouter Decision
    // Heuristic: OpenRouter models have "/", Native ones don't.
    const isNative = !target.includes("/");

    if (isNative) {
      // If we mapped to a native string (unlikely) or passed through
      return nativeHandler;
    }

    // 5. OpenRouter Handler (default for provider/model format)
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
      }
      // OpenRouter handler logic (estimation)
      const txt = JSON.stringify(body);
      return c.json({ input_tokens: Math.ceil(txt.length / 4) });
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
