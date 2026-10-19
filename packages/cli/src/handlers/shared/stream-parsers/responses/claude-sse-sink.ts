/**
 * The one writer of Claude SSE on the Responses path.
 *
 * One sink is one downstream Claude message: `message_start` once, a
 * monotonic content-block index shared by every upstream leg of the turn, the
 * keepalive ping, the tool blocks' states, and exactly one ending
 * (`message_delta` + `message_stop`, an SSE `error`, or a client disconnect).
 * The leg parser (`responses-leg.ts`) and the turn driver
 * (`responses-turn.ts`) write only through it, so a second upstream leg
 * continues at the next block index and can never reopen or reuse a block.
 *
 * `cancel()` is the downstream disconnect: it marks the sink closed, stops the
 * ping, and aborts the turn's AbortController, whose signal the leg uses to
 * cancel its upstream reader and the driver checks before issuing anything.
 */

import { log } from "../../../../logger.js";
import { messageStartUsage } from "../message-start-usage.js";

/** STARTED → ARGS-COMPLETE → STOPPED. A block stopped without ARGS-COMPLETE was cut off. */
interface ToolBlockState {
  name: string;
  argsComplete: boolean;
  stopped: boolean;
}

export interface ClaudeSseSinkOptions {
  modelName: string;
  /** Seeds `message_start.usage`; see message-start-usage.ts. */
  priorInputTokens?: number;
  /** Fired at every tool_use `content_block_start`: observation and dispatch are one event. */
  onToolCallObserved?: (name: string) => void;
}

export class ClaudeSseSink {
  private readonly encoder = new TextEncoder();
  private curIdx = 0;
  private closed = false;
  private ended = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();
  private readonly toolBlocks = new Map<number, ToolBlockState>();
  private readonly abort = new AbortController();
  private firstToolId: string | undefined;
  /** Text blocks of the message by index, in order (code mode anchors a text-only turn by them). */
  private readonly texts = new Map<number, string>();

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly opts: ClaudeSseSinkOptions
  ) {}

  /** Aborted when the client disconnects. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** True once the downstream is closed (an ending was written, or the client left). */
  get isClosed(): boolean {
    return this.closed;
  }

  /** True when the client disconnected (as opposed to the turn ending normally). */
  get isCancelled(): boolean {
    return this.abort.signal.aborted;
  }

  /** Any tool_use block of this message has been started. */
  get hasToolUse(): boolean {
    return this.toolBlocks.size > 0;
  }

  /** A tool block was started and either is still open or was stopped without its final arguments. */
  get hasIncompleteToolBlock(): boolean {
    for (const t of this.toolBlocks.values()) if (!t.argsComplete) return true;
    return false;
  }

  /** At least one tool block was stopped with its final arguments sent. */
  get hasCompletedToolBlock(): boolean {
    for (const t of this.toolBlocks.values()) if (t.argsComplete && t.stopped) return true;
    return false;
  }

  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.controller.enqueue(
      this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    );
  }

  /** Upstream bytes arrived: the ping only fires after a second of upstream silence. */
  touch(): void {
    this.lastActivity = Date.now();
  }

  /** The next content-block index. Never reused, across every leg of the turn. */
  nextIndex(): number {
    return this.curIdx++;
  }

  /** `message_start`, one ping, and the 1 s keepalive. */
  start(): void {
    this.send("message_start", {
      type: "message_start",
      message: {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: this.opts.modelName,
        stop_reason: null,
        stop_sequence: null,
        usage: messageStartUsage(this.opts.priorInputTokens),
      },
    });
    this.send("ping", { type: "ping" });
    this.pingTimer = setInterval(() => {
      if (!this.closed && Date.now() - this.lastActivity > 1000) {
        this.send("ping", { type: "ping" });
      }
    }, 1000);
  }

  startBlock(index: number, contentBlock: Record<string, unknown>): void {
    if (contentBlock.type === "text") this.texts.set(index, "");
    this.send("content_block_start", {
      type: "content_block_start",
      index,
      content_block: contentBlock,
    });
  }

  delta(index: number, delta: Record<string, unknown>): void {
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      const text = this.texts.get(index);
      if (text !== undefined) this.texts.set(index, text + delta.text);
    }
    this.send("content_block_delta", { type: "content_block_delta", index, delta });
  }

  /** The id of the message's first tool_use block, if any. */
  get firstToolUseId(): string | undefined {
    return this.firstToolId;
  }

  /** The message's text blocks so far, in block order. */
  textBlocks(): string[] {
    return [...this.texts.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
  }

  stopBlock(index: number): void {
    this.send("content_block_stop", { type: "content_block_stop", index });
  }

  /** A tool_use `content_block_start`; the observer fires here and nowhere else. */
  startToolBlock(index: number, id: string, name: string): void {
    this.toolBlocks.set(index, { name, argsComplete: false, stopped: false });
    this.firstToolId ??= id;
    this.opts.onToolCallObserved?.(name);
    this.startBlock(index, { type: "tool_use", id, name, input: {} });
  }

  /** The block's final arguments have been sent. */
  markToolArgsComplete(index: number): void {
    const t = this.toolBlocks.get(index);
    if (t) t.argsComplete = true;
  }

  stopToolBlock(index: number): void {
    const t = this.toolBlocks.get(index);
    if (t) t.stopped = true;
    this.stopBlock(index);
  }

  /** One whole tool_use block: start, its complete arguments as one delta, stop. */
  emitToolUse(id: string, name: string, argsJson: string): void {
    const index = this.nextIndex();
    this.startToolBlock(index, id, name);
    this.delta(index, { type: "input_json_delta", partial_json: argsJson });
    this.markToolArgsComplete(index);
    this.stopToolBlock(index);
  }

  /** `message_delta` + `message_stop`. */
  endMessage(stopReason: string, usage: { input_tokens: number; output_tokens: number }): void {
    this.send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    });
    this.send("message_stop", { type: "message_stop" });
    this.finish();
  }

  /**
   * The five-event tail of an in-band error: a text block carrying the message,
   * then a normal `end_turn`.
   */
  endWithText(text: string, usage: { input_tokens: number; output_tokens: number }): void {
    const idx = this.nextIndex();
    this.startBlock(idx, { type: "text", text: "" });
    this.delta(idx, { type: "text_delta", text });
    this.stopBlock(idx);
    this.endMessage("end_turn", usage);
  }

  /**
   * End with an SSE `error` event: Claude Code discards the message (no
   * tool_use of it runs) and retries the turn.
   */
  endWithError(message: string, type = "api_error"): void {
    this.send("error", { type: "error", error: { type, message } });
    this.finish();
  }

  /** Stop the ping and close the controller. Idempotent; safe after cancel(). */
  close(): void {
    this.stopPing();
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // Already closed by cancel(); nothing left to do.
    }
  }

  /**
   * The client went away. The controller is already closed by the runtime, so
   * nothing may be enqueued again: without `closed` the ping timer would call
   * `enqueue()` on a closed controller and throw from a timer callback, where
   * nothing catches it, killing the proxy process.
   */
  cancel(): void {
    this.closed = true;
    this.stopPing();
    if (!this.abort.signal.aborted) {
      log("[ResponsesSSE] client disconnected: cancelling the upstream reader");
      this.abort.abort();
    }
  }

  /** An ending was written: nothing more goes out, the ping stops. */
  private finish(): void {
    this.ended = true;
    this.stopPing();
    this.closed = true;
  }

  /** True once an ending (message_stop or error) was written. */
  get hasEnded(): boolean {
    return this.ended;
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
