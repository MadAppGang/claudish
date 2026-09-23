/**
 * Tool-use duplication replay (jsboige/roo-extensions#3276, re-scoped 2026-09-23).
 *
 * Symptom under the pre-gpt-6 model: the same tool_use executed twice in one
 * turn. User decision: gpt-6 now serves the lane — verify the claudish OpenAI
 * provider does not ITSELF duplicate a tool_use when translating an OpenAI
 * response, e.g. a tool call emitted in both a streamed delta and the final
 * message. This file is that replay: feed the suspect upstream shapes through
 * both OpenAI wire parsers and count the tool_use blocks emitted against what
 * the upstream declared.
 *
 * Verdict contract: N blocks emitted = N function calls DECLARED by the
 * upstream (via output_item.added / delta.tool_calls). The two "echo" vectors —
 * response.completed's response.output on the Responses wire, and the terminal
 * chunk's choices[0].message.tool_calls on the chat wire — must each emit
 * nothing. A duplicate observed downstream with these tests green is
 * upstream-declared duplication, not a translation defect.
 */

import { describe, expect, test } from "bun:test";
import { createResponsesStreamHandler } from "./openai-responses-sse.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function mockContext() {
  const headers = new Headers();
  const json = () => null;
  const c: any = {
    header: (k: string, v: string) => headers.set(k, v),
    json,
    headers,
    req: {},
    body: (stream: ReadableStream, init?: any) => new Response(stream, init),
  };
  return c;
}

async function captureStdout(run: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = ((chunk: any) => {
    lines.push(String(chunk));
    return true;
  }) as any;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" ") + "\n");
  };
  try {
    await run();
    await Bun.sleep(50);
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  return lines;
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

/** Every tool_use content_block_start in the translated stream, as `index:name`. */
function toolUseStarts(output: string): string[] {
  return [...output.matchAll(/event: content_block_start\ndata: ([^\n]*)/g)]
    .map((m) => JSON.parse(m[1]))
    .filter((d) => d.content_block?.type === "tool_use")
    .map((d) => `${d.index}:${d.content_block.name}`);
}

/** Concatenated input_json_delta fragments, in emitted order. */
function toolJsonDeltas(output: string): string {
  let acc = "";
  for (const m of output.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)) {
    acc += JSON.parse(`"${m[1]}"`);
  }
  return acc;
}

// ─── Responses wire (gpt-6 lane) ─────────────────────────────────────────────

describe("#3276 replay — Responses wire: streamed call + echoed final message", () => {
  test("response.completed carrying the full function_call in response.output emits it ZERO extra times", async () => {
    // The exact suspect shape: the call arrives as a streamed output item
    // (added → argument deltas → done), then response.completed's
    // response.output ALSO carries the complete function_call item — the
    // Responses-wire form of "emitted in both a streamed delta and the final
    // message".
    const events = [
      { type: "response.output_text.delta", delta: "Let me check." },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "fc_1", name: "search", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", call_id: "fc_1", delta: '{"query"' },
      { type: "response.function_call_arguments.delta", call_id: "fc_1", delta: ':"x"}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "fc_1" } },
      {
        type: "response.completed",
        response: {
          usage: { input_tokens: 10, output_tokens: 4 },
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me check." }] },
            { type: "function_call", id: "fc_1", call_id: "fc_1", name: "search", arguments: '{"query":"x"}' },
          ],
        },
      },
    ];
    const raw = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

    let output = "";
    await captureStdout(async () => {
      const result = createResponsesStreamHandler(mockContext(), sseResponse(raw), {
        modelName: "gpt-6",
      }) as Response;
      output = await drain(result);
    });

    // Upstream declared 1 function call → exactly 1 tool_use block, once.
    expect(toolUseStarts(output)).toEqual(["1:search"]);
    // And its arguments are the streamed fragments, NOT re-appended by the echo.
    expect(toolJsonDeltas(output)).toBe('{"query":"x"}');
  });

  test("an upstream that REDECLARES the same call_id gets its duplication passed through — N emitted = N declared", async () => {
    // Bounding assertion: the parser adds no dedup of its own on
    // output_item.added. If a broken upstream re-declares the same call, the
    // translated stream carries both — which is how a downstream duplicate with
    // the echo tests green is attributable to the upstream, not to claudish.
    const events = [
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "fc_1", name: "search", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", call_id: "fc_1", delta: '{"query":"x"}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "fc_1" } },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "fc_1", name: "search", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", call_id: "fc_1", delta: '{"query":"x"}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "fc_1" } },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ];
    const raw = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

    let output = "";
    await captureStdout(async () => {
      const result = createResponsesStreamHandler(mockContext(), sseResponse(raw), {
        modelName: "gpt-6",
      }) as Response;
      output = await drain(result);
    });

    // 2 declared → 2 emitted. Pass-through, not translation-added.
    expect(toolUseStarts(output).length).toBe(2);
  });
});

// ─── Chat wire (openai-sse) ──────────────────────────────────────────────────

describe("#3276 replay — chat wire: streamed deltas + echoed final message", () => {
  const adapter = {
    processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }),
  };

  async function runChat(raw: string): Promise<string> {
    let output = "";
    await captureStdout(async () => {
      const result = createStreamingResponseHandler(
        mockContext(),
        sseResponse(raw),
        adapter,
        "glm-5.3",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      ) as Response;
      output = await drain(result);
    });
    return output;
  }

  test("a terminal chunk carrying choices[0].message.tool_calls (non-delta) emits it ZERO extra times", async () => {
    // The chat-wire form of the suspect: the call arrives via delta.tool_calls
    // fragments, then the terminal chunk carries the COMPLETE call in
    // choices[0].message.tool_calls — the shape some OpenAI-compatible backends
    // (vLLM/LiteLLM families) emit as a final summary. The parser must read
    // only the deltas: 1 block, args exactly once.
    const raw =
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: '{"que' } }] } }],
      })}\n\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] } }],
      })}\n\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: null, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"query":"x"}' } }] } }],
      })}\n\n` +
      "data: [DONE]\n\n";

    const output = await runChat(raw);

    // 1 declared via deltas → exactly 1 tool_use block.
    expect(toolUseStarts(output)).toEqual(["0:search"]);
    // Args are the delta fragments — the echoed complete arguments were not
    // appended a second time (that would yield {"query":"x"}{"query":"x"}).
    expect(toolJsonDeltas(output)).toBe('{"query":"x"}');
    expect(output).toContain('"stop_reason":"tool_use"');
  });
});
