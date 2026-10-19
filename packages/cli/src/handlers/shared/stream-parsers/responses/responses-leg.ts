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

/** One leg's usage, read from `response.completed` / `.incomplete`. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** From `input_tokens_details.cached_tokens` when the backend reports it. */
  cacheDetail?: UsageCacheDetail;
}

export type LegOutcome =
  | { kind: "done"; usage?: Usage; incomplete?: string }
  | { kind: "stall"; afterMs: number }
  | {
      kind: "degenerate-wrapper";
      bytes: number;
      reason: "unparseable" | "shape" | "empty" | "incomplete";
      usage?: Usage;
    }
  | { kind: "api-error"; code: string; message: string; usage?: Usage }
  | { kind: "stream-error"; error: unknown; openToolBlock: boolean; usage?: Usage }
  | { kind: "cancelled"; usage?: Usage };

export interface ResponsesLegContext {
  sink: ClaudeSseSink;
  modelName: string;
  toolNameMap?: Map<string, string>;
  /** Claude Code's own tool names; see isParallelWrapperName. */
  declaredToolNames: string[];
  // biome-ignore lint/suspicious/noExplicitAny: MiddlewareManager is untyped on every parser
  middlewareManager?: any;
  /** Shared across every chunk hook of the turn; handed to afterStreamComplete. */
  // biome-ignore lint/suspicious/noExplicitAny: middleware metadata is free-form
  streamMetadata: Map<string, any>;
  onToolCall?: (name: string, argsJson: string) => string | null | undefined;
  shouldBufferTool?: (name: string) => boolean;
  onAssistantText?: (text: string, kind?: "text" | "reasoning") => void;
}

type FnCall = {
  name: string;
  arguments: string;
  index: number;
  claudeId?: string;
  /** Withhold input_json_delta until the call completes so it can be repaired. */
  buffered?: boolean;
  /**
   * Bytes of `arguments` already sent downstream as `input_json_delta`. Zero
   * for a buffered call until it completes, and zero for every call of a Codex
   * multi-call turn, which streams no argument deltas at all.
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

  constructor(private readonly ctx: ResponsesLegContext) {}

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
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

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
          // A malformed frame, or a handler or middleware that throws on one
          // event, costs that event only, never the turn.
          let stop: Stop | undefined;
          try {
            stop = await this.dispatch(JSON.parse(data));
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
      log(`[ResponsesSSE] Stream error: ${error}`);
      this.closeReasoning();
      this.closeText();
      // A tool block still open here had its argument JSON cut mid-object: the
      // socket died between `output_item.added` and `output_item.done`. Its
      // content_block_start is already on the wire, so how the turn ENDS decides
      // what the client does with the fragment (see the driver).
      const openToolBlock = this.openToolBlocks.size > 0;
      this.closeTools();
      return { kind: "stream-error", error, openToolBlock, usage: this.usage };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    if (signal.aborted) return { kind: "cancelled", usage: this.usage };

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
    };
  }

  private degenerate(
    reason: "unparseable" | "shape" | "empty" | "incomplete",
    bytes: number
  ): LegOutcome {
    log(`[ResponsesSSE] degenerate parallel wrapper (${reason}, ${bytes} bytes)`);
    return { kind: "degenerate-wrapper", reason, bytes, usage: this.usage };
  }

  private async dispatch(event: ResponsesEvent): Promise<Stop | undefined> {
    // Response-side observation point. The Responses API has no `delta`
    // object of its own, so the event stands in for both — observers here key
    // off `event.type`.
    if (this.ctx.middlewareManager) {
      await this.ctx.middlewareManager.afterStreamChunk({
        modelId: this.ctx.modelName,
        chunk: event,
        delta: event,
        metadata: this.ctx.streamMetadata,
      });
    }
    if (getLogLevel() === "debug" && event.type) {
      log(`[ResponsesSSE] Event: ${event.type}`);
    }

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
      case "response.output_item.done":
        return this.onItemDone(event);
      case "response.incomplete":
        return this.onIncomplete(event);
      case "response.completed":
      case "response.done":
        this.usage = readUsage(event.response?.usage ?? event.usage) ?? this.usage;
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
    this.ctx.onAssistantText?.(event.delta ?? "", "text");
    this.closeReasoning();
    if (this.textIdx < 0) {
      this.textIdx = this.sink.nextIndex();
      this.sink.startBlock(this.textIdx, { type: "text", text: "" });
    }
    this.sink.delta(this.textIdx, { type: "text_delta", text: event.delta || "" });
  }

  private onItemAdded(event: ResponsesEvent): void {
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
      buffered: this.ctx.shouldBufferTool?.(fnName) === true,
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
    this.ctx.onAssistantText?.(event.delta ?? "", "reasoning");
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
    // Buffered calls emit nothing here — the whole argument object goes out in
    // one delta at output_item.done, after any repair.
    if (!fnCall.buffered) {
      this.sink.delta(fnCall.index, { type: "input_json_delta", partial_json: event.delta || "" });
      fnCall.forwardedBytes += (event.delta || "").length;
    }
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
    if (item?.type !== "function_call") return undefined;

    const callId = item.call_id || item.id;
    const itemArgs = typeof item.arguments === "string" ? item.arguments : undefined;

    const held = this.heldWrappers.get(callId) || this.heldWrappers.get(item.id);
    if (held) {
      this.heldWrappers.delete(callId);
      this.heldWrappers.delete(item.id);
      const final = held.doneArgs ?? itemArgs ?? held.arguments;
      const parsed = parseParallelWrapper(final, (n) => this.decodeToolName(n));
      if (!parsed.ok) return { stop: this.degenerate(parsed.reason, final.length) };
      this.emitExpandedWrapper(held, parsed.calls);
      return undefined;
    }

    const fnCall = this.functionCalls.get(callId) || this.functionCalls.get(item.id);
    if (!fnCall || !this.openToolBlocks.has(fnCall)) return undefined;
    const final = fnCall.doneArgs ?? itemArgs ?? fnCall.arguments;
    if (fnCall.buffered) {
      // Give the behavior layer its one chance to rewrite the call, then emit
      // the complete argument object as a single delta.
      const finalArgs = this.repairBufferedCall(fnCall.name, final);
      this.sink.delta(fnCall.index, { type: "input_json_delta", partial_json: finalArgs });
      fnCall.forwardedBytes = finalArgs.length;
    } else {
      this.emitUnforwardedArguments(fnCall, final, fnCall.doneArgs !== undefined ? "done" : "item");
    }
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

  /** The behavior layer's one chance to rewrite a buffered call. A throwing rule changes nothing. */
  private repairBufferedCall(name: string, args: string): string {
    if (this.ctx.shouldBufferTool?.(name) !== true) return args;
    try {
      const repaired = this.ctx.onToolCall?.(name, args);
      if (typeof repaired === "string" && repaired !== args) {
        log(`[ResponsesSSE] tool call repaired: ${name}`);
        return repaired;
      }
    } catch (err) {
      // A failing rule must never corrupt the stream — emit the model's
      // original arguments and carry on.
      log(`[ResponsesSSE] onToolCall threw for ${name}: ${err}`);
    }
    return args;
  }

  /**
   * Emit a valid wrapper's entries as ordinary tool_use blocks, one complete
   * argument delta each (a buffered tool goes through onToolCall first). The
   * wrapper's reasoning is remembered under the FIRST expanded id only, so the
   * next request replays it exactly once, before that call.
   */
  private emitExpandedWrapper(held: HeldWrapper, calls: ParallelWrapperCall[]): void {
    this.closeReasoning();
    this.closeText();
    calls.forEach((call, k) => {
      const id = `${held.claudeBaseId}_p${k}`;
      const args = this.repairBufferedCall(call.name, call.arguments);
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
   * At `output_item.done` of a non-buffered call, send whatever part of the
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
      // A buffered call that never reached output_item.done (truncated or
      // failed stream) still has to emit what it accumulated. Withholding it
      // would turn "partial arguments" into "no arguments", which is strictly
      // worse — the non-buffered path would already have streamed the same
      // fragments. What the client then DOES with malformed JSON is decided by
      // how the turn ends: only an `error` event reliably stops Claude Code
      // executing the fragment. The block stays not-ARGS-COMPLETE on the sink.
      const accumulated = fnCall.doneArgs ?? fnCall.arguments;
      if (fnCall.buffered && accumulated) {
        this.sink.delta(fnCall.index, { type: "input_json_delta", partial_json: accumulated });
      }
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
