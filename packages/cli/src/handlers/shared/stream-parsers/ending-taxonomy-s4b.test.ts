/**
 * S4-b lot C — the ending taxonomy (c1b907f, item 4): a stream that ends with
 * no finish_reason after producing content is a failure, never an end_turn.
 *
 * `finish_reason` is the ONLY completion signal — neither `[DONE]` nor a final
 * usage object counts. The rows are exercised with constructed frames in the
 * exact shape a CUT capture produces (a dead socket drops the tail of the
 * body); upstream probed the same rows by cutting real captures
 * (`probes/ending-taxonomy.ts`, deliberately uncommitted there) — no `.sse`
 * fixture is invented here either.
 *
 * INTENDED DIVERGENCE FROM UPSTREAM (ai-01 arbitration, corpus-settled):
 * upstream's failure ending emits a bare SSE `error` event. This fork delivers
 * the failure through its labeled text-block lane instead — 1017 `resp-*.sse`
 * captures on our wire carry ZERO `event: error` frames, and our never-hang
 * corpus invariant is "every terminating path ends with message_stop after a
 * well-formed turn". Every failure test below therefore asserts: a labeled
 * text block, `end_turn`, `message_stop`, and NO bare error event.
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

interface RunOpts {
  toolSchemas?: any[];
}

async function run(raw: string, opts: RunOpts = {}): Promise<any[]> {
  const response = createStreamingResponseHandler(
    mockContext(),
    sseResponse(raw),
    { processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }) } as any,
    "test-model",
    undefined,
    undefined,
    opts.toolSchemas,
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

const READ_SCHEMA = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];

const stopReasonOf = (events: any[]) =>
  events.find((e) => e.type === "message_delta")?.delta?.stop_reason;
const textOf = (events: any[]) =>
  events
    .filter((e) => e.delta?.type === "text_delta")
    .map((e) => e.delta.text)
    .join("");
const toolBlocks = (events: any[]) =>
  events.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
const hasErrorEvent = (events: any[]) => events.some((e) => e.type === "error");
const hasMessageStop = (events: any[]) => events.some((e) => e.type === "message_stop");

describe("S4-b lot C: ending taxonomy (c1b907f)", () => {
  test("row [null, content, tool] — a cut tool stream that still carries [DONE] is a FAILURE", async () => {
    const events = await run(
      frame({ tool_calls: [{ index: 0, function: { name: "Read", arguments: '{"file_path":"/x' } }] }) +
        "data: [DONE]\n\n", // transport punctuation, not completion
      { toolSchemas: READ_SCHEMA }
    );
    expect(hasErrorEvent(events)).toBe(false); // our lane: never a bare error event
    expect(toolBlocks(events).length).toBe(0); // buffered flush suppressed — no NEW tool block
    expect(textOf(events)).toMatch(/\[Upstream stream/i);
    expect(stopReasonOf(events)).toBe("end_turn");
    expect(hasMessageStop(events)).toBe(true);
  });

  test("row [null, content, tool] — a final usage object is not completion either", async () => {
    const usageFrame = `data: ${JSON.stringify({
      id: "x",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`;
    const events = await run(
      frame({ tool_calls: [{ index: 0, function: { name: "Read", arguments: '{"file_path"' } }] }) +
        usageFrame,
      { toolSchemas: READ_SCHEMA }
    );
    expect(hasErrorEvent(events)).toBe(false);
    expect(toolBlocks(events).length).toBe(0);
    expect(textOf(events)).toMatch(/\[Upstream stream/i);
    expect(stopReasonOf(events)).toBe("end_turn");
  });

  test("row [null, content, no tool] — silent truncation degrades to max_tokens, NOT a failure", async () => {
    const events = await run(frame({ content: "partial prose that just stop" }));
    expect(hasErrorEvent(events)).toBe(false);
    expect(textOf(events)).toContain("partial prose"); // the text stays VISIBLE
    expect(textOf(events)).not.toMatch(/\[Upstream stream/i); // no error label on harmless prose
    expect(stopReasonOf(events)).toBe("max_tokens");
    expect(hasMessageStop(events)).toBe(true);
  });

  test("row [null, none] — produced nothing, ended nothing: still a plain success end_turn", async () => {
    const events = await run("data: [DONE]\n\n");
    expect(stopReasonOf(events)).toBe("end_turn");
    expect(hasMessageStop(events)).toBe(true);
    // our fork's empty-response notice covers the empty content array
    expect(textOf(events)).toMatch(/\[Error:/i);
  });

  test("rows unchanged: finish_reason stop → end_turn", async () => {
    const events = await run(frame({ content: "answer" }) + frame({}, "stop") + "data: [DONE]\n\n");
    expect(stopReasonOf(events)).toBe("end_turn");
  });

  test("rows unchanged: finish_reason tool_calls → tool_use", async () => {
    const events = await run(
      frame({ tool_calls: [{ index: 0, function: { name: "Read", arguments: "{}" } }] }) +
        frame({}, "tool_calls") +
        "data: [DONE]\n\n",
      { toolSchemas: READ_SCHEMA }
    );
    expect(stopReasonOf(events)).toBe("tool_use");
    expect(toolBlocks(events).length).toBe(1);
  });

  test("rows unchanged: length OUTRANKS tool_use", async () => {
    const events = await run(
      frame({ tool_calls: [{ index: 0, function: { name: "Read", arguments: '{"file_path' } }] }) +
        frame({}, "length") +
        "data: [DONE]\n\n",
      { toolSchemas: READ_SCHEMA }
    );
    expect(stopReasonOf(events)).toBe("max_tokens");
  });

  test("rows unchanged: content_filter → refusal", async () => {
    const events = await run(frame({ content: "hi" }) + frame({}, "content_filter") + "data: [DONE]\n\n");
    expect(stopReasonOf(events)).toBe("refusal");
  });

  test("reason=error with a buffered tool pending: the flush is suppressed, the lane labels it", async () => {
    // OpenRouter in-stream error shape (321c2f0): empty choices + error object,
    // after a tool fragment arrived and was buffered.
    const errorFrame = `data: ${JSON.stringify({
      id: "x",
      object: "chat.completion.chunk",
      choices: [],
      error: { code: 502, message: "upstream connect error" },
    })}\n\n`;
    const events = await run(
      frame({ tool_calls: [{ index: 0, function: { name: "Read", arguments: '{"file_path":"/x' } }] }) +
        errorFrame,
      { toolSchemas: READ_SCHEMA }
    );
    expect(hasErrorEvent(events)).toBe(false);
    expect(toolBlocks(events).length).toBe(0); // no COMPLETE tool call shipped with a failed turn
    expect(textOf(events)).toMatch(/\[Upstream (stream error|policy)/i);
    expect(hasMessageStop(events)).toBe(true);
  });

  test("a text-RECOVERED tool call on a finish_reason-less turn is suppressed, not dispatched", async () => {
    // Recovery runs before classification and counts as content AND as a tool
    // in flight — the population it exists for (local models) is exactly the
    // one most likely to end with no finish_reason.
    const events = await run(
      frame({ content: 'Calling now: <function=Read>{"file_path":"/x"}</function>' }),
      { toolSchemas: READ_SCHEMA }
    );
    expect(toolBlocks(events).length).toBe(0);
    expect(textOf(events)).toMatch(/\[Upstream stream/i);
    expect(stopReasonOf(events)).toBe("end_turn");
  });
});
