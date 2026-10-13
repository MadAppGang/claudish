/**
 * ComposedHandler — composes a ProviderTransport + ModelAdapter to implement ModelHandler.
 *
 * This is the universal handler that replaces all 11 monolithic handlers.
 * The Provider owns transport (auth, endpoint, headers, rate limiting).
 * The Adapter owns transforms (messages, tools, payload, text post-processing).
 *
 * Flow:
 *   1. transformOpenAIToClaude(payload)          — normalize incoming request
 *   1a. hook request stage A                      — system / message / tool-set actions
 *   2. adapter.convertMessages(claudeRequest)    — Claude → target format
 *   3. adapter.convertTools(claudeRequest)        — tool schema conversion
 *   3a. hook request stage B                      — tool descriptions, both representations
 *   3b. middleware.beforeRequest(...)             — pre-flight hooks
 *   4. adapter.buildPayload(...)                  — assemble full request body
 *   5. adapter.prepareRequest(payload, original)  — tool name truncation, etc.
 *   6. fetch via provider (with optional queue)   — HTTP request
 *   7. stream parser by provider.streamFormat     — response → Claude SSE
 *
 * Steps 3a and 3b must stay ahead of step 4: buildPayload does not reliably
 * alias `messages`/`tools`, so anything that runs after it is silently
 * discarded on the Codex/Responses path. Stage A runs BEFORE conversion so a
 * system note reaches chat-completions routes, whose payload is built from the
 * converted `messages` alone; stage B runs AFTER `convertTools` so
 * `summarizeTools` can never cut a description append. The hook stages run only
 * when `withHooks` (hooks/response-seam.ts) put the request hooks on the context.
 */

import type { Context } from "hono";
import {
  type BaseAPIFormat,
  DefaultAPIFormat,
  type EffortLevel,
} from "../adapters/base-api-format.js";
import { MiniMaxModelDialect } from "../adapters/minimax-model-dialect.js";
import type { ProviderTransport, StreamFormat } from "../providers/transport/types.js";
import type { ModelHandler } from "./types.js";
// Alias for readability within this file
type BaseModelAdapter = BaseAPIFormat;
import { lookupModelAcceptsImages, lookupModelForProvider } from "../adapters/model-catalog.js";
import type { QuotaAdapter } from "../auth/quota/adapter.js";
import { resolveQuotaAdapter } from "../auth/quota/registry.js";
import { PLAN_POLL_INTERVAL_MS } from "../auth/quota/types.js";
import { type HookRequestScope, isNativeRoute, requestHooksOf } from "../hooks/request-stage.js";
import {
  getLogLevel,
  log,
  logRecovery,
  logStderr,
  logStructured,
  truncateContent,
} from "../logger.js";
import { GeminiThoughtSignatureMiddleware, MiddlewareManager } from "../middleware/index.js";
import { deepMergeParams } from "../model-params.js";
import type { ResolvedConnection } from "../providers/connection-resolver.js";
import type { WireHeader } from "../providers/connection-wire.js";
import { describeSiblingKeys, getProviderByName } from "../providers/provider-definitions.js";
import { isTerminal429 } from "../providers/transport/openai.js";
import { wireMarkerContext } from "../providers/wire-markers.js";
import {
  type WireChoices,
  type WireMode,
  type WireSpeed,
  mergeWireHeaders,
  recoverBorrowedWireFields,
  shapeRequestFromWire,
  wireChoicesFromClaudeRequest,
} from "../providers/wire-request.js";
import { recoveryClock } from "../recovery/clock.js";
import {
  type RecoveryOutcome,
  episodeCount,
  noteTargetReachable,
  uiLeaseValid,
} from "../recovery/coordinator.js";
import { resolveRecoveryEnabled } from "../recovery/settings.js";
import {
  type OpenAIImageBlock,
  type VisionProxyAuthHeaders,
  describeImages,
} from "../services/vision-proxy.js";
import { type SessionEventRegistry, extractSessionId } from "../session-events/index.js";
import { applyProInjection, isUltracodeMainTurn } from "../session-events/pro-injection.js";
import type { StatsEvent } from "../stats-otlp.js";
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
import {
  authVerdictHeaders,
  classifyAuthFailure,
  isCredentialRejection,
  respondAuthFailure,
} from "./shared/auth-failure.js";
import { sseResponseToJson } from "./shared/collect-sse-message.js";
import type { ConnectionErrorKind } from "./shared/connection-error.js";
import {
  buildConnectionErrorMessage,
  buildRecoveryHoldMessage,
  classifyConnectionError,
} from "./shared/connection-error.js";
import { sniffDevinStreamHead } from "./shared/devin-stream-head-sniffer.js";
import { hasActionableLink, hasModelUnsupportedWording } from "./shared/model-unsupported.js";
import { filterIdentity } from "./shared/openai-compat.js";
import { hasPlanLimitWording, isQuotaExhaustionError } from "./shared/quota-exhaustion.js";
import { connectionFaultHeaders, recoveryHoldHeaders } from "./shared/recovery-marker.js";
import { isSubscriptionProvider } from "./shared/remote-provider-types.js";
import {
  CONTEXT_OVERFLOW_PHRASE,
  isContextOverflowError,
  isRequestShapeError,
} from "./shared/request-shape.js";
import { sniffResponsesStreamHead } from "./shared/stream-head-sniffer.js";
import { createAnthropicPassthroughStream } from "./shared/stream-parsers/anthropic-sse.js";
import { createDevinConnectStream } from "./shared/stream-parsers/devin-connect.js";
import { createGeminiSseStream } from "./shared/stream-parsers/gemini-sse.js";
import { createOllamaJsonlStream } from "./shared/stream-parsers/ollama-jsonl.js";
import { createResponsesStreamHandler } from "./shared/stream-parsers/openai-responses-sse.js";
import { createStreamingResponseHandler } from "./shared/stream-parsers/openai-sse.js";
import { TokenTracker, type UsageCacheDetail } from "./shared/token-tracker.js";
import {
  type ConnectionErrorInfo,
  MIN_ATTEMPT_SLOT_MS,
  deadlineClamp,
  inboundStartedAtPerf,
  mergeSignalIntoInit,
  refreshDeadlineAt,
  tier1DeadlineAt,
  withConnectionRetry,
} from "./shared/transient-retry.js";
import { captureUpstreamError } from "./shared/upstream-error-capture.js";

/**
 * Backoff schedule for a retryable error that arrived inside an HTTP 200 stream.
 * Progressive rather than tight: the Codex capacity outage that motivated this
 * lasted minutes, so the useful attempts are the late ones.
 */
const STREAM_RETRY_DELAYS_MS = [3_000, 15_000, 30_000];

/**
 * One request's running account of what network recovery cost it. Mutable, and
 * mutated only by `recoverConnection`.
 *
 * Every field is REQUEST-scoped even though the episode behind them is not.
 * See `ComposedHandler.newRecoveryTally` for why that distinction is the whole
 * point, and `transient-retry.ts`'s `ConnectionRetryTally` for where the
 * request-scoped figures come from.
 */
interface RecoveryTally {
  /** Re-issues this request made. Not counting the failure that started it. */
  retries: number;
  /** Ms of this request's own latency spent inside the ladder. */
  recoveryMs: number;
  /** Set once an episode exists. Its presence is what makes the rest real. */
  episodeId?: string;
  /** Which tier-2 re-entry this request is. 0 = the original. */
  clientRetry: number;
  /** How the episode ended for this request, once it has. */
  outcome?: RecoveryOutcome;
}

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
   * Treat this route as FOREIGN for hooks (`RouteInfo.native` false) regardless
   * of the model's name, so foreign-scoped built-in hooks stay armed.
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
  /**
   * `--effort <level>`: pin the reasoning effort verbatim, skipping the
   * per-model catalog clamp. Installed on this handler's dialect(s) at
   * construction; undefined leaves the clamped mapping untouched.
   */
  effortOverride?: EffortLevel;
  /**
   * `--model-params k=v[,...]`: extra request params deep-merged into the
   * outbound payload at step 5a — AFTER every adapter has shaped it, so these
   * win over adapter defaults AND over the step 5a-pre preset injection.
   */
  modelParams?: Record<string, unknown>;
  /**
   * `--pro-on-ultracode`: apply this model's catalog provider-preset while the
   * Claude Code session is in ultracode. Opt-in; when falsy the session-event
   * layer is never consulted and does no filesystem work.
   */
  proOnUltracode?: boolean;
  /**
   * Test seam for the session-event registry. Defaults to the process-wide
   * singleton. Only tests should pass this.
   */
  sessionEventRegistry?: SessionEventRegistry;
  /**
   * Test seam for the model-catalog cache path used by preset resolution.
   * Defaults to ~/.claudish/cloud-models-catalog-v3.json. Only tests should pass this.
   */
  catalogCachePath?: string;
  /**
   * The catalog connection this handler calls, with its `wire` (catalog 3.7.0).
   * When its wire is known, step 5w shapes the output limit, reasoning, mode and
   * speed from it alone, after every adapter and dialect has run.
   */
  connection?: ResolvedConnection;
  /**
   * A model-family dialect the PROFILE chose for a provider that serves one
   * family (the Grok subscription). Never chosen from the model name.
   */
  dialect?: BaseAPIFormat;
  /** `+pro` on the model spec: request mode pro, refused where the wire does not publish it. */
  wireMode?: WireMode;
  /** `#<speed>` on the model spec, refused where the wire does not publish it. */
  wireSpeed?: WireSpeed;
}

export class ComposedHandler implements ModelHandler {
  private provider: ProviderTransport;
  /** The dialect resolved for this model, or the OpenAI-shaped default. */
  private resolvedDialect: BaseAPIFormat;
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

    // The dialect is never picked by model name. A catalog connection's `wire`
    // (or a custom endpoint's declared one) decides every reasoning and limit
    // field (step 5w); a profile that genuinely serves one model family names
    // its dialect explicitly (`options.dialect`: the Grok subscription). The
    // name-ordered dialect factory this replaced picked, for example, the GLM
    // dialect for any id containing "glm", whatever host or API served it.
    //
    // The dialect gets the REQUEST wire format, which only this class knows:
    // the Layer 1 converter decides the request shape, so its getStreamFormat()
    // is the signal — NOT provider.overrideStreamFormat(), which only re-labels
    // the RESPONSE for aggregators.
    //
    // One quirk is the MODEL's on every host and no wire field describes it:
    // MiniMax rejects a temperature outside its range. It keys on the catalog's
    // vendor field (data), and the MiniMax dialect's reasoning fields are then
    // overwritten by the wire like any other (step 5w runs after it).
    this.resolvedDialect =
      options.dialect ??
      (options.connection?.vendor === "minimax"
        ? new MiniMaxModelDialect(this.bareModelName, this.explicitAdapter?.getStreamFormat())
        : new DefaultAPIFormat(this.bareModelName, this.explicitAdapter?.getStreamFormat()));

    const resolvedModelAdapter = this.resolvedDialect;
    if (options.connection) {
      for (const adapter of [this.explicitAdapter, this.resolvedDialect]) {
        adapter?.setUpstreamVendor(options.connection.vendor ?? "");
      }
    }
    if (resolvedModelAdapter.getName() !== "DefaultAPIFormat") {
      this.modelAdapter = resolvedModelAdapter;
    }

    // Tell every adapter which PARSER will read the response.
    //
    // This is the only place that knows: `resolveStreamFormat()` consults
    // `provider.overrideStreamFormat()` FIRST, and no adapter can see that. The
    // pairing it exists for is `{transport:"openai", streamFormat:"anthropic-sse"}`
    // — an OpenAI-shaped REQUEST answered in Anthropic SSE. The request shape
    // armed the 64-char tool-name encoder while the Anthropic passthrough parser
    // takes no decode map, so Claude Code received a tool name it never
    // advertised and its allowlist dropped the call with no error anywhere.
    // `getToolNameLimit()` now returns null for any wire whose parser cannot
    // decode. See `wireDecodesToolNames`.
    //
    // Set once, here, because it is a property of the COMPOSITION:
    // `resolveStreamFormat()` never looks at the request, so this carries none
    // of the per-request race that made the tool-name bindings per-request.
    // `resolvedDialect`, not `modelAdapter`: an unrecognized model leaves
    // `modelAdapter` unset and `getAdapter()` then returns the dialect, which is
    // the instance that would do the encoding.
    const responseWire = this.resolveStreamFormat() as StreamFormat;
    this.resolvedDialect.setResponseWireFormat(responseWire);
    this.explicitAdapter?.setResponseWireFormat(responseWire);

    // Initialize middleware (only register model-specific middleware when applicable).
    // Use bareModelName for the middleware gate — .includes() works identically for
    // "google@gemini-2.5-flash" and "gemini-2.5-flash", and bare form is the invariant.
    this.middlewareManager = new MiddlewareManager();
    // With a connection, from data: a Gemini-API wire, or a Google model behind
    // a gateway (OpenRouter carries its thought signatures in reasoning_details).
    const connectionWire = options.connection?.wire;
    if (
      options.connection
        ? (connectionWire?.status === "known" && connectionWire.api === "gemini") ||
          options.connection.vendor === "google"
        : this.bareModelName.includes("gemini") || this.bareModelName.includes("google/")
    ) {
      // Selected from data when there is a connection: the middleware's own
      // name gate must not re-filter an opaque gateway id out again.
      this.middlewareManager.register(
        new GeminiThoughtSignatureMiddleware({ alwaysHandle: !!options.connection })
      );
    }
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[ComposedHandler:${this.bareModelName}] Middleware init error: ${err}`));

    // `--effort`: install the pin on EVERY dialect this handler can route
    // through. getAdapter() picks explicitAdapter or resolvedDialect at request
    // time and modelAdapter runs in addition to it, so pinning only one leaves
    // the flag working on some models and silently not on others. Safe to
    // mutate: the dialect is built per handler by its profile, and
    // an explicit adapter is built per handler by its profile.
    if (options.effortOverride) {
      for (const dialect of new Set(
        [this.explicitAdapter, this.resolvedDialect, this.modelAdapter].filter(Boolean)
      )) {
        (dialect as BaseAPIFormat).setEffortOverride(options.effortOverride);
      }
      log(
        `[ComposedHandler] --effort ${options.effortOverride} pinned for ${this.targetModel} (catalog clamp skipped)`
      );
    }

    // Initialize token tracker — model adapter knows the real context window
    this.tokenTracker = new TokenTracker(port, {
      contextWindow: this.getModelContextWindow(),
      providerName: provider.name,
      modelName: this.bareModelName,
      providerDisplayName: provider.displayName,
    });
  }

  /**
   * The route hooks are scoped by. `native` is the exact rule the plan-mode
   * supervisor has always used: `claude-*` names and the `anthropic` provider,
   * unless the provider profile sets `forceForeignModel`.
   */
  private routeInfo(): { modelId: string; provider: string; native: boolean } {
    return {
      modelId: this.bareModelName,
      provider: this.provider.name,
      native: isNativeRoute(this.bareModelName, this.provider.name, this.options.forceForeignModel),
    };
  }

  /** Provider adapter — handles transport format (messages, tools, payload) */
  private getAdapter(): BaseModelAdapter {
    return this.explicitAdapter || this.resolvedDialect;
  }

  /** Model context window — model adapter wins over provider adapter */
  private getModelContextWindow(): number {
    return this.modelAdapter?.getContextWindow() ?? this.getAdapter().getContextWindow();
  }

  /** Model vision support — model adapter wins over provider adapter */
  private getModelSupportsVision(): boolean {
    // A catalog connection asks the catalog's data about the MODEL (not a
    // dialect's default by name). Unknown is not "no": an image the user
    // attached is sent, and the upstream's own answer is what they see.
    const connection = this.options.connection;
    if (connection) {
      if (connection.generationId === "declared") return true;
      try {
        return lookupModelAcceptsImages(connection.modelId, this.options.catalogCachePath) ?? true;
      } catch {
        return true;
      }
    }
    return this.modelAdapter?.supportsVision() ?? this.getAdapter().supportsVision();
  }

  /** Get the active adapter name for stats reporting. */
  private getActiveAdapterName(): string {
    // Model-specific dialect takes precedence (GLMModelDialect, GrokModelDialect, etc.)
    if (this.modelAdapter) return this.modelAdapter.getName();
    return this.getAdapter().getName();
  }

  /**
   * Which host to name in a connection-failure message.
   *
   * A connect failure raised while MINTING A TOKEN happened against the auth
   * host, not the inference endpoint — for `gk@` those are `auth.x.ai` and
   * `api.x.ai`. A transport that knows better attaches `claudishEndpoint` to the
   * error it rethrows; otherwise fall back to the request endpoint, and finally
   * to the provider name so the sentence is never blank.
   */
  private connectionEndpointFor(error: unknown, requestEndpoint?: string): string {
    const attached = (error as { claudishEndpoint?: unknown })?.claudishEndpoint;
    if (typeof attached === "string" && attached.length > 0) return attached;
    if (requestEndpoint) return requestEndpoint;
    try {
      return this.provider.getEndpoint(this.targetModel);
    } catch {
      return this.provider.displayName;
    }
  }

  /**
   * What one REQUEST did inside the retry ladder, accumulated across every site
   * in that request that could enter it.
   *
   * One per `handle()` call, never on `this` — a `ComposedHandler` instance is
   * reused for the life of the process and serves concurrent requests, so an
   * instance field here would report one request's outage on another request's
   * record. The cost of getting that wrong is not a wrong number in a log: it
   * is a wrong number in the only stream that can answer "how often does this
   * happen", which is what the feature was measured by.
   *
   * ACCUMULATION IS PER-REQUEST AND LAST-EPISODE-WINS. A request can hit an
   * auth-path episode and then a fetch-path episode. Attempts and waits ADD
   * (they are both this request's own time, and there is exactly one record per
   * request), while `episodeId` and `clientRetry` are overwritten — so the id
   * that survives is the one belonging to the episode that DECIDED THE STATUS,
   * which is the only reading under which a scalar correlation id is
   * well-defined.
   */
  private static newRecoveryTally(): RecoveryTally {
    return { retries: 0, recoveryMs: 0, clientRetry: 0 };
  }

  /**
   * The recovery half of a stats event — spread into every `recordStats` on a
   * path a recovery could precede.
   *
   * Empty unless an episode actually happened, which is what keeps a healthy
   * request's record byte-identical to what it was before this feature existed.
   * `retry_attempts: 0` IS emitted when an episode existed and this request
   * added no re-issue to it; that is a different fact from "no recovery", and
   * only the presence of `recovery_episode_id` distinguishes them.
   */
  private recoveryStats(tally: RecoveryTally | undefined): Partial<StatsEvent> {
    if (!tally?.episodeId) return {};
    return {
      retry_attempts: tally.retries,
      recovery_ms: tally.recoveryMs,
      recovery_episode_id: tally.episodeId,
      recovery_client_retry: tally.clientRetry,
      ...(tally.outcome ? { recovery_outcome: tally.outcome } : {}),
    };
  }

  /**
   * The ONE response shape for "claudish could not reach the host".
   *
   * Every outbound call in this handler that can throw without a Response must
   * classify first and come here, or rethrow unchanged. None may invent a
   * status of its own — that is the rule this method exists to make cheap to
   * follow, because the two statuses a hand-written site reaches for are both
   * wrong:
   *
   *   - **401** (what the auth catches returned) is read by
   *     `fallback-handler.ts`'s `isRetryableError` as retryable, so a network
   *     outage during a token refresh ADVANCES THE CHAIN — silently moving a
   *     subscription user onto a per-token provider, during an outage, for a
   *     fault that had nothing to do with their credentials.
   *   - **500** (what an unclassified throw becomes at `proxy-server.ts`) hides
   *     the actionable sentence behind a stack dump.
   *
   * 400 with type `connection_error` is neither: `isRetryableError` stops the
   * chain, Claude Code renders it inline instead of behind "API error ·
   * Retrying", and `probe-live`'s classifier keys off the TYPE (status-agnostic)
   * to report "network error".
   */
  private respondConnectionError(
    c: Context,
    error: unknown,
    conn: { kind: ConnectionErrorKind; code: string },
    endpoint: string,
    ctx: {
      startTime: number;
      fallbackMeta?: { chain: string[]; attempts: number };
      /**
       * This request's ladder account, if it ran one. Absent means the ladder
       * was skipped, which is today's immediate-400 behaviour.
       */
      recovery?: RecoveryTally;
      /**
       * A retry this request made BEFORE the ladder — the parameter-recovery
       * re-fetch and the forced-auth re-fetch both are one. OR'd with the
       * ladder's own count rather than replaced by it, because both are true
       * answers to "did claudish retry before reporting this".
       */
      retriedBeforeLadder?: boolean;
      authType?: "api-key" | "oauth" | "none";
      /** Where the failure happened, for the debug log only. */
      site?: string;
    }
  ): Response {
    const msg = buildConnectionErrorMessage(conn.kind, this.provider.displayName, endpoint);
    log(
      `[${this.provider.displayName}] ${msg} (code=${conn.code}${ctx.site ? `, site=${ctx.site}` : ""})`
    );
    logStderr(`Error: ${msg}`);
    reportError({
      error,
      providerName: this.provider.name,
      providerDisplayName: this.provider.displayName,
      streamFormat: this.provider.streamFormat,
      modelId: this.targetModel,
      httpStatus: undefined,
      isStreaming: false,
      // DERIVED, never hand-set. This field had been a literal `false` on this
      // path since before the ladder existed, so every recovered-then-failed
      // outage was reported as a first-and-only attempt. It is true exactly
      // when this request re-issued the operation at least once, from either
      // source.
      retryAttempted: (ctx.retriedBeforeLadder ?? false) || (ctx.recovery?.retries ?? 0) > 0,
      isInteractive: this.isInteractive,
      ...(ctx.authType ? { authType: ctx.authType } : {}),
    });
    try {
      const { error_class, error_code } = classifyError(error, undefined);
      recordStats({
        model_id: this.targetModel,
        provider_name: this.provider.name,
        stream_format: this.provider.streamFormat,
        latency_ms: Math.round(performance.now() - ctx.startTime),
        success: false,
        http_status: 0,
        error_class,
        error_code,
        token_strategy: this.options.tokenStrategy ?? "standard",
        adapter_name: this.getActiveAdapterName(),
        middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
        fallback_used: ctx.fallbackMeta !== undefined,
        fallback_chain: ctx.fallbackMeta?.chain,
        fallback_attempts: ctx.fallbackMeta?.attempts,
        invocation_mode: this.options.invocationMode ?? "auto-route",
        ...this.recoveryStats(ctx.recovery),
      });
    } catch {
      // Stats must never crash claudish
    }
    // The chain-safety marker, on THIS arm as well as on the 503.
    //
    // It is the third argument rather than a `c.header()` call, because `c` is
    // SHARED across every candidate in a fallback chain and a sticky header set
    // here would ride out on `formatCombinedError`'s response — the same
    // invariant `respondRecoveryHold` obeys by building a standalone Response.
    // Hono's `newResponse` applies this bag to the returned Response only; it
    // never touches the context's own header store.
    //
    // Without it, chain-safety existed exactly where a banner did. A headless
    // exhaustion answered an unmarked 400, `isRetryableError` fell through to
    // its status-agnostic quota-wording match, and a host whose NAME contained
    // "quota" advanced the chain onto a metered provider mid-outage. See
    // `recovery-marker.ts`.
    return c.json(
      wrapAnthropicError(400, msg, "connection_error"),
      400 as any,
      connectionFaultHeaders()
    );
  }

  /**
   * The OTHER response shape: "claudish could not reach the host YET, and a
   * surface is painting that fact, so the retry is handed back to the client."
   *
   * This is tier 2. The episode stays open for its grace window, Claude Code's
   * own backoff elapses, it re-POSTs, and `joinEpisode` finds the open episode —
   * same `episodeId`, same ladder position, `clientRetries` incremented. One
   * banner, one attempt counter, one episode across both tiers.
   *
   * ── WHY `new Response` AND NEVER `c.header()` + `c.json()` ──────────────────
   *
   * `fallback-handler.ts` carries an explicit invariant: each candidate handler
   * must NOT mutate the Hono `Context` (e.g. `c.header()`) before returning a
   * non-ok Response. `c` is SHARED across every candidate in a chain, so a
   * sticky `x-should-retry` set here would ride out on
   * `formatCombinedError`'s `c.json(..., exhaustedChainStatus(errors))` — a
   * terminal 400 telling Claude Code to retry it, which reintroduces exactly
   * the buried-reason failure the whole 400-not-503 doctrine exists to prevent.
   * A standalone `Response` cannot do that. The file's one `c.header()` call
   * (`X-Dropped-Params`) is safe only because it sits after the `!response.ok`
   * early returns; this arm has no such luck and must not acquire any.
   *
   * ── WHY 503 AND NOT 529 ─────────────────────────────────────────────────────
   *
   * `exhaustedChainStatus`'s transient set already contains 503 and does not
   * contain 529, and `isRetryableError`'s remap-recovery check already scopes
   * to 429/503. 529 would add a status this codebase has never carried and
   * re-open every `status ===` under `handlers/`. 503 is the status the house
   * already owns for "transient after our own retries, do not switch the user's
   * provider".
   *
   * No `reportError` and no `logStderr("Error: …")` on this arm, deliberately.
   * This is a handoff, not a verdict: with the retry watchdog enabled the
   * client may re-ask hundreds of times during one outage, and a terminal-shaped
   * error line per handoff would drown the pane's own account of the same
   * fault. The 400 arm — lease gone, or the user pressed give-up — is where the
   * failure is finally reported, once.
   */
  private respondRecoveryHold(
    error: unknown,
    conn: { kind: ConnectionErrorKind; code: string },
    endpoint: string,
    ctx: {
      /** EPISODE-scoped, and deliberately so: these two are what the SENTENCE
       *  quotes, and the sentence is about the outage rather than about this
       *  socket. The request-scoped figures the stats record are in
       *  `recovery`. */
      startTime: number;
      attempts: number;
      recoveryMs: number;
      fallbackMeta?: { chain: string[]; attempts: number };
      recovery?: RecoveryTally;
    }
  ): Response {
    const reason = buildConnectionErrorMessage(conn.kind, this.provider.displayName, endpoint);
    const msg = buildRecoveryHoldMessage(reason, ctx.attempts, ctx.recoveryMs);
    try {
      const { error_class, error_code } = classifyError(error, undefined);
      recordStats({
        model_id: this.targetModel,
        provider_name: this.provider.name,
        stream_format: this.provider.streamFormat,
        latency_ms: Math.round(performance.now() - ctx.startTime),
        success: false,
        http_status: 503,
        error_class,
        error_code,
        token_strategy: this.options.tokenStrategy ?? "standard",
        adapter_name: this.getActiveAdapterName(),
        middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
        fallback_used: ctx.fallbackMeta !== undefined,
        fallback_chain: ctx.fallbackMeta?.chain,
        fallback_attempts: ctx.fallbackMeta?.attempts,
        invocation_mode: this.options.invocationMode ?? "auto-route",
        ...this.recoveryStats(ctx.recovery),
      });
    } catch {
      // Stats must never crash claudish
    }
    return new Response(JSON.stringify(wrapAnthropicError(503, msg, "overloaded_error")), {
      status: 503,
      headers: recoveryHoldHeaders(),
    });
  }

  /**
   * The inbound client's abort signal, or one that never fires.
   *
   * It fires sub-millisecond when Claude Code goes away — measured at
   * 0.49–0.86 ms across twelve trials, in the HELD shape (handler awaiting, no
   * headers sent) as well as the streaming one. Nothing in this codebase read
   * it before recovery existed, which is also why a fallback matters: a caller
   * that builds a Context without a real `Request` must get a signal that never
   * aborts rather than a crash.
   */
  private clientSignal(c: Context): AbortSignal {
    try {
      const signal = c.req?.raw?.signal;
      if (signal) return signal;
    } catch {
      // A synthesised Context. Fall through.
    }
    return new AbortController().signal;
  }

  /**
   * Should the retry ladder be skipped entirely, answering today's immediate
   * 400? Returns the REASON, or null to proceed.
   *
   * FOUR GATES, AND DELIBERATELY NO FIFTH. Each is a fact available at this
   * instant — a request header, configuration, the user's explicit give-up,
   * and the clock.
   *
   * There is NO special case for a refused loopback address, and that absence
   * is a decision rather than an omission. An earlier design skipped the ladder
   * for `refused` + loopback when the recovery UI was off, on the reasoning
   * that a stopped local server will not start itself. It was cut for two
   * reasons. The narrow one: the predicate was a regression generator — every
   * revision of it either fired universally (skipping recovery everywhere) or
   * fired never, and both times the defect was invisible because the SAME rule
   * decided the tests. The broad one, which is the real one: this is not a
   * feature for Ollama. It is the general answer to "claudish could not reach
   * the host", and a general rule that carves out one address family stops
   * being general. A user who restarts their server mid-ladder gets their turn
   * back, exactly as a user whose VPN reconnects does.
   */
  private shouldSkipTier1(c: Context, deadlineAt: number): string | null {
    // Probes MUST fail fast. Every probe POSTs through this handler, so
    // without this gate `--probe` and the config TUI's Test All would each
    // hold an unreachable link open for the full deadline and then misreport
    // it as a timeout — breaking the two tools that diagnose this exact fault.
    if (c.req.header("x-claudish-no-recovery") === "1") return "probe";
    // The CI / scripted-`-p` master switch. Off restores today's behaviour
    // everywhere, byte for byte.
    if (!resolveRecoveryEnabled()) return "recovery-disabled";
    // Attempt 1 already spent the budget. A guard, not a hope.
    if (recoveryClock().now() + MIN_ATTEMPT_SLOT_MS > deadlineAt) return "no-budget";
    return null;
  }

  /**
   * Answer a failure at a credential site that is NOT a connection fault
   * (`auth-failure.ts`): a terminal one (a dead or unsubscribed login, as the
   * producer marked it) as 400 with the terminal verdict, so the chain stops and
   * the message lands inline; a transient one — and any unclassifiable one of a
   * SUBSCRIPTION — as 503/429 with the transient verdict, retried on the same
   * hop, never 401.
   *
   * An unclassifiable failure of a METERED provider gets 401 only where
   * `meteredUnknown` is `"401"` (the refreshAuth and forceRefreshAuth catches,
   * which always answered it, so the chain may try another credential).
   * Everywhere else it returns null and the caller rethrows it unchanged:
   * classify first or rethrow — never invent a status.
   */
  private answerAuthFailure(
    c: Context,
    err: unknown,
    meteredUnknown: "401" | "rethrow"
  ): Response | null {
    const failure = classifyAuthFailure(err);
    const isSubscription = isSubscriptionProvider(this.provider.name);
    if (failure.kind === "connection") return null;
    if (failure.kind === "unknown" && !isSubscription && meteredUnknown === "rethrow") return null;
    return respondAuthFailure(c, failure, {
      isSubscription,
      providerDisplayName: this.provider.displayName,
    });
  }

  /**
   * {@link recoverConnection} at a credential site. A failure the ladder could
   * not classify as a connection fault (its `"threw"` outcome, e.g. a token
   * refresh that timed out and was then answered "login expired") is answered by
   * {@link answerAuthFailure} instead of escaping `handle()` — where
   * FallbackHandler would record status 0 and advance the chain.
   */
  private async recoverAtAuthSite<T>(
    c: Context,
    first: unknown,
    conn: ConnectionErrorInfo,
    endpoint: string,
    op: (signal: AbortSignal) => Promise<T>,
    ctx: Parameters<ComposedHandler["recoverConnection"]>[5],
    meteredUnknown: "401" | "rethrow"
  ): Promise<{ kind: "value"; value: T } | { kind: "respond"; response: Response }> {
    try {
      return await this.recoverConnection<T>(c, first, conn, endpoint, op, ctx);
    } catch (thrown) {
      const response = this.answerAuthFailure(c, thrown, meteredUnknown);
      if (response) return { kind: "respond", response };
      throw thrown;
    }
  }

  /**
   * Run tier-1 recovery for one classified connection failure.
   *
   * Callers reach this from inside their own `catch`, never before, and only
   * after `classifyConnectionError` returned non-null. `value` means the
   * operation eventually succeeded and the caller carries on with it;
   * `respond` means the caller returns that Response immediately. An
   * unclassifiable failure on a LATER attempt is rethrown from here, exactly as
   * an unclassifiable first failure is rethrown by the caller.
   */
  private async recoverConnection<T>(
    c: Context,
    first: unknown,
    conn: ConnectionErrorInfo,
    endpoint: string,
    op: (signal: AbortSignal) => Promise<T>,
    ctx: {
      startTime: number;
      deadlineAt: number;
      fallbackMeta?: { chain: string[]; attempts: number };
      authType?: "api-key" | "oauth" | "none";
      site: string;
      /** True at the two sites that are THEMSELVES a retry. See the field of
       *  the same name on `respondConnectionError`. */
      retriedBeforeLadder?: boolean;
      /**
       * THIS REQUEST'S tally, created once per `handle()` and threaded through
       * every site that can enter the ladder. Mutated here and nowhere else.
       */
      recovery: RecoveryTally;
    }
  ): Promise<{ kind: "value"; value: T } | { kind: "respond"; response: Response }> {
    const skip = this.shouldSkipTier1(c, ctx.deadlineAt);
    if (skip) {
      log(
        `[Recovery] skipped (${skip}) — ${this.provider.displayName} at ${endpoint}, site=${ctx.site}`
      );
      return {
        kind: "respond",
        response: this.respondConnectionError(c, first, conn, endpoint, ctx),
      };
    }

    // Lift Bun's per-request idle timeout so the hold is bounded by OUR
    // deadline rather than by the server's. `c.env` IS the Bun `Server` and
    // `c.env.timeout` is a real two-arity function — measured: a request given
    // `0` survived SIX times its `idleTimeout` where the un-disarmed control
    // died at 1.6×. Called HERE, inside the catch, and never on a healthy
    // request.
    try {
      (c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(
        c.req.raw,
        0
      );
    } catch {
      // An older Bun, or a synthesised Context. The deadline still holds; only
      // the server's own ceiling might cut it short, and that is today's
      // behaviour rather than a regression.
    }

    const result = await withConnectionRetry(op, first, {
      providerName: this.provider.name,
      providerDisplayName: this.provider.displayName,
      resolveEndpoint: (err) => this.connectionEndpointFor(err, endpoint),
      deadlineAt: ctx.deadlineAt,
      signal: this.clientSignal(c),
    });

    // Fold this ladder run into the request's account BEFORE any arm below can
    // return. A request that recovers at the auth site and then exhausts at the
    // fetch site must report BOTH sets of attempts and BOTH waits — they were
    // all its own latency — under the id of the episode that decided its
    // status, which is the later one. Both halves of that are this statement.
    ctx.recovery.retries += result.requestRetries;
    ctx.recovery.recoveryMs += result.requestRecoveryMs;
    ctx.recovery.episodeId = result.episodeId;
    ctx.recovery.clientRetry = result.clientRetry;

    switch (result.kind) {
      case "ok":
        ctx.recovery.outcome = "recovered";
        return { kind: "value", value: result.value };
      case "threw":
        // Classification runs on every attempt. Something that is not a
        // connection failure must keep its own route out of here.
        throw result.error;
      case "client_gone":
        ctx.recovery.outcome = "client_gone";
        this.recordClientGone(
          ctx.startTime,
          ctx.fallbackMeta,
          result.episodeId,
          result.attempts,
          ctx.recovery
        );
        // Nobody reads this. It exists so Hono has an object to return for a
        // socket that is already gone.
        return { kind: "respond", response: new Response(null, { status: 499 }) };
      default: {
        // THE LEASE IS READ HERE AND NOWHERE ELSE, at the instant the status is
        // chosen — never cached off the result object, which would be stale by
        // the time it was destructured. That staleness is exactly how the
        // superseded `uiAttached` latch could report a banner that had been
        // killed, closed or frozen minutes earlier, and then answer a retryable
        // status with the reason visible nowhere: the one outcome strictly
        // worse than the terminal 400 this feature exists to remove.
        //
        // THE RULE THE TWO ARMS ENCODE. A retryable status is permissible
        // exactly when claudish still has a surface on which the reason is
        // legible. Absent such a surface, the reason must ride the status,
        // which means 400.
        const leased = uiLeaseValid(result.episodeId);

        // `gave_up` is NOT eligible, and the guard is `result.kind` rather than
        // the lease. `[q] give up` is the user saying stop; a lease may well
        // still be valid at that instant (the pane that took the keystroke is
        // by definition alive), so a lease-only test would answer a retryable
        // 503 and Claude Code would immediately re-ask — turning the give-up
        // key into a no-op with a banner still on screen.
        ctx.recovery.outcome = result.kind === "exhausted" ? "handoff" : "gave_up";

        if (result.kind === "exhausted" && leased) {
          logRecovery(
            `[Recovery] ${this.provider.displayName} exhausted after ${result.attempts} attempts ` +
              `in ${result.recoveryMs}ms (episode ${result.episodeId}, ui_lease=true) — ` +
              "handing the retry back to the client (503, tier 2)"
          );
          return {
            kind: "respond",
            response: this.respondRecoveryHold(result.error, result.conn, result.endpoint, {
              startTime: ctx.startTime,
              attempts: result.attempts,
              recoveryMs: result.recoveryMs,
              fallbackMeta: ctx.fallbackMeta,
              recovery: ctx.recovery,
            }),
          };
        }

        logRecovery(
          `[Recovery] ${this.provider.displayName} exhausted after ${result.attempts} attempts ` +
            `in ${result.recoveryMs}ms (episode ${result.episodeId}, outcome ${result.kind}, ` +
            `ui_lease=${leased}) — answering connection_error`
        );
        return {
          kind: "respond",
          response: this.respondConnectionError(c, result.error, result.conn, result.endpoint, ctx),
        };
      }
    }
  }

  /** Stats for a request whose client went away mid-recovery. */
  private recordClientGone(
    startTime: number,
    fallbackMeta: { chain: string[]; attempts: number } | undefined,
    episodeId: string,
    attempts: number,
    recovery?: RecoveryTally
  ): void {
    log(
      `[Recovery] client disconnected after ${attempts} attempts (episode ${episodeId}) — ` +
        "releasing the request"
    );
    try {
      recordStats({
        model_id: this.targetModel,
        provider_name: this.provider.name,
        stream_format: this.provider.streamFormat,
        latency_ms: Math.round(performance.now() - startTime),
        success: false,
        http_status: 0,
        error_class: "network",
        error_code: "client_disconnected",
        token_strategy: this.options.tokenStrategy ?? "standard",
        adapter_name: this.getActiveAdapterName(),
        middleware_names: this.middlewareManager.getActiveNames(this.bareModelName),
        fallback_used: fallbackMeta !== undefined,
        fallback_chain: fallbackMeta?.chain,
        fallback_attempts: fallbackMeta?.attempts,
        invocation_mode: this.options.invocationMode ?? "auto-route",
        ...this.recoveryStats(recovery),
      });
    } catch {
      // Stats must never crash claudish
    }
  }

  /**
   * One request. Once it has been SIGNED (its headers fetched), every answer —
   * the stream, the JSON form, and an upstream error such as a 5xx or a
   * remapped 400 — names the credential that signed it, so `--probe` reports
   * the signer even when the request then failed for another reason. A request
   * that failed before it was signed (no usable login) names nothing.
   */
  async handle(c: Context, payload: any): Promise<Response> {
    const signing: { headers?: Record<string, string> } = {};
    const response = await this.handleSigned(c, payload, signing);
    if (!signing.headers || !this.provider.signingCredential) return response;
    return withSignerHeader(response, this.provider.signingCredential(signing.headers));
  }

  private async handleSigned(
    c: Context,
    payload: any,
    signing: { headers?: Record<string, string> }
  ): Promise<Response> {
    const startTime = performance.now();
    // Stamp the recovery deadline's ZERO POINT here, and not wherever something
    // first asks for it.
    //
    // `inboundStartedAtPerf` memoises on `c.req.raw`, so before this line the
    // zero point was set by the FIRST caller — which on the fetch path is
    // `tier1DeadlineAt(c)` inside the `catch`, i.e. AFTER attempt 1 has already
    // failed. MEASURED against an unrouted address: attempt 1 burned macOS's
    // 75 s connect timeout, the deadline's clock then started from there, and a
    // request with a 30 s budget answered at 108 s — the budget was not
    // exceeded, it was never applied. A ladder cannot bound a request whose
    // clock starts after the overrun it was supposed to bound.
    //
    // One `performance.now()` and one `WeakMap.set` per request; nothing else
    // on the healthy path reads it. A later candidate in a fallback chain finds
    // the value already there and inherits it, which is the documented intent —
    // the deadline belongs to the inbound request, not to a candidate.
    inboundStartedAtPerf(c);
    // latency_ms = time-to-first-byte (from request send to successful response).
    // Captured here so it is available to the post-stream stats callback below.
    let latencyMs = 0;
    // Capture and consume fallback metadata (set by FallbackHandler before calling handle).
    // Used in all stats recording paths so a single event carries complete info.
    const fallbackMeta = this.pendingFallbackMeta;
    this.pendingFallbackMeta = undefined;
    // This request's network-recovery account. A local, like `fallbackMeta` and
    // for the same reason: the handler instance outlives the request and serves
    // several at once. It stays all-zero and contributes NOTHING to any stats
    // record unless a classified connection failure actually occurs.
    const recoveryTally = ComposedHandler.newRecoveryTally();
    // 1. Transform incoming Claude-format request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

    // 1a. Hook request stage A, on this attempt's own deep copy (each
    // FallbackHandler candidate gets a fresh one, so nothing leaks between
    // attempts). Before conversion, so a system note reaches every route:
    // chat-completions adapters copy `system` into messages[0] at step 2 and
    // build their payload from `messages` alone.
    const hooks = requestHooksOf(c);
    const hookScope: HookRequestScope | undefined = hooks
      ? await hooks.beginAttempt(c, {
          claudeRequest,
          route: this.routeInfo(),
          model: typeof payload?.model === "string" ? payload.model : this.bareModelName,
          stream: payload?.stream === true,
        })
      : undefined;

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

    // 3a. Hook request stage B: tool-description actions, on the Claude-format
    // tools AND the converted ones, after convertTools (so `summarizeTools`,
    // which keeps only a description's first sentence, cannot cut an append)
    // and after the tool-count cap (a description action on a capped tool
    // changes the Claude-format copy only, journaled `capped`). It runs before
    // the middleware step on purpose: a pre-flight hook sees the request the
    // closed actions produced.
    hookScope?.applyToolDescriptions(claudeRequest.tools ?? [], tools);

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

    // 5a-pre. Ultracode → catalog provider-preset injection (opt-in).
    //
    // Runs BEFORE the 5a --model-params merge, and that order IS the
    // precedence rule: an explicit user `--model-params reasoning.mode=x` wins
    // only because the merge lands last. Swap these two blocks and the
    // injection silently overrides what the user asked for.
    //
    // Both blocks sit after step 5 (prepareRequest) and before 5c
    // (transformPayload) on purpose: after, so they beat every adapter default;
    // before, so they write into the payload itself rather than into a
    // provider envelope that 5c may wrap around it.
    // 5w. A known catalog wire decides the output limit, reasoning, mode and
    // speed — nothing else does. It runs after every adapter and dialect (it
    // removes whatever they emitted for those decisions) and before
    // --model-params, which stays the user's last word.
    let wireHeaders: WireHeader[] = [];
    let wireBorrowed: string[] = [];
    const wire = this.options.connection?.wire;
    if (wire?.status === "known") {
      const choices: WireChoices = {
        ...wireChoicesFromClaudeRequest(claudeRequest, this.options.effortOverride),
        catalogMaxOutputTokens: this.options.connection?.maxOutputTokens,
        // `--accept-served-model` (or CLAUDISH_ACCEPT_SERVED_MODEL=1): the user
        // named the swap, so a part the catalog warns about may be sent.
        acceptServedModelChange: process.env.CLAUDISH_ACCEPT_SERVED_MODEL === "1",
      };
      const markers = wireMarkerContext.getStore();
      const wireMode = this.options.wireMode ?? markers?.mode;
      const wireSpeed = this.options.wireSpeed ?? markers?.speed;
      if (wireMode) {
        choices.mode = { value: wireMode, explicit: true };
      } else if (
        this.options.proOnUltracode &&
        isUltracodeMainTurn({
          enabled: true,
          sessionId: extractSessionId(claudeRequest?.metadata),
          outputConfig: claudeRequest?.output_config,
          registry: this.options.sessionEventRegistry,
        })
      ) {
        choices.mode = { value: "pro", explicit: false };
      }
      if (wireSpeed) choices.speed = { value: wireSpeed, explicit: true };

      const shaped = shapeRequestFromWire(
        requestPayload,
        wire,
        choices,
        this.options.connection?.ownerWire
      );
      wireBorrowed = shaped.borrowed;
      const where = `${this.options.connection?.route.routeId}/${this.options.connection?.route.routeProfileId} · ${this.options.connection?.externalModelId}`;
      for (const note of shaped.notes) log(`[Wire] ${where}: ${note}`);
      if (shaped.refusal) {
        return c.json(
          wrapAnthropicError(
            400,
            `claudish: ${shaped.refusal} (${where})`,
            "invalid_request_error"
          ),
          400 as any
        );
      }
      wireHeaders = shaped.headers;
    } else if (
      this.options.wireMode ||
      this.options.wireSpeed ||
      wireMarkerContext.getStore()?.mode ||
      wireMarkerContext.getStore()?.speed
    ) {
      // A marker asks for something only a connection's wire can grant; without
      // one there is nothing that says how, or whether, to send it.
      return c.json(
        wrapAnthropicError(
          400,
          `claudish: ${this.targetModel} has no catalog wire, so a +mode or #speed marker cannot be applied`,
          "invalid_request_error"
        ),
        400 as any
      );
    } else if (this.options.proOnUltracode) {
      applyProInjection(requestPayload, {
        enabled: true,
        sessionId: extractSessionId(claudeRequest?.metadata),
        bareModelName: this.bareModelName,
        provider: this.provider.name,
        targetModel: this.targetModel,
        outputConfig: claudeRequest?.output_config,
        registry: this.options.sessionEventRegistry,
        cachePath: this.options.catalogCachePath,
      });
    }

    // 5a. --model-params: the user's last word on the payload.
    if (this.options.modelParams) {
      deepMergeParams(requestPayload, this.options.modelParams);
      log(
        `[ComposedHandler] Merged --model-params (${Object.keys(this.options.modelParams).join(", ")}) for ${this.targetModel}`
      );
    }

    // 5b. Refresh auth / health check (must happen before transformPayload, which may use auth state)
    if (this.provider.refreshAuth) {
      try {
        await this.provider.refreshAuth();
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
        // CLASSIFY FIRST — before `err.terminal`, before anything invents a
        // status. `refreshAuth()` is a NETWORK call for most transports
        // (Antigravity makes three, Vertex mints a token, a local provider
        // probes its own server), so "the refresh threw" and "the credential is
        // bad" are two different facts and only one of them is this catch's
        // subject. Answering 401 for the network one is not a cosmetic
        // mislabel: `fallback-handler.ts`'s `isRetryableError` treats 401 as
        // retryable, so a DNS or refused-connection failure here walked the
        // user across every provider in the chain — off a subscription onto
        // metered billing — for an outage on their own machine.
        //
        const conn = classifyConnectionError(err);
        if (conn) {
          // The refresh path's deadline is DELIBERATELY earlier than the fetch
          // path's. Both live in the same request and share one budget; if a
          // refresh recovers at the very end of it and then succeeds, the flow
          // proceeds to the primary fetch — byte-identical to today's
          // expression and therefore unclamped — and a maximal connect hang
          // would land the response write a whole connect timeout past the
          // deadline.
          const outcome = await this.recoverAtAuthSite(
            c,
            err,
            conn,
            this.connectionEndpointFor(err),
            () => this.provider.refreshAuth!(),
            {
              startTime,
              deadlineAt: refreshDeadlineAt(tier1DeadlineAt(c)),
              fallbackMeta,
              authType: "oauth",
              site: "refreshAuth",
              recovery: recoveryTally,
            },
            "401"
          );
          if (outcome.kind === "respond") return outcome.response;
          // Recovered: fall through as if the first refresh had succeeded.
        } else {
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
          // One classifier for every credential site (`auth-failure.ts`):
          //   - terminal (misconfiguration, revoked entitlement, expired login)
          //     → 400 with the terminal verdict. Answering 401 sent the client
          //     into ~11 retries over two minutes of backoff with the message
          //     hidden behind "API error · Retrying", and walked the chain.
          //   - transient (the token host answered 5xx/429) → 503/429 with the
          //     transient verdict, never 401: the same hop answers on retry.
          //   - unclassifiable: a SUBSCRIPTION → 503 with the transient verdict
          //     (retried, never walked; a dead login is marked terminal by its
          //     producer, `credential-error.ts`); a METERED provider → 401 as
          //     before, so the chain may try a provider with another credential.
          const answered = this.answerAuthFailure(c, err, "401");
          if (answered) return answered;
          throw err;
        }
      }
      // Update display name in case auth resolved it (e.g., Gemini tier
      // detection). Moved out of the `try` so it runs after a RECOVERED
      // refresh too — a refresh that only succeeded on attempt four resolved
      // the same names as one that succeeded on attempt one.
      if (this.provider.displayName) {
        this.tokenTracker.setProviderDisplayName(this.provider.displayName);
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

    // 5c. Provider payload transformation (e.g., CodeAssist envelope wrapping)
    if (this.provider.transformPayload) {
      requestPayload = this.provider.transformPayload(requestPayload, claudeRequest);
    }

    // (Middleware beforeRequest ran at step 3b, before buildPayload — see the
    // note there for why it cannot run at this point.)

    const endpoint = this.provider.getEndpoint(this.targetModel);
    // The ORIGINAL inbound body, not the normalized `claudeRequest` clone: a
    // header carrying conversation identity must see what Claude Code sent.
    //
    // `getHeaders()` sat outside EVERY try, and for some transports it is the
    // request's first network touch — `gk@` reaches
    // `resolveGrokAccessToken()` → `fetch(auth.x.ai/oauth2/token)` from here
    // when the cached token has expired. An unclassified throw escaped `handle()`
    // entirely and landed in one of two places, neither of which says anything
    // true: `fallback-handler.ts`'s catch, which records `status: 0` and
    // ADVANCES THE CHAIN with not even the per-token cost warning (that warning
    // sits on the non-throwing branch), or — for a single-candidate route, where
    // no FallbackHandler exists — `proxy-server.ts`'s bare 500.
    //
    // The touch is refresh-conditional, which makes this rare, not safe.
    // Every header fetch below goes through this, so a header the wire requires
    // (a beta token next to the field it wrote) survives the auth retries too.
    // The headers of THIS request's latest attempt — the one whose answer is
    // returned (primary, parameter re-fetch or auth retry), recorded on this
    // call's own `signing` record so a concurrent request on the same handler
    // cannot replace it. `handle` names the signer from them (`signingCredential`).
    const fetchHeaders = async (): Promise<Record<string, string>> => {
      const fetched = await this.provider.getHeaders(payload);
      mergeWireHeaders(fetched, wireHeaders);
      signing.headers = fetched;
      return fetched;
    };
    let headers: Record<string, string>;
    try {
      headers = await fetchHeaders();
    } catch (err: any) {
      const conn = classifyConnectionError(err);
      if (!conn) {
        // A credential failure this site can place is answered here — terminal
        // as 400; transient, or a subscription's unclassifiable one, as 503/429.
        // Anything else (a metered provider's unclassifiable throw) keeps its
        // existing route out of here untouched.
        const answered = this.answerAuthFailure(c, err, "rethrow");
        if (answered) return answered;
        throw err;
      }
      const outcome = await this.recoverAtAuthSite<Record<string, string>>(
        c,
        err,
        conn,
        this.connectionEndpointFor(err, endpoint),
        fetchHeaders,
        {
          startTime,
          // An auth site with the unclamped primary fetch still ahead of it —
          // same reservation as the refreshAuth catch, same reason.
          deadlineAt: refreshDeadlineAt(tier1DeadlineAt(c)),
          fallbackMeta,
          authType: "oauth",
          site: "getHeaders",
          recovery: recoveryTally,
        },
        "rethrow"
      );
      if (outcome.kind === "respond") return outcome.response;
      headers = outcome.value;
    }

    // 6a. The body is NOT necessarily JSON. A transport may serialize the
    // payload itself (Devin encodes Connect-protobuf, credential and all).
    // Computed ONCE — retries must re-send identical bytes — and
    // default-preserving: a transport that leaves `serializeBody` undefined
    // yields `undefined` here and every expression below collapses to exactly
    // what it was before this hook existed.
    // Always the encoding of the CURRENT `requestPayload`: parameter recovery
    // replaces the payload and re-encodes it here, so the 401 auth retry below
    // never resends bytes the provider already rejected.
    let serialized = this.provider.serializeBody?.(requestPayload);
    headers["Content-Type"] = serialized?.contentType ?? "application/json";

    log(`[${this.provider.displayName}] Calling API: ${endpoint}`);

    // Merge provider-specific fetch options (e.g., undici dispatcher, abort signal)
    const requestInit = this.provider.getRequestInit?.() || {};

    // THE REQUEST'S OWN CEILING — the one thing outside the `catch` that this
    // feature adds to a healthy request, and the reason it is here rather than
    // in the ladder: an unclamped attempt 1 could outlive the whole derived
    // deadline (measured: 75 s of macOS connect against a 30 s budget, answered
    // at 108 s), which makes the budget a suggestion. It is absolute, it fires
    // at `deadlineAt` and never earlier, and it is disarmed the instant the
    // call settles — see `deadlineClamp` for why both of those are what keep it
    // from turning a slow answer into a re-issued one.
    const deadlineAt = tier1DeadlineAt(c);
    const clamp = deadlineClamp(deadlineAt);
    const doFetch = () =>
      fetch(
        endpoint,
        mergeSignalIntoInit(
          {
            method: "POST",
            headers,
            body: serialized?.body ?? JSON.stringify(requestPayload),
            ...requestInit,
          },
          clamp.signal
        )
      );

    let response: Response;
    try {
      try {
        response = this.provider.enqueueRequest
          ? await this.provider.enqueueRequest(doFetch)
          : await doFetch();
      } finally {
        // Before a byte of the body is read, so the ceiling can only ever bound
        // connect-and-headers — never cut a response already arriving.
        clamp.disarm();
      }
    } catch (error: any) {
      // A failure to even REACH the provider (DNS can't resolve, connection
      // refused, host unreachable) is a LOCAL network problem, not an upstream
      // server error. Surface it as a connection_error with an honest,
      // actionable message so Claude Code and the config probe show "can't reach
      // host — check your network/DNS" instead of a mystifying 500. (A Tailscale
      // MagicDNS outage making chatgpt.com unresolvable is what motivated this.)
      const conn = classifyConnectionError(error);
      if (!conn) {
        // Not a connection fault: answer it the way the other credential sites
        // do. A transport's `enqueueRequest` can mint or refresh a credential
        // here (`muse@` mints its key per request), so a dead login (terminal
        // 400), a token host's 429/5xx (transient) or a SUBSCRIPTION's
        // unclassified throw (transient 503) lands as a response. Escaping
        // `handle()` instead is the five-sites bug: FallbackHandler records
        // status 0 and advances a subscription onto a metered hop. A METERED
        // unknown is still rethrown unchanged ("rethrow").
        const answered = this.answerAuthFailure(c, error, "rethrow");
        if (answered) return answered;
        throw error;
      }

      // Every construct below is built HERE, inside the catch, after
      // classification returned non-null. A successful request never executes
      // one line of it, and the expression above is byte-identical to what it
      // was before recovery existed — including its `enqueueRequest` ternary.
      //
      // The re-issue must go through that SAME ternary. Six transports
      // implement `enqueueRequest`, and what they implement is not decoration:
      // a bounded 429 loop with `Retry-After`, a model-fallback chain drawn
      // from the dynamic models catalog, and the local concurrency gate that
      // stops `ollama@llama3.2:3` running four inferences at once. Skipping it
      // would make the attempt that finally CONNECTS behave differently from
      // the one that failed — and at the moment a network returns, N woken
      // waiters would stampede unqueued into a provider that has just come back.
      //
      // `getRequestInit()` IS CALLED AGAIN, PER ATTEMPT, and that is not a
      // tidiness preference. A transport may return a ONE-SHOT signal from it —
      // `vertex-oauth.ts` returns `AbortSignal.timeout(30000)`, `local.ts` a
      // ten-minute one — and `mergeSignalIntoInit` composes it with the clamp
      // via `AbortSignal.any`. Re-using the hoisted object meant that from 30 s
      // after the FIRST call, every ladder attempt was handed an
      // already-aborted signal and rejected instantly without touching the
      // network: tier 1 silently dead past t+30 s, the request held for the
      // full ~270 s deadline making ZERO real connect attempts, while the
      // `[Recovery]` log and the pane both reported attempts that never left
      // the process. A transport ceiling that must survive across attempts has
      // to be RE-MINTED, never re-used. `doParamRetry` and `doAuthRetry` below
      // already call it freshly per attempt; this is the same rule.
      const doFetchWith = (sig: AbortSignal) =>
        fetch(
          endpoint,
          mergeSignalIntoInit(
            {
              method: "POST",
              headers,
              body: serialized?.body ?? JSON.stringify(requestPayload),
              ...(this.provider.getRequestInit?.() || {}),
            },
            sig
          )
        );
      const reissue = (sig: AbortSignal) => {
        const attempt = () => doFetchWith(sig);
        return this.provider.enqueueRequest
          ? this.provider.enqueueRequest(attempt, { signal: sig })
          : attempt();
      };

      // Through the auth-site wrapper: a re-issue that fails with something
      // other than a connection fault is classified like any credential
      // failure, not rethrown out of `handle()` into a status-0 chain advance.
      const outcome = await this.recoverAtAuthSite<Response>(
        c,
        error,
        conn,
        endpoint,
        reissue,
        {
          startTime,
          // The SAME value the primary attempt was bounded by, not a fresh read.
          deadlineAt,
          fallbackMeta,
          site: "fetch",
          recovery: recoveryTally,
        },
        "rethrow"
      );
      if (outcome.kind === "respond") return outcome.response;
      response = outcome.value;
    }

    // We reached the host. ANY status proves that — a 401 is a conversation, a
    // refused socket is not — so this is the moment an episode parked in
    // `handoff` for this target learns that its outage is over.
    //
    // It has to be said here rather than left to the grace timer because tier
    // 2's rejoin is not what happens when the network comes back. Claude Code's
    // re-POST enters the byte-identical primary fetch ABOVE, which succeeds
    // outright: no catch, no `joinEpisode`, no rejoin — and the pane would go
    // on painting "waiting for Claude Code to retry" over a working session for
    // the rest of the 120-second grace.
    //
    // `episodeCount()` is a `Map.size` read and is 0 on every machine that has
    // never had an outage, so the healthy path pays one integer comparison for
    // a banner that stops lying.
    if (episodeCount() > 0) noteTargetReachable(this.provider.name, endpoint);

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
      // 4xx caused by an OPTIONAL parameter the model dialect added
      // speculatively: let the dialect rewrite the payload and retry ONCE.
      //
      // This is what lets a dialect send a capability parameter optimistically
      // instead of withholding it from every model it cannot prove supports it.
      // Withholding fails silently — the user's setting vanishes and the only
      // symptom is different model behaviour — whereas sending fails here,
      // loudly, and is repaired in one round-trip that is then remembered.
      // Motivating case: grok-4.6 accepts `reasoning_effort` but postdated the
      // allowlist, so it silently ran at the provider's default (near-`high`)
      // tier and blew a 900s team deadline.
      //
      // Bounded to a single attempt on purpose: the dialect records the verdict,
      // so a second failure means the error was never about that parameter.
      //
      // BOTH ADAPTERS ARE ASKED, in Layer order. This used to call
      // `this.modelAdapter` alone, which silently excluded every model that
      // resolves to `DefaultAPIFormat`: `resolveModelDialect` returns it for any
      // model no dialect recognises, and the constructor above deliberately
      // leaves `modelAdapter` unset for exactly that value. So an unrecognized
      // model on a custom OpenAI-compatible endpoint — a brand-new
      // `vendor/new-model`, which is the population most likely to meet a strict
      // relay — reached a 400 `Unknown parameter: 'stop'` with no recovery at
      // all, even though `BaseAPIFormat.recoverFromRejection` is written to
      // repair precisely that. The Layer 1 converter is also the adapter that
      // BUILT the payload (`getAdapter()` is `explicitAdapter || resolvedDialect`),
      // so it is the one that added the optional parameter in the first place.
      //
      // Deduped by identity, first non-null wins. Every implementation is
      // stateless with respect to the payload — it returns a NEW object and
      // mutates nothing — so asking a second one after the first declines costs
      // nothing and cannot corrupt the retry.
      if (response.status >= 400 && response.status < 500) {
        const candidates = [this.modelAdapter, this.getAdapter()].filter(
          (a, i, all): a is BaseModelAdapter => !!a?.recoverFromRejection && all.indexOf(a) === i
        );
        const errorText =
          candidates.length > 0 || wireBorrowed.length > 0 ? await response.clone().text() : "";
        // Fields borrowed from the owner's connection (this connection's own
        // value is unknown) are the first suspects: tried in turn, dropped on the
        // 400 that names them. Only those fields — never one the wire published.
        let recovery: { payload: any; note: string } | null = recoverBorrowedWireFields(
          requestPayload,
          wireBorrowed,
          errorText
        );
        if (recovery) wireBorrowed = [];
        for (const candidate of recovery ? [] : candidates) {
          recovery = candidate.recoverFromRejection(requestPayload, errorText);
          if (recovery) break;
        }
        if (recovery) {
          log(`[${this.provider.displayName}] Parameter rejected — retrying: ${recovery.note}`);
          requestPayload = recovery.payload;
          // Re-serialize: a transport that owns its own encoding (Devin) must
          // re-encode the changed payload rather than resend the stale bytes.
          serialized = this.provider.serializeBody?.(requestPayload);
          const retrySerialized = serialized;
          // This re-fetch had NO `try` at all. A connection throw therefore
          // escaped handle() entirely and landed in `fallback-handler.ts`'s
          // catch, which pushes `{ status: 0 }` and advances the chain
          // unconditionally — the same silent move onto metered billing the
          // auth catches make, reached from a different direction.
          //
          // A classified failure answers with the network truth rather than
          // re-reporting the original parameter complaint: the parameter is no
          // longer what is wrong, and repeating it would send the chain hunting
          // for a provider that accepts it while the machine is offline. An
          // UNCLASSIFIED throw is rethrown unchanged, so the existing 500 route
          // out of here is untouched.
          const doParamRetry = async (sig?: AbortSignal): Promise<Response> => {
            const retryHeaders = await fetchHeaders();
            retryHeaders["Content-Type"] = retrySerialized?.contentType ?? "application/json";
            return fetch(
              endpoint,
              mergeSignalIntoInit(
                {
                  method: "POST",
                  headers: retryHeaders,
                  body: retrySerialized?.body ?? JSON.stringify(requestPayload),
                  ...(this.provider.getRequestInit?.() || {}),
                },
                sig
              )
            );
          };
          let retryResp: Response;
          try {
            retryResp = await doParamRetry();
          } catch (err: any) {
            const conn = classifyConnectionError(err);
            if (!conn) {
              // The re-fetch re-reads the headers, so a credential failure can
              // surface here too; one this site can place is answered.
              const answered = this.answerAuthFailure(c, err, "rethrow");
              if (answered) return answered;
              throw err;
            }
            const outcome = await this.recoverAtAuthSite<Response>(
              c,
              err,
              conn,
              this.connectionEndpointFor(err, endpoint),
              doParamRetry,
              {
                startTime,
                // The full budget: this site runs AFTER the primary fetch, so
                // there is no unclamped attempt left ahead of it to reserve for.
                deadlineAt: tier1DeadlineAt(c),
                fallbackMeta,
                retriedBeforeLadder: true,
                site: "parameter-recovery",
                recovery: recoveryTally,
              },
              "rethrow"
            );
            if (outcome.kind === "respond") return outcome.response;
            retryResp = outcome.value;
          }
          if (retryResp.ok) {
            response = retryResp;
          } else if (isCredentialRejection(retryResp.status, await retryResp.clone().text())) {
            // The re-fetch's credential was REJECTED (401/403 that is not a
            // model, quota or region answer). That is the newer, decisive fact:
            // the parameter is fixed and the login is what is wrong now. It
            // replaces the original 400 and takes the normal error path, so a
            // 401 still gets the forced refresh, and a subscription's rejection
            // answers the terminal 400 with the verdict and the
            // `claudish login …` line (D10). Reporting the parameter 400
            // instead dropped both, and a metered key could not advance.
            log(
              `[${this.provider.displayName}] Retry after ${recovery.note} was rejected ` +
                `(HTTP ${retryResp.status}); reporting the credential rejection`
            );
            response = retryResp;
          } else {
            // Fall through to the normal error path with the ORIGINAL response,
            // so the user sees the real upstream complaint rather than the
            // artefact of our retry.
            log(
              `[${this.provider.displayName}] Retry after ${recovery.note} still failed ` +
                `(HTTP ${retryResp.status})`
            );
          }
        }
      }
    }

    if (!response.ok) {
      // 401: retry with forced auth refresh (OAuth token expiry)
      if (response.status === 401 && this.provider.forceRefreshAuth) {
        log(`[${this.provider.displayName}] Got 401, forcing auth refresh and retrying`);
        // The forced refresh AND the retry fetch that follows it, as one
        // re-issuable operation. Both are network calls and either can fail
        // transiently, so a ladder that could only re-run one of them would
        // leave the other exactly as exposed as it was.
        const doAuthRetry = async (sig?: AbortSignal): Promise<Response> => {
          // The headers of the request the upstream rejected, so a transport can
          // tell a stale failure from one naming the credential it holds now.
          await this.provider.forceRefreshAuth!({ rejectedHeaders: headers });
          const retryHeaders = await fetchHeaders();
          // Same serialization as the primary request — this is a separate call
          // site and the easy one to forget, which is why both are pinned by
          // the same assertion.
          retryHeaders["Content-Type"] = serialized?.contentType ?? "application/json";
          const retryInit = this.provider.getRequestInit?.() || {};
          return fetch(
            endpoint,
            mergeSignalIntoInit(
              {
                method: "POST",
                headers: retryHeaders,
                body: serialized?.body ?? JSON.stringify(requestPayload),
                ...retryInit,
              },
              sig
            )
          );
        };
        /** Returns a Response to answer with, or null to carry on streaming. */
        const settleAuthRetry = async (retryResp: Response): Promise<Response | null> => {
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
                ...this.recoveryStats(recoveryTally),
              });
            } catch {
              // Stats must never crash claudish
            }
            // A 401/403 that SURVIVED a fresh credential is terminal for a
            // subscription, or wherever the transport says so: answered 400 with
            // the terminal verdict and the same hint and wording as the generic
            // remap below, so the login line lands inline and the chain stops.
            // 401/403 ONLY: Antigravity's terminal 429 keeps its own route.
            if (retryResp.status === 401 || retryResp.status === 403) {
              const transportTerminal = this.provider.classifyTerminalError?.(
                retryResp.status,
                errorText
              );
              // The subscription stop is for a credential rejection only; a model
              // or allowance miss keeps its pass-through route (`isCredentialRejection`).
              if (
                (isSubscriptionProvider(this.provider.name) &&
                  isCredentialRejection(retryResp.status, errorText)) ||
                transportTerminal === true
              ) {
                const hint = getRecoveryHint(
                  retryResp.status,
                  errorText,
                  this.provider.displayName,
                  transportTerminal,
                  this.provider.name
                );
                let parsed: unknown;
                try {
                  parsed = JSON.parse(errorText);
                } catch {
                  parsed = undefined;
                }
                const providerMsg = extractProviderMessage(parsed ?? errorText);
                const surfaced = buildSurfacedErrorMessage({
                  providerDisplayName: this.provider.displayName,
                  status: retryResp.status,
                  hint,
                  providerMessage: providerMsg,
                });
                return c.json(
                  wrapAnthropicError(
                    400,
                    surfaced,
                    "invalid_request_error",
                    retryResp.status,
                    providerMsg
                  ),
                  400 as any,
                  authVerdictHeaders("terminal")
                );
              }
            }
            return c.json(wrapAnthropicError(retryResp.status, errorText), retryResp.status as any);
          }
          return null;
        };
        try {
          const answered = await settleAuthRetry(await doAuthRetry());
          if (answered) return answered;
        } catch (err: any) {
          // CLASSIFY FIRST, exactly as in the refreshAuth catch above, and for a
          // sharper reason: this path covers BOTH `forceRefreshAuth()` AND the
          // raw retry `fetch` that follows it, so "the network dropped while we
          // were re-signing a request" arrives here and left as an unconditional
          // `authentication_error` 401. `isRetryableError` reads 401 as
          // retryable, so the upstream's 401 plus a network blip got relabelled
          // as an auth failure and ADVANCED THE CHAIN — a subscription user
          // moved onto a metered candidate mid-outage, which is the one outcome
          // this whole area exists to prevent.
          const conn = classifyConnectionError(err);
          if (conn) {
            const outcome = await this.recoverAtAuthSite<Response>(
              c,
              err,
              conn,
              this.connectionEndpointFor(err, endpoint),
              doAuthRetry,
              {
                startTime,
                deadlineAt: tier1DeadlineAt(c),
                fallbackMeta,
                retriedBeforeLadder: true,
                authType: "oauth",
                site: "forceRefreshAuth",
                recovery: recoveryTally,
              },
              "401"
            );
            if (outcome.kind === "respond") return outcome.response;
            const answered = await settleAuthRetry(outcome.value);
            if (answered) return answered;
            // Recovered and streaming: `response` was reassigned by
            // settleAuthRetry. Fall through to the shared stream handling.
          } else {
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
                ...this.recoveryStats(recoveryTally),
              });
            } catch {
              // Stats must never crash claudish
            }
            // The same classifier as the refreshAuth catch: terminal → 400 with
            // the terminal verdict; transient, or a subscription's
            // unclassifiable failure → 503/429 with the transient verdict; a
            // metered provider's unclassifiable failure → 401 as before.
            const answered = this.answerAuthFailure(c, err, "401");
            if (answered) return answered;
            throw err;
          }
        }
      } else {
        const errorText = await response.text();
        log(`[${this.provider.displayName}] Error: ${errorText}`);
        // Durable copy, opt-in via CLAUDISH_UPSTREAM_ERROR_LOG. `log()` only
        // persists under --debug, so without this the body that distinguishes a
        // retryable rate limit from a hard quota wall is gone the moment it is
        // classified. No-op and non-throwing when the env var is unset.
        captureUpstreamError({
          provider: this.provider.displayName,
          model: this.bareModelName,
          status: response.status,
          body: errorText,
        });
        // A transport that parses its provider's structured errors outranks the
        // shared substring heuristics — computed ONCE here so the user-facing
        // hint and the terminal/retryable remap below cannot disagree about what
        // happened. `undefined` (the default for every transport without the
        // hook) leaves the generic rules exactly as they were.
        const transportTerminal = this.provider.classifyTerminalError?.(response.status, errorText);
        const hint = getRecoveryHint(
          response.status,
          errorText,
          this.provider.displayName,
          transportTerminal,
          // The INTERNAL name, beside the display name: the catalog is keyed by
          // it, and an auth failure on a vendor with sibling-tier keys needs
          // that lookup to say which other key exists. A transport whose name
          // is not a catalog entry (a custom endpoint) simply finds nothing and
          // gets today's sentence unchanged.
          this.provider.name
        );
        let parsedErrorBody: any;
        try {
          parsedErrorBody = JSON.parse(errorText);
        } catch {
          parsedErrorBody = undefined;
        }
        const providerMsg = extractProviderMessage(parsedErrorBody ?? errorText);
        // Richer stderr line: provider + status + hint + the real upstream message,
        // so the cause is findable in scrollback even when Claude Code only shows
        // its own "API error · Retrying" banner.
        //
        // "One tidy line" used to be bounded by LENGTH alone, which is a different
        // promise: `extractProviderMessage` returns a non-JSON body verbatim, and a
        // provider may answer an error as an SSE frame rather than a document —
        // Alibaba Model Studio answers a denied model with `event:error\ndata:{…}`.
        // 200 characters of that is still three lines, and three lines written into
        // a terminal a TUI is painting tears the frame. Collapsing whitespace FIRST
        // is what makes the sentence true; the slice then bounds what is already
        // one line.
        const oneLineMsg = providerMsg.replace(/\s+/g, " ").trim();
        const msgTail = oneLineMsg
          ? ` (${oneLineMsg.length > 200 ? `${oneLineMsg.slice(0, 200)}…` : oneLineMsg})`
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
            ...this.recoveryStats(recoveryTally),
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
        if (
          isTerminalError(response.status, errorText, transportTerminal ?? isTerminal429(errorText))
        ) {
          const surfaced = buildSurfacedErrorMessage({
            providerDisplayName: this.provider.displayName,
            status: response.status,
            hint,
            providerMessage: providerMsg,
            // The one phrase an Anthropic client recognises for an oversized
            // prompt. Providers state the same fact in their own words, which
            // no client matches — see CONTEXT_OVERFLOW_PHRASE.
            leadPhrase: isContextOverflowError(response.status, errorText)
              ? CONTEXT_OVERFLOW_PHRASE
              : undefined,
          });
          // A SUBSCRIPTION's rejected credential stops the routing chain here
          // (`auth-failure.ts`): the next hop would bill the user per token for a
          // login they can fix. A spent allowance (402/429) is not a credential
          // failure and still advances, with its warning.
          // A model the provider does not carry (Zen Go's 401 "Model <id> is not
          // supported") is NOT a credential rejection and keeps advancing.
          const verdictHeaders =
            isSubscriptionProvider(this.provider.name) &&
            isCredentialRejection(response.status, errorText)
              ? authVerdictHeaders("terminal")
              : undefined;
          // Carry the ORIGINAL upstream status as a structured field so
          // machine consumers (probe classification) can tell a remapped
          // auth failure from a genuine 400.
          return c.json(
            wrapAnthropicError(
              400,
              surfaced,
              "invalid_request_error",
              response.status,
              // The upstream's own sentence, kept whole and separate. `surfaced`
              // leads with claudish's hint, which is correct for Claude Code and
              // useless to a probe row that clips.
              providerMsg
            ),
            400 as any,
            verdictHeaders
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
            ...this.recoveryStats(recoveryTally),
          });
        } catch {
          // Stats must never crash claudish
        }
        // `settled.message` is the upstream's own text; `surfaced` wraps it in
        // claudish's retry narration. Both travel, so a probe row can lead with
        // the provider's words.
        return c.json(
          wrapAnthropicError(503, surfaced, "overloaded_error", undefined, settled.message),
          503 as any,
          settled.unreachable ? connectionFaultHeaders() : undefined
        );
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
            ...this.recoveryStats(recoveryTally),
          });
        } catch {
          // Stats must never crash claudish
        }
        return isTerminal
          ? c.json(
              wrapAnthropicError(
                400,
                surfaced,
                "invalid_request_error",
                undefined,
                settled.message
              ),
              400 as any
            )
          : c.json(
              wrapAnthropicError(503, surfaced, "overloaded_error", undefined, settled.message),
              503 as any,
              settled.kind === "exhausted" && settled.unreachable
                ? connectionFaultHeaders()
                : undefined
            );
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
          ...this.recoveryStats(recoveryTally),
        });
      } catch {
        // Stats must never crash claudish
      }
      try {
        // Hook telemetry's turn denominator. getInputTokens() is the FULL
        // conversation context for this request (assignment, not accumulation
        // — see the context-tracking note in CLAUDE.md), which is exactly the
        // figure the context bucket wants. No-op unless behaviour telemetry is
        // opted in.
        hookScope?.noteTurnComplete(this.tokenTracker.getInputTokens());
      } catch {
        // Telemetry must never crash claudish
      }
    };

    const streamed = this.handleStream(
      c,
      response,
      adapter,
      claudeRequest,
      toolNameMap,
      onStreamComplete,
      (code, message) => {
        streamApiError = { code, message };
      }
    );

    // A client that did not ask for a stream gets the single JSON message the
    // Messages API defines, not SSE. `=== true` rather than `!== false` because
    // the API treats an absent `stream` as false, and NativeHandler already
    // behaves that way — it forwards the payload verbatim and Anthropic decides
    // — so anything looser would leave proxied models disagreeing with native
    // ones, which is the bug being fixed. Claudish's own internal callers
    // (mcp-server.ts:235, probe-live.ts:139) both send `stream: true`
    // explicitly, so this changes nothing for them.
    if (payload?.stream === true) return streamed;
    return sseResponseToJson(streamed, this.bareModelName);
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
   * 503. For a pinned `provider@model` there is no FallbackHandler, so the 503
   * reaches Claude Code, which runs its own retry loop against the same model.
   * Inside a bare-name chain, fallback-handler's isRetryableError advances on it
   * to the next candidate: this provider stayed overloaded through every retry.
   */
  private async settleResponsesStreamHead(
    initial: Response,
    reissue: () => Promise<Response>
  ): Promise<
    | { kind: "ok"; response: Response }
    | { kind: "exhausted"; code: string; message: string; attempts: number; unreachable?: true }
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
          // A connection fault, not the provider's answer. The caller marks the
          // 503 with the connection-fault header, so a routing chain HOLDS here
          // instead of advancing onto the next (possibly metered) candidate.
          unreachable: true,
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
   * Terminal messages pass through the transport's rewrite when it offers one.
   * That rewrite checks the dynamic models catalog, which is what turns an
   * opaque backend string into "that uid is not served by your subscription;
   * here is what is".
   */
  private async settleDevinStreamHead(
    initial: Response,
    reissue: () => Promise<Response>
  ): Promise<
    | { kind: "ok"; response: Response }
    | { kind: "terminal"; code: string; message: string }
    | { kind: "exhausted"; code: string; message: string; attempts: number; unreachable?: true }
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
          // A connection fault, not the provider's answer. The caller marks the
          // 503 with the connection-fault header, so a routing chain HOLDS here
          // instead of advancing onto the next (possibly metered) candidate.
          unreachable: true,
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
  /**
   * Introspection seam — the three facts that define this handler's composition,
   * without going through a live request.
   *
   * Exists because a mis-composed handler is invisible until it hits the wire: the
   * Zen Go MiniMax bug shipped an Anthropic format+transport pointed at an
   * `/v1/chat/completions` endpoint, and that pairing was only observable as a 400
   * from the upstream vendor. `endpoint` is included precisely because the failure
   * was a format/endpoint MISMATCH — neither field alone would have caught it.
   */
  describeComposition(): { transport: string; streamFormat: string; endpoint: string } {
    return {
      transport: this.provider.name,
      streamFormat: this.resolveStreamFormat(),
      endpoint: this.provider.getEndpoint(this.bareModelName),
    };
  }

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
    onApiError?: (code: string, message: string) => void
  ): Response {
    // Local mutable copy so we can null it out after firing (prevents double-firing)
    // without reassigning the function parameter.
    let pendingOnComplete = onComplete;
    // `input` is the FULL context size, always — never the cache-reduced figure
    // that rides on the wire. `detail` is the optional cached breakdown of that
    // same number and is used for COST ONLY; see UsageCacheDetail and
    // `context-window.md`, which records what happens when a reduced count
    // reaches the context accounting (auto-compaction silently disarms).
    const onTokenUpdate = (input: number, output: number, detail?: UsageCacheDetail) => {
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
        default:
          this.tokenTracker.update(input, output, detail);
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

    /**
     * The ONE place a completed tool call is observed. Tool counting feeds the
     * end-of-session summary, which must work for every model on every wire, so
     * every parser below gets it unconditionally.
     *
     * The parsers carry no tool buffering, argument repair or output
     * observation: tool interception is the hook response seam's job, above
     * every parser (`hooks/response-seam.ts`).
     */
    const observeToolCall = (name: string): void => {
      this.tokenTracker.recordToolUse(name);
    };

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
          // Always pass the options object: without it `onToolCallObserved` is not
          // installed on the busiest wire in claudish (GLM, Kimi, Grok, DeepSeek,
          // Qwen, OpenRouter, LiteLLM).
          { onToolCallObserved: observeToolCall }
        );

      case "openai-responses-sse":
        return createResponsesStreamHandler(c, response, {
          modelName: this.bareModelName,
          onTokenUpdate,
          // The map THIS request captured right after prepareRequest — not a
          // fresh read. This runs after an awaited fetch, and on a handler
          // shared by two conversations the adapter's own map may already
          // belong to the next request by now.
          toolNameMap,
          contextWindow: lookupModelForProvider(this.bareModelName, this.provider.name),
          onApiError,
          priorInputTokens,
          middlewareManager: this.middlewareManager,
          onToolCallObserved: observeToolCall,
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
          // on this wire (qtoken@'s qwen / glm / deepseek models).
          adapter: (this.modelAdapter ?? adapter) as BaseAPIFormat,
          onToolCallObserved: observeToolCall,
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
          onToolCallObserved: observeToolCall,
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
          onToolCallObserved: observeToolCall,
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
 * Name the credential that signed THIS request on its response, as
 * `x-claudish-signed-with` (URI-encoded: a tier name need not be a valid
 * header byte string), for a provider with several login sources (muse@: own
 * login, borrowed copy, Keychain). Per response, so `--probe` names the signer
 * of its own request and never a process-wide guess.
 *
 * Set on the returned Response, not through `c.header()`: the Responses stream
 * parser builds its own `new Response`, which never sees the context's headers.
 * Headers a stream parser built are mutable; a frozen set is copied instead.
 */
function withSignerHeader(response: Response, signer: string | undefined): Response {
  if (!signer) return response;
  const value = encodeURIComponent(signer);
  try {
    response.headers.set("x-claudish-signed-with", value);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set("x-claudish-signed-with", value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * Return a human-readable recovery hint based on HTTP status and error body.
 *
 * `transportTerminal429` is the transport's own verdict on a 429 when it can
 * read its provider's structured errors (see
 * `ProviderTransport.classifyTerminalError`). It OVERRIDES the wording
 * heuristics below, which are pattern-matching prose and cannot tell a spent
 * plan from a per-minute throttle when the provider phrases both identically.
 * `undefined` — every transport without the hook — keeps the original behaviour.
 *
 * `providerUid` is the INTERNAL provider name (`ProviderTransport.name`, e.g.
 * `qwen-token-plan`), not the display name, because it is what the provider
 * catalog is keyed by. It is optional and every branch below is unchanged
 * without it: it only lets the auth branch look up whether this vendor ships a
 * SECOND, non-interchangeable key for another tier (`siblingKeyEnvVars`).
 * Nothing is inferred from the credential itself — see the branch for why the
 * key's own bytes are deliberately not read.
 */
export function getRecoveryHint(
  status: number,
  errorText: string,
  providerName: string,
  transportTerminal429?: boolean,
  providerUid?: string
): string {
  const lower = errorText.toLowerCase();

  if (status === 503 || lower.includes("overloaded")) {
    return "Provider overloaded. Retry or use a different model.";
  }
  if (status === 429 && (transportTerminal429 ?? isTerminal429(errorText))) {
    // Terminal, but WHICH terminal? "Out of quota — check your plan & billing
    // details" tells a flat-rate subscriber their money ran out when the real
    // state is a billing cycle that has not reset, sending them to a billing
    // page to fix a plan that is working. MiniMax Coding is the measured case:
    // `429 "Token Plan usage limit reached: Upgrade your Token Plan or purchase
    // Credits for more usage. (2056)"`.
    //
    // Same predicate the probe's `plan-limit` state uses, so this hint and the
    // TUI row cannot disagree about one response — the recurring failure mode
    // this file already guards against for auth vs model-unsupported.
    if (hasPlanLimitWording(errorText)) {
      return "Plan limit reached — your allowance is spent for this cycle and refills on the provider's own schedule (see the message below). Wait, upgrade the plan, or switch provider.";
    }
    return "Out of quota — check your plan & billing details. This won't recover on retry.";
  }
  // The transport has positively identified this 429 as transient. Return the
  // throttling advice here rather than falling through, because the
  // exhaustion-wording branch below would otherwise claim it: Google stamps
  // "Resource has been exhausted (e.g. check quota)." on every RESOURCE_EXHAUSTED
  // reply, so a per-minute rate limit matches "quota" and gets described as a
  // spent subscription allowance that "refills on the provider's own schedule".
  if (status === 429 && transportTerminal429 === false) {
    return "Rate limited. Wait, reduce concurrency, or check plan limits.";
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
    // Some providers (e.g. OpenCode Zen Go) return 401 for a model they do not
    // carry, not for a bad credential. Shared with probe-live's state
    // classifier — see shared/model-unsupported.ts for why one predicate rather
    // than two: this hint said "model not supported" while the probe state said
    // `auth-failed`, so the two surfaces disagreed about the same response.
    if (hasModelUnsupportedWording(errorText)) {
      return "Model not supported by this provider. Verify model name.";
    }
    // A plan that has run out is not an auth failure, but some providers report
    // it as one — see shared/quota-exhaustion.ts for why this is shared with the
    // fallback gate rather than duplicated here.
    if (isQuotaExhaustionError(status, errorText)) {
      // Kimi's coding plan is exactly this shape: `403 permission_error
      // "You've reached your usage limit for this billing cycle"`. It is a spent
      // ALLOWANCE arriving on an auth status, so it takes the plan wording, not
      // the balance wording — same split as the 429 branch above.
      if (hasPlanLimitWording(errorText)) {
        return "Plan limit reached — your allowance is spent for this cycle and refills on the provider's own schedule (see the message below). Wait, upgrade the plan, or switch provider.";
      }
      return "Out of quota — check your plan & billing details. This won't recover on retry.";
    }
    // The provider already said what to do, and it is not "check your key".
    // Measured: Zen Go answers a model the account has not opted into with
    // `403 RegionError … requires explicit opt in: <url>`. The route, the
    // credential and the model are all fine — so telling the user to audit a
    // working credential talks over the fix sitting in the same sentence.
    // Checked LAST, so a genuine auth failure that happens to cite a docs link
    // still reaches the credential advice above via its own wording.
    if (hasActionableLink(errorText)) {
      return "Provider rejected the request and gave a specific fix — follow the link in the message below.";
    }
    // Reached only when the credential really is the most likely cause. For a
    // vendor that sells the SAME models under several plans, "check your key"
    // is still not the whole story: the plans' keys are isolated and rejected
    // by each other's hosts with a near-identical 401, so "right key, wrong
    // silo" is at least as likely as "bad key". Measured 2026-09-17 with one
    // real Alibaba Token Plan key: 200 on `token-plan…`, 401 `invalid access
    // token or token expired` on `coding-intl…`, 401 `Incorrect API key
    // provided` on `dashscope-intl…`.
    //
    // Driven by `siblingKeyEnvVars`, so it is a property of any vendor that
    // declares one (`opencode-zen-go` does today) rather than an Alibaba
    // special case — and the variable names come from the catalog via
    // `describeSiblingKeys`, the same sentence `describeMissingCredential`
    // emits, so the two cannot drift into saying different things about one
    // pair of keys.
    //
    // What this deliberately does NOT do is look at the key. A Token Plan key
    // can match `sk-sp-`, which Alibaba's own Coding Plan docs call their
    // format, so a prefix hint would confidently mislabel a working
    // credential. The key's bytes are never read, which also keeps a failed
    // secret operation out of a status line.
    // "Access denied" for a MODEL is not a credential fault. Alibaba's Model
    // Studio answers `403 Model.AccessDenied "Model access denied."` while the
    // SAME key lists 169 models on the same host, and it answers that way for
    // every model, including ids taken from the account's own list (measured
    // 2026-09-19 on dashscope-intl). Sending the reader to check a key that the
    // provider just accepted wastes the one clue they have: the account, not the
    // credential, is what lacks access.
    if (status === 403 && /access denied|accessdenied/i.test(lower)) {
      return "The provider accepted the credential but denied access to this model — check model access or activation for this account in the provider's console, not the key.";
    }
    // A SUBSCRIPTION that signs with claudish's own login: the rejected
    // credential is that login, so the fix is a new login, not a key audit.
    // Only providers that declare `oauthLoginSlug` get the command (muse@,
    // kc@, gk@, Antigravity); a subscription signed by a key or by another
    // CLI's login (Devin, the Alibaba plans) keeps the generic advice below.
    // `openai-codex` is not in SUBSCRIPTION_PROVIDERS (its arm is decided by
    // the credential that signed), so a metered cx@ key is never told to log in.
    const loginSlug = providerUid ? getProviderByName(providerUid)?.oauthLoginSlug : undefined;
    if (
      loginSlug &&
      providerUid &&
      isSubscriptionProvider(providerUid) &&
      isCredentialRejection(status, errorText)
    ) {
      return `The ${providerName} login was rejected (HTTP ${status}). Run \`claudish login ${loginSlug}\` to sign in again.`;
    }
    const siblingNote = providerUid ? describeSiblingKeys(getProviderByName(providerUid)) : "";
    if (siblingNote) {
      return `Check API key / OAuth credentials. This vendor sells several plans whose keys are isolated, so a ${status} can also mean the right key on the wrong plan's host.${siblingNote}`;
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
    // Read the provider's own attribution BEFORE guessing from prose. The size
    // test below is a substring match on "token", and OpenAI's parameter NAMES
    // contain that word — `max_output_tokens`, `max_completion_tokens` — so a
    // parameter-shape rejection matched it and was reported as a size problem.
    // Measured against `oai@gpt-6-astra`, 6.7 KB of input against a 1.05M
    // window:
    //
    //   400 unknown_parameter — "Unknown parameter: 'max_output_tokens'."
    //   rendered as → "Input too large. Reduce message history or use a
    //                  larger-context model."
    //
    // The hint and the body it quotes then disagreed inside one line, and the
    // advice sent the reader to shrink a prompt that was never the problem.
    if (isRequestShapeError(errorText)) {
      return "Wrong request shape for this endpoint — the provider named the parameter it rejected (see the message below). Nothing was too large; a shorter prompt will not help.";
    }
    // A model the provider does not carry also arrives as a 400 — Alibaba's
    // silos answer an id outside the plan with a bare `Model not exist`. Same
    // predicate the 401/403 branch above uses, for the same reason it exists:
    // one reading of "the MODEL is the problem", so the hint cannot say
    // something different depending on which status the provider chose.
    //
    // Placed AFTER `isRequestShapeError` (a provider that names a parameter has
    // stated the fact, and a heuristic must not talk over it) and BEFORE the
    // size test, which is a bare `includes("token")` and would otherwise claim
    // any model-unsupported body that happens to spell "tokens".
    if (hasModelUnsupportedWording(errorText)) {
      return "Model not supported by this provider. Verify model name.";
    }
    if (lower.includes("context") || lower.includes("too long") || lower.includes("token")) {
      return "Input too large. Reduce message history or use a larger-context model.";
    }
    return "Request format may be incompatible with provider.";
  }
  // 413 is "Payload Too Large" by definition, and until now fell through to
  // "Unexpected HTTP 413 from <provider>" — a status name where the actionable
  // advice already exists three lines above. Gated on the narrow predicate, so a
  // 413 about something other than the prompt keeps the generic line.
  if (isContextOverflowError(status, errorText)) {
    return "Input too large. Reduce message history or use a larger-context model.";
  }
  if (status >= 500) {
    return "Server error — retry after a brief wait.";
  }
  return `Unexpected HTTP ${status} from ${providerName}.`;
}
