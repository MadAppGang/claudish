import { describe, expect, it } from "bun:test";

import type { UsageCacheDetail } from "../token-tracker.js";
import { createAnthropicPassthroughStream } from "./anthropic-sse.js";

const ctx: any = {
  body: (stream: any, init: any) => new Response(stream, init),
  json: () => {
    throw new Error("Unexpected no-body error path");
  },
};

const encoder = new TextEncoder();

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// The drop happens in pull, which runs only once the queued frames have been
// read: erroring a stream discards whatever is still queued in it.
const sseResponse = (frames: string[], dropAfter = false) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
      },
      pull(controller) {
        if (dropAfter) controller.error(new Error("socket dropped"));
        else controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

const turn = (startUsage: Record<string, number>, outputTokens: number) => [
  frame("message_start", {
    type: "message_start",
    message: { id: "msg_1", usage: startUsage },
  }),
  frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  }),
  frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: outputTokens },
  }),
  frame("message_stop", { type: "message_stop" }),
];

async function reported(
  frames: string[],
  opts: { adapter?: any; dropAfter?: boolean } = {}
): Promise<Array<[number, number, UsageCacheDetail | undefined]>> {
  const calls: Array<[number, number, UsageCacheDetail | undefined]> = [];
  await createAnthropicPassthroughStream(ctx, sseResponse(frames, opts.dropAfter), {
    modelName: "test-model",
    adapter: opts.adapter,
    onTokenUpdate: (input, output, detail) => calls.push([input, output, detail]),
  }).text();
  return calls;
}

describe("anthropic-sse usage reporting", () => {
  it("reports the three input counters summed, with the cached part as detail", async () => {
    const calls = await reported(
      turn({ input_tokens: 2, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 }, 7)
    );
    expect(calls).toEqual([[502, 7, { cacheReadTokens: 400, cacheCreationTokens: 100 }]]);
  });

  it("reports input alone when the provider sends no cache counters", async () => {
    const calls = await reported(turn({ input_tokens: 30 }, 5));
    expect(calls).toEqual([[30, 5, { cacheReadTokens: 0, cacheCreationTokens: 0 }]]);
  });

  it("reports the same split on the thinking-filter path", async () => {
    const calls = await reported(
      turn({ input_tokens: 2, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 }, 7),
      { adapter: { shouldFilterThinking: () => true } }
    );
    expect(calls).toEqual([[502, 7, { cacheReadTokens: 400, cacheCreationTokens: 100 }]]);
  });

  it("reports the split for a turn the upstream abandoned", async () => {
    const [start] = turn(
      { input_tokens: 2, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 },
      0
    );
    const calls = await reported([start], { dropAfter: true });
    expect(calls).toEqual([[502, 0, { cacheReadTokens: 400, cacheCreationTokens: 100 }]]);
  });
});
