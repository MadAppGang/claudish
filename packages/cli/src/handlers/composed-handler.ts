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
 *   3b. raw providerRequest hooks                 — unsafe tier, on committed clones
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

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import {
  type BaseAPIFormat,
  DefaultAPIFormat,
  type EffortLevel,
} from "../adapters/base-api-format.js";
import { MiniMaxModelDialect } from "../adapters/minimax-model-dialect.js";
import { allowanceHintOf, getAllowanceService } from "../auth/accounts/allowance-service.js";
import type { PlanClass, ResponseOutcome, TokenCounts } from "../auth/accounts/allowance/types.js";
import { respondAccountsQuotaFailure } from "../auth/accounts/error-surface.js";
import {
  MeteredEscapeError,
  RefreshUnavailableError,
  isAccountsError,
} from "../auth/accounts/errors.js";
import { planClassOf } from "../auth/accounts/ledger/ledger-row.js";
import {
  type AccountOutcomeFold,
  codexQuotaOutcome,
  reportAccountOutcome,
} from "../auth/accounts/outcomes.js";
import type { SelectReason } from "../auth/accounts/policy.js";
import { getAccountPool } from "../auth/accounts/pool.js";
import type {
  AccountOutcome,
  AccountRef,
  AccountSelectionContext,
  UsageSnapshot,
} from "../auth/accounts/types.js";
import { sameAccount } from "../auth/accounts/types.js";
import { snapshotFromCodexHeaders } from "../auth/accounts/usage/codex.js";
import type { AuthBinding, ProviderTransport, StreamFormat } from "../providers/transport/types.js";
import type { ModelHandler } from "./types.js";
// Alias for readability within this file
type BaseModelAdapter = BaseAPIFormat;
import { lookupModelAcceptsImages, lookupModelForProvider } from "../adapters/model-catalog.js";
import type { QuotaAdapter } from "../auth/quota/adapter.js";
import { resolveQuotaAdapter } from "../auth/quota/registry.js";
import { PLAN_POLL_INTERVAL_MS } from "../auth/quota/types.js";
import { accountKeyFromBinding } from "../code-mode/ids.js";
import { type CodeModeSetting, DEFAULT_CODE_MODE_SETTING } from "../code-mode/policy.js";
import { createCodeModeTurnHooks } from "../code-mode/relay.js";
import {
  type CodeModePayloadContext,
  type PreparedCodeMode,
  isLiteRejection,
  prepareCodeModeRequest,
  rebuildAsClassic,
  withoutLiteHeader,
} from "../code-mode/request.js";
import { resumeFromToolResults } from "../code-mode/resume.js";
import { loadQuickJSModule } from "../code-mode/sandbox/quickjs-loader.js";
import { getCodeModeStores, peekCodeModeStores } from "../code-mode/stores.js";
import { conversationMessages } from "../code-mode/types.js";
import { extractSessionId as extractHarnessSessionId } from "../hooks/harness.js";
import { getHookEngine } from "../hooks/index.js";
import { type RawStreamTap, statsNames } from "../hooks/raw.js";
import type { UpstreamFacts } from "../hooks/registry.js";
import { type HookRequestScope, isNativeRoute, requestHooksOf } from "../hooks/request-stage.js";
import {
  getLogLevel,
  log,
  logRecovery,
  logStderr,
  logStructured,
  truncateContent,
} from "../logger.js";
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
import { resolveRecoveryEnabled, resolveTier1DeadlineMs } from "../recovery/settings.js";
import { redactForClient } from "../redact.js";
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
import {
  type HopAttempt,
  abortedResponse,
  addSigningSecrets,
  callAbortError,
  callAbortSignal,
  callAborted,
  credentialValuesFromRequest,
  raceCallAbort,
  recordHopEntry,
  releaseWhenBodyEnds,
  sleepUnlessAborted,
  withCallSignal,
} from "./shared/call-context.js";
import {
  type CodexUsageLimit,
  parseCodexUsageLimit,
  resolveUsageLimitResetAt,
} from "./shared/codex-usage-limit.js";
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
import {
  CREDENTIAL_DECIDED_PROVIDERS,
  type RequestBilling,
  isSubscriptionProvider,
} from "./shared/remote-provider-types.js";
import {
  CONTEXT_OVERFLOW_PHRASE,
  isContextOverflowError,
  isRequestShapeError,
} from "./shared/request-shape.js";
import {
  type LegAuthBinding,
  createLegIssuer,
  isSameCredentialSilo,
} from "./shared/responses-leg-issuer.js";
import { sniffResponsesStreamHead } from "./shared/stream-head-sniffer.js";
import { createAnthropicPassthroughStream } from "./shared/stream-parsers/anthropic-sse.js";
import { createDevinConnectStream } from "./shared/stream-parsers/devin-connect.js";
import { createGeminiSseStream } from "./shared/stream-parsers/gemini-sse.js";
import { createOllamaJsonlStream } from "./shared/stream-parsers/ollama-jsonl.js";
import {
  type CodeModeTurnHooks,
  type ResponsesRetryOptions,
  type TurnBilledUsage,
  createResponsesStreamHandler,
  createSyntheticToolUseReply,
  resolveStallPolicy,
} from "./shared/stream-parsers/openai-responses-sse.js";
import { createStreamingResponseHandler } from "./shared/stream-parsers/openai-sse.js";
import { notifyOnDownstreamCancel } from "./shared/stream-parsers/upstream-cancel.js";
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
 * A retry leg's binding: the request's `AuthBinding` plus the account it names
 * (`accountKeyFromBinding`), which the leg issuer compares between legs.
 */
type LegBinding = AuthBinding & LegAuthBinding;

/** What `handle()` builds for a Responses turn and `handleStream` hands the parser. */
interface ResponsesTurnWiring {
  retry: ResponsesRetryOptions;
  onTurnSummary: (s: { legs: number; legRetries: number }) => void;
  /** Code mode for this turn (`openai-codex`, decided at 5d). */
  codeMode?: CodeModeTurnHooks;
}

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

/**
 * One ACCOUNT attempt of one inbound request, for the usage ledger (allowance
 * architecture §2.2). Opened by `observeResponse` on the subscription arm only,
 * so an api-key request never has one.
 */
interface LedgerAttempt {
  /** Position in the request's attempt list; part of the row id. */
  n: number;
  /** When this attempt's latest response arrived. */
  at: number;
  account: AccountRef;
  reason: SelectReason | undefined;
  /** `x-codex-plan-type`, mapped into the closed set on arrival; the header text is never kept. */
  planClass: PlanClass | null;
  usage?: UsageSnapshot;
  outcome: ResponseOutcome;
  written: boolean;
}

/**
 * The request's ledger drafts, owned by ONE inbound request (never the handler
 * or the transport, which serve concurrent turns). `handle()` creates it and
 * writes every attempt not yet written once the request is over: at once for a
 * returned answer or a throw, at the end of the body for a stream.
 */
interface LedgerDraft {
  requestId: string;
  session: string | null;
  attempts: LedgerAttempt[];
  /** This request's billed tokens, every Responses leg included (`onTurnBilled`). */
  billed: TokenCounts | undefined;
  finalInput: number;
  /** Set when the answer is a stream: how the stream ended, read once its body ends. */
  streamOutcome?: () => ResponseOutcome;
  /** Ends this request's in-flight mark in the allowance service; idempotent. */
  releaseFlight: () => void;
}

/** Marks one inbound request in flight for the allowance service (§2.4); never throws. */
function startAllowanceFlight(): () => void {
  try {
    return getAllowanceService().requestStarted();
  } catch {
    return () => {};
  }
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
   * Code mode for `openai-codex` (`auto` | `on` | `off`), resolved by the CLI
   * from `--code-mode` > `CLAUDISH_CODE_MODE` > `codeMode` config. Absent ⇒
   * `DEFAULT_CODE_MODE_SETTING` (`auto`). Read only on the `openai-codex` request path.
   */
  codeMode?: CodeModeSetting;
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
  /**
   * Who issues requests through this handler. `"advisor"` marks a handler built
   * for `--advisor` panel and collector calls, which claudish issues itself:
   * it writes no status-line token file (the main session owns it), skips the
   * plan-usage scrape and poll (that reading belongs on the main status line
   * too), runs no hooks (a panel call is not a harness turn), and
   * tags every stats event `request_role: "advisor"`. Absent on every handler
   * that serves Claude Code's own requests.
   */
  requestRole?: "advisor";
}

export class ComposedHandler implements ModelHandler {
  private provider: ProviderTransport;
  /** The dialect resolved for this model, or the OpenAI-shaped default. */
  private resolvedDialect: BaseAPIFormat;
  private explicitAdapter?: BaseModelAdapter;
  /** Model-specific adapter (GLM, Grok, etc.) — handles model quirks independent of provider */
  private modelAdapter?: BaseModelAdapter;
  private tokenTracker: TokenTracker;
  /** Full routed model string (e.g. "zai@glm-4.7"). Used for provider routing and display echo. */
  private targetModel: string;
  /**
   * Bare model name (e.g. "glm-4.7"), provider prefix stripped. Used for model identity:
   * dialect selection, catalog lookup, raw-hook routing, context tracking. Never contains '@'.
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
      ...(options.requestRole === "advisor" ? { writesTokenFile: false } : {}),
    });
  }

  /**
   * The endpoint a binding signs for, read only for its credential query
   * parameters (Gemini's `?key=`). Never throws: a transport that cannot name
   * its endpoint here simply contributes no query value.
   */
  private signedEndpoint(binding: AuthBinding | undefined): string | undefined {
    try {
      return this.provider.getEndpoint(this.targetModel, binding);
    } catch {
      return undefined;
    }
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

  /**
   * `middleware_names` for stats: the built-in raw hooks (the Gemini
   * thought-signature hook, today) that apply to this route. User hooks never
   * appear, so the OTLP `llm.middleware` attribute is unchanged for them.
   */
  private rawStatsNames(): string[] {
    return statsNames(getHookEngine(), this.routeInfo(), this.upstreamFacts());
  }

  /**
   * What the catalog says about this handler's upstream, for built-ins selected
   * from data rather than by model name (`BuiltinHook.selectByUpstream`). Only
   * with a catalog connection: without one the hooks' name globs decide.
   */
  private upstreamFacts(): UpstreamFacts | undefined {
    const connection = this.options.connection;
    if (!connection) return undefined;
    return {
      wireApi: connection.wire.status === "known" ? connection.wire.api : null,
      vendor: connection.vendor ?? null,
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
   * The ONE writer of this handler's stats events. Every `recordStats` call in
   * this class goes through here, so a field that must be on every event (the
   * request role of an advisor handler) is added in one place and cannot be
   * missed by a site added later.
   */
  private emitStats(event: Parameters<typeof recordStats>[0]): void {
    recordStats(
      this.options.requestRole ? { ...event, request_role: this.options.requestRole } : event
    );
  }

  /**
   * Fill a hop-log entry once the request is signed: the arm from the
   * binding the credential half returned (`RequestAuth.arm`, never inferred
   * from a resolved object's truthiness), and the billing.
   *
   * For a provider whose billing the signing credential decides
   * (`CREDENTIAL_DECIDED_PROVIDERS`, i.e. `openai-codex`) the billing is THIS
   * request's arm: `oauth` is the subscription, anything else (absent
   * included) is metered. It is never `isSubscriptionProvider(name)`, whose
   * probe reads a process-wide last-signed arm that a concurrent main request
   * can overwrite between this request's refresh and this line. Every other
   * provider's billing is its fixed category (`SUBSCRIPTION_PROVIDERS`
   * membership), whatever arm signs: a flat-rate key is still flat-rate.
   */
  private markHopSigned(hop: HopAttempt, binding: AuthBinding | undefined): void {
    hop.arm = binding?.auth?.arm ?? null;
    hop.billing = this.signedBilling(binding).subscription ? "subscription" : "metered";
  }

  /**
   * The billing of a request signed with `binding`, by the rule above: the
   * signing arm for a credential-decided provider, the fixed category for
   * every other one. The ONE derivation shared by the hop label
   * (`markHopSigned`) and the request's cost updates (`handleStream`), so the
   * two cannot disagree.
   */
  private signedBilling(binding: AuthBinding | undefined): RequestBilling {
    const name = this.provider.name.toLowerCase();
    return {
      subscription: CREDENTIAL_DECIDED_PROVIDERS.has(name)
        ? binding?.auth?.arm === "oauth"
        : isSubscriptionProvider(name),
    };
  }

  /**
   * The answer when an internal call's deadline passed (`call-context.ts`).
   * No classification, no recovery, nothing on stderr: the caller has already
   * stopped waiting and reports the timeout itself. One failure stats event,
   * so the attempt is still counted. Unreachable on a main request, which
   * never carries a call signal.
   */
  private respondCallAborted(
    startTime: number,
    fallbackMeta?: { chain: string[]; attempts: number }
  ): Response {
    log(`[${this.provider.displayName}] call stopped: its deadline passed`);
    try {
      this.emitStats({
        model_id: this.targetModel,
        provider_name: this.provider.name,
        stream_format: this.provider.streamFormat,
        latency_ms: Math.round(performance.now() - startTime),
        success: false,
        http_status: 408,
        error_class: "timeout",
        error_code: "call_aborted",
        token_strategy: this.options.tokenStrategy ?? "standard",
        adapter_name: this.getActiveAdapterName(),
        middleware_names: this.rawStatsNames(),
        fallback_used: fallbackMeta !== undefined,
        fallback_chain: fallbackMeta?.chain,
        fallback_attempts: fallbackMeta?.attempts,
        invocation_mode: this.options.invocationMode ?? "auto-route",
      });
    } catch {
      // Stats must never crash claudish
    }
    return abortedResponse();
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
      this.emitStats({
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
        middleware_names: this.rawStatsNames(),
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
      this.emitStats({
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
        middleware_names: this.rawStatsNames(),
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
    //
    // `advisor` is the panel gateway's own value. An advisor call has a 60 s
    // budget a multi-minute hold cannot fit, and a tier-2 503 means nothing to
    // an internal caller; it is named for itself so the skip line in the log
    // says which kind of request skipped the ladder.
    const noRecovery = c.req.header("x-claudish-no-recovery");
    if (noRecovery === "1") return "probe";
    if (noRecovery === "advisor") return "advisor";
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
    if (failure.kind === "connection") return null;
    const quota = respondAccountsQuotaFailure(c, err);
    if (quota) return quota;
    // Typed verdicts never consult billing: a failed account-list read must not
    // invoke the same failing projection while constructing its response.
    const isSubscription = failure.kind === "unknown" && isSubscriptionProvider(this.provider.name);
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
      this.emitStats({
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
        middleware_names: this.rawStatsNames(),
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
    const ledger: LedgerDraft = {
      requestId: "",
      session: null,
      attempts: [],
      billed: undefined,
      finalInput: 0,
      releaseFlight: startAllowanceFlight(),
    };
    let response: Response;
    try {
      response = await this.handleSigned(c, payload, signing, ledger);
    } catch (err) {
      this.finalizeLedger(ledger, "error");
      throw err;
    }
    response = this.settleLedger(response, ledger);
    if (!signing.headers || !this.provider.signingCredential) return response;
    return withSignerHeader(response, this.provider.signingCredential(signing.headers));
  }

  /**
   * Every early exit passes through here: an answer returned at once (an
   * upstream error, a capacity 429, an aborted call) finalizes its attempts
   * now, a stream when its body ends (done, cancelled or errored). A request
   * with no attempt (not the subscription arm) is returned untouched.
   */
  private settleLedger(response: Response, ledger: LedgerDraft): Response {
    if (ledger.attempts.every((a) => a.written)) {
      this.settleAllowance(ledger);
      return response;
    }
    const streamOutcome = ledger.streamOutcome;
    if (!streamOutcome) {
      this.finalizeLedger(ledger, "error");
      return response;
    }
    return releaseWhenBodyEnds(response, () => this.finalizeLedger(ledger, streamOutcome()));
  }

  /**
   * Write every attempt not yet written: the last with the request's billed
   * tokens and `lastOutcome`, any earlier one as `error`. Synchronous and
   * never throws; a ledger can never change a response.
   */
  private finalizeLedger(ledger: LedgerDraft, lastOutcome: ResponseOutcome): void {
    try {
      const last = ledger.attempts[ledger.attempts.length - 1];
      for (const attempt of ledger.attempts) {
        if (attempt.written) continue;
        attempt.written = true;
        const isLast = attempt === last;
        attempt.outcome = isLast ? lastOutcome : "error";
        this.recordLedgerAttempt(ledger, attempt, isLast);
      }
    } catch {
      // The ledger is observational.
    }
    this.settleAllowance(ledger);
  }

  /**
   * Tell the allowance service this request is over, once per provider its
   * attempts used. Only now may it read the ledger: a row written mid-request
   * (a quota attempt before a rotation) only buffers.
   */
  private settleAllowance(ledger: LedgerDraft): void {
    try {
      // Released first: the settle below may schedule a ledger read, which waits for no request in flight.
      ledger.releaseFlight();
      const service = getAllowanceService();
      for (const provider of new Set(ledger.attempts.map((a) => a.account.provider))) {
        service.requestSettled(provider);
      }
    } catch {
      // The ledger is observational.
    }
  }

  private recordLedgerAttempt(ledger: LedgerDraft, attempt: LedgerAttempt, billed: boolean): void {
    try {
      const service = getAllowanceService();
      // The session's status line shows the pool's allowance label (§3.3); an
      // advisor handler writes no token file.
      if (this.options.requestRole !== "advisor") {
        service.attachLabelSink(attempt.account.provider, this.tokenTracker);
      }
      service.record({
        requestId: ledger.requestId,
        attempt: attempt.n,
        at: attempt.at,
        account: attempt.account,
        planClass: attempt.planClass,
        session: ledger.session,
        model: this.targetModel,
        reason: attempt.reason,
        outcome: attempt.outcome,
        tokens: billed ? (ledger.billed ?? null) : null,
        finalInput: billed ? ledger.finalInput : null,
        usage: attempt.usage,
      });
    } catch {
      // The ledger is observational.
    }
  }

  /**
   * The open attempt for `account`: the last one, unless it belongs to another
   * account or is already written, in which case a new one is opened.
   */
  private ledgerAttemptFor(
    ledger: LedgerDraft,
    account: AccountRef,
    reason: SelectReason | undefined
  ): LedgerAttempt {
    const open = ledger.attempts[ledger.attempts.length - 1];
    if (open && !open.written && sameAccount(open.account, account)) return open;
    const attempt: LedgerAttempt = {
      n: ledger.attempts.length,
      at: Date.now(),
      account,
      reason,
      planClass: null,
      outcome: "ok",
      written: false,
    };
    ledger.attempts.push(attempt);
    return attempt;
  }

  private async handleSigned(
    c: Context,
    payload: any,
    signing: { headers?: Record<string, string> },
    ledger: LedgerDraft
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
    // An internal call's deadline (the advisor panel gateway installs it).
    // Undefined on every request from Claude Code, and then every use below
    // collapses to the expression that ran before it existed.
    const callSignal = callAbortSignal(c);
    // This hop's entry in an internal call's hop log (advisor gateway only):
    // pushed on entry, so the log lists every hop whose handle() ran, and
    // filled with the signing arm once 5b has signed.
    const hop = recordHopEntry(c, this.provider.name, this.bareModelName);
    if (callSignal?.aborted) return this.respondCallAborted(startTime, fallbackMeta);
    // One inbound request owns every retry budget; dispatch never reinitializes them.
    const state = {
      requireOAuth: false,
      quotaRotations: 0,
      replacementBinding: undefined as AuthBinding | undefined,
      exclude: [] as AccountRef[],
      selectionContext: undefined as AccountSelectionContext | undefined,
      parameterSpent: false,
      forcedSignSpent: false,
      reSigned: false,
      overload: { attempts: 0 },
      deadlineAt: tier1DeadlineAt(c),
      payloadVersion: 0,
      requestId: randomUUID(),
      outcomes: new Map() as AccountOutcomeFold,
      observedResponses: new WeakSet<Response>(),
      ledger,
    };
    ledger.requestId = state.requestId;
    // 1. Transform incoming Claude-format request
    const transformed = transformOpenAIToClaude(payload);
    const { droppedParams } = transformed;
    // `let`: a raw `providerRequest` hook's committed copies replace it (3b).
    let claudeRequest = transformed.claudeRequest;
    // The WHOLE request: `extractSessionId` reads `metadata.user_id` itself.
    ledger.session = extractHarnessSessionId(claudeRequest) ?? null;

    // 1a. Hook request stage A, on this attempt's own deep copy (each
    // FallbackHandler candidate gets a fresh one, so nothing leaks between
    // attempts). Before conversion, so a system note reaches every route:
    // chat-completions adapters copy `system` into messages[0] at step 2 and
    // build their payload from `messages` alone.
    // An advisor handler runs none: a panel call is not a harness turn, and its
    // request carries no session id whose pending notes it could consume. The
    // panel gateway's never-served context carries no hooks either; this check
    // keeps that true if an advisor handler is ever reached another way.
    const hooks = this.options.requestRole === "advisor" ? undefined : requestHooksOf(c);
    const hookScope: HookRequestScope | undefined = hooks
      ? await hooks.beginAttempt(c, {
          claudeRequest,
          route: this.routeInfo(),
          upstream: this.upstreamFacts(),
          model: typeof payload?.model === "string" ? payload.model : this.bareModelName,
          stream: payload?.stream === true,
        })
      : undefined;

    // 2. Get adapter and reset state
    const adapter = this.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();

    // 3. Convert messages and tools
    let messages = adapter.convertMessages(claudeRequest, filterIdentity);
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
    // the raw tier on purpose: a raw `providerRequest` hook sees the request the
    // closed actions produced.
    hookScope?.applyToolDescriptions(claudeRequest.tools ?? [], tools);

    // 3b. Raw `providerRequest` hooks (the unsafe tier; the Gemini
    // thought-signature built-in lives here), after stage B so they see the
    // request the closed actions produced.
    //
    // MUST run before buildPayload. buildPayload is not guaranteed to keep a
    // reference to `messages`/`tools`: the Chat Completions adapter assigns them
    // straight onto the payload, but the Codex/Responses adapter deep-copies
    // both and lifts the system prompt out of `claudeRequest.system` into
    // `payload.instructions`. A hook run after buildPayload would lose every
    // change on exactly the path gpt-5.x uses.
    //
    // Each hook works on clones, committed only when its call succeeds within
    // its timeout; a throw, rejection or timeout leaves the request as it was.
    if (hookScope) {
      ({ claudeRequest, messages, tools } = await hookScope.raw.providerRequest({
        claudeRequest,
        messages,
        tools,
      }));
    }

    // 4. Build request payload
    let requestPayload = adapter.buildPayload(claudeRequest, messages, tools);

    // Merge provider-specific extra fields
    const extraFields = await this.provider.getExtraPayloadFields?.();
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

    // 5b. Sign / refresh auth (must happen before transformPayload, which may use auth state)
    //
    // `binding` is THIS request's auth: a transport that mints a per-request
    // artifact (`openai-codex`) returns it, and every later auth-dependent call
    // of this request (5c, the endpoint, every header fetch, the 401 retry, the
    // quota rotation, the retry legs) is handed it back, so a concurrent
    // request's refresh on the same handler can never change what this one
    // signs with. A handle()-scoped LOCAL, never a field on the handler or the
    // transport: one ComposedHandler and one transport serve concurrent turns.
    // Undefined for a transport that returns nothing (every other one), which
    // then behaves exactly as before.
    let binding: AuthBinding | undefined;
    if (this.provider.signRequest || this.provider.refreshAuth) {
      // ONE operation for the first sign AND every recovery-ladder re-issue of
      // it, so a sign that only succeeded on attempt four yields this request's
      // artifact exactly as one that succeeded on attempt one. Handing the ladder
      // `refreshAuth` here would recover the network and then sign with nothing.
      const signOrRefresh = async (): Promise<AuthBinding | undefined> => {
        if (this.provider.signRequest) {
          if (this.provider.name === "openai-codex") {
            // The allowance thread hint (§2.2) comes from the request as it
            // arrived, before any hook edit: a per-turn system note must not
            // move a thread to a new key. Built only under `ebr`/`lookahead`.
            state.selectionContext ??= getAccountPool("openai-codex").createSelectionContext(() =>
              allowanceHintOf(ledger.session, transformed.claudeRequest)
            );
          }
          const signed = await this.provider.signRequest({
            requireOAuth: state.requireOAuth,
            selectionContext: state.selectionContext,
          });
          state.requireOAuth ||= signed.arm === "oauth";
          return { auth: signed };
        }
        return (await this.provider.refreshAuth?.()) || undefined;
      };
      try {
        // Raced, not cancelled: a refresh is single-flight and shared with
        // other requests, so an aborted call stops WAITING for it and nothing
        // more.
        binding = await raceCallAbort(signOrRefresh(), callSignal);
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
        // A stopped call is not a failure to classify: no verdict, no stderr.
        if (callAborted(c)) return this.respondCallAborted(startTime, fallbackMeta);
        const conn = classifyConnectionError(err);
        if (conn) {
          // The refresh path's deadline is DELIBERATELY earlier than the fetch
          // path's. Both live in the same request and share one budget; if a
          // refresh recovers at the very end of it and then succeeds, the flow
          // proceeds to the primary fetch — byte-identical to today's
          // expression and therefore unclamped — and a maximal connect hang
          // would land the response write a whole connect timeout past the
          // deadline.
          const outcome = await this.recoverAtAuthSite<AuthBinding | undefined>(
            c,
            err,
            conn,
            this.connectionEndpointFor(err),
            signOrRefresh,
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
          // Recovered: carry on bound to the artifact the recovered attempt signed.
          binding = outcome.value;
        } else {
          if (isAccountsError(err)) {
            const answered = this.answerAuthFailure(c, err, "rethrow");
            if (answered) return answered;
            throw err;
          }
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
    if (hop) this.markHopSigned(hop, binding);
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

    // 5r. Code-mode resume (`openai-codex`): tool_results answering a suspended
    // exec script's batch feed the script. After 5b, so the account is THIS
    // request's; after 3b, so a synthetic reply gets the same raw hooks (the
    // response seam above this handler applies the closed tool hooks to it).
    // Synchronous from record lookup to state transition. A script that
    // blocked again is answered here with its next batch — no upstream call,
    // no further auth, no stats record (nothing was billed) — through the same
    // exit as step 8. Anything else continues. A store that was never created
    // (no code-mode request in this process) is created here only when the
    // last message answers nested ids — the first request after a restart —
    // so the lost script's tombstone exists before 5d builds the input.
    if (this.provider.name === "openai-codex") {
      const resume = (mayRequestModule: boolean) =>
        resumeFromToolResults(
          claudeRequest,
          binding,
          peekCodeModeStores(),
          claudeRequest?.tool_choice,
          {
            setting: this.options.codeMode ?? DEFAULT_CODE_MODE_SETTING,
            createStores: getCodeModeStores,
            mayRequestModule,
          }
        );
      let resumed = resume(true);
      if (resumed.kind === "needs-module") {
        // A lost script can replay, but its module was dropped (retired,
        // poisoned, recycled). 5r never awaits: load here, then run 5r once
        // more — never a third time, so a failed load ends in the tombstone.
        await loadQuickJSModule();
        resumed = resume(false);
      }
      if (resumed.kind === "reply") {
        const sse = createSyntheticToolUseReply(resumed.blocks, {
          modelName: this.bareModelName,
          priorInputTokens: this.tokenTracker.getLastInputTokens(),
          onToolCallObserved: (name: string) => this.tokenTracker.recordToolUse(name),
          raw: hookScope?.raw.streamTap(),
        });
        return payload?.stream === true ? sse : sseResponseToJson(sse, this.bareModelName);
      }
    }

    // 5c. Provider payload transformation (e.g., CodeAssist envelope wrapping)
    if (this.provider.transformPayload) {
      requestPayload = this.provider.transformPayload(requestPayload, claudeRequest, binding);
    }

    // 5d. Code mode (`openai-codex` only; by default `auto`, on where
    // discovery reports `code_mode_only`; `--code-mode` / CLAUDISH_CODE_MODE /
    // `codeMode` override it). After 5c, so the Codex fields 5c added are
    // kept; decided from THIS request's binding. A lite
    // request's header joins `wireHeaders`, so every header fetch below
    // carries it. Never throws: a failed decision or build leaves the request
    // exactly as 5c produced it.
    //
    // `codeModeShape` is the shape actually sent (`lite` falls back to
    // `classic` in the 4xx block when the backend rejects it); the clone and
    // context are what that fallback rebuilds from.
    let codeModeShape: "lite" | "classic" | undefined;
    let codeModePrePayload: any;
    let codeModeContext: CodeModePayloadContext | undefined;
    let codeModeTurn: PreparedCodeMode["turn"];
    if (this.provider.name === "openai-codex") {
      const prepared = await prepareCodeModeRequest({
        providerName: this.provider.name,
        setting: this.options.codeMode ?? DEFAULT_CODE_MODE_SETTING,
        binding,
        api:
          wire?.status === "known"
            ? wire.api
            : this.resolveStreamFormat() === "openai-responses-sse"
              ? "responses"
              : undefined,
        claudeRequest,
        payload: requestPayload,
      });
      if (prepared.request) {
        requestPayload = prepared.request.payload;
        codeModeShape = prepared.request.shape;
        codeModePrePayload = prepared.prePayload;
        codeModeContext = prepared.context;
        codeModeTurn = prepared.turn;
        wireHeaders = [...wireHeaders, ...prepared.request.headers];
        // 5a'. --model-params again, only for a code-mode payload: the user's
        // explicit fields still win over what 5d wrote (idempotent deep merge).
        if (this.options.modelParams) deepMergeParams(requestPayload, this.options.modelParams);
      }
    }

    // (Raw providerRequest hooks ran at step 3b, before buildPayload — see the
    // note there for why they cannot run at this point.)

    // The endpoint and the headers both come from THIS request's binding, so a
    // concurrent turn cannot move either between these two lines. Every later
    // attempt recomputes its own (`attempt` below), from the binding it signs with.
    const endpoint = this.provider.getEndpoint(this.targetModel, binding);
    // `payload` is the ORIGINAL inbound body, not the normalized `claudeRequest`
    // clone: a header carrying conversation identity must see what Claude Code
    // sent. `binding` is this request's auth. Both are per-request; neither may
    // be read back off the transport instance.
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
    //
    // Signed by the binding passed, never by shared transport state: the
    // primary fetch and parameter retry pass this request's `binding`, the 401
    // retry the one `forceRefreshAuth` just returned, a retry leg its own.
    //
    // The headers of THIS request's latest attempt — the one whose answer is
    // returned (primary, parameter re-fetch or auth retry), recorded on this
    // call's own `signing` record so a concurrent request on the same handler
    // cannot replace it. `handle` names the signer from them (`signingCredential`).
    //
    // Every attempt's credential values are registered for redaction right
    // here, before any of them can be echoed back: the primary fetch, the
    // parameter re-fetch, the 401 retry's fresh token and every Responses leg
    // sign through this one function. From now until the inbound request's
    // body ends, every log sink and every `redactSecrets` caller replaces them.
    //
    // A transport's out-of-header secrets (`redactionSecrets`: Devin's key reads
    // env, config and a file) are read once per binding of this request: a
    // forced refresh returns a new binding and is read again (Antigravity's
    // access token changes with it), the post-serialize registration below
    // reuses the read.
    let transportSecretsRead = false;
    let transportSecretsBinding: AuthBinding | undefined;
    let transportSecretsValue: string[] = [];
    const transportSecrets = (b: AuthBinding | undefined): string[] => {
      if (!this.provider.redactionSecrets) return [];
      if (transportSecretsRead && transportSecretsBinding === b) return transportSecretsValue;
      transportSecretsRead = true;
      transportSecretsBinding = b;
      transportSecretsValue = this.provider.redactionSecrets();
      return transportSecretsValue;
    };
    const fetchHeaders = async (b: AuthBinding | undefined): Promise<Record<string, string>> => {
      // Every fetch passes the SAME two arguments: dropping the inbound body
      // loses the conversation identity a transport puts in a header (OpenCode
      // Zen's `x-opencode-session`); dropping the binding signs with the
      // transport's legacy state rather than this request's artifact.
      const fetched = await this.provider.getHeaders(payload, b);
      mergeWireHeaders(fetched, wireHeaders);
      addSigningSecrets(c, credentialValuesFromRequest(fetched, this.signedEndpoint(b)));
      addSigningSecrets(c, transportSecrets(b));
      signing.headers = fetched;
      return fetched;
    };
    let headers: Record<string, string>;
    try {
      headers = await raceCallAbort(fetchHeaders(binding), callSignal);
    } catch (err: any) {
      if (callAborted(c)) return this.respondCallAborted(startTime, fallbackMeta);
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
        () => fetchHeaders(binding),
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
    const serialize = () =>
      this.provider.serializeBody?.(requestPayload) ?? {
        body: JSON.stringify(requestPayload),
        contentType: "application/json",
      };
    let serialized = serialize();
    // A credential the transport put in the BODY (Devin) is registered as soon
    // as the bytes exist (the read `fetchHeaders` made for this binding).
    addSigningSecrets(c, transportSecrets(binding));
    const deadlineAt = state.deadlineAt;
    let activeEndpoint = endpoint;
    let activeHeaders = headers;
    const pooledAccount = (): AccountRef | undefined => {
      const auth = binding?.auth;
      return auth?.arm === "oauth" && auth.account?.provider === "openai-codex"
        ? auth.account
        : undefined;
    };
    const selectionReason = () =>
      state.quotaRotations > 0
        ? "quota-switch"
        : state.reSigned
          ? "forced-sign"
          : "initial-selection";
    // Parse only after headers have arrived, outside every connect/re-issue catch.
    const pooledHttpQuota = async (received: Response): Promise<CodexUsageLimit | null> => {
      if (!pooledAccount() || (received.status !== 429 && received.status !== 403)) return null;
      const body = await received.clone().text();
      return (
        parseCodexUsageLimit(body) ??
        (isQuotaExhaustionError(received.status, body)
          ? { code: "usage_limit_reached", message: "Codex subscription usage limit reached" }
          : null)
      );
    };
    const reportQuota = async (limit: CodexUsageLimit, quotaHeaders: Headers): Promise<void> => {
      const account = pooledAccount();
      if (!account) return;
      // The ledger row for this attempt goes to disk NOW, before a rotation
      // opens the next account's attempt.
      try {
        const attempt = this.ledgerAttemptFor(state.ledger, account, binding?.auth?.selectReason);
        attempt.usage = snapshotFromCodexHeaders(quotaHeaders) ?? attempt.usage;
        attempt.planClass = planClassOf(quotaHeaders.get("x-codex-plan-type")) ?? attempt.planClass;
        attempt.at = Date.now();
        attempt.outcome = "quota";
        attempt.written = true;
        this.recordLedgerAttempt(state.ledger, attempt, false);
      } catch {
        // The ledger is observational.
      }
      try {
        await reportAccountOutcome(
          {
            requestId: state.requestId,
            account,
            outcome: codexQuotaOutcome(limit, snapshotFromCodexHeaders(quotaHeaders) ?? undefined),
            reason: selectionReason(),
          },
          state.outcomes
        );
      } catch {
        // Reporting is observational; selection queries have their own classified boundary.
        try {
          log(`[accounts] quota observation pending for ${account.id}`);
        } catch {
          /* non-fatal */
        }
      }
      if (
        !state.exclude.some((ref) => ref.provider === account.provider && ref.id === account.id)
      ) {
        state.exclude.push(account);
      }
    };
    const capacityResponse = (): Response => {
      try {
        const pool = getAccountPool("openai-codex");
        const failure = pool.errorIfNoEligible({
          exclude: state.exclude,
          selectionContext: state.selectionContext,
        });
        if (failure) throw failure;
      } catch (err) {
        if (classifyConnectionError(err) || isAccountsError(err)) throw err;
        throw new RefreshUnavailableError("account capacity observation unavailable");
      }
      // R4: a spent request budget is not spent subscription capacity.
      return c.json(
        wrapAnthropicError(
          429,
          "Codex account retry deferred; retry this request.",
          "rate_limit_error",
          429
        ),
        429,
        authVerdictHeaders("transient")
      );
    };
    // Every inference, including queued/recovered/stream re-issues, binds the
    // current artifact together and mints a fresh one-shot transport init.
    const observeResponse = async (received: Response, final = false): Promise<void> => {
      const auth = binding?.auth;
      if (
        auth?.arm !== "oauth" ||
        auth.account?.provider !== "openai-codex" ||
        (!final && state.observedResponses.has(received))
      )
        return;
      const account = auth.account;
      try {
        const usage = snapshotFromCodexHeaders(received.headers) ?? undefined;
        try {
          const attempt = this.ledgerAttemptFor(state.ledger, account, auth.selectReason);
          attempt.at = Date.now();
          if (usage) attempt.usage = usage;
          attempt.planClass =
            planClassOf(received.headers.get("x-codex-plan-type")) ?? attempt.planClass;
        } catch {
          // The ledger is observational.
        }
        // A 200 head may still contain quota: only settled success resets estimates.
        const outcome: AccountOutcome = received.ok
          ? !final && usage
            ? { kind: "usage", usage }
            : { kind: "ok", usage }
          : received.status === 401 || received.status === 403
            ? { kind: "auth-failed", status: received.status }
            : { kind: "http-error", status: received.status };
        await reportAccountOutcome(
          {
            requestId: state.requestId,
            account,
            outcome,
            usage,
            reason: selectionReason(),
          },
          state.outcomes
        );
        state.observedResponses.add(received);
      } catch {
        // An observer failure must not replace the inference response or its route.
        try {
          log(`[accounts] response observation pending for ${account.id}`);
        } catch {
          /* non-fatal */
        }
      }
    };
    // The primary attempt reuses the headers fetched above for THIS binding:
    // fetching again doubled every per-call mint or refresh check. Any later
    // attempt, or one after a re-sign replaced `binding`, fetches its own.
    let primedHeaders:
      | { binding: AuthBinding | undefined; headers: Record<string, string> }
      | undefined = { binding, headers };
    // THE REQUEST'S OWN CEILING. An unclamped attempt 1 could outlive the whole
    // derived deadline (measured: 75 s of macOS connect against a 30 s budget,
    // answered at 108 s), which makes the budget a suggestion. It is absolute,
    // it fires at `deadlineAt` and never earlier, and it is disarmed the
    // instant the call settles — see `deadlineClamp`. It bounds the PRIMARY
    // attempt and every pooled one. A non-pooled re-issue (parameter, auth,
    // ladder, stream head) stays unclamped, as it was before the attempt
    // helper: the ladder carries its own signal.
    //
    // An internal call's deadline reaches every attempt twice: a pre-start
    // check, so a queue that admits it late never starts a fetch, and the
    // signal on the fetch and on the queue admission, which also governs the
    // body read after `clamp.disarm()`.
    let primaryAttempt = true;
    const attempt = async (signal?: AbortSignal): Promise<Response> => {
      if (callSignal?.aborted) throw callAbortError();
      if (
        (state.requireOAuth || this.provider.poolConfigured?.()) &&
        binding?.auth?.arm !== "oauth"
      ) {
        throw new MeteredEscapeError("Request requires a Codex OAuth artifact before fetch");
      }
      const primed =
        primedHeaders && primedHeaders.binding === binding ? primedHeaders.headers : undefined;
      primedHeaders = undefined;
      const clamped = primaryAttempt || pooledAccount() !== undefined;
      primaryAttempt = false;
      activeEndpoint = this.provider.getEndpoint(this.targetModel, binding);
      activeHeaders = primed ?? (await raceCallAbort(fetchHeaders(binding), callSignal));
      activeHeaders["Content-Type"] = serialized.contentType;
      const clamp: ReturnType<typeof deadlineClamp> = clamped
        ? deadlineClamp(deadlineAt)
        : { disarm: () => {} };
      const attemptSignal = withCallSignal(
        signal && clamp.signal ? AbortSignal.any([clamp.signal, signal]) : (signal ?? clamp.signal),
        callSignal
      );
      const fetchCurrent = () => {
        if (callSignal?.aborted) return Promise.reject(callAbortError());
        return fetch(
          activeEndpoint,
          mergeSignalIntoInit(
            {
              method: "POST",
              headers: activeHeaders,
              body: serialized.body,
              ...(this.provider.getRequestInit?.() || {}),
            },
            attemptSignal
          )
        );
      };
      const signedWith = binding?.auth;
      let received: Response;
      try {
        received = await (this.provider.enqueueRequest
          ? this.provider.enqueueRequest(fetchCurrent, { signal: attemptSignal })
          : fetchCurrent());
      } catch (error) {
        clamp.disarm();
        if (signedWith?.arm === "oauth" && signedWith.account?.provider === "openai-codex") {
          try {
            await reportAccountOutcome(
              {
                requestId: state.requestId,
                account: signedWith.account,
                outcome: { kind: "transport-error", message: "inference transport failed" },
                reason: selectionReason(),
              },
              state.outcomes
            );
          } catch {
            // Preserve the transport's original evidence even if its observer fails.
          }
        }
        throw error;
      } finally {
        // Only connect and headers are clamped, never body consumption.
        clamp.disarm();
      }
      this.capturePlanUsage(received, signedWith?.account);
      await observeResponse(received);
      return received;
    };
    log(`[${this.provider.displayName}] Calling API: ${endpoint}`);

    let response: Response;
    try {
      response = await attempt();
    } catch (error: any) {
      // A stopped call first: no classification, no stderr, no recovery.
      if (callAborted(c)) return this.respondCallAborted(startTime, fallbackMeta);
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
      //
      // The CURRENT artifact's endpoint and headers, read at call time like
      // `doFetch` reads them — never ones captured before a re-sign.
      const reissue = (sig: AbortSignal) => attempt(sig);

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
    // The stall guard's zero (7b below): when the response the parser will read
    // had its headers.
    let responseHeadersAt = Date.now();
    for (;;) {
      try {
        this.capturePlanUsage(response, binding?.auth?.account);
        await observeResponse(response);
        const quota = await pooledHttpQuota(response);
        if (quota) {
          await reportQuota(quota, response.headers);
          await response.body?.cancel().catch(() => {});
          // A code-mode body was built for THIS account (its encrypted
          // reasoning and the turn's records are keyed by it), so it is never
          // resent under another one: the request answers the transient 429 and
          // its retry is built for the account selection picks then.
          if (
            state.quotaRotations >= 1 ||
            !this.provider.signRequest ||
            codeModeShape !== undefined
          ) {
            return capacityResponse();
          }
          // Spend BEFORE signing. Lease try-around may choose a second contacted account,
          // but once this artifact is sent no third account may be selected this request.
          state.quotaRotations++;
          const rotateAndSend = async (signal?: AbortSignal): Promise<Response> => {
            if (!state.replacementBinding) {
              if (callSignal?.aborted) throw callAbortError();
              const signed = await raceCallAbort(
                this.provider.signRequest!({
                  exclude: state.exclude,
                  selectionContext: state.selectionContext,
                  requireOAuth: state.requireOAuth,
                }),
                callSignal
              );
              state.replacementBinding = { auth: signed };
              binding = state.replacementBinding;
              state.requireOAuth ||= signed.arm === "oauth";
              // The rotation re-signs this hop: its entry names the new arm.
              if (hop) this.markHopSigned(hop, binding);
            }
            return attempt(signal);
          };
          try {
            response = await rotateAndSend();
          } catch (err) {
            if (callAborted(c)) return this.respondCallAborted(startTime, fallbackMeta);
            const conn = classifyConnectionError(err);
            if (!conn) {
              const answered = this.answerAuthFailure(c, err, "rethrow");
              if (answered) return answered;
              throw err;
            }
            const recovered = await this.recoverAtAuthSite<Response>(
              c,
              err,
              conn,
              this.connectionEndpointFor(err, activeEndpoint),
              rotateAndSend,
              {
                startTime,
                deadlineAt,
                fallbackMeta,
                site: "quota-rotation",
                recovery: recoveryTally,
              },
              "rethrow"
            );
            if (recovered.kind === "respond") return recovered.response;
            response = recovered.value;
          }
          continue;
        }

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
          if (!state.parameterSpent && response.status >= 400 && response.status < 500) {
            const candidates = [this.modelAdapter, this.getAdapter()].filter(
              (a, i, all): a is BaseModelAdapter =>
                !!a?.recoverFromRejection && all.indexOf(a) === i
            );
            const errorText =
              candidates.length > 0 || wireBorrowed.length > 0 || codeModeShape === "lite"
                ? await response.clone().text()
                : "";
            let recovery: { payload: any; note: string } | null = null;
            // A code-mode LITE request the backend rejects for the lite header or
            // `reasoning.context` (the raw upstream status, before the terminal
            // remap): resend it once in the code-mode CLASSIC shape — the same exec
            // tool and input, never the non-code-mode function tools — without the
            // header (a classic body with it is itself a 400, variant D). The model
            // stays on classic for the discovery TTL. Checked first: nothing else
            // in this request is suspect yet.
            if (
              codeModeShape === "lite" &&
              codeModeContext &&
              codeModePrePayload !== undefined &&
              isLiteRejection(response.status, errorText)
            ) {
              wireHeaders = withoutLiteHeader(wireHeaders);
              const classic = rebuildAsClassic(
                codeModePrePayload,
                codeModeContext,
                typeof requestPayload?.model === "string" ? requestPayload.model : this.targetModel
              );
              codeModeShape = classic.shape;
              if (this.options.modelParams) {
                deepMergeParams(classic.payload, this.options.modelParams);
              }
              recovery = { payload: classic.payload, note: "lite request rejected; classic shape" };
            }
            // Fields borrowed from the owner's connection (this connection's own
            // value is unknown) are the first suspects: tried in turn, dropped on the
            // 400 that names them. Only those fields — never one the wire published.
            if (!recovery) {
              recovery = recoverBorrowedWireFields(requestPayload, wireBorrowed, errorText);
              if (recovery) wireBorrowed = [];
            }
            for (const candidate of recovery ? [] : candidates) {
              recovery = candidate.recoverFromRejection(requestPayload, errorText);
              if (recovery) break;
            }
            if (recovery) {
              log(`[${this.provider.displayName}] Parameter rejected — retrying: ${recovery.note}`);
              state.parameterSpent = true;
              state.payloadVersion++;
              requestPayload = recovery.payload;
              // Re-serialize: a transport that owns its own encoding (Devin) must
              // re-encode the changed payload rather than resend the stale bytes.
              serialized = serialize();
              addSigningSecrets(c, transportSecrets(binding));
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
              //
              // The SAME artifact as the first attempt, on every ladder attempt too —
              // this retry re-sends the payload, not the credential.
              const doParamRetry = (sig?: AbortSignal) => attempt(sig);
              let retryResp: Response;
              try {
                retryResp = await doParamRetry();
              } catch (err: any) {
                if (callAborted(c)) return this.respondCallAborted(startTime, fallbackMeta);
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
                  this.connectionEndpointFor(err, activeEndpoint),
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
              if (retryResp.ok || (await pooledHttpQuota(retryResp))) {
                // A pooled quota response is newer evidence than the parameter complaint.
                await response.body?.cancel();
                response = retryResp;
                continue;
              }
              if (isCredentialRejection(retryResp.status, await retryResp.clone().text())) {
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
                await response.body?.cancel();
                response = retryResp;
                continue;
              }
              // Other providers retain the original parameter complaint.
              log(
                `[${this.provider.displayName}] Retry after ${recovery.note} still failed ` +
                  `(HTTP ${retryResp.status})`
              );
              await retryResp.body?.cancel();
            }
          }
        }

        if (!response.ok) {
          // 401: retry with forced auth refresh (OAuth token expiry)
          //
          // `forceRefreshAuth` is the ONE re-sign path. A transport that returns a
          // binding from it RE-SIGNS and hands back a new artifact, which replaces
          // this request's binding; a transport that signs through `signRequest`
          // (`openai-codex`) implements it as a forced `signRequest` carrying the
          // request's signing state below (`pin`, `rejected`, `requireOAuth`), so
          // a pooled request re-signs the account that was rejected.
          //
          // GATED ON THE OAUTH ARM, deliberately: only for a request with no
          // binding (every transport but `openai-codex`, unchanged) or one bound to
          // the OAuth arm. A 401 on the api-key arm is a bad KEY, and no refresh
          // can fix it: re-signing would spend a round trip to fail identically
          // and then answer a bare retryable 401, where the else-branch below
          // surfaces the actionable reason inline as a 400 today (the "API error ·
          // Retrying" regression, #148). So a metered Codex user's 401 takes
          // exactly the path it takes now.
          //
          // EXACTLY ONE forced re-sign per request, and its failure is TERMINAL. On
          // the re-sign arm, a retry that still fails is handed to the generic error
          // path below — the same 400 remap, `upstream_status` and recovery hint a
          // Codex 401 got before re-signing existed — and a re-sign that throws is
          // answered by `answerAuthFailure`, terminal for a rejected login. Returning the raw
          // retry status instead (a 401, or a 429) was the #148 pattern again: a
          // deactivated workspace 401s every token, so every client retry of that
          // raw status spent another forced token exchange.
          const canReSign =
            this.provider.signRequest !== undefined && binding?.auth?.arm === "oauth";
          if (
            !state.forcedSignSpent &&
            response.status === 401 &&
            this.provider.forceRefreshAuth &&
            (binding === undefined || binding.auth?.arm === "oauth")
          ) {
            log(`[${this.provider.displayName}] Got 401, forcing auth refresh and retrying`);
            // The forced refresh AND the retry fetch that follows it, as one
            // re-issuable operation. Both are network calls and either can fail
            // transiently, so a ladder that could only re-run one of them would
            // leave the other exactly as exposed as it was.
            //
            // TWO RETRIES, TWO TRIGGERS, AND THEY NEST. The recovery ladder re-runs
            // this operation when it could not REACH a host; the re-sign runs once
            // because a host was reached and REJECTED the bearer. So the ladder is
            // the inner loop and the re-sign the outer step, and neither can drive
            // the other: the ladder never sees an HTTP status, and nothing below this
            // branch re-signs.
            //
            // On the re-sign arm the refresh half therefore runs until it SUCCEEDS
            // ONCE, and never again. A re-sign that could not connect produced no
            // artifact, so the ladder retrying it is still the first re-sign; but once
            // one has succeeded, a ladder re-issue (its retry fetch could not connect)
            // re-sends with the artifact already in hand. Re-signing then would be a
            // second forced token exchange for one 401.
            const rejected = binding;
            const rejectedHeaders = activeHeaders;
            state.forcedSignSpent = true;
            await response.body?.cancel();
            /** Answers that never reached the upstream (another credential silo): reported as such. */
            const notResentResponses = new WeakSet<Response>();
            const doAuthRetry = async (sig?: AbortSignal): Promise<Response> => {
              if (!state.reSigned) {
                if (callSignal?.aborted) throw callAbortError();
                // The headers of the request the upstream rejected go with it, so a
                // transport can tell a stale failure from one naming the credential
                // it holds now.
                const refreshed = await raceCallAbort(
                  this.provider.forceRefreshAuth!({
                    rejectedHeaders,
                    requireOAuth: state.requireOAuth,
                    rejected: rejected?.auth ?? undefined,
                    pin: rejected?.auth?.account,
                    exclude: state.exclude,
                    selectionContext: state.selectionContext,
                  }),
                  callSignal
                );
                // Latch before fetch: a fetch outage cannot repeat the exchange.
                state.reSigned = true;
                if (refreshed) {
                  // The body was built for THIS binding's account (code mode renders
                  // its encrypted reasoning and keys its records by it): a refresh
                  // onto another arm or account must not resend it. Answered with a
                  // response, never a throw: inside the recovery ladder an
                  // unclassified throw escapes `handle()`. A 503, never a 401: no
                  // credential was rejected, and a headerless 401 reads as a
                  // subscription's rejected login (`isSubscriptionCredentialRejection`),
                  // which walks a bare chain onto a metered hop. The pool pins
                  // the rejected account, so for a pooled request this is a
                  // backstop; for the legacy login it catches a re-login onto
                  // another ChatGPT account between the sign and the 401.
                  if (
                    rejected &&
                    !isSameCredentialSilo(
                      { auth: rejected.auth, accountKey: accountKeyFromBinding(rejected) },
                      { auth: refreshed.auth, accountKey: accountKeyFromBinding(refreshed) }
                    )
                  ) {
                    log(
                      `[${this.provider.displayName}] sign-in changed during the request; not resent`
                    );
                    const notResent = new Response(
                      "Codex sign-in changed during the request; it was not resent",
                      { status: 503 }
                    );
                    notResentResponses.add(notResent);
                    return notResent;
                  }
                  binding = refreshed;
                  state.requireOAuth ||= refreshed.auth?.arm === "oauth";
                  // A re-sign replaces the arm on this hop's entry in place.
                  if (hop) this.markHopSigned(hop, binding);
                }
              }
              return attempt(sig);
            };
            /**
             * Returns a Response to answer with, or null to carry on — to the stream
             * handling on success, or (re-sign arm) to the generic error path below.
             */
            const settleAuthRetry = async (retryResp: Response): Promise<Response | null> => {
              // Not resent: the refresh signed in another account. No key is wrong
              // and no retry went out, so neither message may say so.
              const resent = !notResentResponses.has(retryResp);
              if (retryResp.ok) {
                response = retryResp; // fall through to stream handling below
              } else if (canReSign && resent) {
                // Fall through to the generic error path with THIS response. No
                // second re-sign exists anywhere below, so this cannot loop.
                log(
                  `[${this.provider.displayName}] Still HTTP ${retryResp.status} after one forced ` +
                    "re-sign — surfacing it as terminal, not re-signing again"
                );
                // The re-signed response carries the fresher plan-usage headers; a
                // 429 here is the turn the user hit their limit.
                this.capturePlanUsage(retryResp, binding?.auth?.account);
                response = retryResp;
                state.reSigned = true;
              } else {
                // Redacted at the read, so the returned body, the logs, the capture
                // and the stats classification all see the same credential-free text.
                const errorText = redactForClient(await retryResp.text());
                log(
                  `[${this.provider.displayName}] ${resent ? "Retry failed" : "Not resent"}: ${errorText}`
                );
                logStderr(
                  resent
                    ? `Error [${this.provider.displayName}]: HTTP ${retryResp.status} after auth retry. Check API key.`
                    : `Error [${this.provider.displayName}]: the sign-in changed to another account during the request, so it was not resent.`
                );
                reportError({
                  error: new Error(errorText),
                  providerName: this.provider.name,
                  providerDisplayName: this.provider.displayName,
                  streamFormat: this.provider.streamFormat,
                  modelId: this.targetModel,
                  httpStatus: retryResp.status,
                  isStreaming: false,
                  retryAttempted: resent,
                  isInteractive: this.isInteractive,
                  authType: "oauth",
                });
                try {
                  const { error_class, error_code } = classifyError(
                    new Error(errorText),
                    retryResp.status,
                    errorText
                  );
                  this.emitStats({
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
                    middleware_names: this.rawStatsNames(),
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
                // A RESENT request only: a not-resent answer (the refresh signed in
                // another account) proves nothing about the login, so it keeps its
                // own 401 and message rather than "the login was rejected".
                if (resent && (retryResp.status === 401 || retryResp.status === 403)) {
                  const transportTerminal = this.provider.classifyTerminalError?.(
                    retryResp.status,
                    errorText
                  );
                  // The subscription stop is for a credential rejection only; a model
                  // or allowance miss keeps its pass-through route (`isCredentialRejection`).
                  // Subscription by THIS request's signing arm (`signedBilling`), never
                  // the process-wide probe another request's arm can overwrite.
                  if (
                    (this.signedBilling(binding).subscription &&
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
                // Not resent: transient on the same hop, in the same shape as a
                // credential site's transient answer (`respondAuthFailure`). Claude
                // Code's retry signs afresh with the login that is current now.
                if (!resent) {
                  return c.json(
                    wrapAnthropicError(
                      503,
                      `${this.provider.displayName}: ${errorText}. Retry the request.`,
                      "overloaded_error"
                    ),
                    503,
                    authVerdictHeaders("transient")
                  );
                }
                return c.json(
                  wrapAnthropicError(retryResp.status, errorText),
                  retryResp.status as any
                );
              }
              return null;
            };
            try {
              const answered = await settleAuthRetry(await doAuthRetry());
              if (answered) return answered;
            } catch (err: any) {
              if (callAborted(c)) return this.respondCallAborted(startTime, fallbackMeta);
              // CLASSIFY FIRST, exactly as in the refreshAuth catch above, and for a
              // sharper reason: this path covers BOTH the forced refresh AND the raw
              // retry `fetch` that follows it, so "the network dropped while we were
              // re-signing a request" arrives here and left as an unconditional
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
                  this.connectionEndpointFor(err, activeEndpoint),
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
                // Recovered: `response` was reassigned by settleAuthRetry. Fall
                // through to the shared stream handling, or on the re-sign arm to
                // the generic error path below.
              } else {
                if (isAccountsError(err)) {
                  const answered = this.answerAuthFailure(c, err, "rethrow");
                  if (answered) return answered;
                  throw err;
                }
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
                  this.emitStats({
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
                    middleware_names: this.rawStatsNames(),
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
            continue;
          }
          if (!response.ok) {
            let errorText: string;
            try {
              // Redacted at the read: the returned body, the logs, the capture and the
              // stats classification below all use this one credential-free text.
              errorText = redactForClient(await response.text());
            } catch (err) {
              if (callAborted(c)) return this.respondCallAborted(startTime, fallbackMeta);
              const conn = classifyConnectionError(err);
              if (!conn) throw err;
              // Headers already arrived: classify the body failure, never re-issue or re-sign.
              return this.respondConnectionError(c, err, conn, activeEndpoint, {
                startTime,
                fallbackMeta,
                recovery: recoveryTally,
                retriedBeforeLadder: state.reSigned,
                ...(binding?.auth?.arm === "oauth" ? { authType: "oauth" as const } : {}),
                site: "errorBody",
              });
            }
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
            const transportTerminal = this.provider.classifyTerminalError?.(
              response.status,
              errorText
            );
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
              // True only when this is the response to the one forced re-sign.
              retryAttempted: state.reSigned,
              ...(state.reSigned ? { authType: "oauth" as const } : {}),
              isInteractive: this.isInteractive,
              providerErrorType,
            });
            try {
              const { error_class, error_code } = classifyError(
                new Error(errorText),
                response.status,
                errorText
              );
              this.emitStats({
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
                middleware_names: this.rawStatsNames(),
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
              isTerminalError(
                response.status,
                errorText,
                transportTerminal ?? isTerminal429(errorText)
              )
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
              // A SUBSCRIPTION's rejected credential carries the terminal verdict
              // (`auth-failure.ts`): an explicit spec stops with the login hint, and
              // a routing chain moves to its next hop with a notice naming that
              // hop's billing (`FallbackHandler`). A spent allowance (402/429) is
              // not a credential failure and advances with its own warning.
              // A model the provider does not carry (Zen Go's 401 "Model <id> is not
              // supported") is NOT a credential rejection and keeps advancing.
              // Subscription by THIS request's signing arm (`signedBilling`): for
              // `openai-codex` the probe reads a process-wide last-signed arm.
              // FallbackHandler still asks the probe for the same hop (main's code).
              const verdictHeaders =
                this.signedBilling(binding).subscription &&
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
        //
        // The stall guard's zero: when the response the parser will read had its
        // headers. Stamped here (a 200 reaches this line the moment its fetch
        // resolved) and again by each 7b re-issue, so the sniff window counts
        // against the guard rather than adding to it.
        responseHeadersAt = Date.now();
        if (this.resolveStreamFormat() === "openai-responses-sse") {
          const settled = await this.settleResponsesStreamHead(
            response,
            async () => {
              const next = await attempt();
              responseHeadersAt = Date.now();
              return next;
            },
            {
              progress: state.overload,
              extendedQuotaWatch: false,
              returnHttpErrors: pooledAccount() !== undefined,
              // Ends the backoff wait when an internal call's deadline passes.
              signal: callSignal,
            }
          );
          if (callAborted(c)) {
            if (settled.kind === "ok" || settled.kind === "http") {
              await settled.response.body?.cancel().catch(() => {});
            }
            return this.respondCallAborted(startTime, fallbackMeta);
          }
          if (settled.kind === "http") {
            response = settled.response;
            continue;
          }
          if (settled.kind === "quota") {
            if (pooledAccount()) {
              // 2a marks even a lone/spent account but NEVER rotates a stream verdict.
              await reportQuota(settled, settled.headers);
              return capacityResponse();
            }
            // The subscription window is spent, reported INSIDE a 200 stream.
            //
            // Until this existed the frame reached the parser and became an
            // `[API Error: usage_limit_reached]` assistant text block with
            // stop_reason end_turn: a recoverable, clock-bound state frozen into the
            // transcript as the model's answer, with no status for any retry hook to
            // key off.
            //
            // 400 + upstream_status 429 is the established shape for a terminal
            // upstream verdict (see the `isTerminalError` branch above): the user
            // reads the real reason inline on the first attempt instead of watching
            // "API error · Retrying", while `extractUpstreamStatus` recovers 429 and
            // the quota wording lets a bare chain advance to another provider with
            // the per-token cost warning.
            //
            // No logStderr here, deliberately: a chain that advances and succeeds
            // must not have printed a red line on a file descriptor shared with the
            // Claude Code TUI for a turn the user experienced as working.
            const resetAt = resolveUsageLimitResetAt(
              {
                code: settled.code,
                message: settled.message,
                ...(settled.resetsInSeconds === undefined
                  ? {}
                  : { resetsInSeconds: settled.resetsInSeconds }),
                ...(settled.resetsAt === undefined ? {} : { resetsAt: settled.resetsAt }),
              },
              Date.now()
            );
            const when = resetAt ? ` Resets ${new Date(resetAt).toLocaleTimeString()}.` : "";
            // The upstream's own text, redacted before it reaches a client body.
            const surfaced = `${this.provider.displayName} subscription usage limit reached: ${redactForClient(settled.message)}${when}`;
            log(
              `[${this.provider.displayName}] in-stream ${redactForClient(settled.code)} — surfacing as 400/429`
            );
            return c.json(
              wrapAnthropicError(400, surfaced, "invalid_request_error", 429),
              400 as any
            );
          }
          if (settled.kind === "exhausted") {
            const waited = STREAM_RETRY_DELAYS_MS.slice(0, settled.attempts).reduce(
              (sum, ms) => sum + ms,
              0
            );
            // The upstream's own text, before it reaches any body sent to Claude
            // Code: an error frame can echo the credential this request signed with.
            const upstreamCode = redactForClient(settled.code);
            const upstreamMessage = redactForClient(settled.message);
            const surfaced =
              `${this.provider.displayName} is overloaded upstream (${upstreamCode}): ${upstreamMessage} ` +
              `claudish retried ${settled.attempts}× over ${Math.round(waited / 1000)}s without success.`;
            logStderr(`Error: ${surfaced}`);
            try {
              this.emitStats({
                model_id: this.targetModel,
                provider_name: this.provider.name,
                stream_format: this.provider.streamFormat,
                latency_ms: Math.round(performance.now() - startTime),
                success: false,
                http_status: 503,
                error_class: "server_error",
                error_code: upstreamCode,
                token_strategy: this.options.tokenStrategy ?? "standard",
                adapter_name: this.getActiveAdapterName(),
                middleware_names: this.rawStatsNames(),
                fallback_used: fallbackMeta !== undefined,
                fallback_chain: fallbackMeta?.chain,
                fallback_attempts: fallbackMeta?.attempts,
                invocation_mode: this.options.invocationMode ?? "auto-route",
                ...this.recoveryStats(recoveryTally),
              });
            } catch {
              // Stats must never crash claudish
            }
            // `upstreamMessage` is the upstream's own text; `surfaced` wraps it in
            // claudish's retry narration. Both travel, so a probe row can lead with
            // the provider's words.
            return c.json(
              wrapAnthropicError(503, surfaced, "overloaded_error", undefined, upstreamMessage),
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
          const settled = await this.settleDevinStreamHead(response, () => attempt());
          if (callAborted(c)) {
            if (settled.kind === "ok") await settled.response.body?.cancel().catch(() => {});
            return this.respondCallAborted(startTime, fallbackMeta);
          }
          if (settled.kind !== "ok") {
            const isTerminal = settled.kind === "terminal";
            const httpStatus = isTerminal ? 400 : 503;
            // Redacted before any body, log line or report is composed from it.
            const upstreamCode = redactForClient(settled.code);
            const upstreamMessage = redactForClient(settled.message);
            const surfaced = isTerminal
              ? `${this.provider.displayName} rejected the request (${upstreamCode}): ${upstreamMessage}`
              : `${this.provider.displayName} is overloaded upstream (${upstreamCode}): ${upstreamMessage} ` +
                `claudish retried ${settled.attempts}× over ` +
                `${Math.round(
                  STREAM_RETRY_DELAYS_MS.slice(0, settled.attempts).reduce(
                    (sum, ms) => sum + ms,
                    0
                  ) / 1000
                )}s without success.`;
            logStderr(`Error: ${surfaced}`);
            reportError({
              error: new Error(upstreamMessage),
              providerName: this.provider.name,
              providerDisplayName: this.provider.displayName,
              streamFormat: this.provider.streamFormat,
              modelId: this.targetModel,
              httpStatus,
              isStreaming: true,
              retryAttempted: !isTerminal,
              isInteractive: this.isInteractive,
              providerErrorType: upstreamCode,
            });
            try {
              this.emitStats({
                model_id: this.targetModel,
                provider_name: this.provider.name,
                stream_format: this.provider.streamFormat,
                latency_ms: Math.round(performance.now() - startTime),
                success: false,
                http_status: httpStatus,
                error_class: isTerminal ? "client_error" : "server_error",
                error_code: upstreamCode,
                token_strategy: this.options.tokenStrategy ?? "standard",
                adapter_name: this.getActiveAdapterName(),
                middleware_names: this.rawStatsNames(),
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
                    upstreamMessage
                  ),
                  400 as any
                )
              : c.json(
                  wrapAnthropicError(503, surfaced, "overloaded_error", undefined, upstreamMessage),
                  503 as any,
                  settled.kind === "exhausted" && settled.unreachable
                    ? connectionFaultHeaders()
                    : undefined
                );
          }
          response = settled.response;
        }

        break;
      } catch (err) {
        // A stopped call first: no classification, no stderr, no recovery.
        if (callAborted(c)) return this.respondCallAborted(startTime, fallbackMeta);
        const conn = classifyConnectionError(err);
        if (conn)
          return this.respondConnectionError(c, err, conn, activeEndpoint, {
            startTime,
            fallbackMeta,
            recovery: recoveryTally,
            site: "response-dispatch",
          });
        if (isAccountsError(err)) {
          const answered = this.answerAuthFailure(c, err, "rethrow");
          if (answered) return answered;
        }
        throw err;
      }
    }

    await observeResponse(response, true);

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
    this.capturePlanUsage(response, binding?.auth?.account);

    // 9. Record stats AFTER stream completes (tokens are populated by onTokenUpdate during streaming).
    // Pass an onComplete callback into handleStream; it fires at the end of the stream after
    // onTokenUpdate, so token counts are available.
    // fallbackMeta was captured at the top of handle() and is available via closure.
    // Terminal errors that ride an HTTP 200 stream (e.g. the Responses backend's
    // `context_length_exceeded`) are invisible to the status code. The stream
    // parser reports them via onApiError; capture it here so the turn is recorded
    // as a failure, not a success. Per-request local — safe under concurrency.
    let streamApiError: { code: string; message: string } | null = null;
    // Set when Claude Code cancels the response body. A parser's cancelled
    // finalize still reports usage the provider had sent (what was billed is
    // billed), which fires onStreamComplete; this keeps that record from
    // reading as a completed turn. Per-request local, like streamApiError.
    let clientCancelled = false;

    // Legs 2..n of a Responses turn: a degenerate `parallel` wrapper is retried
    // inside the same downstream message (responses-turn.ts). Built from THIS
    // request's header builder, body and transport hooks, so a leg is the
    // primary fetch again, with its own ceiling and the turn's abort signal.
    // Per-request locals — safe under concurrency on a shared handler.
    let legRetries = 0;
    let responsesTurn: ResponsesTurnWiring | undefined;
    if (this.resolveStreamFormat() === "openai-responses-sse") {
      // Each leg is bound like the primary fetch: the issuer re-runs
      // `refreshAuth`, refuses a binding whose arm or account differs from the
      // turn's ("Codex sign-in changed during the turn"), and signs the leg
      // with the binding it just checked. A transport that returns no binding
      // keeps the no-binding path, which is exactly the primary fetch's.
      // biome-ignore lint/suspicious/noConfusingVoidType: refreshAuth() and forceRefreshAuth() resolve to `AuthBinding | void`
      const toLegBinding = (b: AuthBinding | void): LegBinding | undefined =>
        b ? { auth: b.auth, accountKey: accountKeyFromBinding(b) } : undefined;
      let legBinding = toLegBinding(binding);
      // A transport that signs through `signRequest` signs each leg the way the
      // request signed: with its `requireOAuth` latch and account selection,
      // pinned to the account the turn is on. A leg can then neither leave the
      // subscription arm (no metered signature after an OAuth sign in the same
      // request, and no metered arm recorded for it) nor select another account;
      // the issuer's silo check stays behind it.
      const signRequest = this.provider.signRequest?.bind(this.provider);
      const legSigningState = () => ({
        requireOAuth: state.requireOAuth,
        selectionContext: state.selectionContext,
        pin: legBinding?.auth?.account,
      });
      const refreshAuth = signRequest
        ? async (): Promise<AuthBinding> => ({ auth: await signRequest(legSigningState()) })
        : this.provider.refreshAuth?.bind(this.provider);
      // Same gate as the primary 401 branch; the arm cannot change mid-turn
      // (the issuer refuses a leg on another arm), so it is decided once here.
      // The request's one forced re-sign is shared with the legs: once it is
      // spent a leg's 401 is that leg's error (`mayForceRefresh`), never a
      // resend of the bearer just rejected.
      //
      // Spent when the re-sign SUCCEEDS, or fails for any reason but a
      // connection fault — the primary branch's `reSigned` rule: a re-sign that
      // could not connect exchanged nothing, so the next leg's 401 may still
      // take it; one the token host answered (a rejection, an unreadable 2xx)
      // may have consumed the refresh token, so it is never presented twice.
      const providerForceRefresh =
        binding === undefined || binding.auth?.arm === "oauth"
          ? this.provider.forceRefreshAuth?.bind(this.provider)
          : undefined;
      const forceRefreshAuth = providerForceRefresh
        ? async () => {
            try {
              const refreshed = await providerForceRefresh({
                ...legSigningState(),
                rejected: legBinding?.auth ?? undefined,
                exclude: state.exclude,
              });
              state.forcedSignSpent = true;
              return refreshed;
            } catch (err) {
              if (!classifyConnectionError(err)) state.forcedSignSpent = true;
              throw err;
            }
          }
        : undefined;
      const issueLeg = createLegIssuer<LegBinding>({
        providerDisplayName: this.provider.displayName,
        getBinding: () => legBinding,
        setBinding: (b) => {
          legBinding = b;
        },
        refreshAuth: refreshAuth ? async () => toLegBinding(await refreshAuth()) : undefined,
        forceRefreshAuth: forceRefreshAuth
          ? async () => toLegBinding(await forceRefreshAuth())
          : undefined,
        mayForceRefresh: () => !state.forcedSignSpent,
        getEndpoint: (b) => this.provider.getEndpoint(this.targetModel, b),
        fetchHeaders: (b) => fetchHeaders(b),
        // `requestPayload` as it stands now: parameter recovery may have
        // dropped fields, and a leg re-sends the body that was accepted.
        serializeBody: (body) => {
          const b = body ?? requestPayload;
          const s = this.provider.serializeBody?.(b);
          return {
            body: s?.body ?? JSON.stringify(b),
            contentType: s?.contentType ?? "application/json",
          };
        },
        getRequestInit: () => (this.provider.getRequestInit?.() || {}) as Record<string, unknown>,
        enqueueRequest: this.provider.enqueueRequest
          ? (fn, o) => this.provider.enqueueRequest!(fn, o)
          : undefined,
        settleStreamHead: async (res, reissue, signal) => {
          const settled = await this.settleResponsesStreamHead(res, reissue, { signal });
          if (settled.kind === "quota") {
            // A spent window on a later leg: marked on the account
            // (observational), never rotated mid-turn — the head is flushed.
            await reportQuota(settled, settled.headers);
            return { kind: "exhausted", code: settled.code, message: settled.message, attempts: 0 };
          }
          if (settled.kind === "http") {
            // Unreachable without `returnHttpErrors`; never handed on as a stream.
            await settled.response.body?.cancel().catch(() => {});
            return {
              kind: "exhausted",
              code: `http_${settled.response.status}`,
              message: `HTTP ${settled.response.status}`,
              attempts: 0,
            };
          }
          return settled;
        },
        legDeadlineAt: () => recoveryClock().now() + resolveTier1DeadlineMs(),
      });
      responsesTurn = {
        retry: {
          // A leg composes its turn signal with an internal call's deadline,
          // and the issuer returns `aborted` before it starts once either fired.
          issueLeg: callSignal
            ? (body, turnSignal) => issueLeg(body, AbortSignal.any([turnSignal, callSignal]))
            : issueLeg,
          // Default scope: `openai-codex` on the subscription arm, the only
          // backend the stall data comes from; CLAUDISH_RESPONSES_STALL_MS
          // overrides it everywhere.
          stall: resolveStallPolicy({
            env: process.env,
            providerName: this.provider.name,
            arm: binding?.auth?.arm,
          }),
          firstHeadersAt: responseHeadersAt,
          // A code-mode continuation leg appends to the body that was accepted.
          primaryBody: () => requestPayload,
        },
        onTurnSummary: (s) => {
          legRetries = s.legRetries;
        },
        // Code mode (decided at 5d): exec calls run in the sandbox and their
        // batches are relayed as tool_use blocks; `codeModeShape` is read at
        // exec time because the lite → classic fallback may have changed it.
        codeMode: codeModeTurn
          ? createCodeModeTurnHooks({
              stores: getCodeModeStores(),
              accountKey: codeModeTurn.accountKey,
              sessionKey: codeModeTurn.sessionKey,
              shape: () => codeModeShape ?? "classic",
              names: codeModeTurn.names,
              allTools: codeModeTurn.allTools,
              defaultMaxOutputTokens: codeModeTurn.defaultMaxOutputTokens,
              // The last user/assistant message, as the input builder reads
              // the message before a text-only answer (a trailing system
              // message would anchor the turn record where no render looks).
              previousMessage: conversationMessages(claudeRequest?.messages).at(-1),
            })
          : undefined,
      };
    }

    const onStreamComplete = () => {
      try {
        const isFreeModel = this.tokenTracker.getTotalCost() === 0;
        this.emitStats({
          model_id: this.targetModel,
          provider_name: this.provider.name,
          stream_format: this.provider.streamFormat,
          latency_ms: latencyMs,
          success: streamApiError === null && !clientCancelled,
          http_status: httpStatus,
          // A turn the client abandoned is not a completed one; the existing
          // error pair marks it, so no new StatsEvent field is needed.
          ...(clientCancelled ? { error_class: "cancelled", error_code: "client_cancelled" } : {}),
          input_tokens: this.tokenTracker.getInputTokens(),
          output_tokens: this.tokenTracker.getOutputTokens(),
          estimated_cost: this.tokenTracker.getTotalCost(),
          is_free_model: isFreeModel,
          token_strategy: this.options.tokenStrategy ?? "standard",
          adapter_name: this.getActiveAdapterName(),
          middleware_names: this.rawStatsNames(),
          fallback_used: fallbackMeta !== undefined,
          fallback_chain: fallbackMeta?.chain,
          fallback_attempts: fallbackMeta?.attempts,
          invocation_mode: this.options.invocationMode ?? "auto-route",
          ...this.recoveryStats(recoveryTally),
          // Absent on a turn that needed no retry, like the recovery fields.
          ...(legRetries > 0 ? { leg_retries: legRetries } : {}),
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

    const streamed = notifyOnDownstreamCancel(
      this.handleStream(
        c,
        response,
        adapter,
        claudeRequest,
        // Decided from the binding this request was finally signed with (a 401
        // re-sign replaced it above); every leg of a Responses turn signs on
        // that same arm, or the leg issuer refuses it.
        this.signedBilling(binding),
        toolNameMap,
        onStreamComplete,
        (code, message) => {
          streamApiError = { code, message };
        },
        hookScope?.raw.streamTap(),
        responsesTurn,
        (u) => {
          ledger.billed = {
            input: u.input,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            output: u.output,
          };
          ledger.finalInput = u.finalInput;
        }
      ),
      () => {
        clientCancelled = true;
      }
    );

    // How this stream ended, read once its body ends (`settleLedger`): a client
    // cancel, an in-stream API error, or a turn that never reported usage is
    // not a completed one.
    ledger.streamOutcome = () =>
      clientCancelled
        ? "cancelled"
        : streamApiError !== null || ledger.billed === undefined
          ? "error"
          : "ok";

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
    reissue: () => Promise<Response>,
    opts: {
      extendedQuotaWatch?: boolean;
      progress?: { attempts: number };
      returnHttpErrors?: boolean;
      /** A turn's or an internal call's signal: an abort ends the backoff wait at once. */
      signal?: AbortSignal;
    } = {}
  ): Promise<
    | { kind: "ok"; response: Response }
    | { kind: "http"; response: Response }
    | { kind: "exhausted"; code: string; message: string; attempts: number; unreachable?: true }
    | {
        kind: "quota";
        code: string;
        message: string;
        headers: Headers;
        resetsInSeconds?: number;
        resetsAt?: number;
      }
  > {
    let response = initial;

    const progress = opts.progress ?? { attempts: 0 };
    for (;;) {
      const attempt = progress.attempts;
      const verdict = await sniffResponsesStreamHead(response, {
        log,
        ...(opts.extendedQuotaWatch ? { extendedQuotaWatch: true } : {}),
      });
      if (verdict.kind === "clean") return { kind: "ok", response: verdict.response };
      if (verdict.kind === "quota") {
        // A spent window is NOT part of the backoff schedule — see the sniffer.
        // Handed straight back so the caller can mark the account and either
        // rotate or surface the reason with its reset time intact.
        return {
          kind: "quota",
          code: verdict.code,
          message: verdict.message,
          headers: response.headers,
          ...(verdict.resetsInSeconds === undefined
            ? {}
            : { resetsInSeconds: verdict.resetsInSeconds }),
          ...(verdict.resetsAt === undefined ? {} : { resetsAt: verdict.resetsAt }),
        };
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
      // Count before the operation, including a non-ok HTTP return to dispatch.
      progress.attempts++;
      if (await sleepUnlessAborted(delayMs, opts.signal)) {
        return { kind: "exhausted", code: verdict.code, message: "aborted", attempts: attempt };
      }

      let next: Response;
      try {
        next = await reissue();
        // Preserve pooled HTTP resets and unused auth/parameter budgets in dispatch.
        if (opts.returnHttpErrors && !next.ok) return { kind: "http", response: next };
      } catch (error) {
        // A pooled re-issue hands its connection fault to the dispatch catch,
        // which answers it. Anything else unclassified must not escape as a
        // status-0 chain advance: it takes the 503 below, like a non-pooled one.
        if (isAccountsError(error) || (opts.returnHttpErrors && classifyConnectionError(error)))
          throw error;
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
        const body = redactForClient(await next.text().catch(() => ""));
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
        if (isAccountsError(error)) throw error;
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
        const body = redactForClient(await next.text().catch(() => ""));
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
    billing: RequestBilling,
    toolNameMap?: Map<string, string>,
    onComplete?: () => void,
    onApiError?: (code: string, message: string) => void,
    /** The raw `providerChunk`/`providerStreamEnd` tap for this stream, when one applies. */
    raw?: RawStreamTap,
    responsesTurn?: ResponsesTurnWiring,
    /**
     * This request's billed usage, for the usage ledger. A Responses turn
     * reports it once over every leg (`onTurnBilled`); every other format
     * reports it from `onTokenUpdate`.
     */
    onBilled?: (u: TurnBilledUsage) => void
  ): Response {
    // Local mutable copy so we can null it out after firing (prevents double-firing)
    // without reassigning the function parameter.
    let pendingOnComplete = onComplete;
    const billedPerTurn = this.resolveStreamFormat() === "openai-responses-sse";
    // `input` is the FULL context size, always — never the cache-reduced figure
    // that rides on the wire. `detail` is the optional cached breakdown of that
    // same number and is used for COST ONLY; see UsageCacheDetail and
    // `context-window.md`, which records what happens when a reduced count
    // reaches the context accounting (auto-compaction silently disarms).
    //
    // `billing` is THIS request's signing decision, passed into every cost
    // update rather than read from the tracker's pricing lookup, whose
    // credential-decided answer is the process-wide last-signed arm.
    const onTokenUpdate = (input: number, output: number, detail?: UsageCacheDetail) => {
      const strategy = this.options.tokenStrategy || "standard";
      switch (strategy) {
        case "accumulate-both":
          this.tokenTracker.accumulateBoth(input, output, detail, billing);
          break;
        case "delta-aware":
          this.tokenTracker.updateWithDelta(input, output, detail, billing);
          break;
        case "local":
          this.tokenTracker.updateLocal(input, output, detail);
          break;
        default:
          this.tokenTracker.update(input, output, detail, billing);
          break;
      }
      if (onBilled && !billedPerTurn) {
        try {
          onBilled({
            input,
            cacheRead: detail?.cacheReadTokens ?? 0,
            cacheWrite: detail?.cacheCreationTokens ?? 0,
            output,
            finalInput: input,
          });
        } catch {
          // The ledger is observational.
        }
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
    // Stream parsers receive bareModelName: it is the value echoed in
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
          raw,
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
          // Claude Code's own tool names: a function_call named `parallel` is the
          // parallel wrapper only when none of these is called that.
          declaredToolNames: Array.isArray(claudeRequest?.tools)
            ? claudeRequest.tools
                .map((t: { name?: unknown } | null) => t?.name)
                .filter((n: unknown): n is string => typeof n === "string")
            : [],
          contextWindow: lookupModelForProvider(this.bareModelName, this.provider.name),
          onApiError,
          priorInputTokens,
          raw,
          onToolCallObserved: observeToolCall,
          retry: responsesTurn?.retry,
          // Earlier legs of a retried turn: cost only, before the stats snapshot
          // that onTokenUpdate fires.
          onExtraBilledInput: (input, detail) =>
            this.tokenTracker.addBilledInputTokens(input, detail, billing),
          onTurnSummary: responsesTurn?.onTurnSummary,
          onTurnBilled: onBilled,
          codeMode: responsesTurn?.codeMode,
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
          raw,
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
   * The claudish provider this handler signs for (`provider.name`): the name
   * its hop-log entries carry (`recordHopEntry`), so a caller that built the
   * handler can map those entries back to its own plan.
   */
  getProviderName(): string {
    return this.provider.name;
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
  private capturePlanUsage(response: Response, account?: AccountRef): void {
    // The plan reading feeds the main status line; an advisor handler has none.
    if (this.options.requestRole === "advisor") return;
    try {
      if (
        account?.provider === "openai-codex" &&
        !getAccountPool(account.provider).isActive(account)
      )
        return;
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
    try {
      getAllowanceService().detachLabelSink(this.tokenTracker);
    } catch {
      // The label is advisory.
    }
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
