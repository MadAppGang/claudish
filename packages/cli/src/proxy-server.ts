import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { log, logStderr } from "./logger.js";
import type { ProxyServer } from "./types.js";
import { NativeHandler } from "./handlers/native-handler.js";
import { OpenRouterProviderTransport } from "./providers/transport/openrouter.js";
import { OpenRouterAPIFormat } from "./adapters/openrouter-api-format.js";
import { LocalTransport } from "./providers/transport/local.js";
import { LocalModelAdapter } from "./adapters/local-adapter.js";
import { PoeProvider } from "./providers/transport/poe.js";
import type { ModelHandler } from "./handlers/types.js";
import { ComposedHandler, type ComposedHandlerOptions } from "./handlers/composed-handler.js";
import {
  resolveProvider,
  parseUrlModel,
  createUrlProvider,
} from "./providers/provider-registry.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { resolveRemoteProvider } from "./providers/remote-provider-registry.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import { warmPricingCache } from "./services/pricing-cache.js";
import { warmRecommendedModels } from "./model-loader.js";
import {
  resolveModelNameSync,
  logResolution,
  warmAllCatalogs,
  ensureCatalogReady,
} from "./providers/model-catalog-resolver.js";
import { FallbackHandler } from "./handlers/fallback-handler.js";
import type { FallbackCandidate } from "./handlers/fallback-handler.js";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
import { route, loadRoutingRules } from "./providers/routing-rules.js";
import { createHandlerForProvider } from "./providers/provider-profiles.js";
import { loadCustomEndpoints } from "./providers/custom-endpoints-loader.js";
import { getRuntimeProviders } from "./providers/runtime-providers.js";
import { loadConfig } from "./profile-config.js";
import { registerForkExtensions, stripBillingHeaderFromBody, logRequest, createHostnameConfig } from "./fork/index.js";
import { forwardToUpstream, readRequestBody, type RelayState } from "./fork/server/relay.js";
import {
  initFailover,
  armFailover,
  isFailoverActive,
  isQuotaExhaustion,
  isWiringError,
  roleFromModelName,
  getFailoverRule,
  resolveFailoverTarget,
  markStepFailed,
  parseResetAtFromBody,
  resetStepSuccess,
  onNominalSuccess,
  consumeStreamNotice,
  appendFailoverNoticeToMessage,
  extractSessionKey,
  type FailoverRole,
} from "./fork/failover.js";
import { executeWebSearch, executeWebFetch, isLowQualityWebContent, extractUrlFromWebContent, cleanRawWebContent } from "./handlers/shared/web-search-executor.js";
import { convertOpenAIRequestToAnthropic } from "./handlers/shared/format/openai-request-to-anthropic.js";
import { anthropicMessageToChatCompletion, createOpenAIChatStreamFromAnthropic } from "./handlers/shared/anthropic-to-openai.js";
import { prependNoticeToAnthropicStream } from "./handlers/shared/failover-stream-notice.js";

/**
 * Intercept WebSearch/WebFetch tool calls and execute them via SearXNG instead
 * of forwarding to the provider. Returns a streaming response with SearXNG results.
 *
 * Claude Code's WebSearch tool sends a sub-agent request with a single user message:
 *   "Perform a web search for the query: <query>"
 * We intercept this, execute SearXNG, and return the results as text.
 */
async function interceptWebTools(c: any, body: any): Promise<Response | null> {
  const messages = body.messages || [];
  const isStreaming = body.stream === true;

  // Case 1: Sub-agent web search request (1 message, user role, starts with "Perform a web search")
  if (messages.length === 1 && messages[0].role === "user") {
    const text = typeof messages[0].content === "string"
      ? messages[0].content
      : Array.isArray(messages[0].content)
        ? messages[0].content.map((b: any) => b.text || "").join("")
        : "";

    const searchMatch = text.match(/^Perform a web search for the query:\s*(.+)$/s);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      log(`[WebTools] Intercepted sub-agent web search: "${query}"`);
      const results = await executeWebSearch(query, 5000);
      log(`[WebTools] SearXNG results: ${results.slice(0, 100)}...`);
      return buildTextResponse(body.model || "unknown", results, isStreaming);
    }

    const fetchMatch = text.match(/^Perform a web fetch for the URL:\s*(.+)$/s);
    if (fetchMatch) {
      const url = fetchMatch[1].trim();
      log(`[WebTools] Intercepted sub-agent web fetch: "${url}"`);
      // Real fetch with graceful degradation:
      // MCP web_url_read → MCP via r.jina.ai → direct HTTP → error text.
      const resultText = await executeWebFetch(url, 10_000);
      return buildTextResponse(body.model || "unknown", resultText, isStreaming);
    }

    // Case 3: Claude Code already fetched the page and sends raw HTML/markdown
    // to a sub-agent for analysis. Format: "Web page content:\n---\n<content>"
    // This happens when Claude Code's native WebFetch tool fetches the page
    // itself, converts to markdown poorly, and delegates to a sub-agent.
    const webContentMatch = text.match(/^Web page content:\s*\n---\n([\s\S]+)$/);
    if (webContentMatch) {
      const rawContent = webContentMatch[1];
      if (isLowQualityWebContent(rawContent)) {
        log(`[WebTools] Detected low-quality web content in sub-agent, attempting re-fetch`);
        const url = extractUrlFromWebContent(rawContent);
        if (url) {
          log(`[WebTools] Re-fetching "${url}" via clean pipeline`);
          const cleanContent = await executeWebFetch(url, 10_000);
          return buildTextResponse(body.model || "unknown", cleanContent, isStreaming);
        }
        // No URL extractable — clean the raw content as best we can
        log(`[WebTools] No URL found, cleaning raw web content`);
        const cleaned = cleanRawWebContent(rawContent);
        return buildTextResponse(body.model || "unknown", cleaned, isStreaming);
      }
      // Content looks reasonable — let it through to the normal handler
      return null;
    }
  }

  // Case 2: tool_use in last assistant message for WebSearch/WebFetch
  const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
  if (lastAssistant?.content) {
    const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
    const webToolCalls = content.filter(
      (b: any) => b.type === "tool_use" && (b.name === "WebSearch" || b.name === "WebFetch")
    );
    if (webToolCalls.length > 0) {
      log(`[WebTools] Intercepting ${webToolCalls.length} tool_use WebSearch/WebFetch`);
      // For now, let these fall through to the normal handler
      // (they'll be handled by the stream parser's searchWeb detection)
    }
  }

  return null;
}

function buildTextResponse(model: string, text: string, streaming: boolean): Response {
  const encoder = new TextEncoder();
  const send = (event: string, data: any) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!streaming) {
    // Non-streaming JSON response
    return new Response(JSON.stringify({
      id: `msg_webtools_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }), {
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
    });
  }

  // Streaming SSE response
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(send("message_start", {
        type: "message_start",
        message: {
          id: `msg_webtools_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));

      controller.enqueue(send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }));

      controller.enqueue(send("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      }));

      controller.enqueue(send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      }));

      controller.enqueue(send("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "anthropic-version": "2023-06-01",
    },
  });
}

/**
 * Build an assistant response with web tool results as text blocks.
 *
 * IMPORTANT: We must NOT use tool_result blocks here. In the Anthropic API,
 * tool_result blocks are only valid in messages with role: "user". Returning
 * them in an assistant message (role: "assistant") causes the client to store
 * malformed conversation history, leading to 400 errors on subsequent requests:
 *   "tool_result blocks can only be in user messages"
 *
 * Instead, we inject the search/fetch results as a text block in a normal
 * assistant response — the same approach used by openai-sse.ts suppression.
 */
function buildToolResultResponse(model: string, toolResults: any[], streaming: boolean): Response {
  const encoder = new TextEncoder();
  const send = (event: string, data: any) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Combine all tool results into a single text block
  const combinedText = toolResults.map((tr) => tr.content).join("\n\n");

  if (!streaming) {
    return new Response(JSON.stringify({
      id: `msg_webtools_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: combinedText }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }), {
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
    });
  }

  // Streaming SSE response — emit results as a text content block
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(send("message_start", {
        type: "message_start",
        message: {
          id: `msg_webtools_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));

      controller.enqueue(send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: combinedText },
      }));

      controller.enqueue(send("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      }));

      controller.enqueue(send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      }));

      controller.enqueue(send("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "anthropic-version": "2023-06-01",
    },
  });
}

export interface ProxyServerOptions {
  summarizeTools?: boolean; // Summarize tool descriptions for local models
  quiet?: boolean; // Suppress informational stderr output (e.g., [Auto-route])
  isInteractive?: boolean; // Whether the current session is interactive (gates consent prompt)
  advisorModels?: string[]; // Advisor models from --advisor flag
  advisorCollector?: string | null; // Collector model (null = no synthesis)
  hostname?: string; // Bind address (default: "127.0.0.1", use "0.0.0.0" for Docker) — fork extension
  relay?: RelayState; // Sidecar relay state — fork extension. Undefined → this process is the hub (always local).
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
  // Resolve proxy key early — needed for both auth middleware and NativeHandler
  const proxyKey = process.env.CLAUDISH_PROXY_KEY || loadConfig().proxyKey;

  // Budget failover config (fork extension). Inert with no CLAUDISH_FAILOVER_*
  // env; when set, diverts a whole role to another pool and announces it at the
  // next condensation. Read once per proxy lifetime. See fork/failover.ts.
  initFailover();

  // Load user-declared custom endpoints from ~/.claudish/config.json and
  // register them in the runtime provider registry so they appear in lookups
  // and handler creation. Runs once per proxy lifetime; idempotent.
  try {
    const customEpResult = loadCustomEndpoints(loadConfig());
    if (customEpResult.registered > 0) {
      log(
        `[Proxy] Registered ${customEpResult.registered} custom endpoint(s) from config`
      );
    }
    for (const err of customEpResult.errors) {
      console.error(
        `[claudish] customEndpoints['${err.name}'] failed validation: ${err.message}`
      );
    }
  } catch (err) {
    // Config read failure should not crash the proxy — the rest of startup
    // continues and users get the default (builtin-only) set of providers.
    log(`[Proxy] customEndpoints load skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Define handlers for different roles
  const nativeHandler = new NativeHandler(anthropicApiKey, options.advisorModels, options.advisorCollector, proxyKey);
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
    // Custom endpoints registered at runtime always have credentials (resolved from config)
    const isRuntimeProvider = getRuntimeProviders().has(resolution.parsed?.provider ?? "");
    if (resolution.category === "direct-api" && (resolution.apiKeyAvailable || isRuntimeProvider)) {
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

  // Fail-closed backstop for the CLAUDISH_NO_ANTHROPIC leak guard: when a native
  // (real api.anthropic.com) route is forbidden and no safe budget reroute is
  // available, refuse cleanly rather than leak. A clean 503 is NOT a never-hang
  // violation — the client gets a terminal error, not a hung stream.
  const anthropicRefusalHandler: ModelHandler = {
    async handle(c) {
      return c.json(
        wrapAnthropicError(
          503,
          "This claudish sidecar has CLAUDISH_NO_ANTHROPIC set and no budget model mapping to reroute a native Anthropic request. Refusing to reach api.anthropic.com (leak-policy: Anthropic models are ai-01 only)."
        ),
        503
      );
    },
    async shutdown() {},
  };

  const getHandlerForRequest = async (
    requestedModel: string,
    depth = 0
  ): Promise<ModelHandler> => {
    // 1. Monitor Mode Override
    if (monitorMode) return nativeHandler;

    // 2. Resolve target model based on mappings or defaults
    // Priority: role mappings > default model (--model) > requested model (native)
    let target = requestedModel;
    let wasFromModelMap = false;

    const req = requestedModel.toLowerCase();

    // The role is derived from what the CLIENT asked for, independently of
    // whether modelMap has an entry for it — a failover must be able to divert
    // an unmapped role (e.g. bare native opus on ai-01) just as well as a mapped
    // one. Single definition in failover.roleFromModelName (role keywords +
    // CLAUDISH_FAILOVER_ROLE_MODELS aliases) so the swap and the cascade loop
    // can never drift.
    const role = roleFromModelName(requestedModel);

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

    // 2a. Budget failover — a whole role is served from a cascade of substitute
    // pools because its nominal plan is exhausted or being conserved. Sits AFTER
    // the modelMap cascade so it overrides the nominal mapping, and BEFORE
    // catalog/route resolution so the substitute is resolved like any other target.
    // resolveFailoverTarget walks the cascade skipping TTL-failed steps. Inert
    // unless CLAUDISH_FAILOVER_* is configured. See fork/failover.ts.
    if (role) {
      const resolved = resolveFailoverTarget(role);
      if (resolved.step && resolved.step.target !== target) {
        log(
          `[Proxy] Failover: role '${role}' ${target} → ${resolved.step.target} step[${resolved.stepIndex}] (${resolved.step.label})`
        );
        target = resolved.step.target;
        wasFromModelMap = true;
      }
    }

    const invocationMode = detectInvocationMode(target, wasFromModelMap);

    // 2b. Catalog resolution — resolve vendor prefix for OpenRouter.
    // This must happen after target is determined but before handler construction.
    // ensureCatalogReady awaits the catalog if not yet warm (with 5s timeout).
    // resolveModelNameSync then reads from the in-memory cache synchronously.
    // (LiteLLM catalog resolution was removed in commit 5 — users type the
    // exact LiteLLM model_group name now; see plan §D.)
    {
      const parsedTarget = parseModelSpec(target);
      if (parsedTarget.provider === "openrouter") {
        await ensureCatalogReady(parsedTarget.provider, 5000);
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
        await ensureCatalogReady("openrouter", 5000);

        const plan = route(parsedForFallback.model, effectiveRoutingRules);
        if (plan.kind === "ok") {
          const chain = [plan.primary, ...plan.fallbacks];
          const candidates: FallbackCandidate[] = [];
          for (const candidate of chain) {
            let handler: ModelHandler | null = null;
            if (candidate.provider === "openrouter") {
              handler = getOpenRouterHandler(candidate.modelSpec, invocationMode);
            } else {
              handler = getRemoteProviderHandler(candidate.modelSpec, invocationMode);
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
          throw new Error(message);
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
      // Leak-policy backstop (defense in depth). On a non-ai-01 autonomous
      // sidecar, CLAUDISH_NO_ANTHROPIC forbids ever touching real
      // api.anthropic.com. An unmapped claude-* (or any bare native string that
      // slipped through the modelMap) would otherwise leak. Reroute to the budget
      // sonnet mapping — keeps the agent alive during an outage without leaking.
      // This sits ABOVE the per-machine config (opus/sonnet/haiku already
      // budget-mapped) because we have leaked on an undefined field before
      // (memory: leak-policy-binary-by-machine).
      //
      // The truthiness test is load-bearing, not sloppy. docker-compose always
      // MATERIALIZES this variable (`- CLAUDISH_NO_ANTHROPIC=${CLAUDISH_NO_ANTHROPIC:-}`),
      // so inside a container it is never absent — only `1` (every machine) or
      // "" (ai-01, the one machine authorized to reach api.anthropic.com).
      // Empty-string-falsy IS the ai-01 exemption; there is no separate opt-out.
      // Deleting the variable from a .env to "clean it up" therefore changes
      // nothing (compose re-creates it empty), and flipping this to a
      // `!== undefined` test would silently kill ai-01 native Opus lane.
      if (process.env.CLAUDISH_NO_ANTHROPIC) {
        if (depth === 0 && modelMap?.sonnet) {
          log(
            `[Proxy] NO_ANTHROPIC: rerouting native '${target}' → budget '${modelMap.sonnet}'`,
            true
          );
          return getHandlerForRequest(modelMap.sonnet, depth + 1);
        }
        // depth > 0 (the budget mapping itself resolved native → misconfig) or no
        // sonnet mapping: fail closed. Never leak.
        log(`[Proxy] NO_ANTHROPIC: refusing native '${target}' (no safe budget reroute)`, true);
        return anthropicRefusalHandler;
      }
      // If we mapped to a native string (unlikely) or passed through
      return nativeHandler;
    }

    // 7. OpenRouter Handler (default for any model with "/" or explicit provider not matched above)
    return getOpenRouterHandler(target, invocationMode);
  };

  /**
   * Run a request through the budget-failover cascade. Tries the resolved target
   * (nominal when not armed, else the first non-TTL-failed cascade step); on a
   * quota wall it advances state (arm the role, or mark the step failed) and
   * retries the next resolution — bounded by (cascade length + 1), so it never
   * hangs. Reuses the same `c` on every attempt: handlers do not mutate the Hono
   * Context before returning a non-ok Response (the FallbackHandler invariant),
   * which is what makes the retry safe.
   *
   * `getHandlerForRequest`'s internal swap reads `resolveFailoverTarget` — the SAME
   * source of truth this loop reads — so mutating failover state between attempts
   * is enough; no override target is passed in (that would race two resolutions).
   */
  const handleWithCascade = async (
    c: Context,
    body: any,
    requestedModel: string
  ): Promise<Response> => {
    const role = roleFromModelName(requestedModel);
    const rule = role ? getFailoverRule(role) : undefined;
    const maxAttempts = rule ? rule.steps.length + 1 : 1; // nominal + each step
    let response: Response | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const handler = await getHandlerForRequest(requestedModel);
      const { stepIndex } = role ? resolveFailoverTarget(role) : { stepIndex: -1 };
      response = await handler.handle(c, body);
      if (response.ok) {
        if (role) {
          if (stepIndex === -1) onNominalSuccess(role); // nominal healthy → fresh episode + maybe recovery
          else resetStepSuccess(role, stepIndex);
        }
        return response;
      }
      if (!role) return response; // no role → no cascade possible
      let errBody = "";
      try {
        errBody = await response.clone().text();
      } catch {
        // unreadable body — status alone still decides for 402
      }
      if (!isQuotaExhaustion(response.status, errBody)) {
        // Fail-forward. A non-quota failure on an INTERMEDIATE cascade step still
        // has a working successor beneath it, so advancing serves the user instead
        // of surfacing a substitute's incident as if it were their own. This is what
        // makes wall *recognition* an optimization rather than a safety prerequisite:
        // an unrecognized wall on a middle step now degrades to one wasted round-trip,
        // not a failed request.
        //
        // Narrow on three axes, each for a different reason:
        //  - nominal (stepIndex -1) never advances: that is the user's own model
        //    failing, and it must surface.
        //  - the last step never advances: there is nothing beneath it.
        //  - wiring faults never advance: a mistyped model id in a step would become
        //    permanently invisible, every request stepping over it in silence.
        const isIntermediateStep =
          stepIndex >= 0 && rule != null && stepIndex < rule.steps.length - 1;
        if (!isIntermediateStep) return response;
        if (isWiringError(response.status, errBody)) {
          log(
            `[Failover] STEP-WIRING ${role} step=${stepIndex} — HTTP ${response.status} looks like a misconfigured step; surfacing instead of advancing`,
            true
          );
          return response;
        }
        // Loud on purpose: advancing must never be silent, or a persistently sick
        // step is indistinguishable from a healthy cascade.
        const why = `HTTP ${response.status} (non-quota) from step ${stepIndex}`;
        log(`[Failover] STEP-ADVANCE ${role} — ${why}; trying next step`, true);
        // Marked, not merely skipped: the first backoff rung is 10 min, so a transient
        // blip costs one short skip of a step that has a live successor — whereas not
        // marking makes every subsequent request re-pay the round-trip (and its
        // timeout) to a step that may be down for hours. Any success resets the count.
        markStepFailed(role, stepIndex, why, parseResetAtFromBody(errBody));
        continue;
      }
      const reason = `HTTP ${response.status} from ${requestedModel}`;
      if (stepIndex === -1) {
        // Nominal walled: arm the role (reactive, AUTO only). armFailover also
        // returns false when the role is ALREADY armed — typically a concurrent
        // request armed it between this request's handler resolution and its 429.
        // That is success for this request, not a failure to arm: proceeding to
        // the retry serves it from the cascade instead of surfacing a raw 429
        // (production 2026-08-20: the disarm-probe window at each 10-min TTL
        // raced two opus requests; the loser died client-side with "API Error").
        if (!armFailover(role, reason) && !isFailoverActive(role)) return response;
      } else {
        markStepFailed(role, stepIndex, reason, parseResetAtFromBody(errBody));
        if (rule && stepIndex === rule.steps.length - 1) return response; // last step also walled
      }
    }
    return response as Response;
  };

  /**
   * Inject failover/recovery notices into a successful Anthropic-shape response.
   * Streaming: a one-time-per-session (per resolved depth) notice prepended as
   * block 0, so the substitute/back-to-nominal model reads it from its own prior
   * turn next time. Non-streaming: the condensation notice appended to the
   * collected message (fires every /compact while armed, RECOVERY_CONDENSATIONS
   * times while recovering). Never throws — a malformed body passes through.
   *
   * Centralized here (not in ComposedHandler) so it also covers NativeHandler
   * responses — the recovery case, where the nominal (Opus) is back, must be
   * announced even though NativeHandler is a thin passthrough.
   */
  const applyFailoverNotices = async (
    response: Response,
    role: FailoverRole | null,
    sessionKey: string | null,
    wantsStreaming: boolean
  ): Promise<Response> => {
    if (!role) return response;
    if (wantsStreaming) {
      const text = consumeStreamNotice(role, sessionKey);
      if (text && response.body) {
        try {
          const wrapped = prependNoticeToAnthropicStream(response.body, text);
          const headers = new Headers(response.headers);
          return new Response(wrapped as any, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } catch {
          // Never hang: fall through to the unmodified stream.
        }
      }
      return response;
    }
    try {
      const message = await response.clone().json();
      appendFailoverNoticeToMessage(message, role);
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify(message), { status: response.status, headers });
    } catch {
      return response;
    }
  };

  // Fork extension: hostname binding + remote address tracking
  const hostnameConfig = createHostnameConfig(options.hostname);

  const app = new Hono();
  app.use("*", cors());

  // Fork extensions: proxy auth + model discovery
  registerForkExtensions(app, { proxyKey });

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
      if (typeof body?.model !== "string" || body.model.length === 0) {
        return c.json(
          wrapAnthropicError(400, "missing required field: model"),
          400
        );
      }
      const handler = await getHandlerForRequest(body.model);

      // If native, forward transparently (all client headers passthrough).
      if (handler instanceof NativeHandler) {
        const HOP_BY_HOP = new Set([
          "host", "connection", "keep-alive", "transfer-encoding", "te",
          "trailer", "upgrade", "content-length",
        ]);
        const reqHeaders: Record<string, string> = { "Content-Type": "application/json" };
        for (const [key, value] of Object.entries(c.req.header())) {
          if (HOP_BY_HOP.has(key.toLowerCase()) || typeof value !== "string") continue;
          reqHeaders[key] = value;
        }
        // Proxy key override (same logic as NativeHandler)
        if (proxyKey) {
          const authHeader = c.req.header("authorization");
          const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
          const clientAuthToken = c.req.header("x-api-key") || bearerToken;
          if (clientAuthToken === proxyKey) {
            delete reqHeaders["x-api-key"];
            delete reqHeaders["authorization"];
            if (anthropicApiKey) {
              if (anthropicApiKey.startsWith("sk-ant-oat")) {
                reqHeaders["authorization"] = `Bearer ${anthropicApiKey}`;
              } else {
                reqHeaders["x-api-key"] = anthropicApiKey;
              }
            }
          }
        }

        const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(body),
        });
        return c.json(await res.json());
      } else {
        // OpenRouter handler logic (estimation)
        const txt = JSON.stringify(body);
        return c.json({ input_tokens: Math.ceil(txt.length / 4) });
      }
    } catch (e) {
      return c.json(wrapAnthropicError(500, String(e)), 500);
    }
  });

  app.post("/v1/messages", async (c) => {
    try {
      // readRequestBody inflates a gzipped body (WAN external sidecar → hub);
      // identical to c.req.json() on the uncompressed LAN/direct path.
      const body = await readRequestBody(c);

      // Sidecar relay (fork extension). In NOMINAL mode (upstream configured +
      // alive) forward the raw request to the central hub and return its piped
      // response. This branch sits BEFORE interceptWebTools / getHandlerForRequest
      // / logRequest, so nominal forwards do NOT capture locally (the hub captures
      // centrally) — mode-aware capture for free. A pre-stream forward failure
      // returns null → fall through to the normal local path for this one request
      // (and feeds the prober's hysteresis toward AUTONOMOUS).
      const relay = options.relay;
      if (relay?.upstream && relay.alive) {
        const forwarded = await forwardToUpstream(c, body, relay);
        if (forwarded) return forwarded;
      }

      // Log tool names in request for debugging WebSearch/WebFetch
      const toolNames = (body.tools || []).map((t: any) => t.name);
      if (toolNames.length > 0) log(`[Proxy] Tools in request: ${toolNames.join(", ")}`);
      // Also check messages for tool_use blocks
      const lastMsg = body.messages?.[body.messages.length - 1];
      if (lastMsg?.content) {
        const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        const toolUses = blocks.filter((b: any) => b.type === "tool_use");
        if (toolUses.length > 0) log(`[Proxy] Last msg tool_use: ${toolUses.map((t: any) => t.name).join(", ")}`);
      }

      // Intercept WebSearch/WebFetch tool calls and execute via SearXNG
      try {
        const webToolResponse = await interceptWebTools(c, body);
        if (webToolResponse) return webToolResponse;
      } catch (e: any) {
        log(`[WebTools] Intercept error (falling through to normal handler): ${e.message}`);
      }

      // Resolve once for the request log + billing-header strip decision. The
      // cascade below re-resolves as failover state mutates (same source of truth).
      const handler = await getHandlerForRequest(body.model);
      logRequest(body, handler.constructor.name, c.req.raw, hostnameConfig.remoteAddrMap);
      stripBillingHeaderFromBody(body, handler instanceof NativeHandler);

      // Route through the budget-failover cascade (nominal → step0 → step1 …),
      // then inject onset/recovery notices. See handleWithCascade / applyFailoverNotices.
      const response = await handleWithCascade(c, body, body.model);
      return applyFailoverNotices(
        response,
        roleFromModelName(body.model),
        extractSessionKey(body),
        body.stream === true
      );
    } catch (e) {
      log(`[Proxy] Error: ${e}`);
      return c.json(wrapAnthropicError(500, String(e)), 500);
    }
  });

  // OpenAI-compatible ingress. An OpenAI client (sk-agent, any AsyncOpenAI
  // consumer) POSTs here; we translate the body to Anthropic shape, run the
  // SAME routing pipeline as /v1/messages (so the client inherits the cascade,
  // budget failover, accounting, and leak policy), and translate the response
  // back to OpenAI wire shape. Anthropic remains the native ingress; this is a
  // translated ingress into the same pipeline. See CLAUDE.md.
  app.post("/v1/chat/completions", async (c) => {
    try {
      const openaiBody = await readRequestBody(c);

      // Relay (sidecar NOMINAL): forward the RAW OpenAI body to the hub's
      // /v1/chat/completions — the hub translates. Path-aware forward
      // (relay.ts) means this reaches the right hub route, not /v1/messages.
      const relay = options.relay;
      if (relay?.upstream && relay.alive) {
        const forwarded = await forwardToUpstream(c, openaiBody, relay);
        if (forwarded) return forwarded;
      }

      if (typeof openaiBody?.model !== "string" || openaiBody.model.length === 0) {
        return c.json(
          { error: { message: "missing required field: model", type: "invalid_request_error", param: "model", code: null } },
          400
        );
      }

      const anthropicBody = convertOpenAIRequestToAnthropic(openaiBody);
      const wantsStream = openaiBody.stream === true;

      const handler = await getHandlerForRequest(anthropicBody.model);
      logRequest(anthropicBody, handler.constructor.name, c.req.raw, hostnameConfig.remoteAddrMap);
      stripBillingHeaderFromBody(anthropicBody, handler instanceof NativeHandler);

      // Route through the cascade, then inject onset/recovery notices on the
      // Anthropic-shape response BEFORE translation to OpenAI wire shape (the
      // notice becomes ordinary content the OpenAI client sees).
      let response = await handleWithCascade(c, anthropicBody, anthropicBody.model);
      response = await applyFailoverNotices(
        response,
        roleFromModelName(anthropicBody.model),
        extractSessionKey(anthropicBody),
        wantsStream
      );

      // Translate the final Anthropic response to OpenAI shape.
      if (!response.ok) {
        // Error: convert the Anthropic error envelope to OpenAI's error shape so
        // an OpenAI SDK can surface it instead of choking on the foreign body.
        let errJson: any;
        try {
          errJson = await response.json();
        } catch {
          errJson = { error: { type: "api_error", message: `upstream HTTP ${response.status}` } };
        }
        const anthropicErr = errJson?.error ?? errJson;
        const oaiErr = {
          error: {
            message: anthropicErr.message ?? `upstream HTTP ${response.status}`,
            type: anthropicErr.type ?? "api_error",
            code: anthropicErr.code ?? null,
          },
        };
        return c.json(oaiErr, response.status as any);
      }

      if (wantsStream) {
        return createOpenAIChatStreamFromAnthropic(response, anthropicBody.model);
      }
      const message = await response.json();
      return c.json(anthropicMessageToChatCompletion(message, anthropicBody.model), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      log(`[Proxy] /v1/chat/completions error: ${e}`);
      return c.json(
        { error: { message: String(e), type: "api_error", code: null } },
        500
      );
    }
  });

  const server = serve({
    fetch(req, env, ctx) {
      if (!req.headers.get("x-forwarded-for") && !req.headers.get("x-real-ip")) {
        // @ts-expect-error — Bun injects remoteAddress on the server info object
        const addr = ctx?.remoteAddress?.address as string | undefined;
        if (addr) hostnameConfig.remoteAddrMap.set(req, addr);
      }
      return app.fetch(req, env, ctx);
    },
    port,
    hostname: hostnameConfig.hostname,
  });

  // Port resolution
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr?.port ? addr.port : port;
  if (actualPort !== port) port = actualPort;

  log(`[Proxy] Server started on port ${port}`);

  // Warm pricing cache in background (non-blocking)
  warmPricingCache().catch(() => {});

  // Warm recommended models from Firebase in background (non-blocking)
  warmRecommendedModels().catch(() => {});

  // Warm model catalog resolvers in background (non-blocking).
  // OpenRouter is the only registered resolver post-commit-5 — the LiteLLM
  // resolver was removed (claudish doesn't fetch LiteLLM's catalog anymore).
  warmAllCatalogs(["openrouter"]).catch(() => {
    // Warming failures are non-fatal — resolver falls back to passthrough
  });

  return {
    port,
    url: `http://${hostnameConfig.hostname}:${port}`,
    shutdown: async () => {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
