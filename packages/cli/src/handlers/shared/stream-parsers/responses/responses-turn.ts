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
 * (parallel-wrapper.ts). When the caller passes `retry`, such a leg is retried
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
 */

/** Retries per leg position: 3 attempts in all. */
export const MAX_LEG_RETRIES = 2;

type RetryDecision =
  | { action: "finish" }
  | { action: "retry" }
  | { action: "end-tool-use" }
  | { action: "error"; message: string };

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

export interface ResponsesTurnOptions extends Omit<ResponsesLegContext, "sink"> {
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
  private legRetries = 0;
  private usageReported = false;

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
      while (true) {
        const outcome = await parseResponsesLeg(response, { ...this.opts, sink: this.sink });
        this.legUsages.push("usage" in outcome ? outcome.usage : undefined);
        const decision = this.retryDecision(outcome);
        if (decision.action === "finish") {
          await this.finish(outcome);
          return;
        }
        if (decision.action === "end-tool-use") {
          // The calls already stopped stand; the trigger's leg is dropped.
          log(`[ResponsesTurn] ${triggerLabel(outcome)} after tool_use blocks — ending tool_use`);
          await this.finishCompleted("tool_use");
          return;
        }
        if (decision.action === "error") {
          log(`[ResponsesTurn] ${decision.message} → error event`);
          this.sink.endWithError(decision.message);
          this.reportUsage();
          return;
        }
        const next = await this.issueRetry(outcome);
        if (!next) return;
        response = next;
      }
    } catch (error) {
      // Only a throwing callback can land here; the leg itself never throws.
      log(`[ResponsesSSE] Stream error: ${error}`);
    } finally {
      this.sink.close();
    }
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
    if (this.legRetries >= max) {
      return { action: "error", message: exhaustedMessage(outcome, this.legRetries + 1) };
    }
    return { action: "retry" };
  }

  /** Issue the next leg; undefined when the turn has ended instead. */
  private async issueRetry(outcome: LegOutcome): Promise<Response | undefined> {
    const retry = this.opts.retry;
    if (!retry) return undefined;
    this.legRetries++;
    const max = retry.maxLegRetries ?? MAX_LEG_RETRIES;
    log(`[ResponsesTurn] ${triggerLabel(outcome)} — retry ${this.legRetries}/${max}`);
    if (this.sink.signal.aborted) {
      this.reportUsage();
      return undefined;
    }
    const leg = await retry.issueLeg(undefined, this.sink.signal);
    if (leg.kind === "ok") return leg.response;
    if (leg.kind === "error") this.sink.endWithError(leg.message);
    this.reportUsage();
    return undefined;
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
