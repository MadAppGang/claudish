import { Hono } from "hono";
import { cors } from "hono/cors";
import { LocalModelAdapter } from "./adapters/local-adapter.js";
import { OpenRouterAPIFormat } from "./adapters/openrouter-api-format.js";
import { credentials } from "./auth/credentials/authority.js";
import { loadHookRules } from "./behavior/hooks.js";
import { parseBehaviorConfig, registerHookRules } from "./behavior/index.js";
import { ComposedHandler, type ComposedHandlerOptions } from "./handlers/composed-handler.js";
import { FallbackHandler } from "./handlers/fallback-handler.js";
import type { FallbackCandidate } from "./handlers/fallback-handler.js";
import { NativeHandler } from "./handlers/native-handler.js";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
import type { ModelHandler } from "./handlers/types.js";
import { log, logStderr } from "./logger.js";
import { warmRecommendedModels } from "./model-loader.js";
import { loadConfig } from "./profile-config.js";
import { API_KEY_MAP } from "./providers/api-key-map.js";
import { DISPLAY_NAMES } from "./providers/auto-route.js";
import {
  ensureCatalogReady,
  logResolution,
  resolveTargetForCatalog,
  warmCatalog,
} from "./providers/catalog-client.js";
import { loadCustomEndpoints } from "./providers/custom-endpoints-loader.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { createHandlerForProvider } from "./providers/provider-profiles.js";
import {
  createUrlProvider,
  parseUrlModel,
  resolveProvider,
} from "./providers/provider-registry.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import { resolveRemoteProvider } from "./providers/remote-provider-registry.js";
import { loadRoutingRules, route } from "./providers/routing-rules.js";
import { LocalTransport } from "./providers/transport/local.js";
import { OpenRouterProviderTransport } from "./providers/transport/openrouter.js";
import { PoeProvider } from "./providers/transport/poe.js";
import type { ProviderTransport } from "./providers/transport/types.js";
import { warmPricingCache } from "./services/pricing-cache.js";
import type { ProxyServer } from "./types.js";

/**
 * Routing failures are TERMINAL — no provider can serve the request (missing
 * credential, empty chain, unknown model). They must surface to the client as a
 * non-retryable HTTP 400, not a retryable 500: a 500 makes Claude Code loop on
 * "API error · Retrying · attempt N/10" and hide the real cause. Tagging the
 * error lets the request handlers map it to 400 with the actionable message.
 */
class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * A single slot-routing entry for `claudish serve`. Claude Desktop sends
 * `body.model = <slot>` (a Claude-recognized id it accepts into its picker);
 * we route that to the user's real `model` on `provider`.
 *
 *   provider: a pinned provider slug (canonical BUILTIN_PROVIDERS name, e.g.
 *             "x-ai", "google", "openrouter"), or null/undefined = autoroute
 *             (let claudish's existing auto-chain pick).
 */
export interface SlotRoute {
  model: string;
  provider?: string | null;
}

export interface ProxyServerOptions {
  summarizeTools?: boolean; // Summarize tool descriptions for local models
  quiet?: boolean; // Suppress informational stderr output (e.g., [Auto-route])
  isInteractive?: boolean; // Whether the current session is interactive (gates consent prompt)
  advisorModels?: string[]; // Advisor models from --advisor flag
  advisorCollector?: string | null; // Collector model (null = no synthesis)
  /**
   * Exact slot-id → real-model map for `claudish serve` (Claude Desktop
   * redirect). Consulted BEFORE the substring tier `modelMap` in
   * getHandlerForRequest, so distinct slots that share a tier substring
   * (e.g. two "opus" slots) don't collide. Optional — existing callers
   * leave it undefined and behavior is unchanged.
   */
  slotMap?: Map<string, SlotRoute>;
  /**
   * Slot ids this gateway advertises on `GET /v1/models` (Claude Desktop
   * builds its picker only from a live /v1/models call). These MUST be the
   * Claude-recognized slot ids, not the real model ids. Defaults to [].
   */
  servedSlotIds?: string[];
  /**
   * An ordered, already-credential-filtered candidate list pinned by a PARENT
   * claudish process (`team` / channel `create_session`), parsed from a `--model`
   * chain value. Element 0 is also the `model` argument, so a chain is opt-in and
   * additive: absent it, routing behaves exactly as before.
   *
   * See step 2a-chain in `getHandlerForRequest` for why this exists and why it is
   * matched before catalog resolution.
   */
  modelChain?: string[];
}

export async function createProxyServer(
  port: number,
  // Legacy: the OpenRouter key is now resolved through the credential authority
  // (transport getHeaders()), not passed in. Param retained for signature
  // stability; callers may pass undefined.
  _openrouterApiKey?: string,
  model?: string,
  monitorMode = false,
  anthropicApiKey?: string,
  modelMap?: { opus?: string; sonnet?: string; haiku?: string; subagent?: string },
  options: ProxyServerOptions = {}
): Promise<ProxyServer> {
  // Load user-declared custom endpoints from ~/.claudish/config.json and
  // register them in the runtime provider registry so they appear in lookups
  // and handler creation. Runs once per proxy lifetime; idempotent.
  try {
    const customEpResult = loadCustomEndpoints(loadConfig());
    if (customEpResult.registered > 0) {
      log(`[Proxy] Registered ${customEpResult.registered} custom endpoint(s) from config`);
    }
    for (const err of customEpResult.errors) {
      logStderr(`customEndpoints['${err.name}'] failed validation: ${err.message}`);
    }
  } catch (err) {
    // Config read failure should not crash the proxy — the rest of startup
    // continues and users get the default (builtin-only) set of providers.
    log(
      `[Proxy] customEndpoints load skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Load behavior-layer hook rules before any handler is constructed: the
  // engine is memoized on first use, and registering rules after that point
  // would leave already-built handlers on a stale rule set.
  try {
    const hookRules = await loadHookRules(parseBehaviorConfig(loadConfig().behavior).hooks);
    if (hookRules.length > 0) registerHookRules(hookRules);
  } catch (err) {
    // Same posture as customEndpoints: a broken optional extension warns and is
    // skipped, it never blocks startup.
    log(`[Proxy] behavior hooks load skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Define handlers for different roles
  const nativeHandler = new NativeHandler(
    anthropicApiKey,
    options.advisorModels,
    options.advisorCollector
  );
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
      // The OpenRouter key is resolved through the credential authority inside
      // the transport's getHeaders() (single source of truth) — the legacy
      // openrouterApiKey param is no longer the signing source.
      const orProvider = new OpenRouterProviderTransport("", modelId);
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
  const getPoeHandler = async (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): Promise<ModelHandler | null> => {
    // Gate on the authority (env → config → op://), not a raw env read.
    if (!(await credentials.isAvailable("poe"))) {
      log(`[Proxy] Poe credentials not available, cannot use Poe model: ${targetModel}`);
      return null;
    }
    // Strip "poe:" prefix to get the actual model name for the API
    const modelId = targetModel.replace(/^poe:/, "");
    if (!poeHandlers.has(modelId)) {
      // The transport resolves its key through the authority in getHeaders().
      const poeTransport = new PoeProvider();
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
  const getRemoteProviderHandler = async (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): Promise<ModelHandler | null> => {
    if (remoteProviderHandlers.has(targetModel)) {
      return remoteProviderHandlers.get(targetModel)!;
    }

    // Use centralized resolver with fallback logic
    const resolution = resolveModelProvider(targetModel);

    if (resolution.wasAutoRouted && resolution.autoRouteMessage) {
      // logStderr, NOT console.error: this fires PER REQUEST, i.e. while Claude
      // Code owns the inherited TTY. A raw console write here lands mid-frame.
      if (!options.quiet) {
        logStderr(`[Auto-route] ${resolution.autoRouteMessage}`);
      } else {
        log(`[Auto-route] ${resolution.autoRouteMessage}`);
      }
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

    // If resolver says use direct-api, resolve credentials via the authority.
    if (resolution.category === "direct-api") {
      const resolved = resolveRemoteProvider(resolveTarget);
      if (!resolved) return null;

      // Skip 'openrouter' provider here - it uses the existing OpenRouterHandler
      if (resolved.provider.name === "openrouter") {
        return null; // Will fall through to OpenRouterHandler
      }

      // Resolve the API key ON DEMAND via the credential authority — the SINGLE
      // source of truth. This pulls env → aliases → config → 1Password (lazy SDK)
      // and writes a resolved op:// key through to process.env. Providers that
      // need no auth (e.g. zen/ free) have no apiKeyEnvVar → empty key.
      let apiKey = "";
      if (resolved.provider.apiKeyEnvVar) {
        // HARDENING: getRequestAuth THROWS for a name the authority never
        // registered (e.g. a runtime-renamed provider missing an alias), which
        // would surface as an HTTP 500. Degrade to the same "no credential"
        // path a missing key takes (null → explicit-spec routing reject → 400,
        // or bare-name fallback) — but warn on stderr so the registration gap
        // stays loud instead of silently masquerading as a missing key.
        if (!credentials.get(resolved.provider.name)) {
          logStderr(
            `[Proxy] No credential provider registered for "${resolved.provider.name}" — treating as missing credential (authority registration gap)`
          );
          log(
            `[Proxy] Credential authority has no provider registered under "${resolved.provider.name}"`
          );
          return null;
        }
        const auth = await credentials.getRequestAuth(resolved.provider.name, {
          model: resolved.modelName,
        });
        // Extract the bearer / x-api-key value back into the construction-time
        // key string createHandlerForProvider expects.
        apiKey =
          auth.headers.Authorization?.replace(/^Bearer\s+/i, "") || auth.headers["x-api-key"] || "";
        // ANTI-POISON: a provider that requires a key but resolved empty must NOT
        // be cached — return null (falls through to OpenRouter) so a key added
        // later (TUI hydrate-on-add, op:// resolve) is picked up on the next try.
        if (!apiKey) return null;
      }

      const handler = createHandlerForProvider({
        provider: resolved.provider,
        modelName: resolved.modelName,
        apiKey,
        targetModel,
        port,
        sharedOpts: { isInteractive: options.isInteractive, invocationMode },
      });
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

  // Direct-provider catalog warmup (LiteLLM, Zen, Zen Go) was removed in
  // commit 5 of the model-catalog and routing redesign. claudish only fetches
  // Firebase catalogs now. The OpenRouter catalog is still warmed below via
  // warmAllCatalogs() since it backs vendor-prefix resolution.

  // Load effective routing rules once at startup. Returns a merged view of
  // DEFAULT_ROUTING_RULES + global config + local config (local wins). The
  // routing engine consults these via route() for every bare-name request.
  const effectiveRoutingRules = loadRoutingRules();

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

  const getHandlerForRequest = async (requestedModel: string): Promise<ModelHandler> => {
    // 1. Monitor Mode Override
    if (monitorMode) return nativeHandler;

    // 2. Resolve target model based on mappings or defaults
    // Priority: exact slot map > role mappings > default model (--model) > requested model (native)
    let target = requestedModel;
    let wasFromModelMap = false;

    // 2a. Exact slot-id map (claudish serve / Claude Desktop redirect).
    // Claude Desktop sends body.model = a Claude-recognized SLOT id; route it
    // to the real model the user assigned that slot. Checked BEFORE the
    // substring tier match below so two slots sharing a tier substring
    // (e.g. claude-opus-4-1 + claude-opus-4-20250514) route distinctly
    // instead of colliding. Rewrite `target` and fall through to the existing
    // pipeline (explicit-provider path for pinned, auto-route + catalog
    // resolution for null-provider, native passthrough for claude-* reals).
    let slotMatched = false;
    const slot = options.slotMap?.get(requestedModel);
    if (slot) {
      target =
        slot.provider != null && slot.provider !== ""
          ? `${slot.provider}@${slot.model}`
          : slot.model;
      slotMatched = true;
      if (!options.quiet) {
        logStderr(`[Serve] slot ${requestedModel} → ${target}`);
      }
    }

    const req = requestedModel.toLowerCase();
    if (slotMatched) {
      // Slot map already set `target` — skip the substring tier match and the
      // --model fallback entirely so they can't override the exact mapping.
    } else if (modelMap) {
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

    // 2a-chain. A PINNED CHAIN from a parent process.
    //
    // `team` / channel `create_session` resolve the route in the parent and spawn
    // the child with explicit specs, because a bare name would make the child
    // re-resolve credentials and open its own 1Password client — one dialog per
    // child instead of one per run (auth/credentials/prehydrate.ts). The cost used
    // to be that "explicit" also means "exactly one candidate": step 2c below is
    // the only place a FallbackHandler is built, it runs only for names the child
    // routes itself, and `isRetryableError` has no other caller. So a spawned child
    // could not fall through on a spent subscription, a rotated key, or a provider
    // that rejects the request shape — failures an interactive run recovers from.
    //
    // The parent now pins the WHOLE credential-filtered chain and this branch
    // rebuilds the FallbackHandler from it. Every element is explicit, so no
    // element re-routes and no SDK client is ever built; and the parent's
    // `route()` already called `credentials.isAvailable()` on each candidate,
    // which write-throughs each resolved op:// key into the env this process
    // inherited — so every candidate here resolves from env at step 1.
    //
    // Matched BEFORE 2b, against the UNRESOLVED target: 2b rewrites the primary to
    // its canonical wire id, so a post-2b comparison against `modelChain[0]` would
    // stop matching for exactly the models whose id needs resolving. Each element
    // gets the same catalog treatment individually, inside the loop.
    //
    // Only the default `--model` carries a chain; a role-mapped target (opus /
    // sonnet / haiku) does not equal `modelChain[0]` and falls through untouched.
    if (options.modelChain && options.modelChain.length > 1 && target === options.modelChain[0]) {
      const cacheKey = `chain:${options.modelChain.join("+")}`;
      const cached = fallbackHandlerCache.get(cacheKey);
      if (cached) return cached;

      await ensureCatalogReady(5000);
      const candidates: FallbackCandidate[] = [];
      for (const spec of options.modelChain) {
        const parsed = parseModelSpec(spec);
        const resolvedSpec = resolveTargetForCatalog(
          spec,
          parsed.isExplicitProvider,
          parsed.model,
          parsed.provider
        ).target;
        const handler =
          parsed.provider === "openrouter"
            ? getOpenRouterHandler(resolvedSpec, invocationMode)
            : ((await getRemoteProviderHandler(resolvedSpec, invocationMode)) ??
              getLocalProviderHandler(resolvedSpec, invocationMode));
        // A candidate that cannot be built is DROPPED, never fatal: the parent
        // credential-filtered this chain, so a miss here means the child's view
        // differs (a provider it cannot construct), and the remaining candidates
        // are still strictly better than failing the request.
        if (handler) {
          candidates.push({ name: DISPLAY_NAMES[parsed.provider] ?? parsed.provider, handler });
        }
      }

      if (candidates.length > 0) {
        const resultHandler =
          candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler;
        fallbackHandlerCache.set(cacheKey, resultHandler);
        if (!options.quiet && candidates.length > 1) {
          logStderr(
            `[Route] ${candidates.length} pinned providers for ${target}: ${candidates.map((c) => c.name).join(" → ")}`
          );
        }
        return resultHandler;
      }
      // Nothing built — fall through to the ordinary pipeline, which will report
      // the real reason for the primary spec.
    }

    // 2b. Catalog resolution — map the typed name to the provider's own wire id.
    //
    // Runs for EVERY provider, not just OpenRouter. It is one `aggregators[]`
    // lookup, so it answers `mm@minimax-m2.5` → `MiniMax-M2.5` (MiniMax's own
    // api_official spelling, and their API is case-sensitive) and
    // `ag@gemini-3.6-flash` → `gemini-3.6-flash-high` with the same code path
    // that already handled `or@qwen3-coder-next`. Gating it to one provider was
    // why every other provider grew its own bespoke translation.
    //
    // Safe to run unconditionally: a model the catalog doesn't know — a local
    // GGUF, a custom endpoint's private id — resolves to null and passes
    // through unchanged. Providers that ALSO resolve live (Antigravity's served
    // set) are unaffected: they re-resolve an exact id to itself.
    //
    // ONLY for an EXPLICIT `provider@model` spec. The rewrite emits a
    // `provider@model` string, and for a BARE name `parsedTarget.provider` is the
    // provider auto-DETECTED from the name — so rewriting a bare name manufactures
    // an explicit spec out of a user request that had none. Step 2c then reads
    // `isExplicitProvider === true`, skips routing entirely, and the model goes to
    // the auto-detected provider with the whole subscription chain unconsulted.
    //
    // This bit exactly one family, which is why it survived: the rewrite only fires
    // when `wasResolved` is true, i.e. when the canonical id DIFFERS from what the
    // user typed — and MiniMax is the only family whose wire id differs by case
    // (`minimax-m2.5` → `MiniMax-M2.5`). Measured across glm-5.2, kimi-k2.7, k3,
    // deepseek-v3.2, grok-4.5, gpt-5.6-sol, gemini-3.6-flash and qwen3.7-plus: all
    // pass through unchanged and keep their chains. Bare `minimax-m2.5` became
    // `minimax@MiniMax-M2.5` and went straight to the METERED MiniMax API, past
    // both `minimax-coding` and `opencode-zen-go`. The user-visible symptom was a
    // subscription-covered model billing per token — or reporting no balance.
    //
    // Nothing is lost by skipping it here: the chain resolves each candidate's wire
    // id itself. `buildRoutingChain` calls `resolveExternalId(modelName, provider)`
    // per candidate, which is the same catalog lookup done PER PROVIDER instead of
    // once against a guessed one — that is what yields `mm@MiniMax-M2.5` for the
    // MiniMax candidate and `zengo@minimax-m2.5` for Zen Go in the same chain, two
    // spellings this single rewrite could never produce.
    {
      const parsedTarget = parseModelSpec(target);
      if (parsedTarget.isExplicitProvider) {
        await ensureCatalogReady(5000);
        const outcome = resolveTargetForCatalog(
          target,
          parsedTarget.isExplicitProvider,
          parsedTarget.model,
          parsedTarget.provider
        );
        if (outcome.resolution)
          logResolution(parsedTarget.model, outcome.resolution, options.quiet);
        target = outcome.target;
      }
    }

    // 2c. Provider fallback chain for auto-routed models
    // When no explicit provider@ prefix is given, consult the routing engine
    // (defaults + user overrides merged in loadRoutingRules), filter to
    // credentialed providers, and wrap them in a FallbackHandler.
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

        // Ensure catalog is warm before route() builds OpenRouter modelSpecs.
        await ensureCatalogReady(5000);

        const plan = await route(parsedForFallback.model, effectiveRoutingRules);
        if (plan.kind === "ok") {
          const chain = [plan.primary, ...plan.fallbacks];
          const candidates: FallbackCandidate[] = [];
          for (const candidate of chain) {
            let handler: ModelHandler | null = null;
            if (candidate.provider === "openrouter") {
              handler = getOpenRouterHandler(candidate.modelSpec, invocationMode);
            } else {
              handler = await getRemoteProviderHandler(candidate.modelSpec, invocationMode);
            }
            if (handler) {
              candidates.push({ name: candidate.displayName, handler });
            }
          }

          if (candidates.length > 0) {
            const resultHandler =
              candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler;

            fallbackHandlerCache.set(cacheKey, resultHandler);

            if (!options.quiet && candidates.length > 1) {
              logStderr(
                `[Route] ${candidates.length} providers for ${parsedForFallback.model}: ${candidates.map((c) => c.name).join(" → ")}`
              );
            }
            return resultHandler;
          }
        } else {
          // No routable provider for a bare model name. Routing is fully
          // data-driven now (DEFAULT_ROUTING_RULES + user overrides) — if the
          // chain is empty and credential filtering produces nothing, that's
          // the user's configured outcome. Throw so the request handler
          // surfaces a clean error instead of silently falling through to a
          // legacy OpenRouter fallback. (Pre-commit-5 there was a hidden
          // OpenRouter step 7 that masked the no-route case.)
          const message = plan.hint
            ? `[Route] ${plan.reason}\n${plan.hint}`
            : `[Route] ${plan.reason}`;
          throw new RoutingError(message);
        }
      }
    }

    // 3. Check for Poe Model (poe: prefix)
    if (isPoeModel(target)) {
      const poeHandler = await getPoeHandler(target, invocationMode);
      if (poeHandler) {
        log(`[Proxy] Routing to Poe: ${target}`);
        return poeHandler;
      }
    }

    // 4. Check for Remote Provider (g/, gemini/, oai/, openai/, mmax/, mm/, kimi/, moonshot/, glm/, zhipu/)
    const remoteHandler = await getRemoteProviderHandler(target, invocationMode);
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

    // 6b. Explicit non-OpenRouter spec that produced no handler above means its
    // credential is MISSING — its key didn't resolve, so getRemoteProviderHandler
    // returned null. Per the routing contract, an explicit provider@model must
    // NOT silently fall through to OpenRouter (defaultProvider/last-resort
    // fallback applies to BARE names only). Silently routing e.g. sc@fugu-ultra
    // to OpenRouter caused it to catalog-resolve "fugu-ultra" → an xAI model
    // (status line "Xai") + a confusing "API error", hiding the real cause: no
    // Sakana key. Fail loudly with an actionable hint instead.
    if (hasExplicitProvider) {
      const parsedExplicit = parseModelSpec(target);
      // openrouter@... legitimately uses the OpenRouter handler below.
      if (parsedExplicit.provider !== "openrouter") {
        const keyInfo = API_KEY_MAP[parsedExplicit.provider];
        const keyNames = keyInfo
          ? [keyInfo.envVar, ...(keyInfo.aliases ?? [])].join(" or ")
          : undefined;
        const hint = keyNames
          ? `No API key for provider "${parsedExplicit.provider}". Set ${keyNames} (env, config, or 1Password import).`
          : `No API key for provider "${parsedExplicit.provider}".`;
        throw new RoutingError(
          `Explicit model "${target}" could not be routed — its provider has no credential. ${hint}`
        );
      }
    }

    // 7. OpenRouter Handler (default for any model with "/" or explicit OpenRouter spec)
    return getOpenRouterHandler(target, invocationMode);
  };

  const app = new Hono();
  app.use("*", cors());

  // Terminal-safety backstop. Hono's DEFAULT error handler is literally
  // `console.error(err)` + a text/plain "Internal Server Error" (see
  // hono/dist/hono-base.js). During an interactive session claudish's stderr IS
  // Claude Code's TTY (claude-runner spawns with stdio: "inherit"), so that one
  // console.error prints Bun's multi-line error dump — `error: …` / `path: …` /
  // `errno: …` / `code: …` — directly into the frame Claude Code is painting,
  // shredding the status line. Overriding onError means no unhandled route
  // rejection can ever reach a console again: it goes to the log file, and the
  // client gets a single-line Anthropic envelope it can render inline.
  app.onError((err, c) => {
    logStderr(`[Proxy] Unhandled error on ${c.req.method} ${c.req.path}: ${err?.message ?? err}`);
    log(`[Proxy] Unhandled error stack: ${err?.stack ?? "(no stack)"}`);
    return c.json(wrapAnthropicError(500, `Proxy error: ${err?.message ?? String(err)}`), 500);
  });

  app.get("/", (c) =>
    c.json({
      status: "ok",
      message: "Claudish Proxy",
      config: { mode: monitorMode ? "monitor" : "hybrid", mappings: modelMap },
    })
  );
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Model discovery endpoint.
  //
  // Two coexisting consumers, one response shape:
  //
  // 1. **Claude Desktop** in third-party-inference mode: builds its picker
  //    from a live `GET /v1/models` and silently drops any id it doesn't
  //    recognize. `serve` callers advertise the Claude-recognized SLOT ids
  //    here (via `options.servedSlotIds`), NOT the real model ids behind
  //    them. This branch must remain byte-identical to upstream slot mode —
  //    Desktop parses the response and regressions wouldn't be caught by
  //    feel.
  //
  // 2. **Gateway model discovery** for non-serve callers
  //    (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`): aggregates routable
  //    model names from routing rules + custom endpoints. The catch-all `*`
  //    rule is excluded (it's a routing wildcard, not a real model id).
  //    Rules whose entire routing chain has no credentials are filtered out
  //    — otherwise the picker surfaces options that can only 401.
  //
  // The two branches never see each other's data: if `servedSlotIds` is
  // non-empty we serve slot mode and ignore the aggregate.
  const servedSlotIds = options.servedSlotIds ?? [];
  app.get("/v1/models", async (c) => {
    if (servedSlotIds.length > 0) {
      return c.json({
        object: "list",
        has_more: false,
        data: servedSlotIds.map((id) => ({
          id,
          object: "model",
          type: "model",
          created: 1716000000,
          owned_by: "claudish",
        })),
      });
    }

    // Discovery mode: aggregate routable models, filter to credentialed providers.
    const cfg = loadConfig();
    const seen = new Set<string>();
    const data: { id: string; object: string; type: string; created: number; owned_by: string }[] = [];

    if (cfg.routing) {
      for (const modelName of Object.keys(cfg.routing)) {
        // Skip the catch-all routing wildcard — it's a routing rule, not a real model.
        if (modelName === "*") continue;
        // Resolve the routing chain and keep the rule only if at least one
        // candidate has credentials. Reuses the same machinery every
        // bare-name request goes through, so the filter is consistent with
        // what would actually serve traffic. A 401-only option in the picker
        // is strictly worse than not advertising it.
        try {
          const plan = await route(modelName, cfg.routing);
          // Only "ok" plans reach a real provider. "no-route" plans mean the
          // rule has no candidate (model not routed anywhere), which is the
          // same outcome for the picker as missing credentials.
          if (plan.kind !== "ok") continue;
        } catch {
          continue;
        }
        if (!seen.has(modelName)) {
          seen.add(modelName);
          data.push({
            id: modelName,
            object: "model",
            type: "model",
            created: 1716000000,
            owned_by: "claudish",
          });
        }
      }
    }

    if (cfg.customEndpoints) {
      for (const [, ep] of Object.entries(cfg.customEndpoints)) {
        const endpoint = ep as { models?: string[] };
        if (endpoint.models) {
          for (const m of endpoint.models) {
            if (!seen.has(m)) {
              seen.add(m);
              data.push({
                id: m,
                object: "model",
                type: "model",
                created: 1716000000,
                owned_by: "claudish",
              });
            }
          }
        }
      }
    }

    return c.json({
      object: "list",
      has_more: false,
      data,
    });
  });

  /**
   * Probe-model discovery for self-hosted / user-deployed providers
   * (litellm, ollama, lmstudio, vllm, mlx, ollamacloud). The cloud
   * /probeModels catalog can't enumerate user deployments — only the
   * endpoint itself knows what's available. The TUI calls this when the
   * catalog has no entry for a provider.
   *
   * GET /v1/probe-discover?provider=<slug>
   * → 200 { provider, model } on success
   * → 200 { provider, model: null, reason } on discovery failure
   * → 404 if provider has no transport-level discoverer
   */
  app.get("/v1/probe-discover", async (c) => {
    const provider = c.req.query("provider");
    if (!provider) return c.json({ error: "missing provider query" }, 400);
    // Optional exclude list — TUI's probe loop passes models that already
    // failed so discovery returns the next candidate. Format: comma-separated.
    const excludeQuery = c.req.query("exclude") ?? "";
    const exclude = new Set(
      excludeQuery
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    // Use a sentinel model name — the handler factory needs one, but
    // discoverProbeModel doesn't consult the modelName field.
    const targetModel = `${provider}@<discover>`;
    // Try local providers first (ollama, lmstudio, vllm, mlx). They're
    // filtered out of the remote registry by design, so getRemoteProviderHandler
    // returns null for them and we'd otherwise report "transport does not
    // support discovery" even though LocalTransport DOES implement it.
    const handler =
      getLocalProviderHandler(targetModel) ?? (await getRemoteProviderHandler(targetModel));
    const transport = (handler as unknown as { provider?: ProviderTransport })?.provider;
    if (!transport?.discoverProbeModel) {
      return c.json({ provider, model: null, reason: "transport does not support discovery" }, 404);
    }
    try {
      const outcome = await transport.discoverProbeModel(exclude);
      return c.json({
        provider,
        model: outcome.model,
        reason: outcome.model ? null : (outcome.reason ?? "no model available"),
      });
    } catch (e: unknown) {
      return c.json(
        {
          provider,
          model: null,
          reason: e instanceof Error ? e.message : String(e),
        },
        500
      );
    }
  });

  // Token counting
  app.post("/v1/messages/count_tokens", async (c) => {
    try {
      const body = await c.req.json();
      if (typeof body?.model !== "string" || body.model.length === 0) {
        return c.json(wrapAnthropicError(400, "missing required field: model"), 400);
      }
      const handler = await getHandlerForRequest(body.model);

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
      if (e instanceof RoutingError) {
        return c.json(wrapAnthropicError(400, e.message, "invalid_request_error"), 400);
      }
      return c.json(wrapAnthropicError(500, String(e)), 500);
    }
  });

  app.post("/v1/messages", async (c) => {
    try {
      const body = await c.req.json();
      // Request-metadata trace (debug log only — the [RequestMeta] prefix is
      // NOT structural-log-worthy, so it never reaches the always-on redacted
      // log). Captures the three fields claudish otherwise never reads, to
      // diff ultracode vs plain-xhigh sessions for a wire-level marker.
      log(
        `[RequestMeta] model=${body.model} output_config=${JSON.stringify(body.output_config) ?? "(none)"} metadata=${JSON.stringify(body.metadata) ?? "(none)"} anthropic-beta=${c.req.header("anthropic-beta") ?? "(none)"}`
      );
      const handler = await getHandlerForRequest(body.model);

      // Route. The `await` is load-bearing: `return handler.handle(...)` hands
      // the promise back BEFORE it settles, so a rejection escapes this
      // try/catch entirely and lands in Hono's error handler instead. That is
      // how connect failures bypassed every message we build here.
      return await handler.handle(c, body);
    } catch (e) {
      log(`[Proxy] Error: ${e}`);
      // Routing failures are terminal — surface as a non-retryable 400 so the
      // client shows the real reason (e.g. missing key) instead of looping on
      // "API error · Retrying". Other errors stay 500.
      if (e instanceof RoutingError) {
        return c.json(wrapAnthropicError(400, e.message, "invalid_request_error"), 400);
      }
      return c.json(wrapAnthropicError(500, String(e)), 500);
    }
  });

  // Bun's NATIVE server — not @hono/node-server.
  //
  // claudish only ever runs under Bun (bin/claudish.cjs is a Node bootstrapper
  // that locates bun and re-execs; the CLI uses bun:ffi / Bun.spawn and cannot
  // run on Node), and Hono runs natively on Bun. Using the NODE adapter here was
  // a runtime mismatch that dragged in its Node-compat global polyfills:
  //   - at import:  an unconditional `global.fetch = …` that replaced Bun's
  //                 native fetch with a wrapper (different streaming/abort
  //                 semantics — every proxy outbound request went through it);
  //   - at serve(): `Object.defineProperty(global, "Response"/"Request", …)`,
  //                 a process-global swap to its own classes that broke any
  //                 Bun-native consumer sharing the process.
  // Bun.serve touches no globals, so the whole class of problem is gone rather
  // than patched up afterwards.
  const server = Bun.serve({
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
    // Streamed provider responses can outlive the default idle timeout.
    idleTimeout: 255,
  });

  // Bun types `port` as optional (a unix-socket server has none); for a TCP
  // listen it is always set. `port` 0 means "pick a free one", so read it back.
  const resolvedPort = server.port ?? port;

  log(`[Proxy] Server started on port ${resolvedPort}`);

  // Warm pricing cache in background (non-blocking)
  warmPricingCache().catch(() => {});

  // Warm recommended models from Firebase in background (non-blocking)
  warmRecommendedModels().catch(() => {});

  // Warm model catalog resolvers in background (non-blocking).
  // OpenRouter is the only registered resolver post-commit-5 — the LiteLLM
  // resolver was removed (claudish doesn't fetch LiteLLM's catalog anymore).
  warmCatalog().catch(() => {
    // Warming failures are non-fatal — resolver falls back to passthrough
  });

  return {
    port: resolvedPort,
    url: `http://127.0.0.1:${resolvedPort}`,
    shutdown: async () => {
      // `true` = close active connections too, so a streamed request in flight
      // can't keep the port alive after shutdown resolves.
      await server.stop(true);
    },
    invalidateHandlerCache: (providerSlug?: string) => {
      if (!providerSlug) {
        localProviderHandlers.clear();
        remoteProviderHandlers.clear();
        return;
      }
      // Handler cache keys are model specs like "lmstudio@<model>". Drop
      // any whose left-of-@ matches the slug, plus any using the slug as
      // a legacy prefix (e.g. "ollama/llama3"). Both forms route to the
      // same transport so both need invalidation.
      const matches = (k: string) =>
        k === providerSlug ||
        k.startsWith(`${providerSlug}@`) ||
        k.startsWith(`${providerSlug}/`) ||
        k.startsWith(`${providerSlug}:`);
      for (const k of [...localProviderHandlers.keys()]) {
        if (matches(k)) localProviderHandlers.delete(k);
      }
      for (const k of [...remoteProviderHandlers.keys()]) {
        if (matches(k)) remoteProviderHandlers.delete(k);
      }
    },
  };
}
