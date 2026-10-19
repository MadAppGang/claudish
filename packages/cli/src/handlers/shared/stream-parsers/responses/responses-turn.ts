/**
 * The turn driver: one downstream Claude message, built from one or more
 * upstream Responses legs.
 *
 * The leg parser (`responses-leg.ts`) turns one upstream body into Claude SSE
 * and reports how it ended; this decides how the MESSAGE ends: the stop_reason,
 * the in-band error text tail, or an SSE `error`, and fires the usage callback
 * that records the request's stats exactly once.
 *
 * ── RETRY WITHIN THE TURN ────────────────────────────────────────────────────
 *
 * About 1% of ChatGPT Codex turns end with a degenerate `parallel` wrapper
 * (parallel-wrapper.ts), usually after a 361-484 s keepalive-only stall. With
 * `retry.stall` armed (stall-guard.ts), a leg with no output item 150 s after
 * its headers is cut off too. When the caller passes `retry`, such a leg is retried
 * by issuing the same body again while the downstream message stays open; the
 * next leg continues at the next block index. A leg is issued only while no
 * tool_use has been emitted in this message:
 *
 *   | state of the message when the trigger fires        | action                    |
 *   |----------------------------------------------------|---------------------------|
 *   | message_start + pings, or closed text/thinking only | retry                     |
 *   | ≥ 1 tool_use stopped with its arguments, none cut   | no retry: end `tool_use`  |
 *   |   off (re-emitting could run a side-effecting Bash  |   for the stopped calls   |
 *   |   twice)                                            |                           |
 *   | any tool_use started but cut off                    | no retry: SSE `error`     |
 *   | retries exhausted                                   | SSE `error`               |
 *
 * NOT done in 7b (the status is already flushed), NOT in FallbackHandler (a
 * model fault must never move a subscription user onto a metered hop), NOT in
 * the transport. After the flush every failure ends with an SSE `error`.
 *
 * ── CODE MODE (`openai-codex`, `codeMode` hooks present) ─────────────────────
 *
 * A leg can end on an exec call (never emitted as a block). The hooks run the
 * script and answer with one of two steps:
 *   - emit-tool-uses: the script blocked on nested tool calls → each becomes a
 *     whole tool_use block, the turn's Responses items are stored, and the
 *     message ends `tool_use` (Claude Code runs them; the next request resumes
 *     the script);
 *   - continue: the script finished without blocking → another leg whose body
 *     is the previous leg's body with this leg's items and the exec call +
 *     output appended to `input`.
 * Bounded by MAX_LEGS_PER_TURN and MAX_INTERSTITIAL_EXECS. A retry inside a
 * code-mode turn re-sends the CURRENT leg's body, not the first one.
 */

/** Retries per leg position: 3 attempts in all. */
export const MAX_LEG_RETRIES = 2;

/**
 * Code mode: upstream legs one downstream message may use (continuations
 * after an exec that did not block, plus retries), and exec calls answered
 * inside one message. Either bound ends the message with
 * {@link CODE_MODE_STOP_TEXT}.
 */
export const MAX_LEGS_PER_TURN = 6;
export const MAX_INTERSTITIAL_EXECS = 6;
export const CODE_MODE_STOP_TEXT = `\n\n[claudish: stopped after ${MAX_INTERSTITIAL_EXECS} code-mode attempts]`;

type RetryDecision =
  | { action: "finish" }
  | { action: "retry" }
  | { action: "end-tool-use" }
  | { action: "stop-attempts" }
  | { action: "error"; message: string };

/** The next leg's response, or undefined when the turn has ended instead. */
type NextLeg = { response: Response; headersAt: number } | undefined;

/** The trigger in words, for the log line and the exhaustion error. */
function triggerLabel(outcome: LegOutcome): string {
  if (outcome.kind === "stall") return `stall ${Math.round(outcome.afterMs / 1000)}s`;
  if (outcome.kind === "degenerate-wrapper") return `degenerate ${outcome.bytes}B`;
  return outcome.kind;
}

function exhaustedMessage(outcome: LegOutcome, attempts: number): string {
  if (outcome.kind === "stall") {
    return `no output for ${Math.round(outcome.afterMs / 1000)} s after ${attempts} attempts`;
  }
  return `degenerate parallel tool wrapper after ${attempts} attempts`;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

import {
  type CodeModeTurnHooks,
  type ExecTurnStep,
  type ResponsesItem,
  relayNestedInput,
} from "../../../../code-mode/types.js";
import { log } from "../../../../logger.js";
import type { LegResponse } from "../../responses-leg-issuer.js";
import type { UsageCacheDetail } from "../../token-tracker.js";
import type { ClaudeSseSink } from "./claude-sse-sink.js";
import {
  type LegOutcome,
  type ResponsesLegContext,
  type Usage,
  parseResponsesLeg,
} from "./responses-leg.js";
import { type StallClock, type StallPolicy, systemStallClock } from "./stall-guard.js";

export interface ResponsesTurnOptions extends Omit<ResponsesLegContext, "sink" | "codeMode"> {
  /** Code mode for this turn (architecture §5.11). Absent ⇒ exec calls are ignored, as before. */
  codeMode?: CodeModeTurnHooks;
  /**
   * Real per-provider context window (tokens) for the model on THIS backend.
   * Used only to make the overflow message specific; omit/0 → left out.
   */
  contextWindow?: number;
  /** An in-stream API error (it rides an HTTP 200, invisible to status). */
  onApiError?: (code: string, message: string) => void;
  /**
   * Fires the request's stats record; called at most once per turn, LAST, with
   * the final leg's input (the context figure) and the output of every leg.
   */
  onTokenUpdate?: (input: number, output: number) => void;
  onTurnEnd?: () => void;
  /** Absent ⇒ one leg per turn, exactly as before retries existed. */
  retry?: ResponsesRetryOptions;
  /**
   * Fires FIRST at turn end, only when earlier legs of a retried turn reported
   * usage: their summed input (and cache detail). Each was a separate upstream
   * request the provider billed in full; nothing else will ever charge it.
   */
  onExtraBilledInput?: (inputTokens: number, detail?: UsageCacheDetail) => void;
  /** Fires after onExtraBilledInput and before onTokenUpdate. */
  onTurnSummary?: (s: { legs: number; legRetries: number }) => void;
}

export interface ResponsesRetryOptions {
  /** Issue leg 2..n of this turn: `undefined` body ⇒ the primary request's body. */
  issueLeg: (body: unknown | undefined, signal: AbortSignal) => Promise<LegResponse>;
  /** Retries per leg position. Default {@link MAX_LEG_RETRIES}. */
  maxLegRetries?: number;
  /**
   * Abort a leg with no output item for too long (stall-guard.ts): attempts
   * 1..n-1 use `thresholdMs`, the final attempt `finalThresholdMs`. Absent or
   * `thresholdMs: 0` ⇒ unarmed.
   */
  stall?: StallPolicy;
  /** When the FIRST leg's response headers arrived (the stall clock's zero). */
  firstHeadersAt?: number;
  /** The stall guard's clock; tests inject a fake one. Default wall clock. */
  stallClock?: StallClock;
  /**
   * The primary request's upstream body (an object with an `input` array). A
   * code-mode continuation leg appends to it; absent ⇒ no continuation leg can
   * be built and an exec that did not block ends the message with an error.
   */
  primaryBody?: () => unknown;
}

/** The in-band text for an in-stream API error; context overflow gets an actionable message. */
function apiErrorText(code: string, message: string, opts: ResponsesTurnOptions): string {
  // Context-overflow gets an actionable message (with the real per-backend cap
  // when known) instead of the bare error code — otherwise the user just sees a
  // cryptic `context_length_exceeded` and a stuck session (/compact re-sends the
  // same oversized input).
  const isCtxOverflow =
    code === "context_length_exceeded" ||
    /context (length|window)|exceeds? the context|too long|maximum context/i.test(message);
  if (!isCtxOverflow) return `\n\n[API Error: ${code} ${message}]`;
  const cap =
    opts.contextWindow && opts.contextWindow > 0
      ? ` ~${Math.round(opts.contextWindow / 1000)}K tokens`
      : "";
  return (
    `\n\n[Context limit reached] This model's backend enforces a smaller context window${cap} than its API spec. ` +
    "Run /clear to start fresh (/compact will also fail — it re-sends the full conversation), " +
    `or route the model via \`oai@${opts.modelName}\` to use the full-size window.`
  );
}

/**
 * The stop_reason for a turn whose last leg completed.
 *
 * A truncated turn must NOT be reported as a finished tool call. OpenAI emits
 * the partial function_call arguments it managed to produce, so "tool_use"
 * makes the client execute a tool with malformed JSON (InputValidationError).
 * Anthropic's contract for a cut-off turn is stop_reason "max_tokens", which is
 * the honest label here.
 *
 * KNOWN GAP: "max_tokens" does not actually stop Claude Code executing the
 * partial block. Verified against 2.1.217 (passflow session, 2026-07-22, six
 * days after v7.12.7 shipped this): the client ran the truncated Write and
 * reported InputValidationError anyway. A mid-stream socket failure uses an
 * `error` event, which does stop it — but that is only safe there because a
 * dead socket is transient. max_output_tokens is deterministic, so an error
 * event would make the client retry a request that truncates again. Capping
 * the budget is the real fix and the codex backend rejects max_output_tokens
 * ("Unsupported parameter"), so the label stays honest and the execution stays
 * unprevented.
 */
function stopReasonFor(incomplete: string | undefined, hasToolUse: boolean): string {
  if (incomplete) return incomplete === "content_filter" ? "refusal" : "max_tokens";
  return hasToolUse ? "tool_use" : "end_turn";
}

class ResponsesTurn {
  /** One entry per leg, in order; undefined for a leg that reported no usage. */
  private readonly legUsages: Array<Usage | undefined> = [];
  /** Retries in the whole turn (telemetry). */
  private legRetries = 0;
  /** Retries at the current leg position (a code-mode continuation starts a new one). */
  private positionRetries = 0;
  private usageReported = false;
  /** The current leg's body; undefined ⇒ the primary request's (`issueLeg(undefined)`). */
  private currentBody: unknown = undefined;
  private interstitialExecs = 0;
  /** Code mode: the Responses items of earlier legs of this message, interstitial execs included. */
  private readonly turnItems: ResponsesItem[] = [];

  constructor(
    private readonly sink: ClaudeSseSink,
    private readonly opts: ResponsesTurnOptions
  ) {}

  private get lastUsage(): Usage | undefined {
    return this.legUsages[this.legUsages.length - 1];
  }

  private get totalOutputTokens(): number {
    return sum(this.legUsages.map((u) => u?.outputTokens ?? 0));
  }

  /** Context figure = the final leg's input; output = every leg's output. */
  private get wireUsage(): { input_tokens: number; output_tokens: number } {
    return {
      input_tokens: this.lastUsage?.inputTokens ?? 0,
      output_tokens: this.totalOutputTokens,
    };
  }

  /**
   * Report the turn's usage, once, in this order:
   *  1. `onExtraBilledInput` with the input of EARLIER legs that reported usage;
   *  2. `onTurnSummary`;
   *  3. `onTokenUpdate(final leg's input, every leg's output)`, which fires the
   *     request's one stats record — so that record already holds 1 and 2.
   * After a client disconnect nothing fires unless a leg had reported usage:
   * what was billed is billed, but a turn cut off before any usage arrived has
   * no figure worth recording.
   */
  private reportUsage(): void {
    if (this.usageReported) return;
    this.usageReported = true;
    const reported = this.legUsages.filter((u): u is Usage => u !== undefined);
    if (this.sink.isCancelled && reported.length === 0) {
      log("[ResponsesSSE] client disconnected before usage arrived; no token update");
      return;
    }
    const earlier = this.legUsages.slice(0, -1).filter((u): u is Usage => u !== undefined);
    const extraInput = sum(earlier.map((u) => u.inputTokens));
    if (extraInput > 0) {
      const cacheRead = sum(earlier.map((u) => u.cacheDetail?.cacheReadTokens ?? 0));
      const cacheCreation = sum(earlier.map((u) => u.cacheDetail?.cacheCreationTokens ?? 0));
      this.opts.onExtraBilledInput?.(
        extraInput,
        cacheRead > 0 || cacheCreation > 0
          ? { cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation }
          : undefined
      );
    }
    this.opts.onTurnSummary?.({ legs: this.legUsages.length, legRetries: this.legRetries });
    this.opts.onTokenUpdate?.(this.lastUsage?.inputTokens ?? 0, this.totalOutputTokens);
  }

  async run(firstResponse: Response): Promise<void> {
    try {
      let response = firstResponse;
      let headersAt =
        this.opts.retry?.firstHeadersAt ?? (this.opts.retry?.stallClock ?? systemStallClock).now();
      while (true) {
        const outcome = await parseResponsesLeg(response, {
          ...this.opts,
          sink: this.sink,
          stall: this.stallFor(headersAt),
          codeMode: this.opts.codeMode !== undefined,
        });
        this.legUsages.push("usage" in outcome ? outcome.usage : undefined);
        const next =
          outcome.kind === "exec" ? await this.onExec(outcome) : await this.afterLeg(outcome);
        if (!next) return;
        response = next.response;
        headersAt = next.headersAt;
      }
    } catch (error) {
      this.failTurn(error);
    } finally {
      this.sink.close();
    }
  }

  /**
   * A callback threw (`primaryBody`, `onApiError`, a usage or middleware
   * hook); the leg itself never throws. A message with no ending yet still
   * gets one: closed without `message_stop` or `error`, the non-streamed path
   * folded it into a silent 200 partial.
   */
  private failTurn(error: unknown): void {
    log(`[ResponsesSSE] Stream error: ${error}`);
    if (!this.sink.hasEnded && !this.sink.isCancelled) {
      this.sink.endWithError(`claudish: the turn failed: ${error}`);
    }
    try {
      this.reportUsage();
    } catch (err) {
      log(`[ResponsesSSE] reporting usage failed: ${err}`);
    }
  }

  /** A leg that did not end on an exec call: finish, retry, or end the message otherwise. */
  private async afterLeg(outcome: LegOutcome): Promise<NextLeg> {
    const decision = this.retryDecision(outcome);
    if (decision.action === "finish") {
      await this.finish(outcome);
      return undefined;
    }
    if (decision.action === "end-tool-use") {
      // The calls already stopped stand; the trigger's leg is dropped.
      log(`[ResponsesTurn] ${triggerLabel(outcome)} after tool_use blocks — ending tool_use`);
      this.recordTurn([]);
      await this.finishCompleted("tool_use");
      return undefined;
    }
    if (decision.action === "stop-attempts") {
      await this.stopAttempts();
      return undefined;
    }
    if (decision.action === "error") {
      log(`[ResponsesTurn] ${decision.message} → error event`);
      this.sink.endWithError(decision.message);
      this.reportUsage();
      return undefined;
    }
    return this.issueRetry(outcome);
  }

  private retryDecision(outcome: LegOutcome): RetryDecision {
    if (outcome.kind !== "degenerate-wrapper" && outcome.kind !== "stall") {
      return { action: "finish" };
    }
    const retry = this.opts.retry;
    if (!retry) return { action: "finish" };
    if (this.sink.hasIncompleteToolBlock) {
      // Never a tool_use finish over an incomplete block: the cut-off rule.
      return {
        action: "error",
        message: `${triggerLabel(outcome)} with a tool call cut off`,
      };
    }
    if (this.sink.hasCompletedToolBlock) return { action: "end-tool-use" };
    const max = retry.maxLegRetries ?? MAX_LEG_RETRIES;
    if (this.positionRetries >= max) {
      return { action: "error", message: exhaustedMessage(outcome, this.positionRetries + 1) };
    }
    if (this.opts.codeMode && this.legUsages.length >= MAX_LEGS_PER_TURN) {
      return { action: "stop-attempts" };
    }
    return { action: "retry" };
  }

  // ─── code mode ──────────────────────────────────────────────────────

  /** Store this message's Responses items (code mode); a throwing hook changes nothing. */
  private recordTurn(finalItems: ResponsesItem[]): void {
    const hooks = this.opts.codeMode;
    if (!hooks) return;
    const items = [...this.turnItems, ...finalItems];
    if (items.length === 0) return;
    try {
      hooks.onTurnEnd({
        anchor: this.sink.firstToolUseId,
        items,
        texts: this.sink.textBlocks(),
      });
    } catch (err) {
      log(`[ResponsesTurn] storing the turn record failed: ${err}`);
    }
  }

  /** The legs bound was reached: a visible note, then `end_turn`. */
  private async stopAttempts(): Promise<void> {
    log(`[ResponsesTurn] code-mode bound reached after ${this.legUsages.length} leg(s)`);
    const idx = this.sink.nextIndex();
    this.sink.startBlock(idx, { type: "text", text: "" });
    this.sink.delta(idx, { type: "text_delta", text: CODE_MODE_STOP_TEXT });
    this.sink.stopBlock(idx);
    this.recordTurn([]);
    await this.finishCompleted("end_turn");
  }

  /** The behavior layer's one chance to rewrite a buffered nested call. */
  private repairNested(name: string, args: string): string {
    if (this.opts.shouldBufferTool?.(name) !== true) return args;
    try {
      const repaired = this.opts.onToolCall?.(name, args);
      if (typeof repaired === "string" && repaired !== args) {
        log(`[ResponsesSSE] tool call repaired: ${name}`);
        return repaired;
      }
    } catch (err) {
      log(`[ResponsesSSE] onToolCall threw for ${name}: ${err}`);
    }
    return args;
  }

  private abandon(callId: string): void {
    try {
      this.opts.codeMode?.onTurnAbandoned(callId);
    } catch (err) {
      log(`[ResponsesTurn] abandoning exec ${callId} failed: ${err}`);
    }
  }

  /** A leg ended on an exec call: run it through the hooks. */
  private async onExec(outcome: Extract<LegOutcome, { kind: "exec" }>): Promise<NextLeg> {
    const hooks = this.opts.codeMode;
    if (!hooks || this.sink.signal.aborted) {
      this.reportUsage();
      return undefined;
    }
    let step: ExecTurnStep;
    try {
      step = await hooks.onExecCall({
        callId: outcome.callId,
        input: outcome.input,
        precedingItems: outcome.precedingItems,
        truncated: outcome.truncated,
      });
    } catch (err) {
      log(`[ResponsesTurn] exec ${outcome.callId} failed in claudish: ${err}`);
      this.sink.endWithError(`claudish could not run the exec call: ${err}`);
      this.reportUsage();
      return undefined;
    }
    if (step.kind === "emit-tool-uses") {
      await this.emitNested(outcome, step.blocks);
      return undefined;
    }
    return this.continueAfterExec(outcome, step.appendItems);
  }

  /** The script blocked: its calls become tool_use blocks and the message ends `tool_use`. */
  private async emitNested(
    outcome: Extract<LegOutcome, { kind: "exec" }>,
    blocks: Extract<ExecTurnStep, { kind: "emit-tool-uses" }>["blocks"]
  ): Promise<void> {
    if (this.sink.signal.aborted) {
      this.abandon(outcome.callId);
      this.reportUsage();
      return;
    }
    for (const block of blocks) {
      this.sink.emitToolUse(
        block.id,
        block.name,
        relayNestedInput(block, (name, args) => this.repairNested(name, args))
      );
    }
    log(`[ResponsesTurn] exec ${outcome.callId} relayed as ${blocks.length} tool_use block(s)`);
    this.recordTurn(outcome.precedingItems);
    if (this.sink.isCancelled) {
      // Claude Code never saw the batch: its retry starts a new upstream turn.
      this.abandon(outcome.callId);
      this.reportUsage();
      return;
    }
    await this.finishCompleted("tool_use");
  }

  /** The script finished without blocking: another leg carries its output to the model. */
  private async continueAfterExec(
    outcome: Extract<LegOutcome, { kind: "exec" }>,
    appendItems: ResponsesItem[]
  ): Promise<NextLeg> {
    if (this.sink.hasToolUse) {
      // A stray classic call already went out in this message: no further leg.
      log(`[ResponsesTurn] exec ${outcome.callId} after a tool_use block — ending tool_use`);
      this.recordTurn(outcome.precedingItems);
      await this.finishCompleted("tool_use");
      return undefined;
    }
    this.interstitialExecs++;
    this.turnItems.push(...outcome.precedingItems, ...appendItems);
    if (
      this.interstitialExecs > MAX_INTERSTITIAL_EXECS ||
      this.legUsages.length >= MAX_LEGS_PER_TURN
    ) {
      await this.stopAttempts();
      return undefined;
    }
    const retry = this.opts.retry;
    const base = (this.currentBody ?? retry?.primaryBody?.()) as
      | { input?: unknown; [field: string]: unknown }
      | undefined;
    if (!retry || !base || typeof base !== "object" || !Array.isArray(base.input)) {
      log("[ResponsesTurn] code-mode continuation has no request body → error event");
      this.sink.endWithError("claudish: the code-mode continuation has no request body");
      this.reportUsage();
      return undefined;
    }
    const body = { ...base, input: [...base.input, ...outcome.precedingItems, ...appendItems] };
    this.currentBody = body;
    this.positionRetries = 0;
    log(
      `[ResponsesTurn] exec ${outcome.callId} finished without tool calls — leg ${this.legUsages.length + 1}`
    );
    return this.issue(body);
  }

  /** Issue a leg with `body` (undefined ⇒ the primary body); undefined when the turn ended instead. */
  private async issue(body: unknown): Promise<NextLeg> {
    const retry = this.opts.retry;
    if (!retry || this.sink.signal.aborted) {
      this.reportUsage();
      return undefined;
    }
    const leg = await retry.issueLeg(body, this.sink.signal);
    if (leg.kind === "ok") return { response: leg.response, headersAt: leg.headersAt };
    if (leg.kind === "error") this.sink.endWithError(leg.message);
    this.reportUsage();
    return undefined;
  }

  /** Issue the next leg; undefined when the turn has ended instead. */
  /**
   * This leg's stall guard settings: the final attempt (no retry left) gets the
   * longer threshold, so no attempt is unbounded and the last one still has
   * room for a long reasoning phase.
   */
  private stallFor(headersAt: number): ResponsesLegContext["stall"] {
    const retry = this.opts.retry;
    const policy = retry?.stall;
    if (!retry || !policy || !("finalThresholdMs" in policy) || policy.thresholdMs <= 0) {
      return undefined;
    }
    const isFinal = this.positionRetries >= (retry.maxLegRetries ?? MAX_LEG_RETRIES);
    return {
      thresholdMs: isFinal ? policy.finalThresholdMs : policy.thresholdMs,
      headersAt,
      clock: retry.stallClock,
    };
  }

  /** Re-send the current leg's body (the primary one until a code-mode continuation). */
  private async issueRetry(outcome: LegOutcome): Promise<NextLeg> {
    const retry = this.opts.retry;
    if (!retry) return undefined;
    this.legRetries++;
    this.positionRetries++;
    const max = retry.maxLegRetries ?? MAX_LEG_RETRIES;
    log(`[ResponsesTurn] ${triggerLabel(outcome)} — retry ${this.positionRetries}/${max}`);
    return this.issue(this.currentBody);
  }

  /** A completed turn: `message_delta` + `message_stop`, usage, then the turn hooks. */
  private async finishCompleted(stopReason: string): Promise<void> {
    this.sink.endMessage(stopReason, this.wireUsage);
    this.reportUsage();
    if (this.opts.middlewareManager) {
      await this.opts.middlewareManager.afterStreamComplete(
        this.opts.modelName,
        this.opts.streamMetadata
      );
    }
    this.opts.onTurnEnd?.();
  }

  private async finish(outcome: LegOutcome): Promise<void> {
    switch (outcome.kind) {
      case "done": {
        const stopReason = stopReasonFor(outcome.incomplete, this.sink.hasToolUse);
        if (outcome.incomplete) {
          log(
            `[ResponsesSSE] Truncated response (${outcome.incomplete}) → stop_reason=${stopReason}`
          );
        }
        this.recordTurn(outcome.items ?? []);
        await this.finishCompleted(stopReason);
        return;
      }
      case "api-error":
        // Signal the terminal error so the caller records this turn as a
        // failure (the error rides an HTTP 200 stream, invisible to status).
        this.opts.onApiError?.(outcome.code, outcome.message);
        this.sink.endWithText(
          apiErrorText(outcome.code, outcome.message, this.opts),
          this.wireUsage
        );
        this.reportUsage();
        return;
      case "stream-error":
        // A tool block that was open when the socket died had its argument JSON
        // cut mid-object, and `end_turn` makes Claude Code run the tool on it:
        //   InputValidationError: Write was called with input that could not
        //   be parsed as JSON. You sent (first 200 of 9437 bytes): {"file_pa…
        // `max_tokens` does not rescue it either (Claude Code 2.1.217 ran a
        // max_tokens-terminated call anyway). Only an `error` event ends the
        // message with no completed tool_use, and it is the honest report — the
        // turn did fail. devin-connect ends a mid-stream fault the same way.
        // With no tool call in flight the inline text keeps partial prose visible.
        if (outcome.openToolBlock) {
          log("[ResponsesSSE] tool arguments cut off mid-stream → error event");
          this.sink.endWithError(`Stream error: ${outcome.error}`);
        } else {
          this.sink.endWithText(`\n\n[Stream error: ${outcome.error}]`, this.wireUsage);
        }
        this.reportUsage();
        return;
      case "degenerate-wrapper":
        // Only reached without `retry`. Never shown to Claude Code: the error
        // event makes it discard the message and retry the turn, and no tool_use
        // of it runs.
        log("[ResponsesSSE] degenerate parallel wrapper → error event");
        this.sink.endWithError(
          `degenerate parallel tool wrapper (${outcome.reason}, ${outcome.bytes} bytes)`
        );
        this.reportUsage();
        return;
      case "stall":
        this.sink.endWithError(`no output for ${Math.round(outcome.afterMs / 1000)} s`);
        this.reportUsage();
        return;
      case "cancelled":
        this.reportUsage();
        return;
    }
  }
}

/**
 * Drive one downstream Claude message from `firstResponse`. Never throws; the
 * sink is closed when this resolves.
 */
export function runResponsesTurn(
  sink: ClaudeSseSink,
  firstResponse: Response,
  opts: ResponsesTurnOptions
): Promise<void> {
  return new ResponsesTurn(sink, opts).run(firstResponse);
}
