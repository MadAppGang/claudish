import { describe, expect, it } from "bun:test";

import { createAnthropicPassthroughStream } from "./anthropic-sse.js";

const ctx: any = {
  body: (stream: any, init: any) => new Response(stream, init),
  json: () => {
    throw new Error("Unexpected no-body error path");
  },
};

const sseResponse = (frames: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const stripPingFrames = (wire: string): string =>
  wire.replaceAll('event: ping\ndata: {"type":"ping"}\n\n', "");

const run = (frames: string[]) =>
  createAnthropicPassthroughStream(ctx, sseResponse(frames), {
    modelName: "test-model",
  }).text();

const messageStart = () =>
  frame("message_start", {
    type: "message_start",
    message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 0 } },
  });

const textBlockStart = (index: number) =>
  frame("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text" },
  });

const textDelta = (index: number, text: string) =>
  frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });

const blockStop = (index: number) =>
  frame("content_block_stop", { type: "content_block_stop", index });

const messageDelta = () =>
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 4 },
  });

const messageStop = () => frame("message_stop", { type: "message_stop" });

describe("anthropic-sse content block index clamping", () => {
  it("passes sequential indices through untouched", async () => {
    const frames = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "hello"),
      blockStop(0),
      messageDelta(),
      messageStop(),
    ];

    const out = stripPingFrames(await run(frames));

    expect(out).toContain('"index":0');
    expect(out).not.toContain('"index":1');
    expect(out).toContain('"stop_reason":"end_turn"');
  });

  it("remaps a jumping content_block_start to the next sequential index", async () => {
    // z.ai has been observed sending 0 → 2, skipping 1. The client fails
    // with "Content block not found" unless the indices are remapped.
    const frames = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "first"),
      blockStop(0),
      textBlockStart(2),
      textDelta(2, "second"),
      blockStop(2),
      messageDelta(),
      messageStop(),
    ];

    const out = stripPingFrames(await run(frames));

    expect(out).toContain('"index":1');
    expect(out).not.toContain('"index":2');
    expect(out).toContain("second");
  });

  it("drops an orphan delta instead of re-attaching it to another block", async () => {
    // A delta can only reference a block the client has opened. One that
    // references nothing is dropped: clamping it onto the last open block
    // would corrupt that block's content.
    const frames = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "ok"),
      textDelta(5, "orphan"),
      blockStop(0),
      messageDelta(),
      messageStop(),
    ];

    const out = stripPingFrames(await run(frames));

    expect(out).toContain('"index":0');
    expect(out).not.toContain('"index":5');
    expect(out).not.toContain('"index":1');
    expect(out).not.toContain("orphan");
  });

  it("absorbs MiniMax's implicit signature block and keeps the stream sequential", async () => {
    // Shape extracted from 7 production captures (MiniMax-M3, anthropic
    // passthrough, 2026-07-19 → 2026-08-06): the upstream emits a
    // signature_delta + stop at index 0 with NO content_block_start for it
    // (the signature is the sha256 of the empty string — an implicit block),
    // then the text block starts at index 1. The old stateless clamp remapped
    // the start 1 → 0 but leaked every following text delta at the original
    // index 1, producing "Content block not found" on the client.
    const frames = [
      messageStart(),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "EoMC" },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      textBlockStart(1),
      textDelta(1, "real content"),
      blockStop(1),
      messageDelta(),
      messageStop(),
    ];

    const out = stripPingFrames(await run(frames));

    // The implicit signature block never existed client-side: dropped whole.
    expect(out).not.toContain("signature_delta");
    // The text block is renumbered to 0 and its deltas FOLLOW the remap —
    // no leak of the original index 1 anywhere.
    expect(out).toContain('"index":0');
    expect(out).not.toContain('"index":1');
    expect(out).toContain("real content");
    // Sequential: exactly one block start, one stop, in order.
    expect(out.indexOf("content_block_start")).toBeLessThan(out.indexOf("text_delta"));
    expect(out.lastIndexOf("content_block_stop")).toBeGreaterThan(out.indexOf("text_delta"));
  });
});
