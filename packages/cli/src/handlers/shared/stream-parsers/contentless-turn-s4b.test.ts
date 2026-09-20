/**
 * S4-b lot C — a successful turn is never contentless (edd4ce9, item 12).
 *
 * `stop_reason: "end_turn"` with an empty `content` array is not a shape
 * Anthropic's API produces. The guard fires only on end_turn — the one value
 * that excludes every case where emptiness is MEANINGFUL (max_tokens,
 * refusal, tool_use).
 *
 * In THIS fork the gap the guard closes is specific: text held back pending a
 * structured tool pattern that never completed counts as "content" for the
 * empty-response notice (accumulatedText > 0) but emitted NO block — a
 * contentless end_turn shipping nothing at all. An EMPTY text block, not
 * placeholder prose and not an error (prose would enter history as the
 * assistant's words; an error would trip the client's retry on a
 * deterministic outcome).
 *
 * Non-vacuity: written before the implementation.
 */

import { describe, expect, test } from "bun:test";
import { createStreamingResponseHandler } from "./openai-sse.js";

const SSE_HEADERS: Record<string, string> = { "Content-Type": "text/event-stream" };

function mockContext() {
  return { req: {}, body: (stream: ReadableStream, init?: any) => new Response(stream, init) };
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

async function run(raw: string): Promise<any[]> {
  const response = createStreamingResponseHandler(
    mockContext(),
    sseResponse(raw),
    { processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }) } as any,
    "test-model",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined
  ) as Response;
  let output = "";
  await response.body!.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk, { stream: true });
      },
    })
  );
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

function frame(delta: any, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const stopReasonOf = (events: any[]) =>
  events.find((e) => e.type === "message_delta")?.delta?.stop_reason;
const blockStarts = (events: any[]) =>
  events.filter((e) => e.type === "content_block_start").map((e) => e.content_block?.type);

describe("S4-b lot C: a successful turn is never contentless (edd4ce9)", () => {
  test("held-back text that never became a call still yields one (empty) text block on end_turn", async () => {
    // <tool_call> tag (hold-back pattern) whose JSON never completed → held
    // back (<1000 chars), extraction at finalize recovers nothing, no block
    // was ever emitted, yet the turn "has content" (accumulatedText > 0).
    // Before the guard: end_turn with an EMPTY content array. NB: an
    // incomplete <function=…> call does NOT reproduce this — the extractor
    // lenient-parses its JSON to {} and dispatches a recovered call.
    const events = await run(
      frame({ content: '<tool_call>{"name": "Read"' }) + frame({}, "stop") + "data: [DONE]\n\n"
    );
    expect(stopReasonOf(events)).toBe("end_turn");
    expect(blockStarts(events)).toEqual(["text"]); // exactly one, EMPTY
    const deltas = events.filter((e) => e.delta?.type === "text_delta");
    expect(deltas.length).toBe(0); // empty — not placeholder prose
  });

  test("max_tokens emptiness is NOT papered over (finish_reason length, no content)", async () => {
    const events = await run(frame({}, "length") + "data: [DONE]\n\n");
    expect(stopReasonOf(events)).toBe("max_tokens");
    // our fork's empty-response notice covers this case; the guard must not
    // add a second block on top of it
    expect(blockStarts(events)).toEqual(["text"]);
  });

  test("a normal text answer is untouched (control)", async () => {
    const events = await run(frame({ content: "hello" }) + frame({}, "stop") + "data: [DONE]\n\n");
    expect(stopReasonOf(events)).toBe("end_turn");
    expect(blockStarts(events)).toEqual(["text"]);
    const text = events
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("hello");
  });
});
