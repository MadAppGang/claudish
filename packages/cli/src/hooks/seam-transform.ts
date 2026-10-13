/**
 * Stage 1 of the response seam: the closed transform (§5.3).
 *
 * - `intercept`: complete events are forwarded as soon as their terminator
 *   arrives, re-encoded from the decoded text (byte-identical for valid UTF-8).
 *   Only a `tool_use` block of an armed tool is held: its `content_block_start`
 *   goes out at once, its `input_json_delta` events are swallowed, and at its
 *   `content_block_stop` the `toolCall` hooks run and the block is finished with
 *   ONE `input_json_delta` carrying the repaired (or original) arguments, then
 *   the stop. No block is inserted or dropped, so no index changes.
 * - `buffer`: `message_start` and leading thinking blocks stream live. From the
 *   first `content_block_start` of any other type, every event except `ping` is
 *   held, in order, until `message_delta`. Then the `toolCall` hooks' repairs
 *   (started at each held tool block's stop) are collected, the
 *   `responseRewrite` hooks run over the whole response, their text actions are
 *   applied to the held blocks, and the held region is re-emitted. Once a block
 *   is inserted or dropped, every later block event is re-serialised with its
 *   new index, so emitted indices are always 0, 1, 2, … with no gap or repeat.
 *
 * Safety (§5.4): pings are forwarded immediately in every state, and while the
 * transform holds content with no upstream ping to forward it emits its own
 * once a second. Past 8 MiB held it flushes everything unchanged and stops
 * holding. An upstream `event: error` flushes the held events unchanged, then
 * the error. A throw inside the transform flushes what it holds and passes the
 * rest through. A client cancel cancels the upstream and aborts running hooks.
 */

import { log } from "../logger.js";
import {
  BlockCollector,
  type CollectedBlock,
  collectorView,
  isThinkingType,
} from "./response-blocks.js";
import type { SeamHooks } from "./seam-hooks.js";
import {
  type SseEvent,
  SseSplitter,
  chunkText,
  encodeUtf8,
  eventJson,
  serializeSseEvent,
} from "./sse-codec.js";
import { type RewriteBlock, applyTextActions } from "./text-rewrite.js";

export type ClosedMode = "intercept" | "buffer";

/** The exact keepalive frame every parser emits. */
export const PING_FRAME = 'event: ping\ndata: {"type":"ping"}\n\n';

/** Held content past which the seam stops holding (§5.4). */
export const HOLD_CAP_BYTES = 8 * 1024 * 1024;

export interface ClosedTransformOptions {
  mode: ClosedMode;
  hooks: SeamHooks;
  /** Interval of the seam's own pings while it holds content. Default 1,000 ms. */
  pingIntervalMs?: number;
  /** Held bytes past which it flushes and stops holding. Default 8 MiB. */
  holdCapBytes?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: parsed SSE payloads are untyped
type Json = any;

type QueueItem =
  | { kind: "event"; ev: SseEvent }
  | { kind: "end" }
  | { kind: "error"; err: unknown };

/** One armed tool block held in `intercept` mode. */
interface HeldTool {
  index: number;
  id: string;
  name: string;
  args: string;
  /** Its `input_json_delta` events, swallowed. */
  deltas: SseEvent[];
  /** Any other event that arrived while it was held. */
  extras: SseEvent[];
}

/** One block of the `buffer` mode's held region. */
interface HeldBlock {
  index: number;
  events: SseEvent[];
  collected: CollectedBlock;
}

function isPing(ev: SseEvent, json: Json): boolean {
  return ev.event === "ping" || json?.type === "ping";
}

function isError(ev: SseEvent, json: Json): boolean {
  return ev.event === "error" || json?.type === "error";
}

/** Re-serialise a block event with a new index; anything unparseable stays raw. */
function reindexed(ev: SseEvent, index: number): string {
  const json = eventJson(ev);
  if (!json || typeof (json as Json).index !== "number") return ev.raw;
  return serializeSseEvent(ev.event, { ...(json as object), index });
}

function inputDelta(index: number, partialJson: string): string {
  return serializeSseEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

/** A rewritten or inserted text block: start (empty), bounded text deltas, stop. */
function textBlock(index: number, text: string): string[] {
  const out = [
    serializeSseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }),
  ];
  for (const piece of chunkText(text)) {
    out.push(
      serializeSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: piece },
      })
    );
  }
  out.push(serializeSseEvent("content_block_stop", { type: "content_block_stop", index }));
  return out;
}

/**
 * A held block re-emitted at `index`: its original bytes when the index is
 * unchanged, every event re-serialised with the new index otherwise. A
 * repaired tool block loses its fragments and gets one delta before its stop.
 */
function heldBlock(
  held: HeldBlock,
  index: number,
  repaired: Record<string, unknown> | undefined
): string[] {
  const same = index === held.index;
  const raw = (ev: SseEvent) => (same ? ev.raw : reindexed(ev, index));
  if (!repaired) return held.events.map(raw);
  const out: string[] = [];
  let deltaSent = false;
  for (const ev of held.events) {
    const json = eventJson(ev) as Json;
    if (json?.type === "content_block_delta" && json.delta?.type === "input_json_delta") continue;
    if (json?.type === "content_block_stop" && !deltaSent) {
      out.push(inputDelta(index, JSON.stringify(repaired)));
      deltaSent = true;
    }
    out.push(raw(ev));
  }
  return out;
}

export function closedTransform(
  source: ReadableStream<Uint8Array>,
  opts: ClosedTransformOptions
): ReadableStream<Uint8Array> {
  return new ClosedTransform(source, opts).readable;
}

class ClosedTransform {
  readonly readable: ReadableStream<Uint8Array>;

  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly splitter = new SseSplitter();
  private readonly abort = new AbortController();
  private readonly pingIntervalMs: number;
  private readonly holdCap: number;
  private readonly queue: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private done = false;
  private lastPingAt = Date.now();
  /** Once true, every event is forwarded unchanged (cap, error, fail-open). */
  private passthrough = false;
  /**
   * An upstream read error, raised once the client has read what was flushed
   * before it: `controller.error()` discards chunks still queued.
   */
  private pendingError: { err: unknown } | null = null;

  // intercept
  private heldTool: HeldTool | null = null;

  // buffer
  private phase: "live" | "holding" | "after" = "live";
  private readonly collector = new BlockCollector();
  private liveBlocks = 0;
  private heldRaw: SseEvent[] = [];
  private heldBlocks: HeldBlock[] = [];
  private readonly heldByIndex = new Map<number, HeldBlock>();
  private loose: Array<{ ev: SseEvent; ordinal: number }> = [];
  private readonly toolRuns = new Map<number, Promise<Record<string, unknown> | undefined>>();
  private heldBytes = 0;

  constructor(
    source: ReadableStream<Uint8Array>,
    private readonly opts: ClosedTransformOptions
  ) {
    this.reader = source.getReader();
    this.pingIntervalMs = opts.pingIntervalMs ?? 1_000;
    this.holdCap = opts.holdCapBytes ?? HOLD_CAP_BYTES;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        this.timer = setInterval(() => this.tick(), this.pingIntervalMs);
        (this.timer as { unref?: () => void }).unref?.();
        void this.pump();
      },
      pull: () => this.raisePendingError(),
      cancel: (reason) => {
        this.stop();
        this.abort.abort(reason ?? new Error("client cancelled"));
        return this.reader.cancel(reason).catch(() => {});
      },
    });
  }

  /* ───────────── reading ───────────── */

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (this.done) return;
        if (done) {
          for (const ev of this.splitter.end()) this.push({ kind: "event", ev });
          this.push({ kind: "end" });
          return;
        }
        for (const ev of this.splitter.push(value)) this.push({ kind: "event", ev });
      }
    } catch (err) {
      if (!this.done) this.push({ kind: "error", err });
    }
  }

  /**
   * Queue one item and drain. While a hook is awaited, a ping skips the queue:
   * keepalive must reach the client however long the hold lasts.
   */
  private push(item: QueueItem): void {
    if (item.kind === "event" && this.busy && isPing(item.ev, eventJson(item.ev))) {
      this.emit(item.ev.raw);
      return;
    }
    this.queue.push(item);
    this.drain();
  }

  /** Process queued items in order; synchronous until a handler returns a promise. */
  private drain(): void {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length > 0 && !this.done) {
      const item = this.queue.shift() as QueueItem;
      let pending: void | Promise<void>;
      try {
        pending = this.handleItem(item);
      } catch (err) {
        this.failOpen(err);
        continue;
      }
      if (pending) {
        pending.then(
          () => {
            this.busy = false;
            this.drain();
          },
          (err) => {
            this.failOpen(err);
            this.busy = false;
            this.drain();
          }
        );
        return;
      }
    }
    this.busy = false;
  }

  private handleItem(item: QueueItem): void | Promise<void> {
    if (item.kind === "end") {
      this.flushHeld();
      this.close();
      return;
    }
    if (item.kind === "error") {
      this.flushHeld();
      this.stop();
      this.pendingError = { err: item.err };
      this.raisePendingError();
      return;
    }
    const ev = item.ev;
    if (this.passthrough) {
      this.emit(ev.raw);
      return;
    }
    const json = eventJson(ev) as Json;
    if (isPing(ev, json)) {
      this.emit(ev.raw);
      return;
    }
    if (isError(ev, json)) {
      this.flushHeld();
      this.passthrough = true;
      this.emit(ev.raw);
      return;
    }
    return this.opts.mode === "intercept" ? this.intercept(ev, json) : this.buffer(ev, json);
  }

  /* ───────────── intercept ───────────── */

  private intercept(ev: SseEvent, json: Json): void | Promise<void> {
    const held = this.heldTool;
    if (held) {
      if (json?.type === "content_block_stop" && json.index === held.index) {
        return this.finishTool(held, ev);
      }
      if (
        json?.type === "content_block_delta" &&
        json.index === held.index &&
        json.delta?.type === "input_json_delta"
      ) {
        held.deltas.push(ev);
        held.args += typeof json.delta.partial_json === "string" ? json.delta.partial_json : "";
      } else {
        held.extras.push(ev);
      }
      this.account(ev, "intercept");
      return;
    }
    const cb = json?.type === "content_block_start" ? json.content_block : undefined;
    if (
      cb?.type === "tool_use" &&
      typeof cb.name === "string" &&
      this.opts.hooks.intercepts(cb.name)
    ) {
      this.heldTool = {
        index: json.index,
        id: typeof cb.id === "string" ? cb.id : "",
        name: cb.name,
        args: "",
        deltas: [],
        extras: [],
      };
    }
    this.emit(ev.raw);
  }

  private async finishTool(held: HeldTool, stop: SseEvent): Promise<void> {
    let repaired: Record<string, unknown> | undefined;
    try {
      repaired = await this.opts.hooks.interceptToolCall(
        { id: held.id, name: held.name, rawArgs: held.args },
        this.abort.signal
      );
    } catch (err) {
      // The block goes out as the model sent it.
      log(`[hooks] seam toolCall failed open: ${err instanceof Error ? err.message : err}`);
    }
    if (this.done || this.heldTool !== held) return;
    this.heldTool = null;
    const args = repaired ? JSON.stringify(repaired) : held.args;
    if (repaired || held.deltas.length > 0) this.emit(inputDelta(held.index, args));
    for (const extra of held.extras) this.emit(extra.raw);
    this.emit(stop.raw);
  }

  /* ───────────── buffer ───────────── */

  private buffer(ev: SseEvent, json: Json): void | Promise<void> {
    if (this.phase === "after") {
      this.emit(ev.raw);
      return;
    }
    if (json) this.collector.onEvent(json);

    if (this.phase === "live") {
      if (json?.type === "message_delta") return this.finishHold(ev);
      if (json?.type === "content_block_start") {
        if (isThinkingType(json.content_block?.type)) {
          this.liveBlocks++;
          this.emit(ev.raw);
          return;
        }
        this.phase = "holding";
        this.hold(ev, json);
        return;
      }
      this.emit(ev.raw);
      return;
    }

    if (json?.type === "message_delta") return this.finishHold(ev);
    this.hold(ev, json);
  }

  private hold(ev: SseEvent, json: Json): void {
    this.heldRaw.push(ev);
    const index = typeof json?.index === "number" ? json.index : undefined;
    if (json?.type === "content_block_start" && index !== undefined) {
      const collected = this.collector.blocks[this.collector.blocks.length - 1] as CollectedBlock;
      const block: HeldBlock = { index, events: [ev], collected };
      this.heldBlocks.push(block);
      this.heldByIndex.set(index, block);
    } else if (index !== undefined && this.heldByIndex.has(index)) {
      const block = this.heldByIndex.get(index) as HeldBlock;
      block.events.push(ev);
      if (json.type === "content_block_stop") this.startToolRun(block);
    } else {
      this.loose.push({ ev, ordinal: this.heldBlocks.length });
    }
    this.account(ev, "buffer");
  }

  /** A held tool block completed: start its `toolCall` hooks now, collect at `message_delta`. */
  private startToolRun(block: HeldBlock): void {
    const c = block.collected;
    if (c.type !== "tool_use" || !c.name || !this.opts.hooks.intercepts(c.name)) return;
    const run = this.opts.hooks
      .interceptToolCall({ id: c.id ?? "", name: c.name, rawArgs: c.args }, this.abort.signal)
      .catch((err: unknown) => {
        log(`[hooks] seam toolCall failed open: ${err instanceof Error ? err.message : err}`);
        return undefined;
      });
    this.toolRuns.set(block.index, run);
  }

  private async finishHold(messageDelta: SseEvent): Promise<void> {
    try {
      await this.rewriteHeld();
    } catch (err) {
      // Fail open: whatever is still held goes out unchanged.
      log(`[hooks] seam rewrite failed open: ${err instanceof Error ? err.message : err}`);
      this.flushHeld();
      this.passthrough = true;
    }
    if (this.done) return;
    this.phase = "after";
    this.emit(messageDelta.raw);
  }

  /** Collect repairs, run `responseRewrite`, and re-emit the held region. */
  private async rewriteHeld(): Promise<void> {
    const repairs = new Map<number, Record<string, unknown>>();
    for (const [index, run] of this.toolRuns) {
      const args = await run;
      if (args) repairs.set(index, args);
    }
    if (this.done) return;
    const hooks = this.opts.hooks;
    const planned = await hooks.rewrite(collectorView(this.collector, repairs), this.abort.signal);
    if (this.done) return;

    const rewriteBlocks: RewriteBlock[] = this.heldBlocks.map((b) => ({
      type: b.collected.type,
      ...(b.collected.type === "text" ? { text: b.collected.text } : {}),
      ...(b.collected.locked ? { locked: true } : {}),
    }));
    if (planned.length > 0 && rewriteBlocks.some((b) => b.locked)) {
      hooks.noteRewriteInvalid("citations");
    }
    const result = applyTextActions(
      rewriteBlocks,
      planned.map((p) => p.action)
    );
    hooks.recordRewrite(planned, result);

    // Build the whole region first, so a throw half way emits nothing twice.
    const out: string[] = [];
    let k = 0;
    let looseAt = 0;
    const flushLoose = (upTo: number) => {
      while (looseAt < this.loose.length && (this.loose[looseAt]?.ordinal ?? 0) <= upTo) {
        out.push((this.loose[looseAt] as { ev: SseEvent }).ev.raw);
        looseAt++;
      }
    };
    for (const block of result.blocks) {
      const index = this.liveBlocks + k++;
      if (block.source !== null) flushLoose(block.source);
      if (block.source === null || block.changed) {
        out.push(...textBlock(index, (block.block as { text?: string }).text ?? ""));
        continue;
      }
      const held = this.heldBlocks[block.source] as HeldBlock;
      out.push(...heldBlock(held, index, repairs.get(held.index)));
    }
    flushLoose(Number.POSITIVE_INFINITY);
    this.resetHeld();
    for (const text of out) this.emit(text);
  }

  /* ───────────── holding bookkeeping ───────────── */

  /** Count held bytes; past the cap, flush everything unchanged and stop holding. */
  private account(ev: SseEvent, mode: ClosedMode): void {
    this.heldBytes += Buffer.byteLength(ev.raw);
    if (this.heldBytes <= this.holdCap) return;
    log(`[hooks] seam held more than ${this.holdCap} bytes: flushed unchanged, holding stopped`);
    if (mode === "buffer") this.opts.hooks.noteRewriteInvalid("buffer_cap");
    else this.opts.hooks.noteInterceptInvalid("buffer_cap");
    this.flushHeld();
    this.passthrough = true;
  }

  /** Forward everything held, unchanged, in arrival order. */
  private flushHeld(): void {
    const tool = this.heldTool;
    if (tool) {
      this.heldTool = null;
      for (const ev of tool.deltas) this.emit(ev.raw);
      for (const ev of tool.extras) this.emit(ev.raw);
    }
    if (this.heldRaw.length > 0) {
      for (const ev of this.heldRaw) this.emit(ev.raw);
    }
    this.resetHeld();
    if (this.phase === "holding") this.phase = "after";
  }

  private resetHeld(): void {
    this.heldRaw = [];
    this.heldBlocks = [];
    this.heldByIndex.clear();
    this.loose = [];
    this.toolRuns.clear();
    this.heldBytes = 0;
  }

  private get holding(): boolean {
    return this.busy || this.heldTool !== null || this.phase === "holding";
  }

  /** The seam's own keepalive, while it holds content and upstream sends none. */
  private tick(): void {
    if (this.done || !this.holding) return;
    if (Date.now() - this.lastPingAt < this.pingIntervalMs) return;
    this.emit(PING_FRAME);
  }

  /** A throw inside the transform: flush what is held and pass the rest through. */
  private failOpen(err: unknown): void {
    log(`[hooks] seam transform failed open: ${err instanceof Error ? err.message : err}`);
    try {
      this.flushHeld();
    } catch {}
    this.passthrough = true;
  }

  /* ───────────── output ───────────── */

  /** Error the stream once the client has drained what was queued before the error. */
  private raisePendingError(): void {
    const pending = this.pendingError;
    if (!pending || (this.controller.desiredSize ?? 0) <= 0) return;
    this.pendingError = null;
    this.controller.error(pending.err);
  }

  private emit(text: string): void {
    if (this.done) return;
    if (text === PING_FRAME || text.startsWith("event: ping")) this.lastPingAt = Date.now();
    this.controller.enqueue(encodeUtf8(text));
  }

  private close(): void {
    if (this.done) return;
    this.stop();
    this.controller.close();
  }

  private stop(): void {
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
