/**
 * S4-b lot C — the one-open-content-block writer (ccca029, item 5).
 *
 * Two test populations, both written BEFORE the implementation:
 *
 *  1. UNIT — the writer's transition table directly. ai-01's dispatch asked
 *     for the invariant "verified by a test that counts, not by re-review":
 *     every test here walks the emitted frames and counts starts/stops against
 *     the open block.
 *
 *  2. PARSER — the behaviour change that motivates the commit: a
 *     `reasoning_content` chunk arriving AFTER text used to open a thinking
 *     block while the text block was still open. Upstream's capture-replay
 *     gate cannot catch it (no capture in any tree emits reasoning after
 *     text); constructed frames can, and inline frames are the repo's
 *     established convention for parser tests (tool-name-mangling,
 *     tool-recovery-trust).
 *
 * The INTERLEAVE degradation (parallel tool_calls fragments, impossible on
 * Anthropic's wire) is tested here with the fix this absorption adds over
 * upstream: a tool degraded to the buffered path RE-RESERVES its index, because
 * its original block index was spent (opened AND closed by the superseding
 * block) — flushing at the spent index would emit a second
 * `content_block_start` for an index the client already saw, which is the
 * double-start this whole commit exists to make impossible.
 *
 * Non-vacuity: written before the implementation.
 */

import { describe, expect, test } from "bun:test";
import { createBlockWriter, type BlockRef } from "./block-writer.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

function collect(): { frames: Array<{ event: string; data: any }>; send: any } {
  const frames: Array<{ event: string; data: any }> = [];
  const send = (event: string, data: any) => frames.push({ event, data });
  return { frames, send };
}

function starts(frames: Array<{ event: string; data: any }>) {
  return frames.filter((f) => f.event === "content_block_start").map((f) => f.data.index);
}
function stops(frames: Array<{ event: string; data: any }>) {
  return frames.filter((f) => f.event === "content_block_stop").map((f) => f.data.index);
}

/** Walk the frames and return every one-open-block violation, named. */
function nestingViolations(frames: Array<{ event: string; data: any }>): string[] {
  const problems: string[] = [];
  let open: number | null = null;
  const started = new Set<number>();
  const stopped = new Set<number>();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.event === "content_block_start") {
      if (open !== null) problems.push(`frame ${i}: start index=${f.data.index} while ${open} is open`);
      if (started.has(f.data.index)) problems.push(`frame ${i}: index=${f.data.index} started twice`);
      started.add(f.data.index);
      open = f.data.index;
    } else if (f.event === "content_block_delta") {
      if (open !== f.data.index)
        problems.push(`frame ${i}: delta index=${f.data.index} but open block is ${open ?? "none"}`);
    } else if (f.event === "content_block_stop") {
      if (open !== f.data.index)
        problems.push(`frame ${i}: stop index=${f.data.index} but open block is ${open ?? "none"}`);
      if (stopped.has(f.data.index)) problems.push(`frame ${i}: index=${f.data.index} stopped twice`);
      stopped.add(f.data.index);
      open = null;
    }
  }
  if (open !== null) problems.push(`ended with index=${open} still open`);
  return problems;
}

describe("S4-b lot C: BlockWriter transition table (ccca029)", () => {
  test("opening a second kind closes the first — one open block at a time, always", () => {
    const { frames, send } = collect();
    const w = createBlockWriter(send);
    const text = w.openText();
    w.append(text, "hello");
    const thinking = w.openThinking();
    w.append(thinking, "hm");
    const tool = w.openTool({ id: "t1", name: "Bash" });
    w.append(tool, "{}");
    w.closeCurrent(); // end the turn — the checker asserts no block left open
    expect(nestingViolations(frames)).toEqual([]);
    expect(starts(frames)).toEqual([0, 1, 2]);
    expect(stops(frames)).toEqual([0, 1, 2]);
  });

  test("appending to a superseded block returns false and emits nothing", () => {
    const { frames, send } = collect();
    const w = createBlockWriter(send);
    const text = w.openText();
    w.openThinking();
    const before = frames.length;
    expect(w.append(text, "late")).toBe(false);
    expect(frames.length).toBe(before); // nothing emitted for the superseded block
  });

  test("openTool never reuses: two calls are two blocks (the repair path's need)", () => {
    const { frames, send } = collect();
    const w = createBlockWriter(send);
    const a = w.openTool({ id: "t1", name: "Read" });
    const b = w.openTool({ id: "t2", name: "Read" });
    w.closeCurrent();
    expect(a.index).not.toBe(b.index);
    expect(w.emittedToolRefs.length).toBe(2);
    expect(nestingViolations(frames)).toEqual([]);
  });

  test("close() is idempotent and safe on a superseded block", () => {
    const { frames, send } = collect();
    const w = createBlockWriter(send);
    const text = w.openText();
    w.openThinking(); // supersedes and closes the text block
    w.close(text); // no-op: already stopped
    w.close(text); // still no-op
    w.closeCurrent();
    expect(stops(frames)).toEqual([0, 1]); // one stop for the text block, one for thinking — index 0 never twice
    expect(nestingViolations(frames)).toEqual([]);
  });

  test("reserve() allocates without emitting; a reserved index is honoured at open", () => {
    const { frames, send } = collect();
    const w = createBlockWriter(send);
    w.openThinking();
    const reserved = w.reserve();
    expect(frames.length).toBe(1); // only the thinking start — reserve emits nothing
    const ref = w.openTool({ id: "t", name: "Bash", index: reserved });
    w.closeCurrent();
    expect(ref.index).toBe(reserved);
    expect(starts(frames)).toEqual([0, reserved]);
  });

  test("a reserved index is NOT spent when the block is already open (logged, unused)", () => {
    const { frames, send } = collect();
    const w = createBlockWriter(send);
    const first = w.openText({ index: 5 });
    const again = w.openText({ index: 9 }); // text already open — reuse
    expect(again).toBe(first);
    expect(starts(frames)).toEqual([5]);
  });

  test("the writer NEVER THROWS — an illegal sequence corrects state and continues", () => {
    const { frames, send } = collect();
    const w = createBlockWriter(send);
    const stranger: BlockRef = { index: 42, kind: "text" };
    expect(() => {
      w.append(stranger, "x"); // never opened
      w.close(stranger); // never opened
      w.closeCurrent(); // nothing open
      w.openText();
    }).not.toThrow();
    w.closeCurrent();
    expect(nestingViolations(frames)).toEqual([]);
  });

  test("append emits the right delta shape per kind", () => {
    const { frames, send } = collect();
    const w = createBlockWriter(send);
    w.append(w.openText(), "t");
    w.append(w.openThinking(), "h");
    w.append(w.openTool({ id: "t", name: "B" }), "{}");
    const deltas = frames.filter((f) => f.event === "content_block_delta").map((f) => f.data.delta.type);
    expect(deltas).toEqual(["text_delta", "thinking_delta", "input_json_delta"]);
  });
});

// ─── Parser-level: constructed frames ────────────────────────────────────────

const SSE_HEADERS: Record<string, string> = { "Content-Type": "text/event-stream" };

function mockContext() {
  const c: any = {
    req: {},
    body: (stream: ReadableStream, init?: any) => new Response(stream, init),
  };
  return c;
}

function sseResponse(raw: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { headers: new Headers(SSE_HEADERS) });
}

async function drain(response: Response): Promise<string> {
  let output = "";
  await response.body?.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk, { stream: true });
      },
    })
  );
  return output;
}

function parseEvents(output: string): any[] {
  const events: any[] = [];
  for (const part of output.split("\n\n")) {
    let dataStr = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("data: ")) dataStr += line.slice(6);
    }
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      events.push(JSON.parse(dataStr));
    } catch {}
  }
  return events;
}

const adapter = {
  processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }),
};

async function runRaw(raw: string): Promise<any[]> {
  const response = createStreamingResponseHandler(
    mockContext(),
    sseResponse(raw),
    adapter as any,
    "test-model",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined
  ) as Response;
  const output = await drain(response);
  return parseEvents(output);
}

function frame(delta: any, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function violationsOf(events: any[]): string[] {
  const frames = events.map((e) => ({ event: e.type, data: e }));
  return nestingViolations(frames);
}

describe("S4-b lot C: parser behaviour change (ccca029)", () => {
  test("reasoning arriving AFTER text closes the text block before opening thinking", async () => {
    const events = await runRaw(
      frame({ content: "answer part" }) +
        frame({ reasoning: "belated thinking" }) +
        frame({ content: " more answer" }) +
        frame({}, "stop") +
        "data: [DONE]\n\n"
    );
    expect(violationsOf(events)).toEqual([]);
    // text@0 … stop 0 … thinking@1 … stop 1 … text@2 — no two blocks ever open
    const idx = events.filter((e) => e.type === "content_block_start").map((e) => e.index);
    expect(idx).toEqual([0, 1, 2]);
  });

  test("interleaved parallel tool fragments degrade to complete buffered blocks at FRESH indices", async () => {
    // tool 0 and tool 1 fragments interleave — impossible on Anthropic's wire.
    // The degraded tool must re-reserve: its original index was spent when the
    // other tool's block superseded (opened+closed) it.
    const tc = (index: number, fn: any) => ({ index, ...{ function: fn } });
    const events = await runRaw(
      frame({ tool_calls: [tc(0, { name: "Read", arguments: '{"a":' })] }) +
        frame({ tool_calls: [tc(1, { name: "Bash", arguments: '{"b":' })] }) + // closes tool 0's block
        frame({ tool_calls: [tc(0, { arguments: '1}' })] }) + // tool 0 lost its open block mid-args
        frame({ tool_calls: [tc(1, { arguments: '2}' })] }) +
        frame({}, "tool_calls") +
        "data: [DONE]\n\n"
    );
    expect(violationsOf(events)).toEqual([]);
    // Three tool starts, all at DISTINCT indices: tool 1's streamed block, tool
    // 0's superseded PARTIAL (left on the wire with its deltas and no
    // completion — by design), and tool 0's complete flushed block at the
    // re-reserved fresh index. The partial never comes back as a second block
    // at the SAME index — that is the double-start this test exists to forbid.
    const toolStarts = events.filter(
      (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"
    );
    expect(toolStarts.length).toBe(3);
    expect(new Set(toolStarts.map((e) => e.index)).size).toBe(3);
    // Each COMPLETE call is one block whose joined deltas parse standalone.
    const argsByIndex = new Map<number, string>();
    for (const e of events) {
      if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
        argsByIndex.set(e.index, (argsByIndex.get(e.index) ?? "") + e.delta.partial_json);
      }
    }
    const completeJsons = Array.from(argsByIndex.values()).filter((v) => {
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    });
    expect(completeJsons).toContain('{"a":1}');
    expect(completeJsons).toContain('{"b":2}');
  });

  test("single tool streams byte for byte (control — the common case must not degrade)", async () => {
    const events = await runRaw(
      frame({ tool_calls: [{ index: 0, function: { name: "Read", arguments: '{"a":' } }] }) +
        frame({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }) +
        frame({}, "tool_calls") +
        "data: [DONE]\n\n"
    );
    expect(violationsOf(events)).toEqual([]);
    const deltas = events.filter(
      (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
    );
    expect(deltas.map((e) => e.delta.partial_json).join("")).toBe('{"a":1}');
  });
});
