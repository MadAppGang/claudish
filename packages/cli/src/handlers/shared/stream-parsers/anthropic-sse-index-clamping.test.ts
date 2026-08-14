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

  it("clamps an orphan delta to the last OPEN block, not the next slot", async () => {
    // A delta can only reference a block the client has opened. Clamping it
    // to highest + 1 would emit a delta for an unopened block — the same
    // "Content block not found" this guard exists to prevent.
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
    expect(out).toContain("orphan");
  });
});
