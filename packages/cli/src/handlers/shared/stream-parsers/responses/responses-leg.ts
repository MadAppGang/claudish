/**
 * One upstream Responses body → Claude SSE events (through the sink) → one
 * LegOutcome.
 *
 * A LEG is one upstream HTTP response. A turn (one downstream Claude message,
 * `responses-turn.ts`) has one leg, or more when the driver retries a stalled or
 * degenerate leg. Everything here is per leg and discarded when the leg ends:
 * function-call accumulators, this leg's open blocks, pending reasoning, the
 * incomplete reason, held `parallel` wrappers and usage. Block indices,
 * message lifecycle and tool block states belong to the turn and live on the
 * sink.
 *
 * Every leg closes the blocks it opened before it returns, so the driver
 * always starts the next leg, or writes the ending, from a clean slate. How
 * the MESSAGE ends is the driver's decision, never the leg's.
 *
 * The Responses API events handled:
 *   response.output_text.delta → content text
 *   response.output_item.added → new item (function_call, reasoning)
 *   response.function_call_arguments.delta / .done → tool arguments
 *   response.reasoning_summary_text.delta / reasoning_text.delta → thinking output
 *   response.output_item.done → close tool_use block
 *   response.completed / response.done / response.incomplete → final usage
 *   error / response.failed → in-stream API error
 */

import {
  type CachedReasoningItem,
  rememberReasoningForCall,
} from "../../../../adapters/reasoning-cache.js";
import type { ResponsesItem } from "../../../../code-mode/types.js";
import type { RawStreamTap } from "../../../../hooks/raw.js";
import { getLogLevel, log } from "../../../../logger.js";
import type { UsageCacheDetail } from "../../token-tracker.js";
import { formatRawSseLogPayload } from "../openai-sse.js";
import { sseDataPayload } from "../sse-line.js";
import type { ClaudeSseSink } from "./claude-sse-sink.js";
import {
  type ParallelWrapperCall,
  isParallelWrapperName,
  parseParallelWrapper,
} from "./parallel-wrapper.js";
import {
  type StallClock,
  StallGuard,
  isOutputBearingEvent,
  systemStallClock,
} from "./stall-guard.js";

/** One leg's usage, read from `response.completed` / `.incomplete`. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** From `input_tokens_details.cached_tokens` when the backend reports it. */
  cacheDetail?: UsageCacheDetail;
}

/**
 * How long a leg keeps reading after its exec call completed, for the
 * terminal event's usage (R1: it arrives milliseconds after the exec item).
 */
export const EXEC_DRAIN_MS = 10_000;

/** Why a `parallel` wrapper was judged degenerate. */
export type DegenerateReason = "unparseable" | "shape" | "empty" | "incomplete";

export type LegOutcome =
  | {
      kind: "done";
      usage?: Usage;
      incomplete?: string;
      /** Code mode only: this leg's assistant text and reasoning items, in order. */
      items?: ResponsesItem[];
    }
  | {
      /** Code mode: the leg ended on an exec call (never emitted as a block). */
      kind: "exec";
      callId: string;
      input: string;
      precedingItems: ResponsesItem[];
      usage?: Usage;
      /** `response.incomplete` cut the exec input: it is never run. */
      truncated: boolean;
    }
  | { kind: "stall"; afterMs: number }
  | {
      kind: "degenerate-wrapper";
      bytes: number;
      reason: DegenerateReason;
      usage?: Usage;
    }
  | { kind: "api-error"; code: string; message: string; usage?: Usage }
  | {
      kind: "stream-error";
      error: unknown;
      openToolBlock: boolean;
      /** Code mode: the socket died while the exec input streamed (never a block, never run). */
      openExec?: boolean;
      usage?: Usage;
    }
  | { kind: "cancelled"; usage?: Usage };

export interface ResponsesLegContext {
  sink: ClaudeSseSink;
  modelName: string;
  toolNameMap?: Map<string, string>;
  /** Claude Code's own tool names; see isParallelWrapperName. */
  declaredToolNames: string[];
  /**
   * The raw-tier tap (`providerChunk`), shared by every leg of the turn. The
   * Responses API has no `delta` object of its own, so the event stands in for
   * both. Tool-argument interception is not this parser's job: it happens at
   * the hook response seam, above every parser.
   */
  raw?: RawStreamTap | null;
  /**
   * This leg's stall guard (stall-guard.ts): fires `thresholdMs` after
   * `headersAt` (this leg's response headers, on `clock`) unless an
   * output-bearing event arrived first. Absent or 0 ⇒ unarmed.
   */
  stall?: { thresholdMs: number; headersAt: number; clock?: StallClock };
  /**
   * Code mode is on for this turn: a `custom_tool_call` named `exec` is held
   * (never a block) and ends the leg as an `exec` outcome. Off ⇒ such items are
   * ignored, exactly as before code mode existed.
   */
  codeMode?: boolean;
  /** The clock of the EXEC_DRAIN_MS drain; tests inject a fake one. Default wall clock. */
  drainClock?: StallClock;
}

/** A held exec call (code mode). */
type HeldExec = {
  callId: string;
  itemId?: string;
  acc: string;
  doneInput?: string;
  /** Set at `output_item.done`: the input is whole. */
  final?: string;
};

type FnCall = {
  name: string;
  arguments: string;
  index: number;
  claudeId?: string;
  /**
   * Bytes of `arguments` already sent downstream as `input_json_delta`. Zero
   * for every call of a Codex multi-call turn, which streams no argument
   * deltas at all.
   */
  forwardedBytes: number;
  /** `response.function_call_arguments.done`'s complete argument string. */
  doneArgs?: string;
};

/**
 * A `parallel` wrapper call being accumulated without a content_block_start
 * (see parallel-wrapper.ts).
 */
type HeldWrapper = {
  claudeBaseId: string;
  arguments: string;
  doneArgs?: string;
  /** The reasoning that led to the wrapper, bound to its first expanded call only. */
  reasoning: CachedReasoningItem[];
};

/** Internal: a leg-ending decision reached inside the event dispatch. */
type Stop = { stop: LegOutcome };

// biome-ignore lint/suspicious/noExplicitAny: Responses events are untyped JSON
type ResponsesEvent = any;

/** Read `usage` from a Responses usage object; undefined when it carries none. */
function readUsage(raw: ResponsesEvent, prior?: Usage, keepPrior = false): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw.input_tokens || (keepPrior ? (prior?.inputTokens ?? 0) : 0);
  const output = raw.output_tokens || (keepPrior ? (prior?.outputTokens ?? 0) : 0);
  const cached = raw.input_tokens_details?.cached_tokens;
  const usage: Usage = { inputTokens: input, outputTokens: output };
  if (typeof cached === "number" && cached > 0) {
    usage.cacheDetail = { cacheReadTokens: cached, cacheCreationTokens: 0 };
  }
  return usage;
}

class ResponsesLeg {
  private textIdx = -1;
  private reasoningIdx = -1;
  // OpenAI splits a reasoning summary into parts (summary_index 0, 1, 2, …),
  // each a bolded section. The paragraph break between parts is structural —
  // it is NOT in the text deltas — so tracking the index lets us re-insert it,
  // otherwise "**A**" + "**B**" render as one smashed "**A****B**".
  private lastSummaryIndex = -1;
  // Set when OpenAI reports the response was cut short (response.incomplete).
  private incompleteReason: string | null = null;
  // Reasoning items seen since the last function call. OpenAI emits them just
  // before the call they informed; we hand them to the cache keyed by that call
  // so the next request can replay them (see reasoning-cache.ts).
  private pendingReasoning: CachedReasoningItem[] = [];
  private usage: Usage | undefined;
  // Keyed by BOTH call_id and item_id, so the same FnCall object appears under
  // two keys — never derive a count from this map's size.
  private readonly functionCalls = new Map<string, FnCall>();
  // Tool blocks that have been started but not yet stopped, in emission order.
  private readonly openToolBlocks = new Set<FnCall>();
  private readonly heldWrappers = new Map<string, HeldWrapper>();
  // Code mode only: the held exec call, and this leg's assistant text and
  // reasoning items in order (an exec's precedingItems; a turn record's items).
  private heldExec: HeldExec | undefined;
  private readonly items: ResponsesItem[] = [];
  private drainTimer: unknown;
  /** A degenerate wrapper held until the terminal event (`holdDegenerate`). */
  private heldDegenerate: { reason: DegenerateReason; bytes: number } | undefined;
  private cancelReader: (() => void) | undefined;

  constructor(private readonly ctx: ResponsesLegContext) {}

  /** The exec outcome for a held exec whose input is whole. */
  private execOutcome(truncated: boolean): LegOutcome {
    const held = this.heldExec as HeldExec;
    return {
      kind: "exec",
      callId: held.callId,
      input: held.final ?? held.doneInput ?? held.acc,
      precedingItems: [...this.items],
      usage: this.usage,
      truncated,
    };
  }

  /**
   * The leg's outcome is decided (a whole exec call, a degenerate wrapper):
   * keep reading only for the terminal event's usage, at most EXEC_DRAIN_MS.
   */
  private startDrain(what: string): void {
    if (this.drainTimer !== undefined) return;
    this.drainTimer = this.drainClock.setTimeout(() => {
      log(`[ResponsesSSE] no terminal event ${EXEC_DRAIN_MS} ms after the ${what}; using it`);
      this.cancelReader?.();
    }, EXEC_DRAIN_MS);
  }

  /**
   * A wrapper judged degenerate at its `output_item.done`: never emitted, and
   * the leg ends degenerate — but only after the terminal event, which carries
   * the usage the provider billed (V0-21.sse: `response.incomplete` six lines
   * after the wrapper, 39,429 input tokens that an immediate stop discarded).
   */
  private holdDegenerate(reason: DegenerateReason, bytes: number): undefined {
    log(
      `[ResponsesSSE] degenerate parallel wrapper (${reason}, ${bytes} bytes); draining for usage`
    );
    this.heldDegenerate = { reason, bytes };
    this.startDrain("degenerate wrapper");
    return undefined;
  }

  /** The held degenerate wrapper is the leg's outcome (the body ended, or the drain gave up). */
  private endHeldDegenerate(): LegOutcome {
    const held = this.heldDegenerate as { reason: DegenerateReason; bytes: number };
    this.closeAll();
    return this.degenerate(held.reason, held.bytes);
  }

  /** While a degenerate wrapper is held: only the terminal event (and its usage) matters. */
  private drainDegenerate(event: ResponsesEvent): Stop | undefined {
    const held = this.heldDegenerate as { reason: DegenerateReason; bytes: number };
    switch (event.type) {
      case "response.completed":
      case "response.done":
        this.usage = readUsage(event.response?.usage ?? event.usage) ?? this.usage;
        break;
      case "response.incomplete":
        if (event.response?.usage) this.usage = readUsage(event.response.usage, this.usage, true);
        break;
      case "error":
      case "response.failed":
        break;
      default:
        return undefined;
    }
    return { stop: this.degenerate(held.reason, held.bytes) };
  }

  private get drainClock(): StallClock {
    return this.ctx.drainClock ?? systemStallClock;
  }

  private get sink(): ClaudeSseSink {
    return this.ctx.sink;
  }

  private decodeToolName(name: string): string {
    return this.ctx.toolNameMap?.get(name) || name;
  }

  async run(response: Response): Promise<LegOutcome> {
    const reader = response.body?.getReader();
    if (!reader) {
      return { kind: "stream-error", error: new Error("No response body"), openToolBlock: false };
    }
    const signal = this.sink.signal;
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    this.cancelReader = () => {
      reader.cancel().catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    // A fired guard cancels the reader; the pending read then settles and the
    // leg reports `stall` instead of how the cut-short stream looked.
    let stalledAfterMs: number | undefined;
    const stall = this.ctx.stall;
    const guard =
      stall && stall.thresholdMs > 0
        ? new StallGuard(
            stall.thresholdMs,
            stall.headersAt,
            (afterMs) => {
              stalledAfterMs = afterMs;
              log(`[ResponsesTurn] no output item ${Math.round(afterMs / 1000)}s after headers`);
              reader.cancel().catch(() => {});
            },
            stall.clock
          )
        : undefined;
    const stalled = (): LegOutcome | undefined => {
      if (stalledAfterMs === undefined || signal.aborted) return undefined;
      this.closeAll();
      return { kind: "stall", afterMs: stalledAfterMs };
    };

    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.sink.touch();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const data = sseDataPayload(line);
          if (data === null || data === "[DONE]") continue;
          // Raw capture, greppable into test data — same contract as
          // [SSE:openai] / [SSE:anthropic] in the sibling parsers.
          if (getLogLevel() === "debug") {
            log(`[SSE:responses] ${formatRawSseLogPayload(data)}`);
          }
          // A malformed frame, or a handler or raw hook that throws on one
          // event, costs that event only, never the turn.
          let stop: Stop | undefined;
          try {
            const event = JSON.parse(data);
            if (guard?.armed && isOutputBearingEvent(event?.type)) guard.disarm();
            stop = await this.dispatch(event);
          } catch (parseError) {
            log(`[ResponsesSSE] Parse error: ${parseError}`);
            continue;
          }
          if (stop) {
            this.closeAll();
            // Awaited: the next leg is never issued while this stream is open.
            await reader.cancel().catch(() => {});
            return stop.stop;
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled", usage: this.usage };
      const stalledOutcome = stalled();
      if (stalledOutcome) return stalledOutcome;
      if (this.heldExec?.final !== undefined) {
        // The exec call was whole before the socket died: run it.
        this.closeAll();
        return this.execOutcome(false);
      }
      // The wrapper was already judged; the drain only waited for usage.
      if (this.heldDegenerate) return this.endHeldDegenerate();
      log(`[ResponsesSSE] Stream error: ${error}`);
      this.closeReasoning();
      this.closeText();
      // A tool block still open here had its argument JSON cut mid-object: the
      // socket died between `output_item.added` and `output_item.done`. Its
      // content_block_start is already on the wire, so how the turn ENDS decides
      // what the client does with the fragment (see the driver).
      const openToolBlock = this.openToolBlocks.size > 0;
      this.closeTools();
      return {
        kind: "stream-error",
        error,
        openToolBlock,
        ...(this.heldExec ? { openExec: true } : {}),
        usage: this.usage,
      };
    } finally {
      guard?.disarm();
      signal.removeEventListener("abort", onAbort);
      if (this.drainTimer !== undefined) this.drainClock.clearTimeout(this.drainTimer);
    }

    if (signal.aborted) return { kind: "cancelled", usage: this.usage };
    return stalled() ?? this.endOfBody();
  }

  /** The body ended without a stop: how the leg ended. */
  private endOfBody(): LegOutcome {
    if (this.heldDegenerate) return this.endHeldDegenerate();
    if (this.heldExec) {
      this.closeAll();
      if (this.heldExec.final !== undefined) return this.execOutcome(false);
      // The body ended inside the exec call: nothing whole to run.
      log("[ResponsesSSE] stream ended inside the exec call");
      return {
        kind: "stream-error",
        error: new Error("the stream ended inside the exec call"),
        openToolBlock: false,
        openExec: true,
        usage: this.usage,
      };
    }

    // The stream ended while a wrapper was still held: its arguments were never
    // completed, so there is nothing valid to expand.
    const unfinished = this.heldWrappers.values().next().value;
    if (unfinished) {
      this.closeAll();
      return this.degenerate("incomplete", (unfinished.doneArgs ?? unfinished.arguments).length);
    }

    this.closeAll();
    return {
      kind: "done",
      usage: this.usage,
      ...(this.incompleteReason ? { incomplete: this.incompleteReason } : {}),
      ...(this.ctx.codeMode ? { items: [...this.items] } : {}),
    };
  }

  private degenerate(reason: DegenerateReason, bytes: number): LegOutcome {
    log(`[ResponsesSSE] degenerate parallel wrapper (${reason}, ${bytes} bytes)`);
    return { kind: "degenerate-wrapper", reason, bytes, usage: this.usage };
  }

  private async dispatch(parsed: ResponsesEvent): Promise<Stop | undefined> {
    // Raw-tier tap, before anything reads the event: what it returns is the
    // committed object, and every read below is of it. The Responses API has
    // no `delta` object of its own, so the event stands in for both.
    const event = this.ctx.raw ? this.ctx.raw.chunk(parsed, (e: ResponsesEvent) => e) : parsed;
    if (getLogLevel() === "debug" && event.type) {
      log(`[ResponsesSSE] Event: ${event.type}`);
    }
    if (this.heldDegenerate) return this.drainDegenerate(event);

    switch (event.type) {
      case "response.output_text.delta":
        this.onTextDelta(event);
        return undefined;
      case "response.output_item.added":
        this.onItemAdded(event);
        return undefined;
      case "response.reasoning_summary_text.delta":
      // The RAW reasoning text (DashScope, open-weight models) rather than a
      // summary of it; a thinking block all the same.
      case "response.reasoning_text.delta":
        this.onReasoningDelta(event);
        return undefined;
      case "response.function_call_arguments.delta":
        this.onArgumentsDelta(event);
        return undefined;
      case "response.function_call_arguments.done":
        this.onArgumentsDone(event);
        return undefined;
      case "response.custom_tool_call_input.delta":
      case "response.custom_tool_call_input.done":
        this.onExecInput(event);
        return undefined;
      case "response.output_item.done":
        return this.onItemDone(event);
      case "response.incomplete":
        return this.onIncomplete(event);
      case "response.completed":
      case "response.done":
        this.usage = readUsage(event.response?.usage ?? event.usage) ?? this.usage;
        // A whole exec call needs nothing after the terminal event's usage.
        if (this.heldExec?.final !== undefined) return { stop: this.execOutcome(false) };
        return undefined;
      case "error":
      case "response.failed": {
        const err = event.error || event.response?.error || {};
        const message = err.message || event.message || "Unknown API error";
        const code = err.code || event.code || "";
        log(`[ResponsesSSE] API error: ${code} - ${message}`);
        return { stop: { kind: "api-error", code, message, usage: this.usage } };
      }
      default:
        return undefined;
    }
  }

  private onTextDelta(event: ResponsesEvent): void {
    this.closeReasoning();
    if (this.textIdx < 0) {
      this.textIdx = this.sink.nextIndex();
      this.sink.startBlock(this.textIdx, { type: "text", text: "" });
    }
    this.sink.delta(this.textIdx, { type: "text_delta", text: event.delta || "" });
  }

  /** Code mode: the held exec's streamed input (`.delta`) or its whole input (`.done`). */
  private onExecInput(event: ResponsesEvent): void {
    const held = this.heldExec;
    if (!held) return;
    const id = event.item_id ?? event.call_id;
    if (id !== undefined && id !== held.itemId && id !== held.callId) return;
    if (event.type === "response.custom_tool_call_input.delta") held.acc += event.delta || "";
    else if (typeof event.input === "string") held.doneInput = event.input;
  }

  /** Code mode: the held exec's `output_item.done` makes its input whole; other items are recorded. */
  private onCodeModeItemDone(item: ResponsesEvent): boolean {
    if (item?.type !== "custom_tool_call") {
      this.recordItem(item);
      return false;
    }
    const held = this.heldExec;
    if (held && (item.call_id === held.callId || item.id === held.itemId)) {
      const itemInput = typeof item.input === "string" ? item.input : undefined;
      held.final = held.doneInput ?? itemInput ?? held.acc;
      this.startDrain("exec call");
    }
    return true;
  }

  /** Code mode: hold the exec call. The text and reasoning before it are closed, never reopened. */
  private onCustomToolCallAdded(item: ResponsesEvent): void {
    if (item.name !== "exec" || this.heldExec) {
      log(`[ResponsesSSE] ignoring custom_tool_call ${item.name ?? ""} (not the exec call)`);
      return;
    }
    this.closeReasoning();
    this.closeText();
    this.heldExec = {
      callId: item.call_id || item.id,
      itemId: item.id,
      acc: typeof item.input === "string" ? item.input : "",
    };
    log(`[ResponsesSSE] holding exec call ${this.heldExec.callId}`);
  }

  /** Code mode: an assistant message or reasoning item, kept verbatim for the turn's items. */
  private recordItem(item: ResponsesEvent): void {
    if (item?.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      const content = item.content
        .filter((p: ResponsesEvent) => p?.type === "output_text" && typeof p.text === "string")
        .map((p: ResponsesEvent) => ({ type: "output_text", text: p.text }));
      if (content.length === 0) return;
      const message: ResponsesItem = { type: "message", role: "assistant", content };
      if (typeof item.phase === "string") message.phase = item.phase;
      this.items.push(message);
    } else if (item?.type === "reasoning" && item.encrypted_content) {
      this.items.push({
        type: "reasoning",
        content: item.content ?? [],
        encrypted_content: item.encrypted_content,
        summary: item.summary ?? [],
      });
    }
  }

  private onItemAdded(event: ResponsesEvent): void {
    if (this.ctx.codeMode && event.item?.type === "custom_tool_call") {
      this.onCustomToolCallAdded(event.item);
      return;
    }
    if (event.item?.type !== "function_call") return;
    const itemId = event.item.id;
    const openaiCallId = event.item.call_id || itemId;
    const callId = openaiCallId.startsWith("toolu_")
      ? openaiCallId
      : `toolu_${openaiCallId.replace(/^fc_/, "")}`;
    const rawFnName = event.item.name || "";
    const fnName = this.decodeToolName(rawFnName);

    if (isParallelWrapperName(fnName, this.ctx.declaredToolNames)) {
      // HOLD: no content_block_start until the arguments are judged. The
      // reasoning so far belongs to the wrapper, not to a later call.
      const held: HeldWrapper = {
        claudeBaseId: callId,
        arguments: "",
        reasoning: this.pendingReasoning,
      };
      this.pendingReasoning = [];
      this.heldWrappers.set(openaiCallId, held);
      if (itemId && itemId !== openaiCallId) this.heldWrappers.set(itemId, held);
      log(`[ResponsesSSE] holding parallel wrapper ${rawFnName}`);
      return;
    }

    this.closeReasoning();
    this.closeText();

    const fnCall: FnCall = {
      name: fnName,
      arguments: "",
      index: this.sink.nextIndex(),
      claudeId: callId,
      forwardedBytes: 0,
    };
    this.functionCalls.set(openaiCallId, fnCall);
    if (itemId && itemId !== openaiCallId) this.functionCalls.set(itemId, fnCall);
    this.openToolBlocks.add(fnCall);

    // Bind the reasoning that led to this call, keyed by the id the client
    // will echo back, so the next request can replay it.
    if (this.pendingReasoning.length > 0) {
      rememberReasoningForCall(callId, this.pendingReasoning);
      this.pendingReasoning = [];
    }

    this.sink.startToolBlock(fnCall.index, callId, fnName);
  }

  private onReasoningDelta(event: ResponsesEvent): void {
    // Reasoning is the model's chain of thought, not its answer — it belongs
    // in a thinking block, or Claude Code renders it as the reply.
    const summaryIndex =
      typeof event.summary_index === "number"
        ? event.summary_index
        : typeof event.content_index === "number"
          ? event.content_index
          : 0;
    if (this.reasoningIdx < 0) {
      this.closeText();
      this.reasoningIdx = this.sink.nextIndex();
      this.lastSummaryIndex = summaryIndex;
      this.sink.startBlock(this.reasoningIdx, { type: "thinking", thinking: "" });
    } else if (summaryIndex !== this.lastSummaryIndex) {
      // New summary section — restore the paragraph break OpenAI represents
      // structurally rather than in the text stream.
      this.lastSummaryIndex = summaryIndex;
      this.sink.delta(this.reasoningIdx, { type: "thinking_delta", thinking: "\n\n" });
    }
    this.sink.delta(this.reasoningIdx, { type: "thinking_delta", thinking: event.delta || "" });
  }

  private onArgumentsDelta(event: ResponsesEvent): void {
    const callId = event.call_id || event.item_id;
    const fnCall = this.functionCalls.get(callId);
    if (!fnCall) {
      const held = this.heldWrappers.get(callId);
      if (held) held.arguments += event.delta || "";
      return;
    }
    fnCall.arguments += event.delta || "";
    this.sink.delta(fnCall.index, { type: "input_json_delta", partial_json: event.delta || "" });
    fnCall.forwardedBytes += (event.delta || "").length;
  }

  private onArgumentsDone(event: ResponsesEvent): void {
    // The complete argument string. The Codex backend sends a multi-call turn
    // with NO argument deltas, so for those calls this (or the item at
    // output_item.done) is the only copy of the arguments.
    if (typeof event.arguments !== "string") return;
    const fnCall = this.functionCalls.get(event.call_id) || this.functionCalls.get(event.item_id);
    if (fnCall) {
      fnCall.doneArgs = event.arguments;
      return;
    }
    const held = this.heldWrappers.get(event.call_id) || this.heldWrappers.get(event.item_id);
    if (held) held.doneArgs = event.arguments;
  }

  private onItemDone(event: ResponsesEvent): Stop | undefined {
    const item = event.item;
    if (item?.type === "reasoning" && item.encrypted_content) {
      // Keep the item verbatim (minus the id, which the Responses API does not
      // require on replay and which buildPayload strips).
      this.pendingReasoning.push({
        type: "reasoning",
        content: item.content ?? [],
        encrypted_content: item.encrypted_content,
        summary: item.summary ?? [],
      });
    }
    if (this.ctx.codeMode && this.onCodeModeItemDone(item)) return undefined;
    if (item?.type !== "function_call") return undefined;

    const callId = item.call_id || item.id;
    const itemArgs = typeof item.arguments === "string" ? item.arguments : undefined;

    const held = this.heldWrappers.get(callId) || this.heldWrappers.get(item.id);
    if (held) {
      this.heldWrappers.delete(callId);
      this.heldWrappers.delete(item.id);
      const final = held.doneArgs ?? itemArgs ?? held.arguments;
      const parsed = parseParallelWrapper(final, (n) => this.decodeToolName(n));
      if (!parsed.ok) return this.holdDegenerate(parsed.reason, final.length);
      this.emitExpandedWrapper(held, parsed.calls);
      return undefined;
    }

    const fnCall = this.functionCalls.get(callId) || this.functionCalls.get(item.id);
    if (!fnCall || !this.openToolBlocks.has(fnCall)) return undefined;
    const final = fnCall.doneArgs ?? itemArgs ?? fnCall.arguments;
    this.emitUnforwardedArguments(fnCall, final, fnCall.doneArgs !== undefined ? "done" : "item");
    this.sink.markToolArgsComplete(fnCall.index);
    this.sink.stopToolBlock(fnCall.index);
    this.openToolBlocks.delete(fnCall);
    return undefined;
  }

  private onIncomplete(event: ResponsesEvent): Stop | undefined {
    // The reason lives at response.incomplete_details.reason — reading
    // event.reason always yielded "unknown".
    this.incompleteReason = event.response?.incomplete_details?.reason ?? event.reason ?? "unknown";
    log(`[ResponsesSSE] Response incomplete: ${this.incompleteReason}`);
    if (event.response?.usage) {
      this.usage = readUsage(event.response.usage, this.usage, true);
    }
    // Code mode: an exec whose input was still streaming is cut, and never run.
    if (this.heldExec) {
      const truncated = this.heldExec.final === undefined;
      if (truncated) log("[ResponsesSSE] exec input cut by response.incomplete; not run");
      return { stop: this.execOutcome(truncated) };
    }
    // A wrapper still held when the response is cut short never got its
    // arguments judged: degenerate by definition.
    const pending = this.heldWrappers.values().next().value;
    if (pending) {
      return {
        stop: this.degenerate("incomplete", (pending.doneArgs ?? pending.arguments).length),
      };
    }
    return undefined;
  }

  /**
   * Emit a valid wrapper's entries as ordinary tool_use blocks, one complete
   * argument delta each. The
   * wrapper's reasoning is remembered under the FIRST expanded id only, so the
   * next request replays it exactly once, before that call.
   */
  private emitExpandedWrapper(held: HeldWrapper, calls: ParallelWrapperCall[]): void {
    this.closeReasoning();
    this.closeText();
    calls.forEach((call, k) => {
      const id = `${held.claudeBaseId}_p${k}`;
      const args = call.arguments;
      const index = this.sink.nextIndex();
      this.sink.startToolBlock(index, id, call.name);
      this.sink.delta(index, { type: "input_json_delta", partial_json: args });
      this.sink.markToolArgsComplete(index);
      this.sink.stopToolBlock(index);
      if (k === 0 && held.reasoning.length > 0) {
        rememberReasoningForCall(id, held.reasoning);
      }
    });
    log(`[ResponsesSSE] parallel wrapper expanded into ${calls.length} tool_use block(s)`);
  }

  /**
   * At `output_item.done` of a call, send whatever part of the
   * final arguments the deltas did not carry. The Codex backend sends every
   * call of a multi-call turn with ZERO argument deltas: the arguments exist
   * only in `function_call_arguments.done` and the done item, so forwarding
   * from deltas alone handed Claude Code `{}` and it answered
   * `InputValidationError: ... The required parameter 'file_path' is missing`.
   * A native `openai@` call streams every byte as deltas, and its final string
   * equals what was forwarded, so nothing more goes out for it.
   */
  private emitUnforwardedArguments(fnCall: FnCall, final: string, source: "done" | "item"): void {
    const emit = (partial: string) => {
      this.sink.delta(fnCall.index, { type: "input_json_delta", partial_json: partial });
      fnCall.forwardedBytes += partial.length;
    };
    if (fnCall.forwardedBytes === 0) {
      if (final) {
        emit(final);
        log(
          `[ResponsesSSE] zero-delta function_call ${fnCall.name}: emitted ${final.length} bytes from ${source}`
        );
      }
      return;
    }
    const forwarded = fnCall.arguments;
    if (final === forwarded) return;
    if (final.startsWith(forwarded)) {
      const suffix = final.slice(forwarded.length);
      emit(suffix);
      log(
        `[ResponsesSSE] function_call ${fnCall.name}: emitted ${suffix.length}-byte suffix the deltas did not carry`
      );
      return;
    }
    log(`[ResponsesSSE] done arguments diverge from streamed deltas for ${fnCall.name}`);
  }

  private closeReasoning(): void {
    if (this.reasoningIdx >= 0) {
      this.sink.stopBlock(this.reasoningIdx);
      this.reasoningIdx = -1;
    }
  }

  private closeText(): void {
    if (this.textIdx >= 0) {
      this.sink.stopBlock(this.textIdx);
      this.textIdx = -1;
    }
  }

  private closeTools(): void {
    for (const fnCall of this.openToolBlocks) {
      // A call that never reached output_item.done (truncated or failed
      // stream) has already streamed its fragments. What the client then DOES
      // with malformed JSON is decided by how the turn ends: only an `error`
      // event reliably stops Claude Code executing the fragment. The block
      // stays not-ARGS-COMPLETE on the sink.
      this.sink.stopToolBlock(fnCall.index);
    }
    this.openToolBlocks.clear();
  }

  private closeAll(): void {
    this.closeReasoning();
    this.closeText();
    this.closeTools();
  }
}

/**
 * Parse one upstream Responses body into Claude SSE on `ctx.sink` and report
 * how the leg ended. Never throws; never writes a message ending.
 */
export function parseResponsesLeg(
  response: Response,
  ctx: ResponsesLegContext
): Promise<LegOutcome> {
  return new ResponsesLeg(ctx).run(response);
}
