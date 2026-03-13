import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { log, logStderr } from "./logger.js";
import type { ProxyServer } from "./types.js";
import { NativeHandler } from "./handlers/native-handler.js";
import type { ModelHandler } from "./handlers/types.js";
import { ProviderHandler } from "./handlers/provider-handler.js";
import {
  parseUrlModel,
  URL_PROVIDER_CAPABILITIES,
} from "./providers/provider-registry.js";
import { parseModelSpec } from "./providers/model-parser.js";
import {
  resolveRemoteProvider,
} from "./providers/remote-provider-registry.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import { warmPricingCache } from "./services/pricing-cache.js";
import { fetchLiteLLMModels } from "./model-loader.js";
import {
  resolveModelName,
  logResolution,
  warmAllCatalogs,
} from "./providers/model-catalog-resolver.js";
import {
  getProviderByName,
  isLocalTransport,
  warmProviderCache,
  type ProviderDefinition,
} from "./providers/provider-definitions.js";
import { selectProviderComponents } from "./providers/provider-components.js";

export interface ProxyServerOptions {
  summarizeTools?: boolean; // Summarize tool descriptions for local models
  quiet?: boolean; // Suppress informational stderr output (e.g., [Auto-route])
  isInteractive?: boolean; // Whether the current session is interactive (gates consent prompt)
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
  const handlerCache = new Map<string, ModelHandler>(); // Map from Target Model ID -> Handler

  // Helper to get or create a handler via the factory for a given definition
  const getFactoryHandler = (def: ProviderDefinition, modelName: string, targetModel: string, apiKey: string, concurrency?: number): ModelHandler | null => {
    const components = selectProviderComponents(def, modelName, apiKey, concurrency);
    if (!components) return null;
    const handler = new ProviderHandler(targetModel, modelName, port, options.isInteractive, components, {
      tokenStrategy: def.tokenStrategy,
      summarizeTools: options.summarizeTools,
    });
    handlerCache.set(targetModel, handler);
    log(`[Proxy] Created ${def.displayName} handler: ${modelName}${concurrency !== undefined ? ` (concurrency: ${concurrency})` : ""}`);
    return handler;
  };

  // Helper to get or create OpenRouter handler for a model ID (vendor/model format)
  const getOpenRouterHandler = (modelId: string): ModelHandler => {
    if (handlerCache.has(modelId)) return handlerCache.get(modelId)!;
    const orDef = getProviderByName("openrouter")!;
    const apiKey = openrouterApiKey || process.env.OPENROUTER_API_KEY || "";
    const handler = getFactoryHandler(orDef, modelId, modelId, apiKey);
    if (!handler) throw new Error("Failed to create OpenRouter handler");
    return handler;
  };

  // Helper to get or create Local Provider handler for a target model
  const getLocalProviderHandler = (targetModel: string): ModelHandler | null => {
    if (handlerCache.has(targetModel)) return handlerCache.get(targetModel)!;

    // Check for definition-based local provider (ollama@, lmstudio@, etc.)
    const parsed = parseModelSpec(targetModel);
    if (isLocalTransport(parsed.provider)) {
      const def = getProviderByName(parsed.provider);
      if (def) return getFactoryHandler(def, parsed.model, targetModel, "", parsed.concurrency);
    }

    // Check for URL-based model (http://localhost:11434/llama3)
    const urlParsed = parseUrlModel(targetModel);
    if (urlParsed) {
      const def: ProviderDefinition = {
        name: "custom-url", displayName: "Custom URL",
        transport: "local", tokenStrategy: "local",
        baseUrl: urlParsed.baseUrl, apiPath: "/v1/chat/completions",
        apiKeyEnvVar: "", authScheme: "none",
        shortcuts: [], legacyPrefixes: [],
        capabilities: URL_PROVIDER_CAPABILITIES,
      };
      return getFactoryHandler(def, urlParsed.modelName, targetModel, "");
    }

    return null;
  };

  // Helper to get or create remote provider handler
  // Uses selectProviderComponents() factory for all transports.
  // Vertex express mode uses the Gemini definition; Vertex OAuth uses the Vertex definition.
  const getRemoteProviderHandler = async (targetModel: string): Promise<ModelHandler | null> => {
    if (handlerCache.has(targetModel)) return handlerCache.get(targetModel)!;

    // Use centralized resolver with fallback logic
    const resolution = await resolveModelProvider(targetModel);

    if (resolution.wasAutoRouted && resolution.autoRouteMessage) {
      if (!options.quiet) {
        console.error(`[Auto-route] ${resolution.autoRouteMessage}`);
      }
      log(`[Auto-route] ${resolution.autoRouteMessage}`);
    }

    // OpenRouter routing (explicit or auto-routed fallback)
    if (resolution.category === "openrouter") {
      return getOpenRouterHandler(resolution.modelName || targetModel);
    }

    // When auto-routed (e.g. to LiteLLM), use the resolved fullModelId so that
    // resolveRemoteProvider() receives "litellm@gemini-2.0-flash" instead of the
    // original bare model name which would match the wrong (native) provider.
    const resolveTarget =
      resolution.wasAutoRouted && resolution.fullModelId ? resolution.fullModelId : targetModel;

    // If resolver says use direct-api and key is available, create handler
    if (resolution.category === "direct-api" && resolution.apiKeyAvailable) {
      const resolved = resolveRemoteProvider(resolveTarget);
      if (!resolved) return null;

      // Get API key - empty string for providers that don't require auth (like zen/ free models)
      const apiKey = resolved.provider.apiKeyEnvVar
        ? process.env[resolved.provider.apiKeyEnvVar] || ""
        : "";

      // Vertex express mode uses Gemini definition; all others use their own definition
      let def: ProviderDefinition | undefined;
      let effectiveApiKey = apiKey;
      if (resolved.provider.name === "vertex" && process.env.VERTEX_API_KEY) {
        def = getProviderByName("google");
        effectiveApiKey = process.env.VERTEX_API_KEY;
      } else {
        def = getProviderByName(resolved.provider.name);
      }
      if (!def) return null;

      const handler = getFactoryHandler(def, resolved.modelName, targetModel, effectiveApiKey);
      if (!handler) return null;

      // Cache under resolveTarget too (if different) so subsequent lookups are served from cache
      if (resolveTarget !== targetModel) {
        handlerCache.set(resolveTarget, handler);
      }
      return handler;
    }

    // If we get here, either category is not direct-api or key is not available
    return null;
  };

  // Pre-warm LiteLLM model cache for auto-routing (non-blocking)
  if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) {
    fetchLiteLLMModels(
      process.env.LITELLM_BASE_URL,
      process.env.LITELLM_API_KEY
    ).then(() => {
      log("[Proxy] LiteLLM model cache pre-warmed for auto-routing");
    }).catch(() => {
      // Silently ignore - auto-routing will skip LiteLLM if cache unavailable
    });
  }

  const getHandlerForRequest = async (requestedModel: string): Promise<ModelHandler> => {
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

    // 2b. Catalog resolution: resolve vendor prefix for OpenRouter and LiteLLM
    // This must happen after target is determined but before handler construction.
    {
      const parsedTarget = parseModelSpec(target);
      if (parsedTarget.provider === "openrouter" || parsedTarget.provider === "litellm") {
        const resolution = await resolveModelName(parsedTarget.model, parsedTarget.provider);
        logResolution(parsedTarget.model, resolution, options.quiet);
        if (resolution.wasResolved) {
          // Reconstruct target with resolved model name so handler construction
          // uses the correct fully-qualified API ID (e.g., "qwen/qwen3-coder-next").
          target = `${parsedTarget.provider}@${resolution.resolvedId}`;
        }
      }
    }

    // 3. Check for Remote Provider (includes Poe via poe: prefix, OpenRouter, Vertex, etc.)
    const remoteHandler = await getRemoteProviderHandler(target);
    if (remoteHandler) return remoteHandler;

    // 4. Check for Local Provider (ollama/, lmstudio/, vllm/, or URL)
    const localHandler = getLocalProviderHandler(target);
    if (localHandler) return localHandler;

    // 5. Native vs OpenRouter Decision
    // Models with explicit provider prefix (@) should never fall to native Anthropic handler.
    // They were explicitly routed to a provider - if the handler wasn't created above,
    // it's because the API key is missing, not because it's a native model.
    const hasExplicitProvider = target.includes("@");
    const isNative = !target.includes("/") && !hasExplicitProvider;

    if (isNative) {
      // If we mapped to a native string (unlikely) or passed through
      return nativeHandler;
    }

    // 6. Explicit provider@ that wasn't handled above means missing API key or
    // unsupported provider -- warn instead of silently falling to OpenRouter.
    if (hasExplicitProvider) {
      const parsed = parseModelSpec(target);
      const def = getProviderByName(parsed.provider);
      if (def) {
        logStderr(`[Proxy] Warning: ${def.displayName} API key not configured, falling back to OpenRouter for: ${target}`);
      } else {
        logStderr(`[Proxy] Warning: Unknown provider "${parsed.provider}", falling back to OpenRouter for: ${target}`);
      }
    }

    // 7. OpenRouter Handler (default for any model with "/" or unmatched explicit provider)
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
      const handler = await getHandlerForRequest(reqModel);

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
      const handler = await getHandlerForRequest(body.model);

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

  // Warm user-defined providers in background (non-blocking)
  warmProviderCache().catch(() => {});

  // Warm pricing cache in background (non-blocking)
  warmPricingCache().catch(() => {});

  // Warm model catalog resolvers in background (non-blocking)
  // OpenRouter always warms; LiteLLM only if configured.
  const catalogProvidersToWarm = ["openrouter"];
  if (process.env.LITELLM_BASE_URL) catalogProvidersToWarm.push("litellm");
  warmAllCatalogs(catalogProvidersToWarm).catch(() => {
    // Warming failures are non-fatal; resolver falls back to passthrough
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    shutdown: async () => {
      return new Promise<void>((resolve) => server.close((e) => resolve()));
    },
  };
}
