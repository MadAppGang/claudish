import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { log, logStderr, isLoggingEnabled } from "./logger.js";
import type { ProxyServer } from "./types.js";
import { NativeHandler } from "./handlers/native-handler.js";
import { OpenRouterProviderTransport } from "./providers/transport/openrouter.js";
import { OpenRouterAPIFormat } from "./adapters/openrouter-api-format.js";
import { LocalTransport } from "./providers/transport/local.js";
import { LocalModelAdapter } from "./adapters/local-adapter.js";
import { GeminiProviderTransport } from "./providers/transport/gemini-apikey.js";
import { GeminiCodeAssistProviderTransport } from "./providers/transport/gemini-codeassist.js";
import { GeminiAPIFormat } from "./adapters/gemini-api-format.js";
import { VertexProviderTransport, parseVertexModel } from "./providers/transport/vertex-oauth.js";
import { DefaultAPIFormat } from "./adapters/base-api-format.js";
import { PoeProvider } from "./providers/transport/poe.js";
import type { ModelHandler } from "./handlers/types.js";
import { ComposedHandler, type ComposedHandlerOptions } from "./handlers/composed-handler.js";
import { LiteLLMProviderTransport } from "./providers/transport/litellm.js";
import { LiteLLMAPIFormat } from "./adapters/litellm-api-format.js";
import { OpenAIProviderTransport } from "./providers/transport/openai.js";
import { OpenAIAPIFormat } from "./adapters/openai-api-format.js";
import { AnthropicProviderTransport } from "./providers/transport/anthropic-compat.js";
import { AnthropicAPIFormat } from "./adapters/anthropic-api-format.js";
import { OllamaProviderTransport } from "./providers/transport/ollamacloud.js";
import { OllamaAPIFormat } from "./adapters/ollama-api-format.js";
import {
  resolveProvider,
  parseUrlModel,
  createUrlProvider,
} from "./providers/provider-registry.js";
import { parseModelSpec } from "./providers/model-parser.js";
import {
  resolveRemoteProvider,
  validateRemoteProviderApiKey,
  getRegisteredRemoteProviders,
} from "./providers/remote-provider-registry.js";
import { getProviderDefinitionByRemoteName } from "./providers/provider-definitions.js";
import { getVertexConfig, validateVertexOAuthConfig } from "./auth/vertex-auth.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import { warmPricingCache } from "./services/pricing-cache.js";
import { fetchLiteLLMModels } from "./model-loader.js";
import {
  resolveModelNameSync,
  logResolution,
  warmAllCatalogs,
} from "./providers/model-catalog-resolver.js";
import { FallbackHandler } from "./handlers/fallback-handler.js";
import type { FallbackCandidate } from "./handlers/fallback-handler.js";
import { getFallbackChain, warmZenModelCache, warmZenGoModelCache } from "./providers/auto-route.js";
import {
  loadRoutingRules,
  matchRoutingRule,
  buildRoutingChain,
} from "./providers/routing-rules.js";
import { createHandlerForProvider } from "./providers/provider-profiles.js";

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
  const getOpenRouterHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler => {
    // For explicit @ syntax: strip provider prefix (openrouter@google/gemini → google/gemini)
    // For already-resolved vendor/model IDs (qwen/qwen3.5-plus-02-15): use as-is to preserve
    // the vendor prefix that OpenRouter requires. parseModelSpec() would otherwise strip it
    // (e.g. "qwen/" is a native pattern match → model becomes "qwen3.5-plus-02-15").
    const parsed = parseModelSpec(targetModel);
    const modelId = targetModel.includes("@") ? parsed.model : targetModel;

    if (!openRouterHandlers.has(modelId)) {
      const orProvider = new OpenRouterProviderTransport(openrouterApiKey || "", modelId);
      const orAdapter = new OpenRouterAPIFormat(modelId);
      openRouterHandlers.set(
        modelId,
        new ComposedHandler(orProvider, modelId, modelId, port, {
          adapter: orAdapter,
          isInteractive: options.isInteractive,
          invocationMode,
        })
      );
    }
    return openRouterHandlers.get(modelId)!;
  };

  // Helper to get or create Poe handler for a target model
  const getPoeHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler | null => {
    const poeApiKey = process.env.POE_API_KEY;
    if (!poeApiKey) {
      log(`[Proxy] POE_API_KEY not set, cannot use Poe model: ${targetModel}`);
      return null;
    }
    // Strip "poe:" prefix to get the actual model name for the API
    const modelId = targetModel.replace(/^poe:/, "");
    if (!poeHandlers.has(modelId)) {
      const poeTransport = new PoeProvider(poeApiKey);
      poeHandlers.set(
        modelId,
        new ComposedHandler(poeTransport, modelId, modelId, port, {
          isInteractive: options.isInteractive,
          invocationMode,
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
  const getLocalProviderHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler | null => {
    if (localProviderHandlers.has(targetModel)) {
      return localProviderHandlers.get(targetModel)!;
    }

    // Check for prefix-based local provider (ollama/, lmstudio/, etc.)
    const resolved = resolveProvider(targetModel);
    if (resolved) {
      const provider = new LocalTransport(resolved.provider, resolved.modelName, {
        concurrency: resolved.concurrency,
      });
      const adapter = new LocalModelAdapter(resolved.modelName, resolved.provider.name);
      const handler = new ComposedHandler(provider, resolved.modelName, resolved.modelName, port, {
        adapter,
        tokenStrategy: "local",
        summarizeTools: options.summarizeTools,
        isInteractive: options.isInteractive,
        invocationMode,
      });
      localProviderHandlers.set(targetModel, handler);
      log(
        `[Proxy] Created local provider handler: ${resolved.provider.name}/${resolved.modelName}${resolved.concurrency !== undefined ? ` (concurrency: ${resolved.concurrency})` : ""}`
      );
      return handler;
    }

    // Check for URL-based model (http://localhost:11434/llama3)
    const urlParsed = parseUrlModel(targetModel);
    if (urlParsed) {
      const providerConfig = createUrlProvider(urlParsed);
      const provider = new LocalTransport(providerConfig, urlParsed.modelName);
      const adapter = new LocalModelAdapter(urlParsed.modelName, providerConfig.name);
      const handler = new ComposedHandler(
        provider,
        urlParsed.modelName,
        urlParsed.modelName,
        port,
        {
          adapter,
          tokenStrategy: "local",
          summarizeTools: options.summarizeTools,
          isInteractive: options.isInteractive,
          invocationMode,
        }
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
  const getRemoteProviderHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler | null => {
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

      // Look up the ProviderDefinition from the RemoteProvider name
      const def = getProviderDefinitionByRemoteName(resolved.provider.name);
      if (!def) return null;

      // Get API key - empty string for providers that don't require auth (like zen/ free models)
      const apiKey = def.apiKeyEnvVar
        ? process.env[def.apiKeyEnvVar] || ""
        : "";

      const handler = createHandlerForProvider(
        def,
        resolved.modelName,
        apiKey,
        targetModel,
        port,
        { isInteractive: options.isInteractive, invocationMode },
      );
      if (!handler) {
        return null; // Profile returned null (missing config) or unknown provider
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
    fetchLiteLLMModels(process.env.LITELLM_BASE_URL, process.env.LITELLM_API_KEY)
      .then(() => {
        log("[Proxy] LiteLLM model cache pre-warmed for auto-routing");
      })
      .catch(() => {});
  }

  // Pre-warm Zen model cache for fallback chain filtering (non-blocking)
  warmZenModelCache()
    .then(() => log("[Proxy] Zen model cache pre-warmed for fallback filtering"))
    .catch(() => {});

  // Pre-warm Zen Go model cache separately (Zen Go serves only 4 models via /go endpoint)
  warmZenGoModelCache()
    .then(() => log("[Proxy] Zen Go model cache pre-warmed for fallback filtering"))
    .catch(() => {});

  // Load custom routing rules once at startup (local .claudish.json takes priority over global)
  const customRoutingRules = loadRoutingRules();

  // Cache fallback handlers by target model string.
  // No TTL/invalidation: claudish is ephemeral per session, so env changes
  // (new API keys) take effect on next session start.
  const fallbackHandlerCache = new Map<string, ModelHandler>();

  // Detect the invocation mode for a given target model string.
  // Used to populate stats: how did the user specify this model?
  const detectInvocationMode = (
    target: string,
    wasFromModelMap: boolean
  ): ComposedHandlerOptions["invocationMode"] => {
    if (wasFromModelMap) return "model-map";
    if (!target) return "auto-route";
    const parsedSpec = parseModelSpec(target);
    if (parsedSpec.isExplicitProvider) {
      // Check if this came from env var (CLAUDISH_MODEL or ANTHROPIC_MODEL)
      const envModel = process.env.CLAUDISH_MODEL || process.env.ANTHROPIC_MODEL;
      if (envModel && (target === envModel || parsedSpec.model === envModel)) {
        return "env-var";
      }
      return "explicit-model";
    }
    return "auto-route";
  };

  const getHandlerForRequest = (requestedModel: string): ModelHandler => {
    // 1. Monitor Mode Override
    if (monitorMode) return nativeHandler;

    // 2. Resolve target model based on mappings or defaults
    // Priority: role mappings > default model (--model) > requested model (native)
    let target = requestedModel;
    let wasFromModelMap = false;

    const req = requestedModel.toLowerCase();
    if (modelMap) {
      // Role-specific mappings take highest priority
      if (req.includes("opus") && modelMap.opus) {
        target = modelMap.opus;
        wasFromModelMap = true;
      } else if (req.includes("sonnet") && modelMap.sonnet) {
        target = modelMap.sonnet;
        wasFromModelMap = true;
      } else if (req.includes("haiku") && modelMap.haiku) {
        target = modelMap.haiku;
        wasFromModelMap = true;
      }
      // Default model (--model) is fallback for all roles
      else if (model) target = model;
    } else if (model) {
      // No role mappings at all - use default model
      target = model;
    }

    const invocationMode = detectInvocationMode(target, wasFromModelMap);

    // 2b. Catalog resolution — resolve vendor prefix for OpenRouter and LiteLLM
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

    // 2c. Provider fallback chain for auto-routed models
    // When no explicit provider@ prefix is given, build a priority chain of providers
    // and wrap them in a FallbackHandler that tries each in order on retryable errors.
    {
      const parsedForFallback = parseModelSpec(target);
      if (
        !parsedForFallback.isExplicitProvider &&
        parsedForFallback.provider !== "native-anthropic" &&
        !isPoeModel(target)
      ) {
        const cacheKey = `fallback:${target}`;
        if (fallbackHandlerCache.has(cacheKey)) {
          return fallbackHandlerCache.get(cacheKey)!;
        }

        const matchedEntries = customRoutingRules
          ? matchRoutingRule(parsedForFallback.model, customRoutingRules)
          : null;
        const chain = matchedEntries
          ? buildRoutingChain(matchedEntries, parsedForFallback.model)
          : getFallbackChain(parsedForFallback.model, parsedForFallback.provider);
        if (chain.length > 0) {
          const candidates: FallbackCandidate[] = [];
          for (const route of chain) {
            let handler: ModelHandler | null = null;
            if (route.provider === "openrouter") {
              handler = getOpenRouterHandler(route.modelSpec, invocationMode);
            } else {
              handler = getRemoteProviderHandler(route.modelSpec, invocationMode);
            }
            if (handler) {
              candidates.push({ name: route.displayName, handler });
            }
          }

          if (candidates.length > 0) {
            const resultHandler =
              candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler;

            fallbackHandlerCache.set(cacheKey, resultHandler);

            if (!options.quiet && candidates.length > 1) {
              const source = matchedEntries ? "[Custom]" : "[Fallback]";
              logStderr(
                `${source} ${candidates.length} providers for ${parsedForFallback.model}: ${candidates.map((c) => c.name).join(" → ")}`
              );
            }
            return resultHandler;
          }
        }
      }
    }

    // 3. Check for Poe Model (poe: prefix)
    if (isPoeModel(target)) {
      const poeHandler = getPoeHandler(target, invocationMode);
      if (poeHandler) {
        log(`[Proxy] Routing to Poe: ${target}`);
        return poeHandler;
      }
    }

    // 4. Check for Remote Provider (g/, gemini/, oai/, openai/, mmax/, mm/, kimi/, moonshot/, glm/, zhipu/)
    const remoteHandler = getRemoteProviderHandler(target, invocationMode);
    if (remoteHandler) return remoteHandler;

    // 5. Check for Local Provider (ollama/, lmstudio/, vllm/, or URL)
    const localHandler = getLocalProviderHandler(target, invocationMode);
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
    return getOpenRouterHandler(target, invocationMode);
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
    // Warming failures are non-fatal — resolver falls back to passthrough
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    shutdown: async () => {
      return new Promise<void>((resolve) => server.close((e) => resolve()));
    },
  };
}
