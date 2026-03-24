import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { log, logStderr } from "./logger.js";
import type { ProxyServer } from "./types.js";
import { NativeHandler } from "./handlers/native-handler.js";
import type { ModelHandler } from "./handlers/types.js";
import type { ComposedHandlerOptions } from "./handlers/composed-handler.js";
import { parseModelSpec } from "./providers/model-parser.js";
import {
  resolveRemoteProvider,
} from "./providers/remote-provider-registry.js";
import { getProviderDefinitionByRemoteName } from "./providers/provider-definitions.js";
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
  // Define handlers
  const nativeHandler = new NativeHandler(anthropicApiKey);
  const handlerCache = new Map<string, ModelHandler>();

  /**
   * Get or create a handler for a target model. Single entry point for all providers.
   *
   * Delegates routing to resolveModelProvider, construction to createHandlerForProvider.
   * Handles auto-routing recursion (bare model -> provider@model) and caching.
   */
  const getHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler | null => {
    if (handlerCache.has(targetModel)) return handlerCache.get(targetModel)!;

    // Use centralized resolver with fallback logic
    const resolution = resolveModelProvider(targetModel);

    if (resolution.wasAutoRouted && resolution.autoRouteMessage) {
      if (!options.quiet) {
        console.error(`[Auto-route] ${resolution.autoRouteMessage}`);
      }
      log(`[Auto-route] ${resolution.autoRouteMessage}`);
    }

    // Auto-routed to a different target (e.g. bare model -> openrouter vendor/model or litellm@model).
    // Recurse with the resolved fullModelId so the correct provider handler is created.
    if (resolution.wasAutoRouted && resolution.fullModelId && resolution.fullModelId !== targetModel) {
      const handler = getHandler(resolution.fullModelId, invocationMode);
      if (handler) {
        // Cache under both the original and resolved target
        handlerCache.set(targetModel, handler);
      }
      return handler;
    }

    // OpenRouter category from auto-routing: the fullModelId has the vendor prefix
    // (e.g. "google/gemini-2.0-flash"). Create via openrouter definition.
    if (resolution.category === "openrouter") {
      const orModelId = resolution.fullModelId || targetModel;
      return createAndCache(
        "openrouter", orModelId, targetModel, invocationMode,
      );
    }

    // Direct-api: look up the ProviderDefinition and create a handler
    if (resolution.category === "direct-api" && resolution.apiKeyAvailable) {
      // When auto-routed, use fullModelId for resolveRemoteProvider so it sees
      // "litellm@gemini-2.0-flash" instead of bare "gemini-2.0-flash"
      const resolveTarget =
        resolution.wasAutoRouted && resolution.fullModelId ? resolution.fullModelId : targetModel;

      const resolved = resolveRemoteProvider(resolveTarget);
      if (!resolved) return null;

      const def = getProviderDefinitionByRemoteName(resolved.provider.name);
      if (!def) return null;

      // Get API key (empty for providers without auth requirement, like zen free models)
      const apiKey = def.apiKeyEnvVar
        ? process.env[def.apiKeyEnvVar] || ""
        : "";

      const handler = createHandlerForProvider(
        def,
        resolved.modelName,
        apiKey,
        targetModel,
        port,
        { isInteractive: options.isInteractive, invocationMode, summarizeTools: options.summarizeTools },
      );
      if (!handler) return null;

      // Cache under both keys so subsequent lookups hit the cache
      handlerCache.set(targetModel, handler);
      if (resolveTarget !== targetModel) {
        handlerCache.set(resolveTarget, handler);
      }
      return handler;
    }

    // Local and Poe: resolve via definition
    if (resolution.category === "local") {
      const def = getProviderDefinitionByRemoteName(resolution.parsed?.provider || "");
      if (!def) return null;

      const handler = createHandlerForProvider(
        def,
        resolution.modelName,
        "",
        targetModel,
        port,
        {
          isInteractive: options.isInteractive,
          invocationMode,
          summarizeTools: options.summarizeTools,
          concurrency: resolution.concurrency,
        },
      );
      if (handler) handlerCache.set(targetModel, handler);
      return handler;
    }

    return null;
  };

  /**
   * Create a handler for a named provider and cache it.
   * Used for OpenRouter (and any future provider that needs creation by name).
   */
  const createAndCache = (
    providerName: string,
    modelId: string,
    cacheKey: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"],
  ): ModelHandler | null => {
    // For OpenRouter: strip @ prefix if present, preserve vendor/ prefix
    const parsed = parseModelSpec(modelId);
    const effectiveModelId = modelId.includes("@") ? parsed.model : modelId;

    const def = getProviderDefinitionByRemoteName(providerName);
    if (!def) return null;

    const apiKey = def.apiKeyEnvVar
      ? process.env[def.apiKeyEnvVar] || openrouterApiKey || ""
      : "";

    const handler = createHandlerForProvider(
      def,
      effectiveModelId,
      apiKey,
      effectiveModelId,
      port,
      { isInteractive: options.isInteractive, invocationMode },
    );
    if (handler) {
      handlerCache.set(cacheKey, handler);
      if (cacheKey !== effectiveModelId) {
        handlerCache.set(effectiveModelId, handler);
      }
    }
    return handler;
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
        !target.startsWith("poe:")
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
            const handler = getHandler(route.modelSpec, invocationMode);
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

    // 3. Try all providers via getHandler (Poe, remote, local, OpenRouter all go through here)
    const handler = getHandler(target, invocationMode);
    if (handler) return handler;

    // 4. Native Anthropic (bare model name, no provider prefix)
    const hasExplicitProvider = target.includes("@");
    const isNative = !target.includes("/") && !hasExplicitProvider;
    if (isNative) return nativeHandler;

    // 5. OpenRouter fallback (vendor/model or unmatched explicit provider)
    return getHandler(`openrouter@${target}`, invocationMode) || nativeHandler;
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
