/**
 * The turn driver: one downstream Claude message, built from one or more
 * upstream Responses legs.
 *
 * The leg parser (`responses-leg.ts`) turns one upstream body into Claude SSE
 * and reports how it ended; this decides how the MESSAGE ends: the stop_reason,
 * the in-band error text tail, or an SSE `error`, and fires the usage callback
 * that records the request's stats exactly once.
 */

import { log } from "../../../../logger.js";
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
  /** Fires the request's stats record; called at most once per turn. */
  onTokenUpdate?: (input: number, output: number) => void;
  onTurnEnd?: () => void;
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
  private usage: Usage | undefined;
  private tokensReported = false;

  constructor(
    private readonly sink: ClaudeSseSink,
    private readonly opts: ResponsesTurnOptions
  ) {}

  private get wireUsage(): { input_tokens: number; output_tokens: number } {
    return {
      input_tokens: this.usage?.inputTokens ?? 0,
      output_tokens: this.usage?.outputTokens ?? 0,
    };
  }

  /**
   * Hand the turn's usage to the caller, which fires the request's stats
   * record. Once. After a client disconnect only if a leg had reported usage:
   * what was billed is billed, but a turn cut off before any usage arrived has
   * no figure worth recording.
   */
  private reportTokens(): void {
    if (this.tokensReported) return;
    this.tokensReported = true;
    if (this.sink.isCancelled && !this.usage) {
      log("[ResponsesSSE] client disconnected before usage arrived; no token update");
      return;
    }
    this.opts.onTokenUpdate?.(this.usage?.inputTokens ?? 0, this.usage?.outputTokens ?? 0);
  }

  async run(firstResponse: Response): Promise<void> {
    try {
      const outcome = await parseResponsesLeg(firstResponse, { ...this.opts, sink: this.sink });
      if ("usage" in outcome && outcome.usage) this.usage = outcome.usage;
      await this.finish(outcome);
    } catch (error) {
      // Only a throwing callback can land here; the leg itself never throws.
      log(`[ResponsesSSE] Stream error: ${error}`);
    } finally {
      this.sink.close();
    }
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
        this.sink.endMessage(stopReason, this.wireUsage);
        this.reportTokens();
        if (this.opts.middlewareManager) {
          await this.opts.middlewareManager.afterStreamComplete(
            this.opts.modelName,
            this.opts.streamMetadata
          );
        }
        this.opts.onTurnEnd?.();
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
        this.reportTokens();
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
        this.reportTokens();
        return;
      case "degenerate-wrapper":
        // Never shown to Claude Code: the error event makes it discard the
        // message and retry the turn, and no tool_use of it runs.
        log("[ResponsesSSE] degenerate parallel wrapper → error event");
        this.sink.endWithError(
          `degenerate parallel tool wrapper (${outcome.reason}, ${outcome.bytes} bytes)`
        );
        this.reportTokens();
        return;
      case "stall":
        this.sink.endWithError(`no output for ${Math.round(outcome.afterMs / 1000)} s`);
        this.reportTokens();
        return;
      case "cancelled":
        this.reportTokens();
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
