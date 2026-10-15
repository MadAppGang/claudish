import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAnthropicPassthroughStream } from "./anthropic-sse.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../test-fixtures/sse-responses"
);

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

const run = (frames: string[], adapter?: any) =>
  createAnthropicPassthroughStream(ctx, sseResponse(frames), {
    modelName: "test-model",
    adapter,
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

/** Replay a whole fixture file (stripping its `# ` metadata lines) through the parser. */
const runFixture = async (name: string, adapter?: any): Promise<string> => {
  const text = readFileSync(join(FIXTURES_DIR, name), "utf-8")
    .split("\n")
    .filter((l) => !l.startsWith("# "))
    .join("\n");
  return stripPingFrames(await run([text], adapter));
};

/** Parse a parser-emitted wire into its data payloads, in order. */
const parseEmitted = (wire: string): any[] =>
  wire
    .split("\n\n")
    .flatMap((frame) => frame.split("\n"))
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .filter((d) => d !== '{"type":"ping"}')
    .map((d) => JSON.parse(d));

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

describe.each([
  { reqN: "r10324", textFragment: "Search-4-LocalSearch", toolFragment: "check_twin_parity.py" },
  { reqN: "r10416", textFragment: "QuantConnect", toolFragment: "config.json" },
])(
  "production fixture: MiniMax-M3 implicit signature block ($reqN)",
  ({ reqN, textFragment, toolFragment }) => {
    it("renumbers the whole stream sequentially and drops the implicit signature block", async () => {
      // Fixtures reconstructed from production captures (see the file header for
      // the reconstruction proof): MiniMax emits a signature_delta + stop at
      // index 0 with NO content_block_start (implicit block), then the text
      // block at index 1 and the tool_use block at index 2.
      const events = parseEmitted(
        await runFixture(`minimax-m3-anthropic-implicit-signature-${reqN}.sse`)
      );

      // The implicit signature block never existed client-side: dropped whole.
      expect(
        events.filter(
          (e) => e.type === "content_block_delta" && e.delta?.type === "signature_delta"
        )
      ).toHaveLength(0);

      // Exactly two blocks are opened, renumbered sequentially: text at 0, tool_use at 1.
      const starts = events.filter((e) => e.type === "content_block_start");
      expect(starts.map((e) => [e.index, e.content_block.type])).toEqual([
        [0, "text"],
        [1, "tool_use"],
      ]);

      // Every text delta follows the remap: all at 0, none leaked at 1.
      const textDeltas = events.filter((e) => e.delta?.type === "text_delta");
      expect(textDeltas.length).toBeGreaterThan(5);
      expect(new Set(textDeltas.map((e) => e.index))).toEqual(new Set([0]));
      expect(textDeltas.map((e) => e.delta.text).join("")).toContain(textFragment);

      // The tool call's input stream follows its own remap: all at 1, none at 2,
      // and the concatenated partial_json reassembles into valid JSON.
      const toolDeltas = events.filter((e) => e.delta?.type === "input_json_delta");
      expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
      expect(new Set(toolDeltas.map((e) => e.index))).toEqual(new Set([1]));
      const toolInput = JSON.parse(toolDeltas.map((e) => e.delta.partial_json).join(""));
      expect(JSON.stringify(toolInput)).toContain(toolFragment);

      // Blocks close in order, the terminal pair is present, and no index ever
      // escapes the sequential range.
      expect(events.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual([
        0, 1,
      ]);
      expect(events.at(-1)?.type).toBe("message_stop");
      const stopReason = events.find((e) => e.type === "message_delta")?.delta?.stop_reason;
      expect(stopReason).toBe("tool_use");
      expect(events.filter((e) => typeof e.index === "number" && e.index > 1)).toHaveLength(0);
    });
  }
);

// Without the adapter, this silently exercises the unfiltered branch and proves
// nothing about the MiniMax path used in production.
describe("index mapping applies on the thinking-filtered path too", () => {
  it("only emits deltas and stops for sequentially opened blocks", async () => {
    const adapter = { shouldFilterThinking: () => true } as any;
    const events = parseEmitted(
      await runFixture("minimax-m3-anthropic-implicit-signature-r10324.sse", adapter)
    );
    const openedIndices = new Set<number>();
    const violations: any[] = [];

    for (const event of events) {
      if (event.type === "content_block_start") {
        openedIndices.add(event.index);
      } else if (
        (event.type === "content_block_delta" || event.type === "content_block_stop") &&
        !openedIndices.has(event.index)
      ) {
        violations.push(event);
      }
    }

    expect(
      violations,
      `Frames referenced unopened content block indices:\n${JSON.stringify(violations, null, 2)}`
    ).toHaveLength(0);
    expect([...openedIndices]).toEqual([0, 1]);
  });
});
