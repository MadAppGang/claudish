import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { log, logStderr, isLoggingEnabled } from "./logger.js";
import type { ProxyServer } from "./types.js";
import { NativeHandler } from "./handlers/native-handler.js";
import { OpenRouterTransport } from "./providers/transport/openrouter.js";
import { OpenRouterAdapter } from "./adapters/openrouter-adapter.js";
import { GeminiFormatAdapter } from "./adapters/gemini-format-adapter.js";
import { VertexOAuthTransport, parseVertexModel } from "./providers/transport/vertex-oauth.js";
import { FormatAdapter } from "./adapters/format-adapter.js";
import { AnthropicPassthroughAdapter } from "./adapters/anthropic-passthrough-adapter.js";
import { OpenAIFormatAdapter } from "./adapters/openai-format-adapter.js";
import { PoeProvider } from "./providers/transport/poe.js";
import type { ModelHandler } from "./handlers/types.js";
import { ProviderHandler } from "./handlers/provider-handler.js";
import {
  parseUrlModel,
  createUrlProvider,
} from "./providers/provider-registry.js";
import { parseModelSpec } from "./providers/model-parser.js";
import {
  resolveRemoteProvider,
} from "./providers/remote-provider-registry.js";
import { getVertexConfig, validateVertexOAuthConfig } from "./auth/vertex-auth.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import { warmPricingCache } from "./services/pricing-cache.js";
import { fetchLiteLLMModels } from "./model-loader.js";
import {
  resolveModelNameSync,
  logResolution,
  warmAllCatalogs,
} from "./providers/model-catalog-resolver.js";
import {
  getProviderByName,
  isLocalTransport,
} from "./providers/provider-definitions.js";
import { createTransportForProvider } from "./providers/provider-factory.js";
import { LocalTransport } from "./providers/transport/local.js";
import { LocalModelAdapter } from "./adapters/local-adapter.js";

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
  const openRouterHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> OpenRouter Handler
  const localProviderHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Local Provider Handler
  const remoteProviderHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Gemini/OpenAI Handler
  const poeHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Poe Handler

  // Helper to get or create OpenRouter handler for a target model
  const getOpenRouterHandler = (targetModel: string): ModelHandler => {
    // For explicit @ syntax: strip provider prefix (openrouter@google/gemini → google/gemini)
    // For already-resolved vendor/model IDs (qwen/qwen3.5-plus-02-15): use as-is to preserve
    // the vendor prefix that OpenRouter requires. parseModelSpec() would otherwise strip it
    // (e.g. "qwen/" is a native pattern match → model becomes "qwen3.5-plus-02-15").
    const parsed = parseModelSpec(targetModel);
    const modelId = targetModel.includes("@") ? parsed.model : targetModel;

    if (!openRouterHandlers.has(modelId)) {
      const orProvider = new OpenRouterTransport(openrouterApiKey || "");
      const orAdapter = new OpenRouterAdapter(modelId);
      openRouterHandlers.set(
        modelId,
        new ProviderHandler(orProvider, modelId, modelId, port, { formatAdapter: orAdapter, isInteractive: options.isInteractive })
      );
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
    // Strip "poe:" prefix to get the actual model name for the API
    const modelId = targetModel.replace(/^poe:/, "");
    if (!poeHandlers.has(modelId)) {
      const poeTransport = new PoeProvider(poeApiKey);
      const poeDef = getProviderByName("poe");
      poeHandlers.set(
        modelId,
        new ProviderHandler(poeTransport, modelId, modelId, port, {
          formatAdapter: new OpenAIFormatAdapter(modelId, poeDef?.capabilities || { supportsTools: true, supportsVision: true, supportsStreaming: true, supportsJsonMode: false, supportsReasoning: false }),
          isInteractive: options.isInteractive,
        })
      );
    }
    return poeHandlers.get(modelId)!;
  };

  // Check if model is a Poe model (has poe: prefix)
  const isPoeModel = (model: string): boolean => {
    return model.startsWith("poe:");
  };

  // Helper to get or create Local Provider handler for a target model
  const getLocalProviderHandler = (targetModel: string): ModelHandler | null => {
    if (localProviderHandlers.has(targetModel)) {
      return localProviderHandlers.get(targetModel)!;
    }

    // Check for definition-based local provider (ollama@, lmstudio@, etc.)
    const parsed = parseModelSpec(targetModel);
    if (isLocalTransport(parsed.provider)) {
      const def = getProviderByName(parsed.provider);
      if (def) {
        const result = createTransportForProvider(def, parsed.model, "", {
          concurrency: parsed.concurrency,
          summarizeTools: options.summarizeTools,
        });
        if (result) {
          const handler = new ProviderHandler(result.transport, parsed.model, parsed.model, port, {
            formatAdapter: result.formatAdapter,
            tokenStrategy: result.tokenStrategy,
            summarizeTools: result.summarizeTools,
            isInteractive: options.isInteractive,
          });
          localProviderHandlers.set(targetModel, handler);
          log(`[Proxy] ${result.logMessage}${parsed.concurrency !== undefined ? ` (concurrency: ${parsed.concurrency})` : ""}`);
          return handler;
        }
      }
    }

    // Check for URL-based model (http://localhost:11434/llama3)
    const urlParsed = parseUrlModel(targetModel);
    if (urlParsed) {
      const providerConfig = createUrlProvider(urlParsed);
      const provider = new LocalTransport(providerConfig, urlParsed.modelName);
      const formatAdapter = new LocalModelAdapter(
        urlParsed.modelName,
        providerConfig.name,
        providerConfig.capabilities
      );
      const handler = new ProviderHandler(provider, urlParsed.modelName, urlParsed.modelName, port, {
        formatAdapter,
        tokenStrategy: "local",
        summarizeTools: options.summarizeTools,
        isInteractive: options.isInteractive,
      });
      localProviderHandlers.set(targetModel, handler);
      log(
        `[Proxy] Created URL-based local provider handler: ${urlParsed.baseUrl}/${urlParsed.modelName}`
      );
      return handler;
    }

    return null;
  };

  // Helper to get or create remote provider handler
  // Uses createTransportForProvider() factory for most transports,
  // with special handling for vertex (express vs oauth mode selection).
  const getRemoteProviderHandler = (targetModel: string): ModelHandler | null => {
    if (remoteProviderHandlers.has(targetModel)) {
      return remoteProviderHandlers.get(targetModel)!;
    }

    // Use centralized resolver with fallback logic
    const resolution = resolveModelProvider(targetModel);

    if (resolution.wasAutoRouted && resolution.autoRouteMessage) {
      if (!options.quiet) {
        console.error(`[Auto-route] ${resolution.autoRouteMessage}`);
      }
      log(`[Auto-route] ${resolution.autoRouteMessage}`);
    }

    // If resolver says use OpenRouter (including fallback cases), create the handler
    // directly here so we can use the correctly-formatted fullModelId (e.g. "google/gemini-2.0-flash")
    // rather than the raw targetModel string.
    if (resolution.category === "openrouter") {
      if (resolution.wasAutoRouted && resolution.fullModelId) {
        return getOpenRouterHandler(resolution.fullModelId);
      }
      return null;
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

      // Skip 'openrouter' provider here - it uses the existing OpenRouterHandler
      if (resolved.provider.name === "openrouter") {
        return null; // Will fall through to OpenRouterHandler
      }

      // Get API key - empty string for providers that don't require auth (like zen/ free models)
      const apiKey = resolved.provider.apiKeyEnvVar
        ? process.env[resolved.provider.apiKeyEnvVar] || ""
        : "";

      let handler: ModelHandler;

      // Vertex has special express/OAuth mode selection
      if (resolved.provider.name === "vertex") {
        const hasApiKey = !!process.env.VERTEX_API_KEY;
        const vertexConfig = getVertexConfig();

        if (hasApiKey) {
          // Express Mode - uses Gemini API endpoint with VERTEX_API_KEY
          const geminiDef = getProviderByName("google");
          const expressResult = geminiDef
            ? createTransportForProvider(geminiDef, resolved.modelName, process.env.VERTEX_API_KEY!)
            : null;
          if (!expressResult) {
            log(`[Proxy] Failed to create Vertex Express handler`);
            return null;
          }
          handler = new ProviderHandler(expressResult.transport, targetModel, resolved.modelName, port, {
            formatAdapter: expressResult.formatAdapter,
            isInteractive: options.isInteractive,
          });
          log(`[Proxy] Created Vertex AI Express handler: ${resolved.modelName}`);
        } else if (vertexConfig) {
          // OAuth Mode - publisher-specific adapter
          const oauthError = validateVertexOAuthConfig();
          if (oauthError) {
            log(`[Proxy] Vertex OAuth config error: ${oauthError}`);
            return null;
          }
          const parsed = parseVertexModel(resolved.modelName);
          const vxProvider = new VertexOAuthTransport(vertexConfig, parsed);

          let vxAdapter: FormatAdapter;
          if (parsed.publisher === "google") {
            vxAdapter = new GeminiFormatAdapter(resolved.modelName);
          } else if (parsed.publisher === "anthropic") {
            vxAdapter = new AnthropicPassthroughAdapter(parsed.model, "vertex");
          } else {
            const modelId = parsed.publisher === "mistralai"
              ? parsed.model
              : `${parsed.publisher}/${parsed.model}`;
            vxAdapter = new OpenAIFormatAdapter(modelId, { supportsTools: true, supportsVision: true, supportsStreaming: true, supportsJsonMode: false, supportsReasoning: false });
          }

          handler = new ProviderHandler(vxProvider, targetModel, resolved.modelName, port, {
            formatAdapter: vxAdapter,
            isInteractive: options.isInteractive,
          });
          log(
            `[Proxy] Created Vertex AI OAuth handler (composed): ${resolved.modelName} [${parsed.publisher}] (project: ${vertexConfig.projectId})`
          );
        } else {
          log(`[Proxy] Vertex AI requires either VERTEX_API_KEY or VERTEX_PROJECT`);
          return null;
        }
      } else {
        // Use the transport factory for all other providers
        const def = getProviderByName(resolved.provider.name);
        if (!def) return null;

        const result = createTransportForProvider(def, resolved.modelName, apiKey);
        if (!result) {
          if (def.transport === "litellm") {
            logStderr("Error: LITELLM_BASE_URL or --litellm-url is required for LiteLLM provider.");
            logStderr("Set it with: export LITELLM_BASE_URL='https://your-litellm-instance.com'");
            logStderr("Or use: claudish --litellm-url https://your-instance.com --model litellm@model 'task'");
          }
          return null;
        }

        handler = new ProviderHandler(result.transport, targetModel, resolved.modelName, port, {
          formatAdapter: result.formatAdapter,
          tokenStrategy: result.tokenStrategy,
          unwrapGeminiResponse: result.unwrapGeminiResponse,
          isInteractive: options.isInteractive,
        });
        log(`[Proxy] ${result.logMessage}`);
      }

      // Cache under both the original targetModel and the resolveTarget (if different)
      // so subsequent lookups with either key are served from cache.
      remoteProviderHandlers.set(resolveTarget, handler);
      if (resolveTarget !== targetModel) {
        remoteProviderHandlers.set(targetModel, handler);
      }
      return handler;
    }

    // If we get here, either category is not direct-api or key is not available
    // Both cases should fall through to OpenRouter or return null
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

    // 2b. Catalog resolution: resolve vendor prefix for OpenRouter and LiteLLM
    // This must happen after target is determined but before handler construction.
    // resolveModelNameSync is synchronous (uses in-memory cache + readFileSync).
    {
      const parsedTarget = parseModelSpec(target);
      if (parsedTarget.provider === "openrouter" || parsedTarget.provider === "litellm") {
        const resolution = resolveModelNameSync(parsedTarget.model, parsedTarget.provider);
        logResolution(parsedTarget.model, resolution, options.quiet);
        if (resolution.wasResolved) {
          // Reconstruct target with resolved model name so handler construction
          // uses the correct fully-qualified API ID (e.g., "qwen/qwen3-coder-next").
          target = `${parsedTarget.provider}@${resolution.resolvedId}`;
        }
      }
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

    // 7. Explicit provider@ that wasn't handled above means missing API key or
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

    // 8. OpenRouter Handler (default for any model with "/" or unmatched explicit provider)
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

// ─── Synchronous transport factory ───────────────────────
