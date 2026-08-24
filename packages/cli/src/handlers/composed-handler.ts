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
 *   4. adapter.buildPayload(...)                  — assemble full request body
 *   5. adapter.prepareRequest(payload, original)  — tool name truncation, etc.
 *   6. middleware.beforeRequest(...)               — pre-flight hooks
 *   7. fetch via provider (with optional queue)   — HTTP request
 *   8. stream parser by provider.streamFormat     — response → Claude SSE
 */

import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import type { BaseAPIFormat } from "../adapters/base-api-format.js";
// Alias for readability within this file
type BaseModelAdapter = BaseAPIFormat;
import { DialectManager } from "../adapters/dialect-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../middleware/index.js";
import { TokenTracker } from "./shared/token-tracker.js";
import { transformOpenAIToClaude } from "../transform.js";
import { filterIdentity } from "./shared/openai-compat.js";
import { stripReasoningContent } from "./shared/format/openai-messages.js";
import { createStreamingResponseHandler } from "./shared/stream-parsers/openai-sse.js";
import { createResponsesStreamHandler } from "./shared/stream-parsers/openai-responses-sse.js";
import { createAnthropicPassthroughStream } from "./shared/stream-parsers/anthropic-sse.js";
import { createOllamaJsonlStream } from "./shared/stream-parsers/ollama-jsonl.js";
import { createGeminiSseStream } from "./shared/stream-parsers/gemini-sse.js";
import { collectAnthropicSseToMessage } from "./shared/collect-sse-message.js";
import { appendUpstreamError } from "./shared/response-capture.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { log, logStderr, logStructured, getLogLevel, truncateContent } from "../logger.js";
import {
  describeImages,
  type OpenAIImageBlock,
  type VisionProxyAuthHeaders,
} from "../services/vision-proxy.js";
import { reportError, classifyError } from "../telemetry.js";
import { recordStats } from "../stats.js";
import { wrapAnthropicError, ensureAnthropicErrorFormat } from "./shared/anthropic-error.js";
import { peekStreamStart } from "./shared/stream-peek.js";

function extractAuthHeaders(c: Context): VisionProxyAuthHeaders {
  const headers = c.req.header();
  const auth: VisionProxyAuthHeaders = {};
  if (headers["x-api-key"]) auth["x-api-key"] = headers["x-api-key"];
  return auth;
}

/**
 * Substituted when stripping images leaves a message with zero content parts
 * (e.g. a PDF-read tool_result message whose only siblings were images).
 * Providers reject empty-content messages — Z.AI answers HTTP 400 code 1213
 * "The prompt parameter was not received normally", which the client then
 * retries into the same wall. The placeholder keeps the turn structure and
 * tells the model an image existed.
 */
export const STRIPPED_IMAGE_PLACEHOLDER =
  "[An image was present in the original request but was removed: this model does not support image input. Ask the user to use a vision-capable model for visual tasks.]";

/**
 * Remove all parts of the given types from every message's content array
 * (in place), collapsing single-text messages to plain strings and
 * substituting STRIPPED_IMAGE_PLACEHOLDER when nothing remains.
 */
export function stripImageBlocksFromMessages(
  messages: any[],
  partTypes: string[]
): void {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.filter((part: any) => !partTypes.includes(part.type));
      if (msg.content.length === 1 && msg.content[0].type === "text") {
        msg.content = msg.content[0].text;
      } else if (msg.content.length === 0) {
        msg.content = STRIPPED_IMAGE_PLACEHOLDER;
      }
    }
  }
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
  /** How this handler was invoked (for stats). */
  invocationMode?: "profile" | "explicit-model" | "auto-route" | "env-var" | "model-map";
  /**
   * Drop `reasoning_content` from converted assistant messages before the
   * payload is built. For strict-schema OpenAI backends that reject unknown
   * fields — see CustomEndpointSimpleSchema.omitReasoningContent.
   */
  omitReasoningContent?: boolean;
}

export class ComposedHandler implements ModelHandler {
  private provider: ProviderTransport;
  private adapterManager: DialectManager;
  private explicitAdapter?: BaseModelAdapter;
  /** Model-specific adapter (GLM, Grok, etc.) — handles model quirks independent of provider */
  private modelAdapter?: BaseModelAdapter;
  private middlewareManager: MiddlewareManager;
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
        `ComposedHandler: modelName must not contain '@' (got "${modelName}"). ` +
          `Strip the provider routing prefix before passing modelName. ` +
          `If you need the full routed form, pass it as targetModel.`
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
    this.adapterManager = new DialectManager(this.bareModelName);

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
      .catch((err) =>
        log(`[ComposedHandler:${this.bareModelName}] Middleware init error: ${err}`)
      );

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

  /**
   * Stream format priority (single definition — three call sites depend on it):
   *   1. Transport override (aggregators like LiteLLM/OpenRouter normalize server-side)
   *   2. Explicit format adapter (provider profile passes it, e.g. AnthropicAPIFormat
   *      for Z.AI, CodexAPIFormat for OpenAI Codex) — the layer that KNOWS the wire.
   *   3. Model dialect — only reached if no explicit adapter was passed. Dialects
   *      handle model quirks, NOT wire format; their inherited "openai-sse" must NOT
   *      override an explicit adapter. That was #102.
   *
   * Also handed to dialects via prepareRequest(ctx) so a model quirk whose encoding
   * differs per wire (Qwen's thinking switch) can pick the form that is actually read.
   */
  private resolveStreamFormat(): StreamFormat {
    return (
      this.provider.overrideStreamFormat?.() ??
      (this.explicitAdapter?.getStreamFormat() ?? this.modelAdapter?.getStreamFormat()) ??
      this.getAdapter().getStreamFormat()
    );
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
    // reasoningRoundtrip: models that REQUIRE their reasoning echoed back
    // (DeepSeek, preserveThinkingInHistory=true) get reasoning_content on every
    // assistant message — see openai-messages.ts. This mirrors the thinking-strip
    // gate just above: same capability, opposite direction.
    const reasoningRoundtrip = !!this.modelAdapter?.preserveThinkingInHistory?.();
    const messages = adapter.convertMessages(claudeRequest, filterIdentity, reasoningRoundtrip);
    // Strict-schema backends reject unknown fields. Must happen HERE, on the
    // converted messages — the thinking-block strip further down cannot reach
    // `reasoning_content`; see stripReasoningContent's docblock.
    if (this.options.omitReasoningContent) {
      const dropped = stripReasoningContent(messages);
      if (dropped > 0) {
        log(
          `[ComposedHandler] Dropped reasoning_content from ${dropped} message(s) for ${this.provider.displayName} (strict schema)`
        );
      }
    }
    const tools = adapter.convertTools(claudeRequest, this.options.summarizeTools);

    // Per-API tool count limits (e.g., OpenAI's 128-tool cap) are enforced
    // by the transport's transformPayload() hook, which runs later in the
    // pipeline with full knowledge of the target API.

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
          stripImageBlocksFromMessages(messages, ["image", "document"]);
        } else {
          // Vision proxy failed or not applicable — strip all unsupported image/document blocks
          log(`[ComposedHandler] Stripping image/document blocks (vision not supported)`);
          stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
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

    // 4. Build request payload
    let requestPayload = adapter.buildPayload(claudeRequest, messages, tools);

    // 4a. Fallback de-escalation system message (cost control).
    // When a low-capability local model is reached ONLY via provider fallback —
    // i.e. the primary model (GLM) failed on every upstream provider (zai, gc)
    // — instruct the fallback model to behave conservatively: keep the session
    // alive with simple, safe responses rather than attempting complex work the
    // primary model would have to redo. This preserves the agent without burning
    // metered tokens on ambitious-but-low-quality output.
    //
    // Gated on `fallbackMeta.attempts > 0` so DIRECT calls to the same model are
    // unaffected (explicit qwen usage keeps full capability). Generalize the
    // model match to a configurable set if more economy-fallback models are added.
    if (
      fallbackMeta &&
      fallbackMeta.attempts > 0 &&
      this.bareModelName === "qwen3.6-35b-a3b"
    ) {
      const FALLBACK_NOTICE =
        "You are operating in TEMPORARY FALLBACK mode because the primary model is temporarily unavailable (the proxy fell back to you after all upstream providers failed). Behave conservatively: avoid complex multi-step reasoning, risky operations, destructive commands, and large refactors. Prioritize keeping the session alive with a safe, simple response. Do NOT attempt ambitious work — the primary model will resume shortly and any complex work you start would need to be redone. If a task is too complex for conservative execution, say so briefly rather than attempting it.";
      const msgs = requestPayload.messages;
      if (Array.isArray(msgs) && msgs.length > 0 && msgs[0]?.role === "system") {
        const existing = msgs[0];
        const existingText =
          typeof existing.content === "string"
            ? existing.content
            : Array.isArray(existing.content)
              ? existing.content.map((c: any) => c.text || "").join("\n")
              : "";
        msgs[0] = { ...existing, content: FALLBACK_NOTICE + "\n\n" + existingText };
      } else if (Array.isArray(msgs)) {
        msgs.unshift({ role: "system", content: FALLBACK_NOTICE });
      }
      logStderr(
        `[Fallback] ${this.provider.displayName} reached as fallback (attempts=${fallbackMeta.attempts}) — injected conservative-mode system message`
      );
    }

    // 4b. Strip inline system messages from messages[] for Anthropic-transport providers.
    // Claude Code v2.1.153+ injects system messages inline (e.g. system-reminders).
    // Providers like Z.AI reject role:"system" in messages — only role:"user"/"assistant" accepted.
    // Merge them into the top-level system field instead.
    if (this.provider.streamFormat === "anthropic-sse" && requestPayload.messages) {
      const inlineSystemTexts: string[] = [];
      requestPayload.messages = requestPayload.messages.filter((msg: any) => {
        if (msg.role === "system") {
          const text = typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.map((c: any) => c.text || "").join("\n")
              : "";
          if (text) inlineSystemTexts.push(text);
          return false;
        }
        return true;
      });
      if (inlineSystemTexts.length > 0) {
        const merged = inlineSystemTexts.join("\n\n");
        if (requestPayload.system) {
          const existing = Array.isArray(requestPayload.system)
            ? requestPayload.system.map((s: any) => s.text || s).join("\n\n")
            : requestPayload.system;
          requestPayload.system = existing + "\n\n" + merged;
        } else {
          requestPayload.system = merged;
        }
        log(`[ComposedHandler] Merged ${inlineSystemTexts.length} inline system message(s) into system prompt for ${this.provider.displayName}`);
      }
    }

    // Strip thinking blocks from message history for non-native providers.
    // ComposedHandler is never used for native Anthropic (that's NativeHandler),
    // so every request here goes to a provider that doesn't understand Anthropic
    // thinking signatures. Without this strip, Opus thinking blocks (with signatures)
    // flow through to Z.AI/GLM/MiniMax/etc., which either ignore or corrupt them.
    //
    // Opt-out: models that REQUIRE their reasoning to be echoed back as
    // reasoning_content (DeepSeek) override preserveThinkingInHistory()=true.
    // For those, the thinking block must survive so the OpenAI-format converter
    // can re-emit reasoning_content on the outbound payload — stripping it makes
    // the converter omit the field, which DeepSeek rejects with HTTP 400.
    if (requestPayload.messages && !this.modelAdapter?.preserveThinkingInHistory?.()) {
      let stripped = 0;
      for (const msg of requestPayload.messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const before = msg.content.length;
          msg.content = msg.content.filter((block: any) => block.type !== "thinking");
          stripped += before - msg.content.length;
        }
      }
      if (stripped > 0) {
        log(`[ComposedHandler] Stripped ${stripped} thinking block(s) from message history for ${this.provider.displayName}`);
      }
    }

    const extraFields = this.provider.getExtraPayloadFields?.();
    if (extraFields) {
      Object.assign(requestPayload, extraFields);
    }

    // 5. Adapter post-processing (tool name truncation, reasoning params, etc.)
    // The wire format is passed through so a dialect whose parameter encoding
    // differs per wire picks the form the endpoint actually reads (Qwen's
    // thinking switch: `enable_thinking` on OpenAI-compat, native `thinking` on
    // Anthropic-compat — each endpoint silently ignores the other's).
    const prepareCtx = { wireFormat: this.resolveStreamFormat() };
    adapter.prepareRequest(requestPayload, claudeRequest, prepareCtx);
    // Model adapter may also need to post-process (e.g., strip unsupported thinking params)
    if (this.modelAdapter && this.modelAdapter !== adapter) {
      this.modelAdapter.prepareRequest(requestPayload, claudeRequest, prepareCtx);
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
        // Fetch quota so status line shows usage remaining (await but with timeout)
        if (typeof (this.provider as any).getQuotaRemaining === "function") {
          await Promise.race([
            this.fetchQuotaForStatusLine(),
            new Promise((r) => setTimeout(r, 2000)), // 2s timeout
          ]).catch(() => {});
        }
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
        // Return 401 (auth failure) so FallbackHandler treats this as retryable and
        // moves to the next provider in the chain. 503 (connection error) would stop
        // the fallback chain since it is not retryable by design.
        return c.json(
          { error: { type: "authentication_error", message: err.message } },
          401 as any
        );
      }
    }
    // Update context window if provider dynamically discovered it
    // (e.g., from OpenRouter model catalog or local model API)
    if (this.provider.getContextWindow) {
      this.tokenTracker.setContextWindow(this.provider.getContextWindow());
    }

    // 5c. Provider payload transformation (e.g., CodeAssist envelope wrapping)
    if (this.provider.transformPayload) {
      requestPayload = this.provider.transformPayload(requestPayload);
    }

    // 6. Middleware before request.
    // Use bareModelName — must match the key used by getActiveNames() and
    // afterStreamComplete() so the same set of middlewares is selected at both ends.
    await this.middlewareManager.beforeRequest({
      modelId: this.bareModelName,
      messages,
      tools,
      stream: true,
    });

    const endpoint = this.provider.getEndpoint(this.targetModel);
    const headers = await this.provider.getHeaders();
    headers["Content-Type"] = "application/json";

    log(`[${this.provider.displayName}] Calling API: ${endpoint}`);

    // Merge provider-specific fetch options (e.g., undici dispatcher, abort signal)
    const requestInit = this.provider.getRequestInit?.() || {};
    const doFetch = () =>
      fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        ...requestInit,
      });

    let response: Response;
    try {
      response = this.provider.enqueueRequest
        ? await this.provider.enqueueRequest(doFetch)
        : await doFetch();
    } catch (error: any) {
      // Connection refused — server is down or not reachable
      if (error.code === "ECONNREFUSED" || error.cause?.code === "ECONNREFUSED") {
        const msg = `Cannot connect to ${this.provider.displayName} at ${endpoint}. Make sure the server is running.`;
        log(`[${this.provider.displayName}] ${msg}`);
        logStderr(`Error: ${msg} Check the server is running.`);
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
        return c.json(wrapAnthropicError(503, msg, "connection_error"), 503 as any);
      }
      throw error;
    }

    // ── Patient overload backoff (2026-06-25) ──────────────────────────────
    // GLM/Z.AI concurrency contention arrives as a direct HTTP 429/503 whose
    // body says "overloaded" (NOT a quota wall — both Anthropic and GLM quotas
    // have headroom). The transport already ran a fast ~60s first-line retry; if
    // the error still persists, back off patiently (~5 min — fits the 600s
    // client timeout, far better than hammering a server that already warned us)
    // via doFetch (direct, bypassing transport 429-retry to avoid compounding)
    // before surfacing 529. The in-stream [1305] variant (HTTP 200 + SSE error)
    // is handled by the peek loop below. Worst case bounded: transport 60s +
    // patient loop ~5 min ≈ 6 min, well under the 10-min client timeout.
    if (!response.ok) {
      let probeText = "";
      try {
        probeText = await response.clone().text();
      } catch {
        // body read is best-effort
      }
      if (isTransientOverload(response.status, probeText)) {
        const recovered = await this.patientOverloadBackoff(doFetch);
        if (recovered) response = recovered;
        // null = exhausted → response stays the overload → !response.ok below → 529
      }
    }

    // Check if the transport fell back to a different model (e.g., capacity exhaustion)
    if (this.provider.getActiveModelName?.()) {
      const activeModel = this.provider.getActiveModelName()!;
      this.tokenTracker.setActiveModelName(activeModel);
      log(`[ComposedHandler] Transport fell back to model: ${activeModel}`);
    }

    log(`[${this.provider.displayName}] Response status: ${response.status}`);
    if (!response.ok) {
      // 401: retry with forced auth refresh (OAuth token expiry)
      if (response.status === 401 && this.provider.forceRefreshAuth) {
        log(`[${this.provider.displayName}] Got 401, forcing auth refresh and retrying`);
        try {
          await this.provider.forceRefreshAuth();
          const retryHeaders = await this.provider.getHeaders();
          retryHeaders["Content-Type"] = "application/json";
          const retryInit = this.provider.getRequestInit?.() || {};
          const retryResp = await fetch(endpoint, {
            method: "POST",
            headers: retryHeaders,
            body: JSON.stringify(requestPayload),
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
          return c.json(
            wrapAnthropicError(401, err.message, "authentication_error"),
            401 as any
          );
        }
      } else {
        const errorText = await response.text();
        // Durably capture the upstream error body: non-ok responses short-circuit
        // before the stream parser, so they never get a resp-*.sse — without this
        // the body lives only in stdout, which a container recreate wipes. This is
        // the exact wording isQuotaExhaustion needs to arm role failover.
        appendUpstreamError({
          model: this.targetModel,
          provider: this.provider.displayName,
          status: response.status,
          body: errorText,
        });
        log(`[${this.provider.displayName}] Error: ${errorText}`);
        const hint = getRecoveryHint(response.status, errorText, this.provider.displayName);
        logStderr(`Error [${this.provider.displayName}]: HTTP ${response.status}. ${hint}`);

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

        // Parse error body to avoid double-JSON-encoding (errorText is already JSON)
        let errorBody: any;
        try {
          errorBody = JSON.parse(errorText);
        } catch {
          errorBody = { error: { type: "api_error", message: errorText } };
        }

        // Transient overload (gc@/Z.AI concurrency limit delivered as a direct
        // HTTP 429/503, body says "overloaded"). By the time we reach here, the
        // patient backoff loop (patientOverloadBackoff, ~5 min via doFetch) has
        // already exhausted — so this is genuinely sustained contention. Surface
        // HTTP 529 overloaded_error so the client retries with its own backoff,
        // NOT 429 (which the client reads as a quota wall and stops the turn).
        // (2026-06-25 patient-backoff.)
        if (isTransientOverload(response.status, errorText)) {
          logStderr(
            `[Overload] [${this.provider.displayName}] HTTP ${response.status} transient overload → returning 529 overloaded_error (patient ~5min backoff exhausted)`,
            true // forceConsole — operational event
          );
          c.header("Retry-After", "5");
          return c.json(
            wrapAnthropicError(
              529,
              `${this.provider.displayName} temporarily overloaded (concurrency limit) — please retry shortly`,
              "overloaded_error"
            ),
            529 as any
          );
        }

        return c.json(ensureAnthropicErrorFormat(response.status, errorBody), response.status as any);
      }
    }

    // ── In-stream rate-limit handling (temporize, then fall back) ──────────
    // Some anthropic-sse providers (notably Z.AI) deliver their burst / RPM
    // limit as HTTP 200 + an in-stream SSE error ([1302]) with no message
    // envelope. That escapes `response.ok` above and FallbackHandler (both key
    // off HTTP status), so it used to reach the client as a bare error and
    // crash the turn. We peek the first bytes (the error arrives in 0-4ms, so a
    // short window catches it without delaying slow-but-healthy big-context
    // responses), temporize with a jittered backoff + retry the SAME provider
    // (the sustained quota has headroom — only the instantaneous burst limit is
    // hit). On persistence we return HTTP 529 (overloaded_error), NOT 429 — a
    // 429 is read by clients as a quota/usage-wall and stops the turn, whereas
    // 529 means "temporarily overloaded, not your usage limit" and the client
    // retries. 529 is also retryable so FallbackHandler advances in multi-
    // candidate mode. See the 2026-06-25 patient-backoff revision.
    //
    // The whole block is fail-open: peekStreamStart() only ever returns a
    // usable Response, and any classification other than "rate-limit" flows
    // straight through to handleStream() unchanged.
    {
      const peekFormat = this.resolveStreamFormat();
      if (peekFormat === "anthropic-sse") {
        // Patient overload backoff (2026-06-25): GLM/Z.AI concurrency limits
        // surface as HTTP 200 + in-stream [130x]. Clients (Claude Code) have
        // generous request timeouts (API_TIMEOUT_MS=600000) and would rather
        // wait several minutes for concurrency to settle than hit a hard error.
        // So we retry up to 6× with a ~5-minute spread (5s/10s/20s/40s/80s/150s
        // + jitter ≈ 305s) and only surface 529 if contention is genuinely
        // sustained. Retries use doFetch DIRECTLY (not enqueueRequest) so the
        // transport's own 429-retry doesn't compound into an unbounded wait.
        // Jitter (the cluster shares one key per provider) prevents synchronized
        // retries from re-colliding on the burst limit.
        const maxRlRetries = 6;
        let rlAttempt = 0;
        let peeked = await peekStreamStart(response);
        while (peeked.cls === "rate-limit" && rlAttempt < maxRlRetries) {
          const backoffMs =
            Math.min(5000 * 2 ** rlAttempt, 150000) + Math.floor(Math.random() * 1000);
          log(
            `[RateLimit] [${this.provider.displayName}] in-stream rate-limit (HTTP 200), temporizing — retry ${rlAttempt + 1}/${maxRlRetries} in ${(backoffMs / 1000).toFixed(1)}s${peeked.detail ? `: ${peeked.detail}` : ""}`,
            true // forceConsole — operational event, must be visible without --debug
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          rlAttempt++;
          let retryResp: Response;
          try {
            // doFetch direct (not enqueueRequest): the transport's 429-retry
            // would compound with this patient loop into an unbounded wait.
            retryResp = await doFetch();
          } catch (e: any) {
            log(
              `[RateLimit] [${this.provider.displayName}] rate-limit retry fetch failed: ${e?.message ?? e}`,
              true
            );
            break;
          }
          if (!retryResp.ok) {
            // A genuine HTTP error this time — surface it for fallback below.
            response = retryResp;
            peeked = { cls: "rate-limit", response: retryResp };
            break;
          }
          response = retryResp;
          peeked = await peekStreamStart(response);
        }
        if (peeked.cls === "rate-limit") {
          log(
            `[Overload] [${this.provider.displayName}] in-stream overload persisted after ${rlAttempt} retr${rlAttempt === 1 ? "y" : "ies"} → returning 529 overloaded_error (patient backoff exhausted)`,
            true // forceConsole — operational event, must be visible without --debug
          );
          try {
            const { error_class, error_code } = classifyError(
              new Error("in-stream overload"),
              529,
              peeked.detail
            );
            recordStats({
              model_id: this.targetModel,
              provider_name: this.provider.name,
              stream_format: this.provider.streamFormat,
              latency_ms: Math.round(performance.now() - startTime),
              success: false,
              http_status: 529,
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
          // 529 overloaded_error (NOT 429): a 429 is read by Claude Code as a
          // quota/usage-wall and stops the turn; 529 means "temporarily
          // overloaded, not your usage limit" and the client retries with its
          // own backoff. Retry-After nudges impatient clients to wait rather
          // than hammer a server that already warned us.
          c.header("Retry-After", "5");
          return c.json(
            wrapAnthropicError(
              529,
              `${this.provider.displayName} temporarily overloaded (concurrency limit); ${rlAttempt} retr${rlAttempt === 1 ? "y" : "ies"} exhausted — please retry shortly`,
              "overloaded_error"
            ),
            529 as any
          );
        }
        // healthy or other-error → use the peeked (tee'd, full) stream below.
        response = peeked.response;
      }
    }

    if (droppedParams.length > 0) {
      c.header("X-Dropped-Params", droppedParams.join(", "));
    }

    // 8. Parse streaming response based on provider's format
    // latency_ms = time-to-first-byte (response received before stream consumed)
    latencyMs = Math.round(performance.now() - startTime);
    const httpStatus = response.status;

    // 9. Record stats AFTER stream completes (tokens are populated by onTokenUpdate during streaming).
    // Pass an onComplete callback into handleStream; it fires at the end of the stream after
    // onTokenUpdate, so token counts are available.
    // fallbackMeta was captured at the top of handle() and is available via closure.
    const onStreamComplete = () => {
      try {
        const isFreeModel = this.tokenTracker.getTotalCost() === 0;
        recordStats({
          model_id: this.targetModel,
          provider_name: this.provider.name,
          stream_format: this.provider.streamFormat,
          latency_ms: latencyMs,
          success: true,
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
    };

    const streamResponse = this.handleStream(
      c,
      response,
      adapter,
      claudeRequest,
      toolNameMap,
      onStreamComplete,
      latencyMs
    );

    // Non-streaming clients (notably Claude Code's `/compact`, and any caller that
    // sent `stream: false`) expect a single JSON `message` body, NOT SSE. Every
    // adapter drives the upstream provider in streaming mode and the whole pipeline
    // emits Claude SSE, so we buffer that translated SSE back into one Anthropic
    // message here. Mirrors request-logger.ts's `stream` definition exactly
    // (`body.stream === true` ⇒ streaming; anything else ⇒ sync). NativeHandler
    // already honors this for Anthropic-direct; this closes the same gap for every
    // proxied/composed model. See collect-sse-message.ts.
    const wantsStreaming = payload?.stream === true;
    if (wantsStreaming) {
      return streamResponse;
    }

    const message = await collectAnthropicSseToMessage(streamResponse, this.bareModelName);

    return c.json(message, {
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    });
  }

  private handleStream(
    c: Context,
    response: Response,
    adapter: BaseModelAdapter,
    claudeRequest: any,
    toolNameMap?: Map<string, string>,
    onComplete?: () => void,
    headerLatencyMs?: number // dispatch → upstream headers (for the [ttft] marker)
  ): Response {
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
        // "actual-cost" is handled separately via updateWithActualCost
        case "standard":
        default:
          this.tokenTracker.update(input, output);
          break;
      }
      // Fire onComplete after token update so recordStats() sees the final token counts.
      if (onComplete) {
        try {
          onComplete();
        } catch {
          // Stats must never crash claudish
        }
        // Prevent double-firing if onTokenUpdate is called more than once
        onComplete = undefined;
      }
    };

    // See resolveStreamFormat() for the priority rules and the #102 history.
    const streamFormat = this.resolveStreamFormat();
    // Stream parsers receive bareModelName: it is used both as the middleware-identity
    // key (must match beforeRequest() / getActiveNames()) AND as the value echoed in
    // `message_start.message.model` for display. Passing the routed form here was the
    // latent second part of #102 — the parameter was named `modelName` but received
    // the full routed string.
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
          headerLatencyMs
        );

      case "openai-responses-sse":
        return createResponsesStreamHandler(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          toolNameMap: adapter.getToolNameMap(),
          headerLatencyMs,
        });

      case "anthropic-sse":
        return createAnthropicPassthroughStream(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          adapter: adapter as BaseAPIFormat,
          headerLatencyMs,
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
          unwrapResponse: this.options.unwrapGeminiResponse,
        });
      }

      case "ollama-jsonl":
        return createOllamaJsonlStream(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
        });

      default:
        throw new Error(`Unknown stream format: ${streamFormat}`);
    }
  }

  /** Expose token tracker for advanced use cases */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  /** Fetch quota and update token tracker (non-blocking, best-effort) */
  private async fetchQuotaForStatusLine(): Promise<void> {
    try {
      const fn = (this.provider as any).getQuotaRemaining;
      if (typeof fn !== "function") return;
      // bareModelName is already the provider-stripped form (invariant enforced
      // in constructor), so pass it directly instead of re-parsing targetModel.
      const remaining = await fn.call(this.provider, this.bareModelName);
      if (typeof remaining === "number") {
        this.tokenTracker.setQuotaRemaining(remaining);
        this.tokenTracker.rewrite();
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Called by FallbackHandler before handle() when this handler is the winning provider
   * after one or more failed attempts. Stores fallback metadata for inclusion in stats.
   */
  setFallbackMeta(chain: string[], attempts: number): void {
    this.pendingFallbackMeta = { chain, attempts };
  }

  /**
   * Patient backoff for transient provider overload (HTTP 429/503 whose body
   * indicates concurrency/overload — NOT a quota wall). Retries the SAME provider
   * via `doFetch` directly (bypassing the transport's own 429-retry so the two
   * don't compound) with a ~5-minute exponential spread (5s/10s/20s/40s/80s/150s
   * + jitter ≈ 305s), which fits comfortably in the 600s client request timeout.
   *
   * Returns:
   *   - a recovered (ok) Response → caller streams it normally.
   *   - a non-transient !ok Response (the error morphed, e.g. into a 500) →
   *     caller surfaces the real error via the normal !response.ok path.
   *   - null → contention genuinely sustained after ~5 min → caller surfaces 529.
   *
   * (2026-06-25 patient-backoff revision.)
   */
  private async patientOverloadBackoff(
    doFetch: () => Promise<Response>
  ): Promise<Response | null> {
    const maxRetries = 6;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const backoffMs =
        Math.min(5000 * 2 ** attempt, 150000) + Math.floor(Math.random() * 1000);
      log(
        `[Overload] [${this.provider.displayName}] transient overload (HTTP) — patient retry ${attempt + 1}/${maxRetries} in ${(backoffMs / 1000).toFixed(1)}s`,
        true // forceConsole — operational event, must be visible without --debug
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      try {
        const retryResp = await doFetch();
        if (retryResp.ok) return retryResp; // recovered
        const retryText = await retryResp.clone().text();
        if (!isTransientOverload(retryResp.status, retryText)) {
          // Morphed into a non-transient error (e.g. 500) — stop retrying and
          // let the caller surface the real error rather than masking it as 529.
          return retryResp;
        }
        // still transient overload → keep backing off
      } catch (e: any) {
        log(
          `[Overload] [${this.provider.displayName}] patient retry fetch failed: ${e?.message ?? e}`,
          true
        );
        // transient network blip — keep retrying
      }
    }
    return null; // exhausted — contention genuinely sustained
  }

  async shutdown(): Promise<void> {
    if (this.provider.shutdown) {
      await this.provider.shutdown();
    }
  }
}

/**
 * Detect whether an HTTP error represents a TRANSIENT provider overload
 * (concurrency/burst limit, server-side) rather than a quota/usage wall.
 *
 * Used to surface the error as HTTP 529 (overloaded_error) instead of 429
 * (rate_limit_error): clients read 429 as "quota reached" and stop the turn,
 * whereas 529 means "temporarily overloaded, not your usage limit" and the
 * client retries with its own backoff. GLM Coding (gc@) frequently delivers
 * concurrency limits as a direct HTTP 429 whose body contains "overloaded" —
 * this is NOT a quota wall, and in no-fallback mode there is no other provider
 * to switch to, so the only useful outcome is a patient client retry. See the
 * 2026-06-25 patient-backoff revision.
 */
/**
 * Test-only export: `cluster-critical.test.ts` (Invariant 4) asserts this logic
 * directly. Keeping the function private otherwise — the production call sites
 * all live in this file.
 */
export function isTransientOverload(status: number, errorText: string): boolean {
  const lower = errorText.toLowerCase();
  if (status === 503) return true;
  if (status === 429) {
    return (
      lower.includes("overloaded") ||
      lower.includes("concurrency") ||
      lower.includes("concurrent") ||
      lower.includes("temporarily") ||
      lower.includes("service may be") ||
      lower.includes("try again later")
    );
  }
  return false;
}

/**
 * Return a human-readable recovery hint based on HTTP status and error body.
 */
function getRecoveryHint(status: number, errorText: string, providerName: string): string {
  const lower = errorText.toLowerCase();

  if (status === 503 || lower.includes("overloaded")) {
    return "Provider overloaded. Retry or use a different model.";
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
