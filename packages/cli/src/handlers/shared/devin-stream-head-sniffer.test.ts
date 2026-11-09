import { describe, expect, test } from "bun:test";
import {
  FRAME_FLAG_END_OF_STREAM,
  FRAME_HEADER_BYTES,
  createFrameReader,
  msg,
  parseTLV,
} from "../../providers/devin/proto-codec.js";
import {
  CLEAN_CAPTURE,
  TERMINAL_CAPTURE,
} from "../../test-fixtures/devin/stream-replay.test-helper.js";
import { sniffDevinStreamHead } from "./devin-stream-head-sniffer.js";

const capturedFrames = createFrameReader()(CLEAN_CAPTURE);
const firstContentFrame = capturedFrames.findIndex(
  (frame) =>
    frame.flags === 0 &&
    parseTLV(frame.payload).some(
      (field) => field.wire === 2 && [3, 6, 9].includes(field.no) && field.payload.length > 0
    )
);
if (firstContentFrame < 1) throw new Error("The healthy Devin capture has no content-free header");

let frameOffset = 0;
const capturedFrameChunks = capturedFrames.map((frame) => {
  const end = frameOffset + FRAME_HEADER_BYTES + frame.payload.length;
  const chunk = CLEAN_CAPTURE.slice(frameOffset, end);
  frameOffset = end;
  return chunk;
});
const headerBytes = msg(...capturedFrameChunks.slice(0, firstContentFrame));
const remainingFrameChunks = capturedFrameChunks.slice(firstContentFrame);
const successFrameIndex = capturedFrames.findIndex(
  (frame) =>
    frame.flags === FRAME_FLAG_END_OF_STREAM && new TextDecoder().decode(frame.payload) === "{}"
);
if (successFrameIndex < 0) throw new Error("The healthy Devin capture has no empty success frame");
const successFrameBytes = capturedFrameChunks[successFrameIndex]!;

describe("sniffDevinStreamHead", () => {
  test("classifies invalid_argument after content-free header frames as terminal", async () => {
    const verdict = await sniffDevinStreamHead(new Response(TERMINAL_CAPTURE));
    try {
      expect(verdict).toMatchObject({ kind: "terminal", code: "invalid_argument" });
    } finally {
      if (verdict.kind === "clean") await verdict.response.body?.cancel();
    }
  });

  test("keeps a healthy captured stream clean and replays every byte across split frames", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < CLEAN_CAPTURE.length; offset += 37) {
            controller.enqueue(CLEAN_CAPTURE.slice(offset, offset + 37));
          }
          controller.close();
        },
      })
    );
    const verdict = await sniffDevinStreamHead(response);
    expect(verdict.kind).toBe("clean");
    if (verdict.kind !== "clean") throw new Error("The healthy Devin capture was rejected");
    expect(new Uint8Array(await verdict.response.arrayBuffer())).toEqual(CLEAN_CAPTURE);
  });

  test("replays every captured byte when content arrives after the sniff budget", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(sourceController) {
          controller = sourceController;
          controller.enqueue(headerBytes);
        },
      })
    );

    const verdict = await sniffDevinStreamHead(response, { budgetMs: 20 });
    for (const chunk of remainingFrameChunks) controller.enqueue(chunk);
    controller.close();

    expect(verdict.kind).toBe("clean");
    if (verdict.kind !== "clean") throw new Error("The delayed healthy Devin capture was rejected");
    const replayed = new Uint8Array(await verdict.response.arrayBuffer());
    expect(replayed.byteLength).toBe(CLEAN_CAPTURE.byteLength);
    expect(replayed).toEqual(CLEAN_CAPTURE);
  });

  test("keeps header frames followed by an empty success frame clean and replays every byte", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(headerBytes);
          controller.enqueue(successFrameBytes);
          controller.close();
        },
      })
    );

    const verdict = await sniffDevinStreamHead(response);
    expect(verdict.kind).toBe("clean");
    if (verdict.kind !== "clean") throw new Error("The empty successful Devin stream was rejected");
    expect(new Uint8Array(await verdict.response.arrayBuffer())).toEqual(
      msg(headerBytes, successFrameBytes)
    );
  });

  test("keeps a closed header-only stream clean and replays every byte", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(headerBytes);
          controller.close();
        },
      })
    );

    const verdict = await sniffDevinStreamHead(response);
    expect(verdict.kind).toBe("clean");
    if (verdict.kind !== "clean")
      throw new Error("The closed header-only Devin stream was rejected");
    expect(new Uint8Array(await verdict.response.arrayBuffer())).toEqual(headerBytes);
  });

  test("returns clean at the budget for an open header-only stream and cancels its replay", async () => {
    const budgetMs = 20;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(sourceController) {
          controller = sourceController;
          controller.enqueue(headerBytes);
        },
        cancel() {
          cancelled = true;
        },
      })
    );

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let verdict: Awaited<ReturnType<typeof sniffDevinStreamHead>> | undefined;
    try {
      verdict = await Promise.race([
        sniffDevinStreamHead(response, { budgetMs }),
        new Promise<never>((_, reject) => {
          // Allow timer scheduling overhead without waiting for the default sniff budget.
          watchdog = setTimeout(
            () => reject(new Error("The open Devin stream exceeded the sniff budget")),
            budgetMs + 100
          );
        }),
      ]);
      expect(verdict.kind).toBe("clean");
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (verdict?.kind === "clean") await verdict.response.body?.cancel();
      else if (!cancelled) controller.close();
    }
    expect(cancelled).toBe(true);
  });
});
