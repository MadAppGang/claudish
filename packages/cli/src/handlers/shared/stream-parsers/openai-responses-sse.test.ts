/**
 * Instrumentation regression tests for the OpenAI Responses SSE parser.
 * The responses lane was operationally invisible (0 completion markers) — these
 * guard the [resp] / EOF-WITHOUT-COMPLETION / INCOMPLETE markers that make
 * gpt-5.6-sol completions measurable on the hub.
 */

import { describe, expect, test } from "bun:test";
import { createResponsesStreamHandler, parseContextOverflow } from "./openai-responses-sse.js";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function sseChunks(events: Array<Record<string, unknown>>): string {
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

function mockContext() {
  const headers = new Headers();
  const json = () => null;
  const c: any = { header: (k: string, v: string) => headers.set(k, v), json, headers, req: {} };
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
    // Give the pump's microtasks a tick to flush their writes.
    await Bun.sleep(50);
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  return lines;
}

async function runStream(events: Array<Record<string, unknown>>) {
  const { lines, output } = await runStreamCollect(events);
  return { lines, output };
}

async function runStreamCollect(events: Array<Record<string, unknown>>) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseChunks(events)));
      controller.close();
    },
  });
  const response = new Response(stream, { headers: new Headers(SSE_HEADERS) });
  let output = "";
  const lines = await captureStdout(() => {
    const result = createResponsesStreamHandler(mockContext(), response, {
      modelName: "gpt-5.6-sol",
    }) as Response;
    // Drive the pump: the parser's ReadableStream start() only runs when the
    // returned body is consumed. Drain it fully (the client would too).
    return result.body?.pipeTo(
      new WritableStream({
        write(chunk: Uint8Array) {
          output += new TextDecoder().decode(chunk, { stream: true });
        },
      })
    );
  });
  return { lines, output };
}

describe("openai-responses-sse instrumentation", () => {
  test("response.completed emits a [resp] responses marker with usage and events", async () => {
    const { lines } = await runStream([
      { type: "response.output_text.delta", delta: "ok" },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 12, output_tokens: 5 } },
      },
    ]);
    const respLine = lines.find((l) => l.startsWith("  [resp] responses"));
    expect(respLine).toBeDefined();
    expect(respLine).toContain("model=gpt-5.6-sol");
    expect(respLine).toContain("closed=true stop=end_turn");
    expect(respLine).toContain("usage=12+5");
    // No premature-termination warning on a clean completed stream.
    expect(lines.some((l) => l.includes("EOF-WITHOUT-COMPLETION"))).toBe(false);
  });

  test("early EOF without completion logs EOF-WITHOUT-COMPLETION (previously silent)", async () => {
    const { lines } = await runStream([
      { type: "response.output_text.delta", delta: "partial" },
    ]);
    const warnLine = lines.find((l) => l.includes("EOF-WITHOUT-COMPLETION"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain("model=gpt-5.6-sol");
    expect(warnLine).toContain("text=true");
  });

  test("response.incomplete logs INCOMPLETE with the reason", async () => {
    const { lines } = await runStream([
      { type: "response.incomplete", reason: "max_output_tokens" },
    ]);
    expect(lines.some((l) => l.includes("INCOMPLETE model=gpt-5.6-sol"))).toBe(true);
    expect(lines.some((l) => l.includes("reason=max_output_tokens"))).toBe(true);
  });

  test("an in-stream API error is logged with its code", async () => {
    const { lines } = await runStream([
      { type: "error", error: { code: "server_error", message: "boom" } },
    ]);
    expect(
      lines.some((l) => l.includes("API error model=gpt-5.6-sol") && l.includes("code=server_error"))
    ).toBe(true);
  });

  test("parallel tool calls after text get sequential block indices (no gap, no duplicate stop)", async () => {
    // Regression 2026-08-27: the old index arithmetic (blockIndex +
    // functionCalls.size + (hasTextContent?1:0)) emitted 0,1,3 for text+2
    // parallel tools — skipping index 2 — and stopped the text block twice.
    // This is the dominant turn shape of the gpt-5.6-sol agentic lane.
    const { output } = await runStreamCollect([
      { type: "response.output_text.delta", delta: "Checking both." },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "fc_1", name: "read_file", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", call_id: "fc_1", delta: '{"p":"a"}' },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_2", call_id: "fc_2", name: "read_file", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", call_id: "fc_2", delta: '{"p":"b"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "fc_1", id: "fc_1" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "fc_2", id: "fc_2" } },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } },
    ]);
    const starts = [...output.matchAll(/event: content_block_start\ndata: ([^\n]*)/g)].map((m) => {
      const d = JSON.parse(m[1]);
      return `${d.index}:${d.content_block.type}`;
    });
    expect(starts).toEqual(["0:text", "1:tool_use", "2:tool_use"]);
    const stops = [...output.matchAll(/event: content_block_stop\ndata: ([^\n]*)/g)].map((m) => JSON.parse(m[1]).index);
    expect(stops).toEqual([0, 1, 2]); // exactly one stop per block, in order
  });
});

describe("context overflow must not report usage 0+0", () => {
  // Regression 2026-08-28: on an error event no `response.completed` ever
  // arrives, so the parser emitted `usage: {input_tokens: 0, output_tokens: 0}`
  // with stop_reason end_turn. A zero tells Claude Code the conversation is
  // EMPTY — its context gauge resets, auto-compact never fires, the session
  // stays in overflow and every later turn fails identically, which the user
  // experiences as "the agent ignores my messages" on the gpt-5.6-sol lane.
  const REAL_MSG =
    "This model's maximum context length is 272000 tokens. However, your messages resulted in 285000 tokens.";

  function firstMessageDelta(output: string) {
    const re = new RegExp("event: message_delta\ndata: ([^\n]*)");
    const m = output.match(re);
    return m ? JSON.parse(m[1]) : null;
  }

  test("parseContextOverflow extracts used and limit from the real backend wording", () => {
    expect(parseContextOverflow(REAL_MSG, "context_length_exceeded")).toEqual({
      used: 285000,
      limit: 272000,
    });
  });

  test("the limit is used as a lower bound when the used count is absent", () => {
    const r = parseContextOverflow("Input exceeds the context window of 272000 tokens.", "");
    expect(r?.used).toBe(272000);
  });

  test("a non-overflow error is left untouched", () => {
    expect(parseContextOverflow("boom", "server_error")).toBeUndefined();
    expect(parseContextOverflow("rate limited", "rate_limit_exceeded")).toBeUndefined();
  });

  test("the emitted message_delta carries the real input tokens, not 0", async () => {
    const { output, lines } = await runStreamCollect([
      { type: "error", error: { code: "context_length_exceeded", message: REAL_MSG } },
    ]);
    const delta = firstMessageDelta(output);
    expect(delta.usage.input_tokens).toBe(285000);
    expect(lines.some((l) => l.includes("CONTEXT-OVERFLOW") && l.includes("used=285000"))).toBe(
      true
    );
  });

  test("a generic error still reports zero usage (behavior unchanged)", async () => {
    const { output } = await runStreamCollect([
      { type: "error", error: { code: "server_error", message: "boom" } },
    ]);
    expect(firstMessageDelta(output).usage.input_tokens).toBe(0);
  });
});

describe("transparent retry on early server_error (2026-09-02 Sol crashes)", () => {
  // OpenAI server_error arrives 1-54s AFTER the first event — outside the peek
  // window — and each surfaced one killed the agent turn, forcing a manual
  // relaunch with a full ~100-190k-token context re-upload. When the error
  // arrives while ZERO content blocks have been emitted, the retry is
  // invisible to the client and safe.

  function sseResponse(events: Array<Record<string, unknown>>): Response {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseChunks(events)));
        controller.close();
      },
    });
    return new Response(stream, { headers: new Headers(SSE_HEADERS) });
  }

  async function runWithRetry(
    events: Array<Record<string, unknown>>,
    retryUpstream: () => Promise<Response | null>,
    retryBackoffMs: readonly number[] = [1, 1]
  ) {
    let output = "";
    const lines = await captureStdout(() => {
      const result = createResponsesStreamHandler(mockContext(), sseResponse(events), {
        modelName: "gpt-5.6-sol",
        retryUpstream,
        retryBackoffMs,
      }) as Response;
      return result.body?.pipeTo(
        new WritableStream({
          write(chunk: Uint8Array) {
            output += new TextDecoder().decode(chunk, { stream: true });
          },
        })
      );
    });
    return { lines, output };
  }

  test("server_error with zero blocks emitted is retried transparently", async () => {
    let calls = 0;
    const { lines, output } = await runWithRetry(
      [{ type: "error", error: { code: "server_error", message: "boom once" } }],
      async () => {
        calls++;
        return sseResponse([
          { type: "response.output_text.delta", delta: "recovered" },
          { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3 } } },
        ]);
      }
    );
    expect(calls).toBe(1);
    expect(lines.some((l) => l.includes("transparent retry 1/2"))).toBe(true);
    // The client saw the RETRIED stream, not the error.
    expect(output).toContain("recovered");
    expect(output).not.toContain("[API Error:");
    expect(output).toContain("event: message_stop");
  });

  test("server_is_overloaded after response.created but before content is retried transparently", async () => {
    let calls = 0;
    const { lines, output } = await runWithRetry(
      [
        { type: "response.created", response: { id: "resp_overloaded" } },
        {
          type: "error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
        },
      ],
      async () => {
        calls++;
        return sseResponse([
          { type: "response.output_text.delta", delta: "recovered from overload" },
          { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 4 } } },
        ]);
      }
    );
    expect(calls).toBe(1);
    expect(lines.some((l) => l.includes("server_is_overloaded before any client-visible block"))).toBe(true);
    expect(output).toContain("recovered from overload");
    expect(output).not.toContain("[API Error:");
    expect(output).toContain("event: message_stop");
  });

  test("persistent server_is_overloaded uses the six-attempt patient budget", async () => {
    let calls = 0;
    const overload = {
      type: "error",
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded. Please try again later.",
    };
    const { lines, output } = await runWithRetry(
      [{ type: "response.created", response: { id: "resp_overloaded" } }, overload],
      async () => {
        calls++;
        return sseResponse([{ type: "response.created", response: { id: `resp_retry_${calls}` } }, overload]);
      },
      [1, 1, 1, 1, 1, 1]
    );
    expect(calls).toBe(6);
    expect(lines.some((l) => l.includes("transparent retry 6/6"))).toBe(true);
    expect(output).toContain("[API Error: server_is_overloaded");
    expect(output).toContain("event: message_stop");
  });

  test("server_error AFTER client-visible content is never retried (would duplicate)", async () => {
    let calls = 0;
    const { output } = await runWithRetry(
      [
        { type: "response.output_text.delta", delta: "partial answer" },
        { type: "error", error: { code: "server_error", message: "mid-stream boom" } },
      ],
      async () => {
        calls++;
        return sseResponse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
      }
    );
    expect(calls).toBe(0);
    expect(output).toContain("[API Error: server_error mid-stream boom]");
  });

  test("retries are bounded at 2, then the error is surfaced", async () => {
    let calls = 0;
    const { lines, output } = await runWithRetry(
      [{ type: "error", error: { code: "server_error", message: "persistent boom" } }],
      async () => {
        calls++;
        // First retry: another server_error stream. Second: fetch failure (null).
        if (calls === 1) return sseResponse([{ type: "error", error: { code: "server_error", message: "again" } }]);
        return null;
      }
    );
    expect(calls).toBe(2);
    expect(lines.some((l) => l.includes("transparent retry 2/2"))).toBe(true);
    expect(output).toContain("[API Error: server_error again]");
  });

  test("deterministic codes (context overflow) never retry", async () => {
    let calls = 0;
    const { output } = await runWithRetry(
      [{ type: "error", error: { code: "context_length_exceeded", message: "too big" } }],
      async () => {
        calls++;
        return sseResponse([]);
      }
    );
    expect(calls).toBe(0);
    expect(output).toContain("[API Error: context_length_exceeded too big]");
  });
});
