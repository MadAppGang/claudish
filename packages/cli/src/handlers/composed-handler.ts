/**
 * ComposedHandler — composes a ProviderTransport + ModelAdapter to implement ModelHandler.
 *
 * This is the universal handler that replaces all 11 monolithic handlers.
 * The Provider owns transport (auth, endpoint, headers, rate limiting).
 * The Adapter owns transforms (messages, tools, payload, text post-processing).
 *
 * Flow:
 *   1. transformOpenAIToClaude(payload)          — normalize incoming request
 *   2. adapter.convertMessages(claudeRequest)    — Claude → target format
 *   3. adapter.convertTools(claudeRequest)        — tool schema conversion
 *   3b. middleware.beforeRequest(...)             — pre-flight hooks
 *   4. adapter.buildPayload(...)                  — assemble full request body
 *   5. adapter.prepareRequest(payload, original)  — tool name truncation, etc.
 *   6. fetch via provider (with optional queue)   — HTTP request
 *   7. stream parser by provider.streamFormat     — response → Claude SSE
 *
 * Step 3b must stay ahead of step 4: buildPayload does not reliably alias
 * `messages`/`tools`, so hooks that run after it are silently discarded on the
 * Codex/Responses path.
 */

import type { Context } from "hono";
import type { BaseAPIFormat } from "../adapters/base-api-format.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import type { ModelHandler } from "./types.js";
// Alias for readability within this file
type BaseModelAdapter = BaseAPIFormat;
import { DialectManager } from "../adapters/dialect-manager.js";
import { lookupModelForProvider } from "../adapters/model-catalog.js";
import type { QuotaAdapter } from "../auth/quota/adapter.js";
import { resolveQuotaAdapter } from "../auth/quota/registry.js";
import { PLAN_POLL_INTERVAL_MS } from "../auth/quota/types.js";
import type { BehaviorEngine, BehaviorSession } from "../behavior/index.js";
import { getBehaviorEngine } from "../behavior/index.js";
import { getLogLevel, log, logStderr, logStructured, truncateContent } from "../logger.js";
import { GeminiThoughtSignatureMiddleware, MiddlewareManager } from "../middleware/index.js";
import { isTerminal429 } from "../providers/transport/openai.js";
import {
  type OpenAIImageBlock,
  type VisionProxyAuthHeaders,
  describeImages,
} from "../services/vision-proxy.js";
import { recordStats } from "../stats.js";
import { classifyError, reportError } from "../telemetry.js";
import { transformOpenAIToClaude } from "../transform.js";
import {
  buildSurfacedErrorMessage,
  ensureAnthropicErrorFormat,
  extractProviderMessage,
  isTerminalError,
  wrapAnthropicError,
} from "./shared/anthropic-error.js";
import { buildConnectionErrorMessage, classifyConnectionError } from "./shared/connection-error.js";
import { requestCatalogContextWindow } from "./shared/context-window-fallback.js";
import { sniffDevinStreamHead } from "./shared/devin-stream-head-sniffer.js";
import { filterIdentity } from "./shared/openai-compat.js";
import { isQuotaExhaustionError } from "./shared/quota-exhaustion.js";
import { sniffResponsesStreamHead } from "./shared/stream-head-sniffer.js";
import { createAnthropicPassthroughStream } from "./shared/stream-parsers/anthropic-sse.js";
import { createDevinConnectStream } from "./shared/stream-parsers/devin-connect.js";
import { createGeminiSseStream } from "./shared/stream-parsers/gemini-sse.js";
import { createOllamaJsonlStream } from "./shared/stream-parsers/ollama-jsonl.js";
import { createResponsesStreamHandler } from "./shared/stream-parsers/openai-responses-sse.js";
import { createStreamingResponseHandler } from "./shared/stream-parsers/openai-sse.js";
import { TokenTracker } from "./shared/token-tracker.js";

/**
 * Backoff schedule for a retryable error that arrived inside an HTTP 200 stream.
 * Progressive rather than tight: the Codex capacity outage that motivated this
 * lasted minutes, so the useful attempts are the late ones.
 */
const STREAM_RETRY_DELAYS_MS = [3_000, 15_000, 30_000];

function extractAuthHeaders(c: Context): VisionProxyAuthHeaders {
  const headers = c.req.header();
  const auth: VisionProxyAuthHeaders = {};
  if (headers["x-api-key"]) auth["x-api-key"] = headers["x-api-key"];
  return auth;
}

export interface ComposedHandlerOptions {
  /** Override format selection — use this specific APIFormat instance */
  adapter?: BaseAPIFormat;
  /** Tool schemas for validation (enables buffered tool call validation) */
  toolSchemas?: any[];
  /** Token tracking strategy */
  tokenStrategy?: "standard" | "accumulate-both" | "delta-aware" | "actual-cost" | "local";
  /** Summarize tool descriptions (for models with small context) */
  summarizeTools?: boolean;
  /** Whether the Gemini SSE stream wraps chunks in {response: {...}} (CodeAssist) */
  unwrapGeminiResponse?: boolean;
  /** Whether the current session is interactive (gates consent prompt). */
  isInteractive?: boolean;
  /**
   * Force the Layer 4 behavior supervisor ON regardless of the model's name.
   *
   * The default rule reads `claude-*` as "native Claude, already follows these
   * conventions" — a naming rule that holds for models reached through
   * Anthropic's own harness. A third party re-serving `claude-sonnet-5-medium`
   * over a reverse-engineered endpoint has no such measurement behind it, so a
   * provider whose uids merely LOOK like Claude's would silently disarm the
   * supervisor for exactly the models most likely to need it. Set by the
   * provider profile; every other provider leaves it undefined and is untouched.
   */
  forceForeignModel?: boolean;
  /** How this handler was invoked (for stats). */
  invocationMode?: "profile" | "explicit-model" | "auto-route" | "env-var" | "model-map";
}

export class ComposedHandler implements ModelHandler {
  private provider: ProviderTransport;
  private adapterManager: DialectManager;
  private explicitAdapter?: BaseModelAdapter;
  /** Model-specific adapter (GLM, Grok, etc.) — handles model quirks independent of provider */
  private modelAdapter?: BaseModelAdapter;
  private middlewareManager: MiddlewareManager;
  private behaviorEngine: BehaviorEngine;
  private tokenTracker: TokenTracker;
  /** Full routed model string (e.g. "zai@glm-4.7"). Used for provider routing and display echo. */
  private targetModel: string;
  /**
   * Bare model name (e.g. "glm-4.7"), provider prefix stripped. Used for model identity:
   * dialect selection, catalog lookup, middleware routing, context tracking. Never contains '@'.
   * @invariant !bareModelName.includes("@")
   */
  private readonly bareModelName: string;
  private options: ComposedHandlerOptions;
  private isInteractive: boolean;
  /** Fallback metadata set by FallbackHandler before calling handle() */
  private pendingFallbackMeta?: { chain: string[]; attempts: number };
  /**
   * When this handler last polled a provider's usage endpoint. A handler is
   * cached per model and can serve overlapping requests, so this throttle is
   * per-handler rather than global — two providers refresh independently.
   */
  private lastPlanPollAt = 0;

  constructor(
    provider: ProviderTransport,
    targetModel: string,
    modelName: string,
    port: number,
    options: ComposedHandlerOptions = {}
  ) {
    // Enforce the bare-name invariant — modelName must not contain provider routing
    // syntax. This prevents #102-class bugs where a routed string leaks into dialect
    // selection (e.g. "zai@glm-4.7" falsely matching GLMModelDialect via the "@glm"
    // substring). Callers must strip the provider prefix before passing modelName.
    if (modelName.includes("@")) {
      throw new Error(
        `ComposedHandler: modelName must not contain '@' (got "${modelName}"). Strip the provider routing prefix before passing modelName. If you need the full routed form, pass it as targetModel.`
      );
    }

    this.provider = provider;
    this.targetModel = targetModel;
    this.bareModelName = modelName;
    this.options = options;
    this.explicitAdapter = options.adapter;
    this.isInteractive = options.isInteractive ?? false;

    // Initialize dialect manager for automatic dialect/format selection.
    // Always pass the bare modelName — passing routed strings here was the root
    // cause of #102 (zai@glm-4.7 false-matching GLMModelDialect).
    //
    // The second argument is the REQUEST wire format, which only this class
    // knows: dialects self-select by model name, and the same model can be
    // served over different wires by different providers (Qwen: DashScope
    // OpenAI-compatible vs. Qwen Plan's Anthropic Messages endpoint),
    // each with a differently-named reasoning knob. The Layer 1 FormatConverter
    // decides the request shape, so its getStreamFormat() is the signal — NOT
    // provider.overrideStreamFormat(), which only re-labels the RESPONSE for
    // aggregators. Undefined when no explicit converter was passed (the dialect
    // is then also the converter) → dialects fall back to the OpenAI default.
    this.adapterManager = new DialectManager(
      this.bareModelName,
      this.explicitAdapter?.getStreamFormat()
    );

    // Always resolve model-specific adapter (GLM, Grok, DeepSeek, etc.)
    // This handles model quirks independent of provider transport (LiteLLM, OpenRouter, etc.)
    const resolvedModelAdapter = this.adapterManager.getAdapter();
    if (resolvedModelAdapter.getName() !== "DefaultAPIFormat") {
      this.modelAdapter = resolvedModelAdapter;
    }

    // Initialize middleware (only register model-specific middleware when applicable).
    // Use bareModelName for the middleware gate — .includes() works identically for
    // "google@gemini-2.5-flash" and "gemini-2.5-flash", and bare form is the invariant.
    this.middlewareManager = new MiddlewareManager();
    if (this.bareModelName.includes("gemini") || this.bareModelName.includes("google/")) {
      this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    }
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[ComposedHandler:${this.bareModelName}] Middleware init error: ${err}`));

    // Layer 4: harness-convention conformance. The engine is stateless and
    // process-wide; per-request state lives on the session created in handle(),
    // because this handler is cached per model and can serve overlapping requests.
    this.behaviorEngine = getBehaviorEngine();

    // Initialize token tracker — model adapter knows the real context window
    this.tokenTracker = new TokenTracker(port, {
      contextWindow: this.getModelContextWindow(),
      providerName: provider.name,
      modelName: this.bareModelName,
      providerDisplayName: provider.displayName,
    });
  }

  /** Provider adapter — handles transport format (messages, tools, payload) */
  private getAdapter(): BaseModelAdapter {
    return this.explicitAdapter || this.adapterManager.getAdapter();
  }

  /** Model context window — model adapter wins over provider adapter */
  private getModelContextWindow(): number {
    return this.modelAdapter?.getContextWindow() ?? this.getAdapter().getContextWindow();
  }

  /** Model vision support — model adapter wins over provider adapter */
  private getModelSupportsVision(): boolean {
    return this.modelAdapter?.supportsVision() ?? this.getAdapter().supportsVision();
  }

  /** Get the active adapter name for stats reporting. */
  private getActiveAdapterName(): string {
    // Model-specific dialect takes precedence (GLMModelDialect, GrokModelDialect, etc.)
    if (this.modelAdapter) return this.modelAdapter.getName();
    return this.getAdapter().getName();
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const startTime = performance.now();
    // latency_ms = time-to-first-byte (from request send to successful response).
    // Captured here so it is available to the post-stream stats callback below.
    let latencyMs = 0;
    // Capture and consume fallback metadata (set by FallbackHandler before calling handle).
    // Used in all stats recording paths so a single event carries complete info.
    const fallbackMeta = this.pendingFallbackMeta;
    this.pendingFallbackMeta = undefined;
    // 1. Transform incoming Claude-format request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

    // 2. Get adapter and reset state
    const adapter = this.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();

    // 3. Convert messages and tools
    const messages = adapter.convertMessages(claudeRequest, filterIdentity);
    let tools = adapter.convertTools(claudeRequest, this.options.summarizeTools);

    // Per-API tool-count cap (e.g. OpenAI Chat Completions hard-caps `tools` at
    // 128 — exceeding it fails the WHOLE request with HTTP 400 "array too long").
    // Head-slice to the limit: Claude Code emits its built-in agentic tools
    // first and appends MCP-server tools after, so keeping the first N preserves
    // the load-bearing built-ins and drops the tail-most MCP tools. Truncating
    // is recoverable; failing the whole request is not.
    const maxToolCount = adapter.getMaxToolCount();
    if (maxToolCount && tools.length > maxToolCount) {
      log(
        `[ComposedHandler] Capping tools from ${tools.length} to ${maxToolCount} for ${this.targetModel} (API limit)`
      );
      tools = tools.slice(0, maxToolCount);
    }

    // Handle image content for models that don't support vision
    if (!this.getModelSupportsVision()) {
      // Collect all image blocks from all messages with their positions.
      // Supports both OpenAI format (image_url) and Anthropic format (type:"image"|"document").
      const imageBlocks: Array<{ msgIdx: number; partIdx: number; block: OpenAIImageBlock }> = [];
      for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx];
        if (Array.isArray(msg.content)) {
          for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
            const part = msg.content[partIdx];
            if (part.type === "image_url" || part.type === "image" || part.type === "document") {
              imageBlocks.push({ msgIdx, partIdx, block: part as OpenAIImageBlock });
            }
          }
        }
      }

      if (imageBlocks.length > 0) {
        log(
          `[ComposedHandler] Non-vision model received ${imageBlocks.length} image(s), calling vision proxy`
        );
        // Only attempt vision proxy for OpenAI-format image_url blocks (proxy expects that format).
        // Anthropic-format image/document blocks are stripped directly.
        const openAIImageBlocks = imageBlocks.filter((b) => (b.block as any).type === "image_url");
        let descriptions: string[] | null = null;

        if (openAIImageBlocks.length > 0) {
          const auth = extractAuthHeaders(c);
          descriptions = await describeImages(
            openAIImageBlocks.map((b) => b.block),
            auth
          );
        }

        if (descriptions !== null && openAIImageBlocks.length > 0) {
          // Replace image_url blocks with [Image Description: ...] text blocks
          for (let i = 0; i < openAIImageBlocks.length; i++) {
            const { msgIdx, partIdx } = openAIImageBlocks[i];
            messages[msgIdx].content[partIdx] = {
              type: "text",
              text: `[Image Description: ${descriptions[i]}]`,
            };
          }
          log(`[ComposedHandler] Vision proxy described ${descriptions.length} image(s)`);
          // Strip any remaining Anthropic-format image/document blocks
          for (const msg of messages) {
            if (Array.isArray(msg.content)) {
              msg.content = msg.content.filter(
                (part: any) => part.type !== "image" && part.type !== "document"
              );
              if (msg.content.length === 1 && msg.content[0].type === "text") {
                msg.content = msg.content[0].text;
              } else if (msg.content.length === 0) {
                msg.content = "";
              }
            }
          }
        } else {
          // Vision proxy failed or not applicable — strip all unsupported image/document blocks
          log("[ComposedHandler] Stripping image/document blocks (vision not supported)");
          for (const msg of messages) {
            if (Array.isArray(msg.content)) {
              msg.content = msg.content.filter(
                (part: any) =>
                  part.type !== "image_url" && part.type !== "image" && part.type !== "document"
              );
              if (msg.content.length === 1 && msg.content[0].type === "text") {
                msg.content = msg.content[0].text;
              } else if (msg.content.length === 0) {
                msg.content = "";
              }
            }
          }
        }
      }
    }

    // Log request summary
    const systemPromptLength =
      typeof claudeRequest.system === "string" ? claudeRequest.system.length : 0;
    logStructured(`${this.provider.displayName} Request`, {
      targetModel: this.targetModel,
      originalModel: payload.model,
      messageCount: messages.length,
      toolCount: tools.length,
      systemPromptLength,
      maxTokens: claudeRequest.max_tokens,
    });

    // Debug logging
    if (getLogLevel() === "debug") {
      const lastUserMsg = messages.filter((m: any) => m.role === "user").pop();
      if (lastUserMsg) {
        const content =
          typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg.content);
        log(`[${this.provider.displayName}] Last user message: ${truncateContent(content, 500)}`);
      }
      if (tools.length > 0) {
        const toolNames = tools.map((t: any) => t.function?.name || t.name).join(", ");
        log(`[${this.provider.displayName}] Tools: ${toolNames}`);
      }
    }

    // 3b. Middleware before request.
    //
    // MUST run before buildPayload. buildPayload is not guaranteed to keep a
    // reference to `messages`/`tools`: the Chat Completions adapter assigns them
    // straight onto the payload (so in-place edits happened to survive), but the
    // Codex/Responses adapter deep-copies both (convertMessagesToResponsesAPI +
    // .map()) and lifts the system prompt out of `claudeRequest.system` into
    // `payload.instructions`. Running this hook after buildPayload therefore
    // discarded every mutation on exactly the path gpt-5.x uses, silently.
    //
    // Use bareModelName — must match the key used by getActiveNames() and
    // afterStreamComplete() so the same set of middlewares is selected at both ends.
    await this.middlewareManager.beforeRequest({
      modelId: this.bareModelName,
      messages,
      tools,
      stream: true,
      claudeRequest,
      claudeTools: claudeRequest.tools ?? [],
    });

    // 3c. Layer 4 — harness-convention conformance. Session is per-request so
    // two concurrent turns on this cached handler cannot share detected state.
    const behaviorSession = this.behaviorEngine.startSession({
      modelId: this.bareModelName,
      providerName: this.provider.name,
      // A naming rule, not a pinned roster: Claude models are `claude-*`, and
      // they already follow these conventions (measured 87/87 on plan mode).
      //
      // `forceForeignModel` is the one escape hatch, and it exists because the
      // name is not always evidence: a subscription aggregator can serve uids
      // like `claude-sonnet-5-medium` that match this test while being reached
      // over a foreign protocol, where the 87/87 measurement says nothing. The
      // flag is opt-in per provider profile, so the global rule — and every
      // other provider's behaviour — is unchanged.
      isNativeAnthropic:
        !this.options.forceForeignModel &&
        (/^claude[-.]/i.test(this.bareModelName) || this.provider.name === "anthropic"),
    });
    if (!behaviorSession.isNoop) {
      behaviorSession.applyRequest(claudeRequest, claudeRequest.tools ?? [], tools, messages);
    }

    // 4. Build request payload
    let requestPayload = adapter.buildPayload(claudeRequest, messages, tools);

    // Merge provider-specific extra fields
    const extraFields = this.provider.getExtraPayloadFields?.();
    if (extraFields) {
      Object.assign(requestPayload, extraFields);
    }

    // 5. Adapter post-processing (tool name truncation, reasoning params, etc.)
    adapter.prepareRequest(requestPayload, claudeRequest);
    // Model adapter may also need to post-process (e.g., strip unsupported thinking params)
    if (this.modelAdapter && this.modelAdapter !== adapter) {
      this.modelAdapter.prepareRequest(requestPayload, claudeRequest);
    }
    const toolNameMap = adapter.getToolNameMap();

    // 5b. Refresh auth / health check (must happen before transformPayload, which may use auth state)
    if (this.provider.refreshAuth) {
      try {
        await this.provider.refreshAuth();
        // Update display name in case auth resolved it (e.g., Gemini tier detection)
        if (this.provider.displayName) {
          this.tokenTracker.setProviderDisplayName(this.provider.displayName);
        }
        // Quota is DELIBERATELY not fetched here.
        //
        // This used to await getQuotaRemaining with a 2s cap on every single
        // request, purely so a status line could show usage — i.e. it could
        // add up to two seconds of latency to a turn before the upstream call
        // had even started. Quota is now published by the adapters in
        // auth/quota: Codex scrapes it from response headers that arrive
        // anyway, and Antigravity polls a free endpoint off the request path.
        // Neither can delay a turn, because neither does any work during one.
      } catch (err: any) {
        log(`[${this.provider.displayName}] Auth/health check failed: ${err.message}`);
        logStderr(
          `Error [${this.provider.displayName}]: Auth/health check failed — ${err.message}. Check credentials and server.`
        );
        reportError({
          error: err,
          providerName: this.provider.name,
          providerDisplayName: this.provider.displayName,
          streamFormat: this.provider.streamFormat,
          modelId: this.targetModel,
          httpStatus: 401,
          isStreaming: false,
          retryAttempted: false,
          isInteractive: this.isInteractive,
          authType: "oauth",
        });
        // A terminal setup failure (misconfiguration, revoked entitlement) can
        // never succeed on retry. Answering 401 sent the client into ~11 retries
        // over two minutes of backoff, with the actionable message hidden behind
        // "API error · Retrying". 400 is not retryable, so the explanation lands
        // inline on the first attempt.
        if (err?.terminal) {
          return c.json(wrapAnthropicError(400, err.message, "invalid_request_error"), 400 as any);
        }
        // Return 401 (auth failure) so FallbackHandler treats this as retryable and
        // moves to the next provider in the chain. 503 (connection error) would stop
        // the fallback chain since it is not retryable by design.
        return c.json(wrapAnthropicError(401, err.message, "authentication_error"), 401 as any);
      }
    }
    // Update context window if provider dynamically discovered it
    // (e.g., from OpenRouter model catalog or local model API).
    //
    // Only a POSITIVE number is applied. A transport returns 0 to mean "I have
    // no opinion" — OpenRouterProviderTransport says so in as many words, and
    // OpenAICodexTransport falls back to 0 on a catalog miss. Applying that 0
    // unconditionally overwrote the window the model dialect had already
    // resolved from the catalog, so every OpenRouter-routed model wrote
    // `"context_window": "unknown"` and lost its context field in the status
    // line. 0 must be a no-op, not a reset.
    if (this.provider.getContextWindow) {
      const providerWindow = this.provider.getContextWindow();
      if (providerWindow > 0) {
        this.tokenTracker.setContextWindow(providerWindow);
      }
    }

    // Still nothing? Ask the cloud catalog for this one model id, off the hot
    // path. Memoized per model id; a miss leaves today's behaviour untouched.
    if (this.tokenTracker.getContextWindow() <= 0) {
      requestCatalogContextWindow(this.bareModelName, (cw) =>
        this.tokenTracker.setContextWindow(cw)
      );
    }

    // 5c. Provider payload transformation (e.g., CodeAssist envelope wrapping)
    if (this.provider.transformPayload) {
      requestPayload = this.provider.transformPayload(requestPayload);
    }

    // (Middleware beforeRequest ran at step 3b, before buildPayload — see the
    // note there for why it cannot run at this point.)

    const endpoint = this.provider.getEndpoint(this.targetModel);
    const headers = await this.provider.getHeaders();

    // 6a. The body is NOT necessarily JSON. A transport may serialize the
    // payload itself (Devin encodes Connect-protobuf, credential and all).
    // Computed ONCE — retries must re-send identical bytes — and
    // default-preserving: a transport that leaves `serializeBody` undefined
    // yields `undefined` here and every expression below collapses to exactly
    // what it was before this hook existed.
    const serialized = this.provider.serializeBody?.(requestPayload);
    headers["Content-Type"] = serialized?.contentType ?? "application/json";

    log(`[${this.provider.displayName}] Calling API: ${endpoint}`);

    // Merge provider-specific fetch options (e.g., undici dispatcher, abort signal)
    const requestInit = this.provider.getRequestInit?.() || {};
    const doFetch = () =>
      fetch(endpoint, {
        method: "POST",
        headers,
        body: serialized?.body ?? JSON.stringify(requestPayload),
        ...requestInit,
      });

    let response: Response;
    try {
      response = this.provider.enqueueRequest
        ? await this.provider.enqueueRequest(doFetch)
        : await doFetch();
    } catch (error: any) {
      // A failure to even REACH the provider (DNS can't resolve, connection
      // refused, host unreachable) is a LOCAL network problem, not an upstream
      // server error. Surface it as a 503 connection_error with an honest,
      // actionable message so Claude Code and the config probe show "can't reach
      // host — check your network/DNS" instead of a mystifying 500. (A Tailscale
      // MagicDNS outage making chatgpt.com unresolvable is what motivated this.)
      const conn = classifyConnectionError(error);
      if (conn) {
        const msg = buildConnectionErrorMessage(conn.kind, this.provider.displayName, endpoint);
        log(`[${this.provider.displayName}] ${msg} (code=${conn.code})`);
        logStderr(`Error: ${msg}`);
        reportError({
          error,
          providerName: this.provider.name,
          providerDisplayName: this.provider.displayName,
          streamFormat: this.provider.streamFormat,
          modelId: this.targetModel,
          httpStatus: undefined,
          isStreaming: false,
          retryAttempted: false,
          isInteractive: this.isInteractive,
        });
        try {
          const { error_class, error_code } = classifyError(error, undefined);
          recordStats({
            model_id: this.targetModel,
            provider_name: this.provider.name,
            stream_format: this.provider.streamFormat,
            latency_ms: Math.round(performance.now() - startTime),
            success: false,
            http_status: 0,
            error_class,
            error_code,
            token_strategy: this.options.tokenStrategy ?? "standard",
            adapter_name: this.getActiveAdapterName(),
            middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
            fallback_used: fallbackMeta !== undefined,
            fallback_chain: fallbackMeta?.chain,
            fallback_attempts: fallbackMeta?.attempts,
            invocation_mode: this.options.invocationMode ?? "auto-route",
          });
        } catch {
          // Stats must never crash claudish
        }
        // Status 400, NOT 503. Both stop claudish's own fallback chain
        // (isRetryableError treats each as terminal), but Claude Code retries a
        // 503 as overloaded_error — ten rounds of "API error · Retrying ·
        // attempt N/10" with the real reason buried behind the banner, which is
        // exactly the failure this fix exists to kill. A 400 is rendered
        // verbatim and inline by Claude Code's native error UI, so the user
        // reads "check your network/DNS" in the transcript instead of watching
        // a retry counter. The `connection_error` TYPE is what carries the
        // meaning: probe-live's classifyHttpError keys off it (status-agnostic)
        // to report "network error" rather than a generic client error.
        return c.json(wrapAnthropicError(400, msg, "connection_error"), 400 as any);
      }
      throw error;
    }

    // Check if the transport fell back to a different model (e.g., capacity exhaustion)
    if (this.provider.getActiveModelName?.()) {
      const activeModel = this.provider.getActiveModelName()!;
      this.tokenTracker.setActiveModelName(activeModel);
      log(`[ComposedHandler] Transport fell back to model: ${activeModel}`);
    }

    log(`[${this.provider.displayName}] Response status: ${response.status}`);

    // Harvest plan usage BEFORE the error branches, because every one of them
    // returns early. A 429 is the single most valuable moment to read Codex's
    // usage headers — it is the turn where the user just hit their limit, and
    // capturing only on success would report 90% and then go quiet at 100%.
    // Idempotent: this runs again after the response settles, and the later,
    // fresher reading simply overwrites this one.
    this.capturePlanUsage(response);

    if (!response.ok) {
      // 401: retry with forced auth refresh (OAuth token expiry)
      if (response.status === 401 && this.provider.forceRefreshAuth) {
        log(`[${this.provider.displayName}] Got 401, forcing auth refresh and retrying`);
        try {
          await this.provider.forceRefreshAuth();
          const retryHeaders = await this.provider.getHeaders();
          // Same serialization as the primary request — this is a separate call
          // site and the easy one to forget, which is why both are pinned by
          // the same assertion.
          retryHeaders["Content-Type"] = serialized?.contentType ?? "application/json";
          const retryInit = this.provider.getRequestInit?.() || {};
          const retryResp = await fetch(endpoint, {
            method: "POST",
            headers: retryHeaders,
            body: serialized?.body ?? JSON.stringify(requestPayload),
            ...retryInit,
          });
          if (retryResp.ok) {
            response = retryResp; // fall through to stream handling below
          } else {
            const errorText = await retryResp.text();
            log(`[${this.provider.displayName}] Retry failed: ${errorText}`);
            logStderr(
              `Error [${this.provider.displayName}]: HTTP ${retryResp.status} after auth retry. Check API key.`
            );
            reportError({
              error: new Error(errorText),
              providerName: this.provider.name,
              providerDisplayName: this.provider.displayName,
              streamFormat: this.provider.streamFormat,
              modelId: this.targetModel,
              httpStatus: retryResp.status,
              isStreaming: false,
              retryAttempted: true,
              isInteractive: this.isInteractive,
              authType: "oauth",
            });
            try {
              const { error_class, error_code } = classifyError(
                new Error(errorText),
                retryResp.status,
                errorText
              );
              recordStats({
                model_id: this.targetModel,
                provider_name: this.provider.name,
                stream_format: this.provider.streamFormat,
                latency_ms: Math.round(performance.now() - startTime),
                success: false,
                http_status: retryResp.status,
                error_class,
                error_code,
                token_strategy: this.options.tokenStrategy ?? "standard",
                adapter_name: this.getActiveAdapterName(),
                middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
                fallback_used: fallbackMeta !== undefined,
                fallback_chain: fallbackMeta?.chain,
                fallback_attempts: fallbackMeta?.attempts,
                invocation_mode: this.options.invocationMode ?? "auto-route",
              });
            } catch {
              // Stats must never crash claudish
            }
            return c.json(wrapAnthropicError(retryResp.status, errorText), retryResp.status as any);
          }
        } catch (err: any) {
          log(`[${this.provider.displayName}] Auth refresh failed: ${err.message}`);
          logStderr(
            `Error [${this.provider.displayName}]: Authentication failed — ${err.message}. Check API key.`
          );
          reportError({
            error: err,
            providerName: this.provider.name,
            providerDisplayName: this.provider.displayName,
            streamFormat: this.provider.streamFormat,
            modelId: this.targetModel,
            httpStatus: 401,
            isStreaming: false,
            retryAttempted: true,
            isInteractive: this.isInteractive,
            authType: "oauth",
          });
          try {
            const { error_class, error_code } = classifyError(err, 401, err.message);
            recordStats({
              model_id: this.targetModel,
              provider_name: this.provider.name,
              stream_format: this.provider.streamFormat,
              latency_ms: Math.round(performance.now() - startTime),
              success: false,
              http_status: 401,
              error_class,
              error_code,
              token_strategy: this.options.tokenStrategy ?? "standard",
              adapter_name: this.getActiveAdapterName(),
              middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
              fallback_used: fallbackMeta !== undefined,
              fallback_chain: fallbackMeta?.chain,
              fallback_attempts: fallbackMeta?.attempts,
              invocation_mode: this.options.invocationMode ?? "auto-route",
            });
          } catch {
            // Stats must never crash claudish
          }
          return c.json(wrapAnthropicError(401, err.message, "authentication_error"), 401 as any);
        }
      } else {
        const errorText = await response.text();
        log(`[${this.provider.displayName}] Error: ${errorText}`);
        const hint = getRecoveryHint(response.status, errorText, this.provider.displayName);
        let parsedErrorBody: any;
        try {
          parsedErrorBody = JSON.parse(errorText);
        } catch {
          parsedErrorBody = undefined;
        }
        const providerMsg = extractProviderMessage(parsedErrorBody ?? errorText);
        // Richer stderr line: provider + status + hint + the real upstream message,
        // so the cause is findable in scrollback even when Claude Code only shows
        // its own "API error · Retrying" banner. Bounded to one tidy line.
        const msgTail = providerMsg
          ? ` (${providerMsg.length > 200 ? `${providerMsg.slice(0, 200)}…` : providerMsg})`
          : "";
        logStderr(
          `Error [${this.provider.displayName}]: HTTP ${response.status}. ${hint}${msgTail}`
        );

        // Extract structured error type from provider response body if present
        let providerErrorType: string | undefined;
        try {
          const parsed = JSON.parse(errorText);
          providerErrorType = parsed?.error?.type || parsed?.type || parsed?.code || undefined;
          // Only keep short, clearly-typed values (not freeform messages)
          if (typeof providerErrorType === "string" && providerErrorType.length > 50) {
            providerErrorType = undefined;
          }
        } catch {
          // Not JSON — no structured error type available
        }

        reportError({
          error: new Error(errorText),
          providerName: this.provider.name,
          providerDisplayName: this.provider.displayName,
          streamFormat: this.provider.streamFormat,
          modelId: this.targetModel,
          httpStatus: response.status,
          isStreaming: false,
          retryAttempted: false,
          isInteractive: this.isInteractive,
          providerErrorType,
        });
        try {
          const { error_class, error_code } = classifyError(
            new Error(errorText),
            response.status,
            errorText
          );
          recordStats({
            model_id: this.targetModel,
            provider_name: this.provider.name,
            stream_format: this.provider.streamFormat,
            latency_ms: Math.round(performance.now() - startTime),
            success: false,
            http_status: response.status,
            error_class,
            error_code,
            token_strategy: this.options.tokenStrategy ?? "standard",
            adapter_name: this.getActiveAdapterName(),
            middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
            fallback_used: fallbackMeta !== undefined,
            fallback_chain: fallbackMeta?.chain,
            fallback_attempts: fallbackMeta?.attempts,
            invocation_mode: this.options.invocationMode ?? "auto-route",
          });
        } catch {
          // Stats must never crash claudish
        }

        // Reuse the body parsed above (avoid double-JSON-encoding — errorText is
        // already JSON when parseable).
        const errorBody: any = parsedErrorBody ?? {
          error: { type: "api_error", message: errorText },
        };
        // Terminal errors (auth / quota / billing / model-unsupported) won't
        // resolve on retry. Leaving a retryable status (429/5xx) makes Claude
        // Code silently retry, showing only "API error · Retrying · attempt N/10"
        // and hiding the real reason. Remap terminal errors to 400
        // (invalid_request_error) — a status Claude Code surfaces verbatim — and
        // attach a rich message (provider + status + hint + upstream message) so
        // the user sees WHY it failed, right in the chat.
        if (isTerminalError(response.status, errorText, isTerminal429(errorText))) {
          const surfaced = buildSurfacedErrorMessage({
            providerDisplayName: this.provider.displayName,
            status: response.status,
            hint,
            providerMessage: providerMsg,
          });
          // Carry the ORIGINAL upstream status as a structured field so
          // machine consumers (probe classification) can tell a remapped
          // auth failure from a genuine 400.
          return c.json(
            wrapAnthropicError(400, surfaced, "invalid_request_error", response.status),
            400 as any
          );
        }
        return c.json(
          ensureAnthropicErrorFormat(response.status, errorBody),
          response.status as any
        );
      }
    }

    if (droppedParams.length > 0) {
      c.header("X-Dropped-Params", droppedParams.join(", "));
    }

    // 7b. Codex-class backends report capacity faults INSIDE a 200 stream, past
    // every status-code retry hook (see stream-head-sniffer.ts). Peek at the head
    // while the status is still ours to choose: retry transient faults, and only
    // when all of them fail hand back a 503 the client will retry itself. Without
    // this, `server_is_overloaded` became an assistant text block with
    // stop_reason end_turn — a retryable failure frozen into the transcript.
    if (this.resolveStreamFormat() === "openai-responses-sse") {
      const settled = await this.settleResponsesStreamHead(response, () =>
        this.provider.enqueueRequest ? this.provider.enqueueRequest(doFetch) : doFetch()
      );
      if (settled.kind === "exhausted") {
        const waited = STREAM_RETRY_DELAYS_MS.slice(0, settled.attempts).reduce(
          (sum, ms) => sum + ms,
          0
        );
        const surfaced =
          `${this.provider.displayName} is overloaded upstream (${settled.code}): ${settled.message} ` +
          `claudish retried ${settled.attempts}× over ${Math.round(waited / 1000)}s without success.`;
        logStderr(`Error: ${surfaced}`);
        try {
          recordStats({
            model_id: this.targetModel,
            provider_name: this.provider.name,
            stream_format: this.provider.streamFormat,
            latency_ms: Math.round(performance.now() - startTime),
            success: false,
            http_status: 503,
            error_class: "server_error",
            error_code: settled.code,
            token_strategy: this.options.tokenStrategy ?? "standard",
            adapter_name: this.getActiveAdapterName(),
            middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
            fallback_used: fallbackMeta !== undefined,
            fallback_chain: fallbackMeta?.chain,
            fallback_attempts: fallbackMeta?.attempts,
            invocation_mode: this.options.invocationMode ?? "auto-route",
          });
        } catch {
          // Stats must never crash claudish
        }
        return c.json(wrapAnthropicError(503, surfaced, "overloaded_error"), 503 as any);
      }
      response = settled.response;
    }

    // 7c. Devin has the same shape of fault in a different encoding: the
    // Connect transport returns 200 and the error rides a `flags=2` frame. Same
    // doctrine as 7b — retry the transient class, and surface the terminal class
    // as a 400 rendered inline rather than a status Claude Code silently retries.
    if (this.resolveStreamFormat() === "connect-proto") {
      const settled = await this.settleDevinStreamHead(response, () =>
        this.provider.enqueueRequest ? this.provider.enqueueRequest(doFetch) : doFetch()
      );
      if (settled.kind !== "ok") {
        const isTerminal = settled.kind === "terminal";
        const httpStatus = isTerminal ? 400 : 503;
        const surfaced = isTerminal
          ? `${this.provider.displayName} rejected the request (${settled.code}): ${settled.message}`
          : `${this.provider.displayName} is overloaded upstream (${settled.code}): ${settled.message} ` +
            `claudish retried ${settled.attempts}× over ` +
            `${Math.round(
              STREAM_RETRY_DELAYS_MS.slice(0, settled.attempts).reduce((sum, ms) => sum + ms, 0) /
                1000
            )}s without success.`;
        logStderr(`Error: ${surfaced}`);
        reportError({
          error: new Error(settled.message),
          providerName: this.provider.name,
          providerDisplayName: this.provider.displayName,
          streamFormat: this.provider.streamFormat,
          modelId: this.targetModel,
          httpStatus,
          isStreaming: true,
          retryAttempted: !isTerminal,
          isInteractive: this.isInteractive,
          providerErrorType: settled.code,
        });
        try {
          recordStats({
            model_id: this.targetModel,
            provider_name: this.provider.name,
            stream_format: this.provider.streamFormat,
            latency_ms: Math.round(performance.now() - startTime),
            success: false,
            http_status: httpStatus,
            error_class: isTerminal ? "client_error" : "server_error",
            error_code: settled.code,
            token_strategy: this.options.tokenStrategy ?? "standard",
            adapter_name: this.getActiveAdapterName(),
            middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
            fallback_used: fallbackMeta !== undefined,
            fallback_chain: fallbackMeta?.chain,
            fallback_attempts: fallbackMeta?.attempts,
            invocation_mode: this.options.invocationMode ?? "auto-route",
          });
        } catch {
          // Stats must never crash claudish
        }
        return isTerminal
          ? c.json(wrapAnthropicError(400, surfaced, "invalid_request_error"), 400 as any)
          : c.json(wrapAnthropicError(503, surfaced, "overloaded_error"), 503 as any);
      }
      response = settled.response;
    }

    // 8. Parse streaming response based on provider's format
    // latency_ms = time-to-first-byte (response received before stream consumed).
    // When 7b retried a transient in-stream fault this also covers the backoff
    // waits — that is deliberate: the honest figure is time-to-USABLE-response,
    // and a turn that silently cost 48s of retries should not report 2s.
    latencyMs = Math.round(performance.now() - startTime);
    const httpStatus = response.status;

    // Harvest plan usage from the response we just received. Placed here, after
    // retries and the 7b stream sniff have settled on a final response, so a
    // retried turn reports the headers of the attempt that actually succeeded.
    this.capturePlanUsage(response);

    // 9. Record stats AFTER stream completes (tokens are populated by onTokenUpdate during streaming).
    // Pass an onComplete callback into handleStream; it fires at the end of the stream after
    // onTokenUpdate, so token counts are available.
    // fallbackMeta was captured at the top of handle() and is available via closure.
    // Terminal errors that ride an HTTP 200 stream (e.g. the Responses backend's
    // `context_length_exceeded`) are invisible to the status code. The stream
    // parser reports them via onApiError; capture it here so the turn is recorded
    // as a failure, not a success. Per-request local — safe under concurrency.
    let streamApiError: { code: string; message: string } | null = null;
    const onStreamComplete = () => {
      try {
        const isFreeModel = this.tokenTracker.getTotalCost() === 0;
        recordStats({
          model_id: this.targetModel,
          provider_name: this.provider.name,
          stream_format: this.provider.streamFormat,
          latency_ms: latencyMs,
          success: streamApiError === null,
          http_status: httpStatus,
          input_tokens: this.tokenTracker.getInputTokens(),
          output_tokens: this.tokenTracker.getOutputTokens(),
          estimated_cost: this.tokenTracker.getTotalCost(),
          is_free_model: isFreeModel,
          token_strategy: this.options.tokenStrategy ?? "standard",
          adapter_name: this.getActiveAdapterName(),
          middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
          fallback_used: fallbackMeta !== undefined,
          fallback_chain: fallbackMeta?.chain,
          fallback_attempts: fallbackMeta?.attempts,
          invocation_mode: this.options.invocationMode ?? "auto-route",
        });
      } catch {
        // Stats must never crash claudish
      }
      try {
        // Layer 4 turn denominator. getInputTokens() is the FULL conversation
        // context for this request (assignment, not accumulation — see the
        // context-tracking note in CLAUDE.md), which is exactly the figure the
        // context bucket wants. No-op unless behaviour telemetry is opted in.
        behaviorSession?.noteTurnComplete(this.tokenTracker.getInputTokens());
      } catch {
        // Telemetry must never crash claudish
      }
    };

    return this.handleStream(
      c,
      response,
      adapter,
      claudeRequest,
      toolNameMap,
      onStreamComplete,
      (code, message) => {
        streamApiError = { code, message };
      },
      behaviorSession
    );
  }

  /**
   * Settle a Responses-format stream head: retry transient upstream faults that
   * arrive inside an HTTP 200 body, before any of it reaches the client.
   *
   * Backoff is progressive (3s → 15s → 30s). The Codex outage this was built for
   * ran ~6.5 minutes, so tight retries would only have burned attempts; the long
   * tail is where recovery actually happens.
   *
   * Returns `exhausted` when every attempt failed — the caller turns that into a
   * 503 so Claude Code runs its own retry loop against the same pinned model.
   * (A 503 is safe here specifically because fallback-handler's isRetryableError
   * does NOT list 503, so this cannot silently switch the user off the model they
   * pinned; it reaches Claude Code untouched.)
   */
  private async settleResponsesStreamHead(
    initial: Response,
    reissue: () => Promise<Response>
  ): Promise<
    | { kind: "ok"; response: Response }
    | { kind: "exhausted"; code: string; message: string; attempts: number }
  > {
    let response = initial;

    for (let attempt = 0; ; attempt++) {
      const verdict = await sniffResponsesStreamHead(response, { log });
      if (verdict.kind === "clean") return { kind: "ok", response: verdict.response };

      const delayMs = STREAM_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        log(
          `[${this.provider.displayName}] in-stream ${verdict.code} persisted after ` +
            `${attempt} retries — surfacing 503 so the client can retry`
        );
        return {
          kind: "exhausted",
          code: verdict.code,
          message: verdict.message,
          attempts: attempt,
        };
      }

      log(
        `[${this.provider.displayName}] in-stream ${verdict.code} before any output — ` +
          `retry ${attempt + 1}/${STREAM_RETRY_DELAYS_MS.length} in ${delayMs / 1000}s`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      let next: Response;
      try {
        next = await reissue();
      } catch (error) {
        log(`[${this.provider.displayName}] retry fetch failed: ${error}`);
        return {
          kind: "exhausted",
          code: verdict.code,
          message: `${verdict.message} (retry could not reach the provider: ${error})`,
          attempts: attempt + 1,
        };
      }

      // The fault graduated to a status-level failure. The !response.ok handling
      // is already behind us, so stop here rather than re-entering it.
      if (!next.ok) {
        const body = await next.text().catch(() => "");
        log(`[${this.provider.displayName}] retry returned HTTP ${next.status}`);
        return {
          kind: "exhausted",
          code: `http_${next.status}`,
          message: body.slice(0, 500) || `HTTP ${next.status}`,
          attempts: attempt + 1,
        };
      }

      response = next;
    }
  }

  /**
   * Settle a Devin Connect stream head — the `connect-proto` twin of
   * {@link settleResponsesStreamHead}, sharing its backoff schedule.
   *
   * It differs in one way, and the difference is the point: the sniffer
   * distinguishes TERMINAL faults from transient ones, so an unserved model uid
   * or a revoked entitlement is answered immediately with the real reason
   * instead of burning 48s of backoff first. Only the transient class is
   * retried; only an exhausted retry chain becomes a 503.
   *
   * Terminal messages pass through the transport's served-set-aware rewrite when
   * it offers one, which is what turns an opaque backend string into "that uid
   * is not served by your subscription; here is what is".
   */
  private async settleDevinStreamHead(
    initial: Response,
    reissue: () => Promise<Response>
  ): Promise<
    | { kind: "ok"; response: Response }
    | { kind: "terminal"; code: string; message: string }
    | { kind: "exhausted"; code: string; message: string; attempts: number }
  > {
    // Optional-method probe rather than a `ProviderTransport` member: this whole
    // branch is Devin-specific by construction, and widening the shared
    // interface for one consumer would invite the next provider to add another.
    const rewrite = (
      this.provider as { rewriteInStreamError?: (code: string, message: string) => string }
    ).rewriteInStreamError?.bind(this.provider);

    let response = initial;

    for (let attempt = 0; ; attempt++) {
      const verdict = await sniffDevinStreamHead(response, { log });
      if (verdict.kind === "clean") return { kind: "ok", response: verdict.response };

      if (verdict.kind === "terminal") {
        const message = rewrite?.(verdict.code, verdict.message) ?? verdict.message;
        log(`[${this.provider.displayName}] terminal in-stream error ${verdict.code}`);
        return { kind: "terminal", code: verdict.code, message };
      }

      const delayMs = STREAM_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        log(
          `[${this.provider.displayName}] in-stream ${verdict.code} persisted after ` +
            `${attempt} retries — surfacing 503 so the client can retry`
        );
        return {
          kind: "exhausted",
          code: verdict.code,
          message: verdict.message,
          attempts: attempt,
        };
      }

      log(
        `[${this.provider.displayName}] in-stream ${verdict.code} before any output — ` +
          `retry ${attempt + 1}/${STREAM_RETRY_DELAYS_MS.length} in ${delayMs / 1000}s`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      let next: Response;
      try {
        next = await reissue();
      } catch (error) {
        log(`[${this.provider.displayName}] retry fetch failed: ${error}`);
        return {
          kind: "exhausted",
          code: verdict.code,
          message: `${verdict.message} (retry could not reach the provider: ${error})`,
          attempts: attempt + 1,
        };
      }

      // The fault graduated to a status-level failure. The !response.ok handling
      // is already behind us, so stop here rather than re-entering it.
      if (!next.ok) {
        const body = await next.text().catch(() => "");
        log(`[${this.provider.displayName}] retry returned HTTP ${next.status}`);
        return {
          kind: "exhausted",
          code: `http_${next.status}`,
          message: body.slice(0, 500) || `HTTP ${next.status}`,
          attempts: attempt + 1,
        };
      }

      response = next;
    }
  }

  /**
   * Resolve which stream parser this request's bytes should go to.
   *
   * Priority:
   *   1. Transport override (aggregators like LiteLLM/OpenRouter normalize server-side)
   *   2. Explicit format adapter (provider profile passes it, e.g. AnthropicAPIFormat
   *      for Z.AI, CodexAPIFormat for OpenAI Codex) — this is the layer that KNOWS
   *      the wire protocol.
   *   3. Model dialect — only reached if no explicit adapter was passed. Dialects like
   *      GLMModelDialect/GrokModelDialect handle model quirks (context window, thinking
   *      block stripping), NOT wire format. Their inherited default "openai-sse" must
   *      NOT override the explicit adapter — that was #102.
   *
   * Previous ordering (pre-fix) put modelAdapter at tier 2, causing GLMModelDialect's
   * inherited "openai-sse" to silently override AnthropicAPIFormat's "anthropic-sse"
   * for zai@glm-* — the Anthropic SSE was then fed to the OpenAI parser and dropped.
   *
   * Resolved in one place because handle() needs it BEFORE handleStream() runs, to
   * decide whether the response head is worth sniffing for retryable errors.
   */
  private resolveStreamFormat(): string {
    return (
      this.provider.overrideStreamFormat?.() ??
      this.explicitAdapter?.getStreamFormat() ??
      this.modelAdapter?.getStreamFormat() ??
      this.getAdapter().getStreamFormat()
    );
  }

  private handleStream(
    c: Context,
    response: Response,
    adapter: BaseModelAdapter,
    claudeRequest: any,
    toolNameMap?: Map<string, string>,
    onComplete?: () => void,
    onApiError?: (code: string, message: string) => void,
    behaviorSession?: BehaviorSession
  ): Response {
    // Local mutable copy so we can null it out after firing (prevents double-firing)
    // without reassigning the function parameter.
    let pendingOnComplete = onComplete;
    const onTokenUpdate = (input: number, output: number) => {
      const strategy = this.options.tokenStrategy || "standard";
      switch (strategy) {
        case "accumulate-both":
          this.tokenTracker.accumulateBoth(input, output);
          break;
        case "delta-aware":
          this.tokenTracker.updateWithDelta(input, output);
          break;
        case "local":
          this.tokenTracker.updateLocal(input, output);
          break;
        default:
          this.tokenTracker.update(input, output);
          break;
      }
      // Fire onComplete after token update so recordStats() sees the final token counts.
      if (pendingOnComplete) {
        try {
          pendingOnComplete();
        } catch {
          // Stats must never crash claudish
        }
        // Prevent double-firing if onTokenUpdate is called more than once
        pendingOnComplete = undefined;
      }
    };

    const streamFormat = this.resolveStreamFormat();
    // Stream parsers receive bareModelName: it is used both as the middleware-identity
    // key (must match beforeRequest() / getActiveNames()) AND as the value echoed in
    // `message_start.message.model` for display. Passing the routed form here was the
    // latent second part of #102 — the parameter was named `modelName` but received
    // the full routed string.
    // Seed for message_start.usage — the previous request's context size. A
    // parser cannot know the real count until the stream ends, and Claude Code
    // keeps whatever message_start carried whenever the closing delta omits it.
    const priorInputTokens = this.tokenTracker.getLastInputTokens();

    switch (streamFormat) {
      case "openai-sse":
        return createStreamingResponseHandler(
          c,
          response,
          adapter,
          this.bareModelName,
          this.middlewareManager,
          onTokenUpdate,
          claudeRequest.tools,
          toolNameMap,
          priorInputTokens,
          behaviorSession && {
            shouldBufferTool: (name) => behaviorSession.interceptsTool(name),
            onToolCall: (name, argsJson) => behaviorSession.repairToolCall(name, argsJson),
            onAssistantText: (text, kind) => behaviorSession.observeText(text, kind),
            onToolCallObserved: (name) => behaviorSession.observeToolCall(name),
            onTurnEnd: () => behaviorSession.finishTurn(),
          }
        );

      case "openai-responses-sse":
        return createResponsesStreamHandler(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          toolNameMap: adapter.getToolNameMap(),
          contextWindow: lookupModelForProvider(this.bareModelName, this.provider.name),
          onApiError,
          priorInputTokens,
          middlewareManager: this.middlewareManager,
          shouldBufferTool: (name) => behaviorSession?.interceptsTool(name) ?? false,
          onToolCall: (name, argsJson) => behaviorSession?.repairToolCall(name, argsJson) ?? null,
          onAssistantText: (text, kind) => behaviorSession?.observeText(text, kind),
          onToolCallObserved: (name) => behaviorSession?.observeToolCall(name),
          onTurnEnd: () => behaviorSession?.finishTurn(),
        });

      case "anthropic-sse":
        return createAnthropicPassthroughStream(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          // Layer 2 dialect wins over the Layer 1 converter — the same
          // precedence as getModelContextWindow()/getModelSupportsVision().
          // This opt is consulted for ONE thing, shouldFilterThinking(), and
          // that is a per-MODEL/per-wire fact only the dialect knows. Every
          // anthropic-sse provider passes an explicit AnthropicAPIFormat, so
          // `adapter` here is always Layer 1 and always answers the base
          // default `false` — which silently made the one dialect override of
          // it (MiniMaxModelDialect's `true`) unreachable dead code, and would
          // do the same to the base's wire-keyed `true` for every other model
          // on this wire (qc@'s qwen / glm / deepseek rosters).
          adapter: (this.modelAdapter ?? adapter) as BaseAPIFormat,
          shouldBufferTool: (name) => behaviorSession?.interceptsTool(name) ?? false,
          repairToolArgs: (name, argsJson) =>
            behaviorSession?.repairToolCall(name, argsJson) ?? null,
          onAssistantText: (text, kind) => behaviorSession?.observeText(text, kind),
          onToolCallObserved: (name) => behaviorSession?.observeToolCall(name),
          onTurnEnd: () => behaviorSession?.finishTurn(),
        });

      case "gemini-sse": {
        // Build onToolCall callback to register tool calls + thoughtSignatures on the adapter
        const onToolCall = (toolId: string, name: string, thoughtSignature?: string) => {
          if (typeof (adapter as any).registerToolCall === "function") {
            (adapter as any).registerToolCall(toolId, name, thoughtSignature);
          }
        };
        return createGeminiSseStream(c, response, {
          modelName: this.bareModelName,
          adapter,
          middlewareManager: this.middlewareManager,
          onTokenUpdate,
          onToolCall,
          repairToolArgs: (name, argsJson) =>
            behaviorSession?.repairToolCall(name, argsJson) ?? null,
          onAssistantText: (text, kind) => behaviorSession?.observeText(text, kind),
          onToolCallObserved: (name) => behaviorSession?.observeToolCall(name),
          onTurnEnd: () => behaviorSession?.finishTurn(),
          unwrapResponse: this.options.unwrapGeminiResponse,
          priorInputTokens,
        });
      }

      case "connect-proto":
        return createDevinConnectStream(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          priorInputTokens,
          onApiError,
          toolNameMap,
          // The backend reports which uid actually answered (`claude-opus-5`
          // resolves to `claude-opus-5-high`), so the status line names the real
          // model instead of the family the user typed.
          onServedModel: (uid) => {
            if (uid !== this.bareModelName) this.tokenTracker.setActiveModelName(uid);
          },
          // Layer 4 — the same hooks the gemini-sse case passes.
          repairToolArgs: (name, argsJson) =>
            behaviorSession?.repairToolCall(name, argsJson) ?? null,
          shouldBufferTool: (name) => behaviorSession?.interceptsTool(name) ?? false,
          onAssistantText: (text, kind) => behaviorSession?.observeText(text, kind),
          onToolCallObserved: (name) => behaviorSession?.observeToolCall(name),
          onTurnEnd: () => behaviorSession?.finishTurn(),
        });

      case "ollama-jsonl":
        return createOllamaJsonlStream(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          priorInputTokens,
        });

      default:
        throw new Error(`Unknown stream format: ${streamFormat}`);
    }
  }

  /** Expose token tracker for advanced use cases */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  /**
   * Read plan usage out of a response the session already received.
   *
   * Synchronous and I/O-free by construction: the headers are in hand, so
   * there is nothing to await and nothing to time out. That is what makes this
   * safe to call on the response path, unlike the per-request quota fetch it
   * replaced. Any throw is swallowed — a usage reading is never worth
   * disturbing a turn over.
   */
  private capturePlanUsage(response: Response): void {
    try {
      const adapter = resolveQuotaAdapter(this.provider.name);
      if (!adapter) return;

      // Preferred: the numbers rode in on a response we already have.
      const plan = adapter.scrape?.(response);
      if (plan) {
        this.tokenTracker.setPlanUsage(plan);
        return;
      }

      // Otherwise the provider may have a free usage endpoint to poll.
      this.maybePollPlanUsage(adapter);
    } catch {
      // Non-fatal, always.
    }
  }

  /**
   * Refresh plan usage from a provider's free usage endpoint.
   *
   * Fire-and-forget and rate-limited. It is deliberately NOT awaited: the
   * whole point of retiring the old step-5b probe was that a turn must never
   * wait on a quota reading. The result lands in the tracker whenever it
   * arrives and is published by the next token write.
   */
  private maybePollPlanUsage(adapter: QuotaAdapter): void {
    if (!adapter.poll) return;

    const now = Date.now();
    if (now - this.lastPlanPollAt < PLAN_POLL_INTERVAL_MS) return;
    // Stamped BEFORE the call, not after: concurrent turns on this handler
    // would otherwise all see a stale timestamp and stampede the endpoint.
    this.lastPlanPollAt = now;

    void adapter
      .poll({ modelId: this.bareModelName })
      .then((plan) => {
        if (plan) this.tokenTracker.setPlanUsage(plan);
      })
      .catch(() => {
        // A failed usage reading is not a session problem.
      });
  }

  /**
   * Called by FallbackHandler before handle() when this handler is the winning provider
   * after one or more failed attempts. Stores fallback metadata for inclusion in stats.
   */
  setFallbackMeta(chain: string[], attempts: number): void {
    this.pendingFallbackMeta = { chain, attempts };
  }

  async shutdown(): Promise<void> {
    if (this.provider.shutdown) {
      await this.provider.shutdown();
    }
  }
}

/**
 * Return a human-readable recovery hint based on HTTP status and error body.
 */
function getRecoveryHint(status: number, errorText: string, providerName: string): string {
  const lower = errorText.toLowerCase();

  if (status === 503 || lower.includes("overloaded")) {
    return "Provider overloaded. Retry or use a different model.";
  }
  if (status === 429 && isTerminal429(errorText)) {
    return "Out of quota — check your plan & billing details. This won't recover on retry.";
  }
  // A spent SUBSCRIPTION allowance also arrives as 429, and the generic
  // rate-limit advice below is actively wrong for it: "reduce concurrency" does
  // nothing about an allowance that refills on a clock. Zen Go's real body is
  // `429 "5-hour usage limit reached. Resets in 3hr 17min"` — the useful reply
  // names the plan and the wait, not the request rate.
  if (isQuotaExhaustionError(status, errorText)) {
    return "Subscription allowance spent — this refills on the provider's own schedule (see the message below). Reducing concurrency won't help; switch model/provider or wait.";
  }
  if (status === 429 || lower.includes("rate limit")) {
    return "Rate limited. Wait, reduce concurrency, or check plan limits.";
  }
  if (status === 401 || status === 403) {
    // Some providers (e.g. OpenCode Zen) return 401 for unsupported models, not auth failures
    if (
      lower.includes("not supported") ||
      lower.includes("unsupported model") ||
      lower.includes("model not found")
    ) {
      return "Model not supported by this provider. Verify model name.";
    }
    // A plan that has run out is not an auth failure, but some providers report
    // it as one — see shared/quota-exhaustion.ts for why this is shared with the
    // fallback gate rather than duplicated here.
    if (isQuotaExhaustionError(status, errorText)) {
      return "Out of quota — check your plan & billing details. This won't recover on retry.";
    }
    return "Check API key / OAuth credentials.";
  }
  if (status === 404) {
    return "Verify model name is correct.";
  }
  if (status === 400) {
    if (lower.includes("unsupported content type") || lower.includes("unsupported_content_type")) {
      return "Model doesn't support this content format. Try a different model.";
    }
    if (lower.includes("context") || lower.includes("too long") || lower.includes("token")) {
      return "Input too large. Reduce message history or use a larger-context model.";
    }
    return "Request format may be incompatible with provider.";
  }
  if (status >= 500) {
    return "Server error — retry after a brief wait.";
  }
  return `Unexpected HTTP ${status} from ${providerName}.`;
}
