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
import { TokenTracker, type UsageCacheDetail } from "./shared/token-tracker.js";
import { clientRequestedThinking } from "./shared/client-thinking.js";
import { clientAttributionEnabled, clientAttributionHeaders } from "./shared/client-attribution.js";
import { transformOpenAIToClaude } from "../transform.js";
import { filterIdentity } from "./shared/openai-compat.js";
import { stripReasoningContent } from "./shared/format/openai-messages.js";
import { resolveInlineSystemMessages } from "./shared/format/inline-system.js";
import { createStreamingResponseHandler } from "./shared/stream-parsers/openai-sse.js";
import { createResponsesStreamHandler } from "./shared/stream-parsers/openai-responses-sse.js";
import { createAnthropicPassthroughStream } from "./shared/stream-parsers/anthropic-sse.js";
import { createOllamaJsonlStream } from "./shared/stream-parsers/ollama-jsonl.js";
import { createGeminiSseStream } from "./shared/stream-parsers/gemini-sse.js";
import { requestNumberFor } from "../fork/middleware/request-logger.js";
import { wallMarkerLine } from "./shared/traffic-markers.js";
import { withFirstUsefulEventWatchdog, boundRetryUpstream } from "./shared/first-event-watchdog.js";
import {
  preStreamPolicyRefusal,
  preStreamPolicyRetry,
  policyRefusalNotice,
  logPolicyRefusal,
} from "./shared/stream-parsers/policy-refusal.js";
import { collectAnthropicSseToMessage } from "./shared/collect-sse-message.js";
import { appendUpstreamError } from "./shared/response-capture.js";
import {
  classifyContextOverflow,
  estimatePayloadTokens,
  estimateClampTokens,
  CONTEXT_LIMIT_SAFETY_MARGIN_TOKENS,
  contextLimitMarginTokens,
  rememberOverflowCap,
  getOverflowCap,
  getStatedContextLimit,
  overflowReportFloor,
  overflowReportedTokens,
  overflowRecoveryText,
  buildOverflowRecoveryStream,
  buildOverflowRecoveryMessage,
  countMediaBlocks,
} from "./shared/context-overflow.js";
import { classifyMediaCap, mediaCapRefusalText, mediaCapSkipDetail } from "./shared/media-cap.js";
import {
  exactCountDisabled,
  inExactCountBand,
  readExactCountBand,
} from "./shared/exact-count.js";
import type { ExactPromptCount } from "../providers/transport/types.js";
import {
  STEP_SKIP_HEADER,
  encodeStepSkipHeader,
  cascadeStepBusyWaitMs,
  classifyConcurrencyRefusal,
  CONCURRENCY_REFUSAL_SKIP_DETAIL,
  isStepSkipEligible,
} from "./shared/step-skip.js";
import { StepBusyError } from "./shared/concurrency-limiter.js";
import { extractSessionKey, isQuotaExhaustion } from "../fork/failover.js";
import { recordSessionBudgetOutput } from "../fork/session-budget.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { log, logStderr, logStructured, getLogLevel, truncateContent } from "../logger.js";
import {
  describeImages,
  type OpenAIImageBlock,
  type VisionProxyAuthHeaders,
} from "../services/vision-proxy.js";
import { reportError, classifyError } from "../telemetry.js";
import { recordStats } from "../stats.js";
import {
  wrapAnthropicError,
  ensureAnthropicErrorFormat,
  extractProviderMessage,
} from "./shared/anthropic-error.js";
import {
  buildConnectionErrorMessage,
  classifyConnectionError,
  connectRetryDelaysMs,
  connectRetryMax,
} from "./shared/connection-error.js";
import { peekStreamStart } from "./shared/stream-peek.js";
import { matchesProxyKey } from "./shared/proxy-keys.js";
import { stripProxyOwnHeaders } from "./native-handler.js";
import { stripForeignVisionApiKey } from "./shared/native-credential-guard.js";

/**
 * #289 — credential policy for the vision fallback, injected once by
 * proxy-server at boot (same pattern as setRoleNominalResolver): the
 * ComposedHandler constructor has ~20 call sites and none of them knows
 * about proxy keys. Unset (tests, library use), NO key can match, so an
 * inbound proxy-shaped key is forwarded verbatim — the boot wiring in
 * proxy-server is what arms the sanitizer in production (pinned by a
 * createProxyServer test; review 03/10, mutation W).
 */
interface VisionAuthPolicy {
  proxyKeys?: string[];
  anthropicApiKey?: string;
}
let visionAuthPolicy: VisionAuthPolicy = {};
export function setVisionAuthPolicy(policy: VisionAuthPolicy): void {
  visionAuthPolicy = policy;
}

/**
 * #289 — the proxy's own key never leaves for api.anthropic.com, whichever
 * path carries the credential. The vision fallback used to forward the
 * inbound `x-api-key` verbatim to the image-description call; a client that
 * authenticates to the proxy with its key in that header would hand it to
 * Anthropic on every described image. Same family as #282/#285 (stripped on
 * the two native sites) and the same swap rule as NativeHandler: a matching
 * key (primary or previous) is replaced by the stored Anthropic key when one
 * is configured — `authorization: Bearer` for an sk-ant-oat, `x-api-key`
 * otherwise — and dropped entirely when none is. A genuine client Anthropic
 * key (no match) passes through unchanged: that is this path's purpose.
 *
 * #315 — a NON-matching key is still the only client-controlled credential
 * here, and it may leave for api.anthropic.com only when it is
 * Anthropic-shaped. A foreign key is dropped (`stripForeignVisionApiKey`,
 * the native lane's predicate — not a second copy) and the call degrades
 * like a missing credential: the images are stripped, the turn continues.
 */
export function sanitizeVisionAuthHeaders(auth: VisionProxyAuthHeaders): void {
  // Defense in depth (#285 helper): this path forwards auth headers only,
  // but if it ever copies more, the strip runs here so the lists cannot drift.
  stripProxyOwnHeaders(auth as Record<string, string>);
  if (
    visionAuthPolicy.proxyKeys?.length &&
    matchesProxyKey(auth["x-api-key"], visionAuthPolicy.proxyKeys)
  ) {
    delete auth["x-api-key"];
    const stored = visionAuthPolicy.anthropicApiKey;
    if (stored) {
      if (stored.startsWith("sk-ant-oat")) auth["authorization"] = `Bearer ${stored}`;
      else auth["x-api-key"] = stored;
    }
    return; // swapped or dropped — the operator's own choice, nothing left to check
  }
  if (stripForeignVisionApiKey(auth)) {
    log("[VisionProxy] dropped non-Anthropic client x-api-key (#315) — describing without a credential", true);
  }
}

export function extractAuthHeaders(c: Context): VisionProxyAuthHeaders {
  const headers = c.req.header();
  const auth: VisionProxyAuthHeaders = {};
  if (headers["x-api-key"]) auth["x-api-key"] = headers["x-api-key"];
  sanitizeVisionAuthHeaders(auth);
  return auth;
}

/**
 * Substituted when stripping images leaves a message with zero content parts
 * (e.g. a PDF-read tool_result message whose only siblings were images).
 * Providers reject empty-content messages — Z.AI answers HTTP 400 code 1213
 * "The prompt parameter was not received normally", which the client then
 * retries into the same wall. The placeholder keeps the turn structure and
 * tells the model an image existed.
 *
 * Both texts name the PROXY's decision, not a property of the model: the
 * verdict comes from the catalog's `supportsVision` flag, which #222 measured
 * wrong for a vision model (glm-4.6v stripped on the hub). "This model does not
 * support image input" would state that verdict as a fact about the model —
 * exactly the claim #222 refutes. No instruction either (doctrine 2026-08-23).
 */
export const STRIPPED_IMAGE_PLACEHOLDER =
  "[An image was present in the original request but was removed by the proxy: this model is not flagged as accepting image input.]";

/**
 * Bounded same-provider retry for a transient "closed" connect failure
 * (#251). Returns the recovered Response, or null when the ladder is
 * exhausted or the error changed shape — the caller then falls back to the
 * original 400 connection_error contract.
 */
async function retryClosedConnect(
  providerDisplayName: string,
  bareModelName: string,
  refetch: () => Promise<Response>,
  firstError: unknown
): Promise<Response | null> {
  const maxRetries = connectRetryMax();
  const delays = connectRetryDelaysMs();
  let lastError = firstError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 1200;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const code = classifyConnectionError(lastError)?.code ?? "?";
    logStderr(
      `[ConnectRetry] ${providerDisplayName} ${bareModelName} closed before response (code=${code}) — retry ${attempt}/${maxRetries}`
    );
    try {
      return await refetch();
    } catch (error: any) {
      lastError = error;
      if (classifyConnectionError(error)?.kind !== "closed") return null;
    }
  }
  return null;
}

/**
 * Factual removal notice appended when stripped parts had surviving siblings.
 * States the fact (count, actor, reason) — never instructions (doctrine 2026-08-23).
 */
export function strippedMediaNotice(count: number): string {
  const subject =
    count === 1 ? "1 image/document part was" : `${count} image/document parts were`;
  return `[${subject} present in this message but removed by the proxy: this model is not flagged as accepting image input.]`;
}

/**
 * Remove all parts of the given types from every message's content array
 * (in place), collapsing single-text messages to plain strings and
 * substituting STRIPPED_IMAGE_PLACEHOLDER when nothing remains.
 *
 * A message that keeps other content after the strip gets a
 * strippedMediaNotice() text part appended — removal must be announced, not
 * silent (#222: [text, image] collapsed to bare text and vision agents
 * answered blind with zero signal).
 */
export function stripImageBlocksFromMessages(
  messages: any[],
  partTypes: string[]
): void {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      const kept: any[] = [];
      let strippedCount = 0;
      for (const part of msg.content) {
        if (partTypes.includes(part.type)) {
          strippedCount++;
        } else {
          kept.push(part);
        }
      }
      if (strippedCount > 0 && kept.length > 0) {
        kept.push({ type: "text", text: strippedMediaNotice(strippedCount) });
      }
      msg.content = kept;
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
  /**
   * #431 AC2 — per-endpoint output cap. Clamps `max_tokens` DOWN (never up)
   * on the Claude-level request before any format conversion, so every wire
   * (openai `max_tokens`/`max_completion_tokens`, anthropic `max_tokens`)
   * inherits it from one seam. This cap bounds what the CLIENT may ask for; it
   * does not gate admission (see `contextLimit` below, #674).
   *
   * Premise correction (measured 2026-10-25, current Swift build): vLLM v0.31
   * REFUSED a prompt+max_tokens sum over `--max-model-len`, which is what this
   * cap was built for. The shipping engine does not: it admits on the PROMPT
   * alone and TRIMS the generation to the remaining window — `reqN=11724`,
   * prompt 262 126 against a 262 144 window, served with `output_tokens: 18`
   * and `stop=max_tokens`; `reqN=931`, prompt 262 145, `400 Input too large`.
   * Keep the cap for the client-visible budget it guarantees; do not read it as
   * a rescue for an over-window prompt, and re-measure before restoring the old
   * wording if the engine is ever pinned back to a build that refuses.
   *
   * The learned-cap short-circuit this endpoint has carried since #651 is itself
   * gated (#676): when a window is KNOWN — `stated ?? derived ?? declared`, i.e.
   * a limit the engine stated in its own refusal, else the `/v1/models`
   * derivation, else a hand-typed literal — the estimate must corroborate
   * against it before the short-circuit fires. With no window known, the learned
   * cap stays the only evidence and behaviour is unchanged. So a cap learned
   * from one refusal can no longer throw away, on its own, a prompt inside the
   * [cap, window) band that #674 is about.
   */
  maxOutputTokens?: number;
  /**
   * #441 — per-endpoint TOTAL window (prompt + output counted together, as
   * vLLM's `--max-model-len` does). When set, `max_tokens` is clamped to
   * `contextLimit − clampEstimate(request) − max(2048, est/64)` per request —
   * the dynamic complement of the #431 static cap, so a compaction turn at
   * the RX95 window (~250k prompt) fits a 262 144 Swift window instead of
   * hitting vLLM's refusal-without-trim (vllm#110). The clamp estimate
   * replaces each image/document base64 block with a fixed 1600-token
   * allocation (`estimateClampTokens`) — a 1 MB screenshot scores ~1.6k
   * tokens, not ~750k (#442 review). If the remainder falls below a useful
   * floor of `min(max_tokens asked, 4096)`, the clamp stands down (max_tokens
   * unchanged): no useful output budget remains, and the upstream refusal +
   * context-overflow recovery path (#431 K1–K5, SKIP stays reachable) own
   * that case. Composes with `maxOutputTokens` — the smaller cap wins. Unset
   * = verbatim passthrough.
   *
   * #674 — scope, measured 2026-10-25: this clamp bounds the OUTPUT, and on the
   * shipping engine it cannot rescue an over-window prompt (admission is
   * decided by the prompt alone; `maxOutputTokens` above). What it still buys is
   * a client-visible `max_tokens` the engine does not have to trim behind us.
   */
  contextLimit?: number;
  /**
   * #651 — the window MEASURED from the engine's own `/v1/models`
   * (`max_model_len` on vLLM, read at startup when the endpoint opts in with
   * `deriveContextLimit: true`).
   *
   * Kept apart from `contextLimit` above, and narrower in effect on purpose:
   * only a MEASURED window pre-seeds the learned cap — i.e. may refuse a
   * request locally on its own authority. A hand-typed literal keeps today's
   * path (clamp, then the upstream's own word), because a stale claim that is
   * too SMALL would refuse requests the engine serves: the same class of
   * failure the admission census avoids, in the opposite direction.
   */
  derivedContextLimit?: number;
  /**
   * #667 — map the client's thinking level (`output_config.effort`, sent by
   * Claude Code next to `thinking:{type:"adaptive"}`) onto this endpoint's
   * OWN depth knob, so the level a user picks actually reaches the model.
   * Today the field is only read by the MiniMax dialect (to overwrite it
   * under an operator policy) — every OpenAI-wire route drops it, and the
   * local vLLM engine serving the haiku role applies its own `medium`
   * default instead (top-level `chat_template_kwargs.reasoning_effort`,
   * levels low|medium|xhigh).
   *
   * Fixed monotonic ladder, 5 client levels → the target's 3:
   *
   *   low → low · medium → medium · high → xhigh · xhigh → xhigh · max → xhigh
   *
   * `high` lands on xhigh, not medium, on purpose: medium is what the engine
   * applies when NOT asked, so mapping the client's explicit high onto it
   * would make the most common client level a no-op — and the target ladder
   * has no "high", so the next step up is the only faithful direction. `max`
   * clamps to the top. Monotone: a higher client level never maps lower.
   *
   * Opt-in per endpoint (config-schema `effortTarget`); applied on the OpenAI
   * wire only, top-level (never under `extra_body`), existing
   * `chat_template_kwargs` keys preserved. Absent client effort → no
   * `reasoning_effort` on the wire (the engine's own default keeps applying);
   * an unrecognized value is dropped with a log line, never thrown (#667 AC5).
   */
  effortTarget?: "chat_template_kwargs.reasoning_effort";
}

/**
 * #667 — the fixed, monotonic effort ladder shared by every endpoint that
 * arms `effortTarget` (see ComposedHandlerOptions.effortTarget for the
 * rationale and docs/reference/proxy-pipeline-notes.md for the table).
 */
const EFFORT_TARGET_LADDER: Record<string, "low" | "medium" | "xhigh"> = {
  low: "low",
  medium: "medium",
  high: "xhigh",
  xhigh: "xhigh",
  max: "xhigh",
};

export class ComposedHandler implements ModelHandler {
  private provider: ProviderTransport;
  private adapterManager: DialectManager;
  private explicitAdapter?: BaseModelAdapter;
  /** Model-specific adapter (GLM, Grok, etc.) — handles model quirks independent of provider */
  private modelAdapter?: BaseModelAdapter;
  private middlewareManager: MiddlewareManager;
  private tokenTracker: TokenTracker;
  /**
   * #518 — last full-context size PER SESSION KEY, feeding the message_start
   * seed. The tracker above is per-handler and handlers are cached per model,
   * so on a multi-session hub its "last input" belongs to whichever session
   * happened to finish last — seeding from it announced a 233-token turn at
   * 166322 (another tenant's context, measured 18/10). Bounded: see
   * rememberSessionInput.
   *
   * Known edge: sub-agents share their parent's session_id (#317 measurement),
   * so one served by the SAME model inherits the parent's count on its first
   * turn — same-session by the key's definition, not a foreign tenant; the
   * terminal delta overwrites it in the nominal case.
   */
  private readonly sessionInputSeeds = new Map<string, number>();
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

  /**
   * #686 — merge client-attribution headers into an outbound set. No-op unless
   * the endpoint opted in (`clientAttribution: true`) and the global kill
   * switch is off. Mutates `headers` in place; called at EVERY site that
   * builds headers from `getHeaders()` so a retry carries attribution too.
   */
  private applyClientAttribution(c: Context, headers: Record<string, string>): void {
    if (!this.provider.clientAttribution || !clientAttributionEnabled()) return;
    Object.assign(headers, clientAttributionHeaders(c));
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
    let tools = adapter.convertTools(claudeRequest, this.options.summarizeTools);

    // Per-API tool-count cap (e.g. OpenAI Chat Completions hard-caps `tools` at
    // 128 — exceeding it fails the WHOLE request with HTTP 400 "array too long").
    // Head-slice to the limit: Claude Code emits its built-in agentic tools
    // first and appends MCP-server tools after, so keeping the first N preserves
    // the load-bearing built-ins and drops the tail-most MCP tools. Truncating
    // is recoverable; failing the whole request is not.
    const maxToolCount = adapter.getMaxToolCount(this.resolveStreamFormat());
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
    // #431 AC2 / #441 — clamp BEFORE the conversion: every wire derives its
    // output field from `claudeRequest.max_tokens` (openai-api-format.ts
    // L101/103, anthropic passthrough), so one Claude-level seam covers all
    // formats. `claudeRequest` is this handler's transform copy — the route's
    // `body` and the client's retry semantics are untouched.
    //
    // Two caps, smallest wins: the #431 static `maxOutputTokens`, and the #441
    // dynamic remainder `contextLimit − promptEstimate − margin` (vLLM counts
    // prompt + output against --max-model-len and REFUSES rather than trims).
    let outputCap: number | undefined;
    let capSource = "";
    if (this.options.maxOutputTokens !== undefined && this.options.maxOutputTokens > 0) {
      outputCap = this.options.maxOutputTokens;
      capSource = "endpoint maxOutputTokens cap, #431";
    }
    if (this.options.contextLimit !== undefined && this.options.contextLimit > 0) {
      const est = estimateClampTokens(claudeRequest);
      // Proportional margin (pre-review #442, ai-01 2026-10-11): the /4
      // estimate drifts toward /3.5 on code-dense prompts — a fixed margin
      // covers none of that at 250k.
      const margin = contextLimitMarginTokens(est);
      const dynamicCap = this.options.contextLimit - est - margin;
      // Useful-floor guard (#442 review c.6114982206): below min(asked, 4096)
      // the clamp would turn a recoverable upstream refusal into a truncated
      // 200 — the exact shape #431 closed (SKIP reason=context must stay
      // reachable on a non-last step; on /compact a truncated "summary").
      const asked =
        typeof claudeRequest.max_tokens === "number" ? claudeRequest.max_tokens : 4096;
      const floor = Math.min(asked, 4096);
      if (dynamicCap >= floor && (outputCap === undefined || dynamicCap < outputCap)) {
        outputCap = dynamicCap;
        capSource = `contextLimit ${this.options.contextLimit} − est ${est} − ${margin}, #441`;
      }
      // dynamicCap < floor: no useful output budget remains in the window —
      // stand down and let the request leave unclamped; the upstream refusal
      // + context-overflow recovery (#431 K1–K5) own the turn.
    }
    if (
      outputCap !== undefined &&
      typeof claudeRequest.max_tokens === "number" &&
      claudeRequest.max_tokens > outputCap
    ) {
      log(
        `[${this.provider.displayName}] max_tokens ${claudeRequest.max_tokens} → ${outputCap} (${capSource})`
      );
      claudeRequest.max_tokens = outputCap;
      // CR minor: a thinking budget ABOVE the clamped max is invalid on the
      // Anthropic wire (budget_tokens must stay < max_tokens — CC sends
      // 31999 against 32000), and a pass-through converter copies both fields
      // verbatim. Pull the budget down to cap-1 so the clamp does not
      // manufacture a 400 the endpoint would otherwise never see.
      const budget = claudeRequest.thinking?.budget_tokens;
      if (typeof budget === "number" && budget >= outputCap) {
        claudeRequest.thinking!.budget_tokens = outputCap - 1;
      }
    }
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

    // 4b. Inline system messages in messages[], for Anthropic-transport providers.
    // Mid-turn user steers must keep their position — see resolveInlineSystemMessages.
    if (this.provider.streamFormat === "anthropic-sse" && requestPayload.messages) {
      const resolved = resolveInlineSystemMessages(requestPayload.messages, requestPayload.system);
      requestPayload.messages = resolved.messages;
      requestPayload.system = resolved.system;
      if (resolved.inlined > 0) {
        log(
          `[ComposedHandler] Kept ${resolved.inlined} inline system message(s) in place as role:"user" for ${this.provider.displayName} (mid-turn user steers must not be hoisted)`
        );
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
    //
    // Per-block opt-out (#324 B1): under a `forced` thinking policy, MiniMax
    // must keep its OWN history thinking blocks (M3 only restarts thinking on
    // a continuation turn when the preceding assistant turn carries one —
    // #295 T4a/T4c) while FOREIGN blocks (an Anthropic signature carried in by
    // a session that switched from Opus to a MiniMax cascade step) stay
    // stripped. The dialect discriminates by signature shape; default false
    // keeps strip-everything for every other provider.
    if (requestPayload.messages && !this.modelAdapter?.preserveThinkingInHistory?.()) {
      let stripped = 0;
      let preserved = 0;
      for (const msg of requestPayload.messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const before = msg.content.length;
          msg.content = msg.content.filter((block: any) => {
            if (block.type !== "thinking") return true;
            if (this.modelAdapter?.preserveThinkingBlock?.(block) === true) {
              preserved++;
              return true;
            }
            return false;
          });
          stripped += before - msg.content.length;
        }
      }
      if (stripped > 0) {
        log(`[ComposedHandler] Stripped ${stripped} thinking block(s) from message history for ${this.provider.displayName}`);
      }
      if (preserved > 0) {
        log(`[ComposedHandler] Preserved ${preserved} own thinking block(s) in history for ${this.provider.displayName} (dialect exempted them from the strip)`);
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

    // 5a. #667 — carry the client's thinking level to the endpoint's own depth
    // knob. Last writer before the wire on purpose: no adapter downstream can
    // clobber what the operator armed here. Reads the ORIGINAL request (the
    // client's `output_config.effort`), writes the outbound body's TOP-LEVEL
    // `chat_template_kwargs.reasoning_effort` — vLLM's per-request depth knob
    // (engine default: medium when the field is absent).
    if (this.options.effortTarget === "chat_template_kwargs.reasoning_effort") {
      if (this.resolveStreamFormat() !== "openai-sse") {
        logStderr(
          `[Effort] effortTarget configured but wire format is ${this.resolveStreamFormat()} — mapping not applied (OpenAI wire only, #667)`
        );
      } else {
        const clientEffort = (claudeRequest as any)?.output_config?.effort;
        if (typeof clientEffort === "string") {
          const mapped = EFFORT_TARGET_LADDER[clientEffort.toLowerCase()];
          if (mapped) {
            const prior = (requestPayload as any).chat_template_kwargs ?? {};
            (requestPayload as any).chat_template_kwargs = { ...prior, reasoning_effort: mapped };
            log(
              `[Effort] ${clientEffort} -> chat_template_kwargs.reasoning_effort=${mapped} (${this.provider.displayName})`
            );
          } else {
            // AC5 — never-hang: an unknown value is dropped with a debug log,
            // the request is still served (engine default applies).
            log(
              `[Effort] unrecognized client effort '${clientEffort}' dropped for ${this.provider.displayName} — serving unmapped`
            );
          }
        }
        // AC4 — absent effort: nothing written; the engine's own default
        // (medium) keeps applying.
      }
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
          wrapAnthropicError(401, err.message, "authentication_error"),
          401 as any
        );
      }
    }
    // Update context window if provider dynamically discovered it
    // (e.g., from OpenRouter model catalog or local model API).
    //
    // Only a POSITIVE number is applied. A transport returns 0 to mean "I have
    // no opinion" — our OpenRouterProviderTransport says so in as many words
    // (openrouter.ts:62 returns a literal 0). Applying that 0 unconditionally
    // overwrote the window the model dialect had already resolved, so every
    // OpenRouter-routed model wrote `"context_window": "unknown"` and lost its
    // context field in the status line. 0 must be a no-op, not a reset.
    if (this.provider.getContextWindow) {
      const providerWindow = this.provider.getContextWindow();
      if (providerWindow > 0) {
        this.tokenTracker.setContextWindow(providerWindow);
      }
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

    // 6b. Context-overflow pre-flight (2026-09-10/11 incident): once a provider
    // has rejected a prompt for size, the learned cap lets later oversized
    // requests short-circuit here — no upstream round-trip, immediate
    // recoverable turn. The first rejection per (provider, model) per process
    // lifetime is unavoidable: the cap is learned, not configured, because the
    // provider-side maximum prompt size is variable and undocumented.
    //
    // #674 corroboration: `est >= cap` alone is NOT evidence the engine will
    // refuse. Measured 25/10 on this lane's own log: 35 short-circuits in 24 h
    // at caps 225-241k, while the same day's SERVED corpus holds 21 bodies with
    // est >= 230k whose real count was 209k-262k — every one under the window,
    // so the [cap, window) band mixes doomed and served prompts. The /4
    // estimate spans 0.99-1.13x of the real count at p01-p95 (outlier 0.57x),
    // and the cost is asymmetric: a false fire forces a compaction turn a
    // served prompt never needed, while a missed fire costs one ~1 s round-trip
    // whose 400 returns the SAME recoverable turn. So when a window is KNOWN,
    // the estimate must corroborate before the short-circuit fires. Two units,
    // never mixed (same rule as the derived branch below): the trigger stays in
    // payload units (est >= cap), the window is judged in the media-aware clamp
    // units every other window comparison uses — a 1.4 MB screenshot scores
    // 350k there and 1.6k here, and the refusal must not flip on that
    // difference. No window known → the cap stays the only evidence, unchanged.
    // (The exact count that would let the [cap, window) band fire safely is
    // #674's remaining build.)
    const overflowCap = getOverflowCap(this.provider.displayName, this.targetModel);
    if (overflowCap !== undefined) {
      const est = estimatePayloadTokens(requestPayload);
      if (est >= overflowCap) {
        // #674 — a window the engine ITSELF stated in a refusal body outranks
        // both the startup probe (it is fresher: a rebuilt engine says so on
        // its next refusal) and the hand-typed literal (never trusted alone,
        // #651). All three are absent on most providers → old behavior.
        const knownWindow =
          getStatedContextLimit(this.provider.displayName, this.targetModel) ??
          this.options.derivedContextLimit ??
          this.options.contextLimit;
        const corroborated =
          knownWindow === undefined ||
          knownWindow <= 0 ||
          overflowCap >= knownWindow ||
          estimateClampTokens(claudeRequest) >= knownWindow;
        if (corroborated) {
          logStderr(
            `[ContextGuard] short-circuit provider=${this.provider.displayName} model=${this.targetModel} est=${est} cap=${overflowCap}${knownWindow !== undefined && knownWindow > 0 && overflowCap < knownWindow ? ` window=${knownWindow} (corroborated)` : " (learned)"} — no upstream call`,
            true
          );
          return this.buildOverflowRecoveryResponse(c, payload, est, undefined, overflowCap);
        }
        // Not corroborated: fall through to the upstream. Its 400 (if doomed)
        // returns the same recoverable turn one round-trip later; its 200 (if
        // served) is a turn the old gate would have thrown away.
      }
    } else if (this.options.derivedContextLimit !== undefined && this.options.derivedContextLimit > 0) {
      // #651 — a window MEASURED from the engine's own `/v1/models` pre-seeds
      // the cap, so a recreate no longer reopens the band between that limit and
      // the reported floor (measured 24/10: 229 645 learned in memory, lost by
      // the recreate, and a `400 "Input too large"` 52 min later that taught
      // nothing back). A cap equal to the real window needs no learning.
      //
      // Only the DERIVED value arms this: a hand-typed `contextLimit` stays on
      // today's path (clamp, then the upstream's word), because a stale literal
      // that is too small would refuse requests the engine serves.
      //
      // Two estimators, never mixed: the learned cap above is recorded in
      // `estimatePayloadTokens` units, so it is compared in those. This window
      // is a prompt+output total, so it is compared against the SAME media-aware
      // estimate the #441 clamp and the #565 census use — with the /4 payload
      // estimator a 1 MB screenshot would score ~350k and short-circuit a
      // request the engine serves in ~1.6k tokens (false refusal on every
      // vision lane with a small window).
      //
      // Threshold is the window itself, not window-minus-margin: this is a
      // "cannot fit" statement about our own measurement, and the residual
      // the /4 estimator undercounts is content-dependent — measured over
      // 1 111 served swift responses (2026-10-25, req→resp paired):
      // real/est = x1.068 p50, x1.118 p95, x1.196 p99, min 0.57, max 3.18.
      // No fixed factor is safe in both directions (one large enough for the
      // tail refuses prompts that fit), which is why the band between this
      // threshold and the wall is #674's exact-counting case, not a fudge
      // factor invented here.
      const est = estimateClampTokens(claudeRequest);
      const window = this.options.derivedContextLimit;
      // #674 — inside the uncertain band the estimate only NOMINATES; the
      // engine's OWN tokenizer DECIDES. The measured spread of real/est over
      // 1 111 served responses is 0.57–3.18, so any threshold on the estimate
      // is wrong in one direction: below the window it refuses prompts that
      // fit, at the window it misses prompts that die (their estimate tops out
      // near 242k against a 262 144 window). The probe is bounded, never
      // throws, and turns itself off for the process on the first 404 — so an
      // endpoint without a tokenizer behaves exactly as before.
      let exact: ExactPromptCount | null = null;
      if (
        !exactCountDisabled() &&
        this.provider.countPromptTokens &&
        inExactCountBand(est, window, readExactCountBand())
      ) {
        const wireMessages = (requestPayload as any)?.messages;
        if (Array.isArray(wireMessages) && wireMessages.length > 0) {
          exact = await this.provider.countPromptTokens(wireMessages);
        }
        if (exact) {
          if (exact.maxModelLen !== undefined && exact.maxModelLen !== window) {
            log(
              `[ExactCount] provider=${this.provider.displayName} model=${this.targetModel} ` +
                `engine declares max_model_len=${exact.maxModelLen}, derived=${window} — ` +
                `the derived window decides (the declaration is advisory)`
            );
          }
          if (exact.exact >= window) {
            log(
              `[ExactCount] refuse-locally provider=${this.provider.displayName} model=${this.targetModel} ` +
                `est=${est} exact=${exact.exact} window=${window} — no upstream call`,
              true
            );
            return this.buildOverflowRecoveryResponse(c, payload, est, undefined, window, exact.exact);
          }
          log(
            `[ExactCount] fits provider=${this.provider.displayName} model=${this.targetModel} ` +
              `est=${est} exact=${exact.exact} window=${window} — upstream decides`
          );
        }
      }
      // Reached only when the exact count did not answer: no tokenizer, the
      // probe failed, or the request is below the band. The estimate keeps its
      // pre-#674 behavior — a "cannot fit" statement about our own measurement.
      if (!exact && est >= window) {
        // `log(msg, true)` — forceConsole lives on log(), not logStderr() (the
        // legacy `logStderr(x, true)` calls above predate that and are standing
        // type errors this PR does not add to).
        log(
          `[ContextGuard] short-circuit provider=${this.provider.displayName} model=${this.targetModel} est=${est} cap=${window} (derived window) — no upstream call`,
          true
        );
        return this.buildOverflowRecoveryResponse(c, payload, est, undefined, window);
      }
    }

    const endpoint = this.provider.getEndpoint(this.targetModel);
    const headers = await this.provider.getHeaders();
    this.applyClientAttribution(c, headers);
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
        ? await this.provider.enqueueRequest(doFetch, {
            // #431 AC3: only a loop-marked CASCADE STEP attempt carries a
            // budget — nominal / walk / non-cascade callers read undefined and
            // keep today's unbounded FIFO.
            busyWaitMs: cascadeStepBusyWaitMs(c),
          })
        : await doFetch();
    } catch (error: any) {
      // #431 AC3: the bounded busy wait expired. Never confuse this with a
      // connection error (the retry below would re-queue behind the same
      // saturated limiter and pay the whole ladder again) — answer the labeled
      // 529 with the skip header; the cascade advances past a non-last step
      // without a failure mark, and every other caller surfaces it as an
      // ordinary retryable overload.
      if (error instanceof StepBusyError) {
        // `log`, not `logStderr`: the forceConsole second argument exists only
        // on log() — several legacy logStderr(x, true) calls are standing type
        // errors in the baseline, and this change adds none.
        log(
          `[StepBusy] provider=${this.provider.displayName} model=${this.targetModel} waited=${error.waitedMs}ms — no concurrency slot (#431)`,
          true // forceConsole — operational event
        );
        return this.buildBusySkipResponse(c, error);
      }
      // A failure to even REACH the provider (DNS can't resolve, connection
      // refused, host unreachable) is a LOCAL network problem, not an upstream
      // server error. Surface it as a 400 connection_error with an honest,
      // actionable message so Claude Code shows "can't reach host — check your
      // network/DNS" instead of a mystifying 500.
      //
      // #251: "closed" alone (reached, then dropped before any byte —
      // ECONNRESET/EPIPE/socket closed) is transient, and in mono-candidate
      // routing no FallbackHandler exists to absorb it: the 400 below reached
      // Claude Code verbatim and killed the turn (z.ai reset, 2026-09-24). A
      // bounded same-provider retry runs FIRST; it also keeps a chain's
      // preferred provider (and its prompt cache) instead of skipping it on a
      // blip. dns/refused/unreachable stay unretried — stable conditions the
      // chain's other hosts cover. Pre-headers only, so never-hang is
      // unaffected; bounded worst case ≈ +1.6 s.
      const recovered =
        classifyConnectionError(error)?.kind === "closed"
          ? await retryClosedConnect(
              this.provider.displayName,
              this.bareModelName,
              this.provider.enqueueRequest
                ? () => this.provider.enqueueRequest!(doFetch)
                : doFetch,
              error
            )
          : null;
      const conn = recovered ? null : classifyConnectionError(error);
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
        // Status 400, NOT 503: Claude Code retries a 503 as overloaded_error —
        // ten rounds of "API error · Retrying · attempt N/10" with the real
        // reason buried behind the banner — while a 400 is rendered verbatim and
        // inline. The `connection_error` TYPE still carries the meaning, and it
        // is what keeps the 400 retryable ACROSS providers: isRetryableError's
        // 400 branch recognises the type and advances the chain, since
        // FallbackHandler's candidates are different hosts by construction and a
        // connect failure on one says nothing about another. In mono-candidate
        // routing no FallbackHandler exists, so this 400 reaches Claude Code
        // directly — which is where the UX gain lives.
        return c.json(wrapAnthropicError(400, msg, "connection_error"), 400 as any);
      }
      if (!recovered) throw error;
      response = recovered;
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
      // #679 — a NON-LAST cascade step refused by the plan's concurrency limit
      // (z.ai 1302) must NOT pay the ~5-minute patience below: that loop is a
      // NOMINAL strategy (no successor exists there, waiting beats switching),
      // while the step's whole job is to yield in seconds so the successor
      // serves (#431 philosophy). Letting the refusal fall through converts it
      // to the 529 the busy skip already rides — measured before this gate, a
      // concurrency-worded 1302 on a step burned the full patient spread and
      // THEN benched the step anyway.
      const stepConcurrencyRefusal =
        isStepSkipEligible(c as unknown as object) &&
        classifyConcurrencyRefusal(response.status, probeText);
      if (isTransientOverload(response.status, probeText) && !stepConcurrencyRefusal) {
        const recovered = await this.patientOverloadBackoff(doFetch);
        if (recovered) response = recovered;
        // null = exhausted → response stays the overload → !response.ok below → 529
      } else if (stepConcurrencyRefusal) {
        log(
          `[Overload] [${this.provider.displayName}] concurrency refusal (code 1302) on a cascade step — skipping the patient backoff, the successor serves (#679)`,
          true // forceConsole — operational event
        );
      } else {
        // Pre-stream policy refusal (#155 — pre-stream extension of #65): the
        // same invalid_prompt class arrives as a plain HTTP 4xx body before any
        // stream byte exists; the lane parsers never run on this path, so it
        // surfaced as a bare API error and killed the turn (fleet session,
        // 2026-09-19 14:41Z). Bounded retry of the identical body, then the
        // labeled terminal turn. Quota walls, transport errors and 5xx never
        // enter here — isQuotaExhaustion keeps owning them (negative control
        // pinned by test).
        const refusal = preStreamPolicyRefusal(response.status, probeText);
        if (refusal) {
          const format = this.resolveStreamFormat();
          const lane: "openai" | "anthropic" | "responses" = format.includes("anthropic")
            ? "anthropic"
            : format.includes("responses")
              ? "responses"
              : "openai";
          const retried = await preStreamPolicyRetry(doFetch, {
            lane,
            model: this.bareModelName,
            provider: this.provider.name,
          });
          if (retried.response) {
            // ok → normal stream path below (own watchdog wrap); foreign
            // non-ok → the generic error path owns it
            response = retried.response;
          } else {
            logPolicyRefusal({
              lane,
              model: this.bareModelName,
              provider: this.provider.name,
              attempt: retried.attempts + 1,
              action: "surface",
            });
            appendUpstreamError({
              model: this.targetModel,
              provider: this.provider.displayName,
              status: response.status,
              body: probeText,
            });
            return this.buildPolicyRefusalResponse(c, payload, refusal.message);
          }
        }
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
          this.applyClientAttribution(c, retryHeaders);
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
            // (port 196e6f8f) `errorText` IS the raw upstream body here — often a
            // whole SSE frame or nested JSON, not a sentence. Parse it first
            // (upstream passes `parsedErrorBody ?? errorText`) so a JSON body
            // yields its nested sentence instead of the whole document
            // re-stringified into provider_message; the `!==` guard then keeps
            // the field for the non-JSON case, exactly like the main non-ok
            // return below.
            let parsedRetryBody: unknown = errorText;
            try {
              parsedRetryBody = JSON.parse(errorText);
            } catch {
              // not JSON — the raw text is what we have (SSE frames unwrap inside)
            }
            const retryEnvelope = ensureAnthropicErrorFormat(
              retryResp.status,
              parsedRetryBody
            );
            const retryProviderSentence = extractProviderMessage(parsedRetryBody);
            if (
              retryProviderSentence &&
              retryProviderSentence !== retryEnvelope.error.message
            ) {
              retryEnvelope.error.provider_message = retryProviderSentence;
            }
            return c.json(retryEnvelope, retryResp.status as any);
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
        // c.req, never the bare Context: Hono's Context has no `.raw`, so passing
        // it whole falls back to the global counter and mislabels the wall line
        // under concurrency (review #632) — the keyed carrier is the HonoRequest.
        logStderr(wallMarkerLine(this.provider.displayName, response.status, requestNumberFor(c.req), hint));

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

        // #679 — the plan's request-concurrency refusal (429, code 1302) is a
        // BUSY signal, not a step failure: annotated on whatever response the
        // branches below produce (the 529 overload conversion or the plain
        // envelope), and only `handleWithCascade` acts on it — advance a
        // non-last step, no mark, no bench. Nominal/last-step callers see the
        // exact response they always did, plus a namespaced header they can
        // ignore. The annotation MUST precede isTransientOverload: the
        // concurrency-worded 1302 variant matches its 429 branch, and the
        // skip decision rides the 529 it returns.
        const concurrencyRefusal = classifyConcurrencyRefusal(response.status, errorText);
        if (concurrencyRefusal) {
          // log(..., true), not logStderr(_, true) — logStderr takes ONE
          // argument (forceConsole is log()'s), and the route harness hooks
          // console.log for countable markers.
          log(
            `[ConcurrencyRefusal] provider=${this.provider.displayName} model=${this.targetModel} HTTP ${response.status} code=1302 — plan concurrency busy, not a step failure`,
            true // forceConsole — operational event (#679 corroboration marker)
          );
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
          const overloaded = c.json(
            wrapAnthropicError(
              529,
              `${this.provider.displayName} temporarily overloaded (concurrency limit) — please retry shortly`,
              "overloaded_error"
            ),
            529 as any
          );
          // #679 — same wire the bounded busy 529 rides: a cascade step
          // advances with no mark; everyone else sees the 529 unchanged.
          if (concurrencyRefusal) {
            overloaded.headers.set(
              STEP_SKIP_HEADER,
              encodeStepSkipHeader("busy", CONCURRENCY_REFUSAL_SKIP_DETAIL)
            );
          }
          return overloaded;
        }

        // Context-overflow interception (2026-09-10/11 incident): this pre-stream
        // 400 used to reach the client as a bare error JSON with no `usage` — the
        // context gauge never advanced, auto-compact never fired, and `/continue`
        // re-sent the same oversized prompt forever. Emit the recoverable turn
        // instead (same doctrine as the Responses lane, openai-responses-sse.ts):
        // HTTP 200 + factual text + usage.input_tokens at or above the real size.
        // `appendUpstreamError` above keeps the durable provider-wording evidence.
        const overflow = classifyContextOverflow(response.status, errorText);
        if (overflow.matched) {
          const est = estimatePayloadTokens(payload);
          // #651 — the evidence string rides into the durable record, so a cap
          // restored after a recreate can be identified rather than guessed at.
          rememberOverflowCap(
            this.provider.displayName,
            this.targetModel,
            est,
            `HTTP ${response.status}${overflow.used !== undefined ? ` input_tokens=${overflow.used}` : ""}`,
            // #674 — the refusal's OWN window statement rides the same record:
            // it is the engine's number, observed live, and the corroboration
            // gate consumes it above.
            overflow.limit
          );
          // `reported`/`synthetic` make the synthetic count greppable: downstream
          // aggregators of `usage` (#41/#89 cost attribution, writeTokenFile) must be
          // able to exclude a number nothing measured — the floor, not the body, put it
          // there.
          const floor = overflowReportFloor();
          const reported = overflowReportedTokens(overflow.used, est, floor);
          logStderr(
            `[ContextGuard] overflow provider=${this.provider.displayName} model=${this.targetModel} used=${overflow.used ?? "?"} est=${est} floor=${floor} reported=${reported} synthetic=${reported > (overflow.used ?? 0)}`,
            true // forceConsole — operational event
          );
          return this.buildOverflowRecoveryResponse(c, payload, est, overflow.used, overflow.limit);
        }

        // #575 — the vLLM per-prompt image cap ("At most 4 image(s) may be
        // provided in one prompt") is a REQUEST-SHAPE incapacity, not a step
        // failure: the step is healthy, this prompt's media count is what it
        // cannot take. Emit the third step-skip class so a non-last step
        // advances with no failure mark, no bench, no arm (#431), and give the
        // reader an exact label — the generic "Request format may be
        // incompatible with provider" is what sent the 20/10 diagnosis thread
        // hunting a translation bug.
        //
        // The status stays 400: nothing about the prompt's SIZE is wrong, so
        // the #79 recoverable turn (whose whole job is to advance the context
        // gauge with an input_tokens at or above the real size) would report a
        // false cause and make the client compact for no reason.
        const mediaCap = classifyMediaCap(response.status, errorText);
        if (mediaCap.matched) {
          const carried = countMediaBlocks(payload);
          logStderr(
            `[MediaCap] provider=${this.provider.displayName} model=${this.targetModel} ` +
              `cap=${mediaCap.max ?? "?"} images=${carried} param=${mediaCap.param ?? "?"} — ` +
              `request-shape incapacity, not a step failure`,
            true // forceConsole — operational event
          );
          const out = c.json(
            wrapAnthropicError(400, mediaCapRefusalText(mediaCap.max, carried), "invalid_request_error"),
            400 as any
          );
          out.headers.set(
            STEP_SKIP_HEADER,
            encodeStepSkipHeader("media", mediaCapSkipDetail(mediaCap, carried))
          );
          return out;
        }

        // (port 196e6f8f) When the body was JSON, `message` already IS the
        // provider's sentence and the field would duplicate it — the `!==` guard
        // keeps provider_message for the case that needs it: the non-JSON
        // fallback above wrapped a whole raw body (SSE frame included) as the
        // message, and the unwrapped sentence beside it is what a clipping
        // consumer can actually read.
        const envelope = ensureAnthropicErrorFormat(response.status, errorBody);
        const providerSentence = extractProviderMessage(errorBody);
        if (providerSentence && providerSentence !== envelope.error.message) {
          envelope.error.provider_message = providerSentence;
        }
        const enveloped = c.json(envelope, response.status as any);
        // #679 — the plain 1302 429 ("Rate limit reached for requests"):
        // annotate, never alter — a non-last cascade step skips forward, the
        // response itself stays byte-for-byte what it always was.
        if (concurrencyRefusal) {
          enveloped.headers.set(
            STEP_SKIP_HEADER,
            encodeStepSkipHeader("busy", CONCURRENCY_REFUSAL_SKIP_DETAIL)
          );
        }
        return enveloped;
      }
    }

    // ── In-stream rate-limit handling (temporize, then fall back) ──────────
    // Some anthropic-sse providers (notably Z.AI) deliver their burst / RPM
    // limit as HTTP 200 + an in-stream SSE error ([1302]) with no message
    // envelope. The OpenAI Responses lane (gpt-5.6-sol) delivers its
    // server_is_overloaded the same way — the error event IS the first stream
    // event, before any response.created. Both escape `response.ok` above and
    // FallbackHandler (both key off HTTP status), so they used to reach the
    // client as a bare error and stop the turn: on the Responses lane that
    // surfaced as a clean HTTP 200 ending in "[API Error: server_is_overloaded
    // …]" text, which Claude Code treats as a completed turn — an autonomous
    // agent reads it as its own last word and stops (po-2025:CoursIA-2,
    // 2026-09-01). We peek the first bytes (the error arrives in 0-4ms, so a
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
      if (peekFormat === "anthropic-sse" || peekFormat === "openai-responses-sse") {
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
    // #518 stats volet: the input/output are THIS stream's counts, handed over by
    // onTokenUpdate — never the handler-wide tracker, which under "accumulate-both"
    // sums input across sessions (and accumulates output under every strategy), so
    // reading it here attributes another session's context to this stream's line.
    // estimated_cost and is_free_model stay on the tracker: they are cumulative
    // session-cost semantics by design, not per-stream counts.
    const onStreamComplete = (streamInput: number, streamOutput: number) => {
      try {
        const isFreeModel = this.tokenTracker.getTotalCost() === 0;
        recordStats({
          model_id: this.targetModel,
          provider_name: this.provider.name,
          stream_format: this.provider.streamFormat,
          latency_ms: latencyMs,
          success: true,
          http_status: httpStatus,
          input_tokens: streamInput,
          output_tokens: streamOutput,
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
      latencyMs,
      // Transparent in-stream retry (openai-responses-sse, 2026-09-02 Sol
      // crashes): re-issues the SAME upstream request via doFetch DIRECTLY —
      // not enqueueRequest, same rationale as the rate-limit peek loop: the
      // transport's own retry must not compound with this one.
      async (): Promise<Response | null> => {
        try {
          return await doFetch();
        } catch {
          return null;
        }
      }
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

  /**
   * Recoverable turn for a context overflow: HTTP 200 so the client treats the
   * turn as completed (not an API error to replay identically), a factual text
   * block, and `usage.input_tokens` at or above the real size so its
   * auto-compact fires on the next turn. SSE when the client asked to stream,
   * single JSON otherwise — same split as the success path (`payload?.stream === true`).
   */
  private buildOverflowRecoveryResponse(
    c: Context,
    payload: any,
    est: number,
    used: number | undefined,
    /** Provider-stated token limit, when the refusal named one (#431 marker). */
    limit?: number,
    /** Engine-measured prompt size, when the tokenizer answered (#674). */
    exact?: number
  ): Response {
    // #674 — when the tokenizer answered, its count is the true size: the
    // client's compaction works off this number, and the estimate is only what
    // nominated the probe in the first place.
    const shown = exact ?? est;
    const inputTokens = overflowReportedTokens(used ?? exact, shown, overflowReportFloor());
    const text = overflowRecoveryText(this.provider.displayName, this.targetModel, shown, exact !== undefined);
    let response: Response;
    if (payload?.stream === true) {
      response = buildOverflowRecoveryStream(text, inputTokens, this.bareModelName);
    } else {
      response = c.json(buildOverflowRecoveryMessage(text, inputTokens, this.bareModelName), {
        headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      });
    }
    // #431 AC1/AC4: mark this 200 as "cannot take THIS request", not a success.
    // Only handleWithCascade acts on it, and only for a non-last cascade step —
    // everywhere else the recovery turn surfaces unchanged, header and all
    // (same doctrine as x-claudish-failover-notice, #229). The cap in the
    // detail prefers the provider-stated limit (vLLM names 262144) and falls
    // back to the learned one; est is the payload estimate either way, and
    // `exact=` is added when the engine's tokenizer produced the count (#674).
    const cap = limit ?? getOverflowCap(this.provider.displayName, this.targetModel);
    response.headers.set(
      STEP_SKIP_HEADER,
      encodeStepSkipHeader(
        "context",
        `est=${est}${exact !== undefined ? ` exact=${exact}` : ""}${cap !== undefined ? ` cap=${cap}` : ""}`
      )
    );
    return response;
  }

  /**
   * #431 AC3 — bounded-busy answer for a cascade step attempt whose concurrency
   * wait expired. A 529 (not 429: the meter is not walled, the lane is full —
   * same vocabulary as the patient-backoff path) carrying the skip header so
   * the cascade advances past a non-last step with no failure mark. Last step
   * and non-cascade callers surface it as an ordinary retryable overload.
   */
  private buildBusySkipResponse(c: Context, err: StepBusyError): Response {
    const response = c.json(
      wrapAnthropicError(
        529,
        `${this.provider.displayName} busy — no concurrency slot within the bounded wait (${err.waitedMs}ms)`,
        "overloaded_error"
      ),
      529 as any
    );
    response.headers.set("Retry-After", "2");
    response.headers.set(
      STEP_SKIP_HEADER,
      encodeStepSkipHeader("busy", `wait=${err.waitedMs}ms label=${err.label}`)
    );
    return response;
  }

  /**
   * Terminal labeled turn for a persistent pre-stream policy refusal (#155).
   * Same synthetic-turn shape as the overflow recovery: a refusal surfaced as
   * a bare 4xx kills the agent turn; as a 200 turn with end_turn the agent
   * reads it, adapts, and the turn completes cleanly. ok-by-design also stops
   * handleWithCascade — a policy flag is not a quota wall and must not burn a
   * failover step (asserted by test).
   */
  private buildPolicyRefusalResponse(
    c: Context,
    payload: any,
    message: string
  ): Response {
    const text = policyRefusalNotice(message);
    if (payload?.stream === true) {
      return buildOverflowRecoveryStream(text, 0, this.bareModelName);
    }
    return c.json(buildOverflowRecoveryMessage(text, 0, this.bareModelName), {
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    });
  }

  /**
   * #518 — record a session's last-known full context size for the
   * message_start seed. delete+set refreshes insertion order so an active
   * session is never the eviction victim of newer inserts; the cap bounds the
   * map on a long-lived hub handler (256 concurrent-or-recent sessions is far
   * beyond any observed lane, and eviction only costs a first-turn fallback).
   */
  private rememberSessionInput(key: string, inputTokens: number): void {
    if (!(inputTokens > 0)) return;
    this.sessionInputSeeds.delete(key);
    this.sessionInputSeeds.set(key, inputTokens);
    if (this.sessionInputSeeds.size > 256) {
      const oldest = this.sessionInputSeeds.keys().next().value;
      if (oldest !== undefined) this.sessionInputSeeds.delete(oldest);
    }
  }

  private handleStream(
    c: Context,
    response: Response,
    adapter: BaseModelAdapter,
    claudeRequest: any,
    toolNameMap?: Map<string, string>,
    onComplete?: (input: number, output: number) => void,
    headerLatencyMs?: number, // dispatch → upstream headers (for the [ttft] marker)
    retryUpstream?: () => Promise<Response | null> // transparent in-stream retry (#65: responses + openai-sse + anthropic-sse lanes)
  ): Response {
    // #518: the seed identity. Same extractor as the dwell seam (#91 p4) so
    // "a session" means the same thing here as everywhere else in the proxy.
    const sessionKey = extractSessionKey(claudeRequest);
    // `input` is the FULL context size, always — never the cache-reduced figure
    // that rides on the wire. `detail` is the optional cached breakdown of that
    // same number and is used for COST ONLY; handing the tracker a reduced
    // count would report a nearly-full conversation as almost empty and disarm
    // auto-compaction. (S4-c)
    const onTokenUpdate = (input: number, output: number, detail?: UsageCacheDetail) => {
      // #317: upstream output tokens feed the per-session budget counter (the
      // attempt token was attached to c.req.raw by the cascade loop). Never
      // throws; no-op when the instrument is inert (no token attached).
      recordSessionBudgetOutput(c.req.raw, output);
      // #518: the full context size, keyed by THIS stream's session — feeds
      // the next same-session message_start seed (see priorInputTokens below).
      if (sessionKey !== null) this.rememberSessionInput(sessionKey, input);
      const strategy = this.options.tokenStrategy || "standard";
      switch (strategy) {
        case "accumulate-both":
          this.tokenTracker.accumulateBoth(input, output, detail);
          break;
        case "delta-aware":
          this.tokenTracker.updateWithDelta(input, output, detail);
          break;
        case "local":
          this.tokenTracker.updateLocal(input, output, detail);
          break;
        // "actual-cost" is handled separately via updateWithActualCost
        case "standard":
        default:
          this.tokenTracker.update(input, output, detail);
          break;
      }
      // Fire onComplete after token update, handing over THIS stream's counts —
      // recordStats() must report them, not the handler-wide tracker (#518).
      if (onComplete) {
        try {
          onComplete(input, output);
        } catch {
          // Stats must never crash claudish
        }
        // Prevent double-firing if onTokenUpdate is called more than once
        onComplete = undefined;
      }
    };

    // See resolveStreamFormat() for the priority rules and the #102 history.
    const streamFormat = this.resolveStreamFormat();
    // The last-known full context size OF THIS SESSION, read BEFORE this
    // stream updates it (S4-b ae8c07f). Seeds message_start.usage on the
    // openai-sse lane: Claude Code only lets a delta override the seed when
    // its value is > 0, so on turns without usage — or fully-cached turns
    // whose netted input is 0 — the seed is what the client records as the
    // conversation size. Keyed per session since #518: the handler's tracker
    // holds whichever session finished last on this MODEL, and seeding from
    // it announced another tenant's context size on a fresh session (166322
    // vs 233 real, hub 18/10). An unknown or keyless session gets `undefined`
    // here, which messageStartUsage() turns into the first-turn constant —
    // never a foreign session's count.
    const priorInputTokens =
      sessionKey !== null ? this.sessionInputSeeds.get(sessionKey) : undefined;
    // First-useful-event watchdog (#108): a stream admitted with 200 that
    // produces only keep-alive comments held hub slots for ~900s during the
    // 14/09 deepseek-flash scheduler incident. Wrapped for every SSE format;
    // ollama-jsonl is excluded because its wire format has no `data:` prefix,
    // so the watchdog could never see its useful events. Expiry cancels the
    // upstream and the parser below finalizes synthetically (never-hang).
    if (streamFormat !== "ollama-jsonl") {
      response = withFirstUsefulEventWatchdog(response, this.bareModelName);
    }
    // Same watchdog for the RETRIED stream (#65 review): the wrap above disarms
    // on the first `data:` line — and the in-stream error chunk that triggers a
    // policy-refusal retry IS one — and never rearms, so the bare doFetch()
    // response the closure used to return was unbounded: a mute-but-200
    // replacement upstream would hang the client exactly as #108 confines.
    // Bounded here, once, for every lane that receives retryUpstream.
    const retryUpstreamBounded =
      streamFormat !== "ollama-jsonl" && retryUpstream
        ? boundRetryUpstream(retryUpstream, this.bareModelName)
        : retryUpstream;
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
          headerLatencyMs,
          // invalid_prompt transparent retry (#65) — same doFetch re-issue the
          // responses lane uses; the marker carries the provider for counting.
          { retryUpstream: retryUpstreamBounded, providerName: this.provider.name },
          priorInputTokens
        );

      case "openai-responses-sse":
        return createResponsesStreamHandler(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          // The map CAPTURED before the upstream await (the `toolNameMap`
          // parameter), never a fresh `adapter.getToolNameMap()`. Handlers are
          // cached per model while `claudish serve` hosts several conversations,
          // so `reset()` on request B replaces the bindings request A's parser
          // still needs; re-reading here hands A the NEXT request's map and
          // `keepOnlyRealTools` then drops A's tool calls with no error anywhere.
          // This lane read fresh while openai-sse (above) already used the
          // captured parameter. It was inert until S4-b 2e18042 made
          // `getToolNameLimit()` cover `openai-responses-sse`: before that the
          // Codex wire never encoded, so both reads returned an empty map.
          toolNameMap,
          headerLatencyMs,
          retryUpstream: retryUpstreamBounded,
          providerName: this.provider.name,
        });

      case "anthropic-sse":
        return createAnthropicPassthroughStream(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          // Thinking-filter consultation must reach the MODEL dialect
          // (MiniMaxModelDialect.shouldFilterThinking()=true), not stop at the
          // explicit wire adapter (AnthropicAPIFormat, base default false) that
          // shadows it on this lane — until 2026-09-23 the documented MiniMax
          // thinking filter never actually fired on the mmc@ lane for exactly
          // this reason. The dialect is the semantic owner of "this model's
          // unrequested thinking blocks leak"; the wire adapter answers a
          // different question.
          adapter: (this.modelAdapter ?? adapter) as BaseAPIFormat,
          // Filter only what the client did not ask for (see parser opts) —
          // `adaptive` is a request too, not just `enabled`.
          clientRequestedThinking: clientRequestedThinking(claudeRequest?.thinking),
          headerLatencyMs,
          retryUpstream: retryUpstreamBounded,
          providerName: this.provider.name,
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
          // #444 — same seed contract as the openai lane: message_start carries
          // the previous turn's input count, never a bare 0.
          priorInputTokens,
        });
      }

      case "ollama-jsonl":
        return createOllamaJsonlStream(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          // #444 — same seed contract as the openai lane.
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
 * #299-B — the class the cascade's one-shot overload walk answers to: a
 * provider overload in either of its wire shapes. A bare 529 is the shape the
 * proxy itself surfaces once the patient backoff is exhausted (the 429/503
 * overload forms convert to 529 above); `isTransientOverload` covers the
 * 429-with-overloaded-body and 503 forms that reach the cascade directly.
 * #298 A adds the third shape: HTTP 400 + `"connection_error"` — the proxy's
 * own synthesis of a transport failure to the nominal (#302, credit po-2025).
 *
 * Deliberately NOT folded into isTransientOverload: that predicate also gates
 * the ~5-minute patient backoff, and a 529 entering it would delay every
 * overloaded turn by minutes before the walk could run — the 2026-10-02 hub
 * measurement shows sustained 529s, where a fast walk to a healthy step beats
 * a patient wait on a provider already refusing ~30 % of attempts.
 */
export function isOverloadWalkClass(status: number, errorText: string): boolean {
  // #298 A (clause carried over from #302, credit po-2025): a connection
  // failure TO the nominal provider is synthesized as HTTP 400 with a
  // `"connection_error"` code in the body (`connection-error.ts`) — same
  // "unreachable, not walled" class as an overload, and the client cannot
  // retry its way out of it any better than a 529.
  if (isConnectionWalkClass(status, errorText)) return true;
  return status === 529 || isTransientOverload(status, errorText);
}

/**
 * #598 — the CONNECTION class ALONE: HTTP 400 carrying the proxy's own
 * `"connection_error"` synthesis (#298 A). Strictly narrower than
 * {@link isOverloadWalkClass}, and that narrowing is the whole point: a step
 * that dies here has said nothing about its PLAN — the host was unreachable —
 * whereas a 529/429/503 answers about capacity the resolver owns (#299 B).
 *
 * Only this class lets the walk advance past a dead step. The measured driver
 * (2026-10-22): the nominal's egress died and walk step 0 sat on it, so
 * 194/194 sonnet walks re-picked step 0 while step 1 was never tried; a
 * transport failure writes no state by design, so `firstServable` keeps
 * finding the same dead step servable.
 */
export function isConnectionWalkClass(status: number, errorText: string): boolean {
  return status === 400 && errorText.includes('"connection_error"');
}

/**
 * Phrases that name the MODEL as the problem rather than the credential or the
 * payload. The phrases that NAME the model are shared by the 401/403 and 400
 * branches of getRecoveryHint so the two cannot disagree about which status
 * "the MODEL is the problem" arrives under (upstream fa09cb7e): Alibaba's
 * silos answer an id their plan does not serve with a bare `400 Model not
 * exist`, which matched none of our phrases — the only hint was "Request
 * format may be incompatible with provider", sending the reader to audit a
 * payload that is fine.
 *
 * Deliberately narrow: a false positive here tells a user with genuinely broken
 * credentials to go check their model name instead. Every phrase names a model
 * — never bare "invalid", "denied" or "unauthorized", the vocabulary of real
 * auth failures.
 *
 * Two predicates, one canonical list (review of #455, B1): the bare
 * "not supported" is deliberately 401/403-ONLY. On an auth-status answer that
 * wording almost always names the model (OpenCode Zen), but on a 400 it most
 * often names a PARAMETER or a content type — "stream_options is not
 * supported" and "Image input is not supported for this model" must keep the
 * format hint, not send the operator to audit a model id that is fine.
 * Upstream keys one shared list on both branches and carries that defect; this
 * split is a deliberate divergence.
 *
 * Hint wording only: `FallbackHandler.isRetryableError` keeps its own 400
 * phrase list and deliberately does NOT carry "model not exist", so the chain
 * still stops on it rather than advancing — a model fault is terminal, not a
 * transport blip another host could absorb.
 */
const MODEL_NAMING_PHRASES = [
  "unsupported model",
  "unsupported_model",
  "model not found",
  "model_not_found",
  "unknown model",
  "model not exist",
  "no such model",
] as const;

function hasModelNamingWording(lower: string): boolean {
  return MODEL_NAMING_PHRASES.some((phrase) => lower.includes(phrase));
}

/** 401/403 only: the naming phrases plus the bare "not supported" (see above). */
function hasModelUnsupportedWording(lower: string): boolean {
  return lower.includes("not supported") || hasModelNamingWording(lower);
}

/**
 * Return a human-readable recovery hint based on HTTP status and error body.
 *
 * Exported for tests: this hint is the line an operator reads first, and a wrong
 * one costs real diagnosis time — on 2026-09-15 it printed "Check API key /
 * OAuth credentials" for Kimi's spent 5-hour window, which reads as a wiring
 * fault while the true condition is a quota wall the cascade is supposed to
 * advance over.
 */
export function getRecoveryHint(status: number, errorText: string, providerName: string): string {
  const lower = errorText.toLowerCase();

  if (status === 503 || lower.includes("overloaded")) {
    return "Provider overloaded. Retry or use a different model.";
  }
  if (status === 429 || lower.includes("rate limit")) {
    return "Rate limited. Wait, reduce concurrency, or check plan limits.";
  }
  if (status === 401 || status === 403) {
    // A 401/403 is not automatically an auth fault. Kimi Coding answers 403 with
    // "You've reached your 5-hour usage limit" and clients render it as "Failed
    // to authenticate" — name the wall instead of sending the reader after a key.
    if (isQuotaExhaustion(status, errorText)) {
      return "Plan/quota window exhausted — a wall, not an auth fault. The cascade advances to the next step.";
    }
    // Some providers (e.g. OpenCode Zen) return 401 for unsupported models, not auth failures
    if (hasModelUnsupportedWording(lower)) {
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
    // A model the provider does not carry also arrives as a 400 (fa09cb7e) —
    // but only the phrases that NAME the model key the hint here (that subset
    // is shared with the 401/403 branch, so the two cannot disagree on it). A
    // bare "not supported" on a 400 most often faults a PARAMETER or a content
    // type ("stream_options is not supported") and must fall through (review
    // of #455, B1). Checked BEFORE the size test, which is a bare
    // includes("token") and would otherwise claim any model-named body that
    // happens to spell "tokens".
    if (hasModelNamingWording(lower)) {
      return "Model not supported by this provider. Verify model name.";
    }
    // #575 — the engine's per-prompt image cap. This body names neither a token
    // nor a context, so it used to fall to "Request format may be incompatible
    // with provider" and read as a translation bug (20/10 diagnosis thread).
    // The cap is a request-shape refusal: the step advances (#431), nothing is
    // wrong with the wiring.
    const mediaCap = classifyMediaCap(status, errorText);
    if (mediaCap.matched) {
      return (
        `This step accepts ${mediaCap.max !== undefined ? `at most ${mediaCap.max} image(s)` : "a limited number of images"} ` +
        `per prompt and refused on the media count — a step-skip, not a failure.`
      );
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
