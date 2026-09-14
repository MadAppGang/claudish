/**
 * Instrumentation regression tests for the OpenAI Responses SSE parser.
 * The responses lane was operationally invisible (0 completion markers) — these
 * guard the [resp] / EOF-WITHOUT-COMPLETION / INCOMPLETE markers that make
 * gpt-5.6-sol completions measurable on the hub.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createResponsesStreamHandler, parseContextOverflow } from "./openai-responses-sse.js";
import { __resetCaptureDirMemo } from "../response-capture.js";

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

/**
 * Run with response capture pointed at a throwaway dir, then restore. Capture is
 * OFF by default in this suite (CLAUDISH_CAPTURE_DIR unset -> createResponseCapture
 * returns NOOP), so every capture assertion has to opt in explicitly — which is
 * also the honest shape of the contract: the [resp] marker only exists when a
 * capture dir is configured, exactly like the anthropic/openai/native lanes.
 */
async function withCapture<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "claudish-resp-cap-"));
  const prev = process.env.CLAUDISH_CAPTURE_DIR;
  process.env.CLAUDISH_CAPTURE_DIR = dir;
  __resetCaptureDirMemo();
  try {
    return await run(dir);
  } finally {
    if (prev === undefined) delete process.env.CLAUDISH_CAPTURE_DIR;
    else process.env.CLAUDISH_CAPTURE_DIR = prev;
    __resetCaptureDirMemo();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single resp-*.sse this run wrote, once the fire-and-forget write lands. */
async function readCaptureFile(dir: string): Promise<{ name: string; body: string }> {
  for (let i = 0; i < 40; i++) {
    const name = readdirSync(dir).find((f) => f.endsWith(".sse"));
    if (name) return { name, body: readFileSync(join(dir, name), "utf8") };
    await Bun.sleep(25);
  }
  throw new Error(`no resp-*.sse written in ${dir} (contents: ${readdirSync(dir).join(", ")})`);
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
  test("response.completed writes a resp capture, and the marker carries usage", async () => {
    await withCapture(async (dir) => {
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

      // The whole point of #90: this lane used to emit a marker and write NO
      // file, so the corpus had no row for it at all.
      const { name, body } = await readCaptureFile(dir);
      expect(name).toMatch(/^resp-\d+-r\d+-.+-responses-gpt-5\.6-sol\.sse$/);
      expect(body).toContain("parser=responses");
      expect(body).toContain('"input_tokens":12');
      // The tap mirrors the bytes the parser actually SENT — the translated
      // Anthropic stream the client sees. (The upstream `response.completed` is
      // consumed by the parser and never tapped; asserting on it was the wrong
      // mental model, caught by running the test.)
      expect(body).toContain("event: content_block_delta");
      expect(body).toContain('"text":"ok"');
      expect(body).toContain("event: message_stop");

      // No premature-termination warning on a clean completed stream.
      expect(lines.some((l) => l.includes("EOF-WITHOUT-COMPLETION"))).toBe(false);
    });
  });

  test("with capture off the lane emits no [resp] marker at all (documented dependency)", async () => {
    const { lines } = await runStream([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    // Same contract as the other three lanes: the marker IS the capture's.
    expect(lines.some((l) => l.startsWith("  [resp] "))).toBe(false);
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
    // A body-stated count is not synthetic — aggregators may keep it.
    expect(lines.some((l) => l.includes("reported=285000") && l.includes("synthetic=false"))).toBe(
      true
    );
  });

  test("a generic error still reports zero usage (behavior unchanged)", async () => {
    const { output } = await runStreamCollect([
      { type: "error", error: { code: "server_error", message: "boom" } },
    ]);
    expect(firstMessageDelta(output).usage.input_tokens).toBe(0);
  });

  // Regression 2026-09-11: the two wordings above both STATE numbers. OpenAI's real
  // count-free wording names neither, so extraction yields nothing — and the
  // truthiness guard on the assignment left the report at its 0 initializer,
  // reintroducing the wedge this block exists to prevent. Measured in production:
  // reqN=2258 at 21:28:57Z and reqN=2541 at 21:35:36Z, same session, same wording,
  // with the client re-sending the error text as conversation content.
  const COUNT_FREE_MSG =
    "Your input exceeds the context window of this model. Please adjust your input and try again.";

  test("the count-free wording matches, yet extracts neither used nor limit", () => {
    const r = parseContextOverflow(COUNT_FREE_MSG, "context_length_exceeded");
    expect(r).toBeDefined();
    expect(r?.used).toBeUndefined();
    expect(r?.limit).toBeUndefined();
  });

  test("a count-free overflow is reported at the floor, not 0", async () => {
    const { output, lines } = await runStreamCollect([
      { type: "error", error: { code: "context_length_exceeded", message: COUNT_FREE_MSG } },
    ]);
    expect(firstMessageDelta(output).usage.input_tokens).toBeGreaterThanOrEqual(280_000);
    expect(lines.some((l) => l.includes("CONTEXT-OVERFLOW") && l.includes("used=?"))).toBe(true);
    // The floor produced this count, not the body — it must be greppable as synthetic
    // so #41/#89 aggregators can exclude it.
    expect(lines.some((l) => l.includes("synthetic=true"))).toBe(true);
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

  function failingResponse(events: Array<Record<string, unknown>>, error: Error): Response {
    const stream = new ReadableStream({
      start(controller) {
        if (events.length > 0) {
          controller.enqueue(new TextEncoder().encode(sseChunks(events)));
        }
        setTimeout(() => controller.error(error), 1);
      },
    });
    return new Response(stream, { headers: new Headers(SSE_HEADERS) });
  }

  function socketCloseError(): Error {
    const cause = Object.assign(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()"
      ),
      { code: "UND_ERR_SOCKET" }
    );
    return Object.assign(new TypeError("fetch failed"), { cause });
  }

  async function runResponseWithRetry(
    response: Response,
    retryUpstream: () => Promise<Response | null>,
    retryBackoffMs: readonly number[] = [1, 1]
  ) {
    let output = "";
    const lines = await captureStdout(() => {
      const result = createResponsesStreamHandler(mockContext(), response, {
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

  async function runWithRetry(
    events: Array<Record<string, unknown>>,
    retryUpstream: () => Promise<Response | null>,
    retryBackoffMs: readonly number[] = [1, 1]
  ) {
    return runResponseWithRetry(sseResponse(events), retryUpstream, retryBackoffMs);
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

  test("socket close before content is retried transparently through a nested cause", async () => {
    let calls = 0;
    const { lines, output } = await runResponseWithRetry(
      failingResponse([], socketCloseError()),
      async () => {
        calls++;
        return sseResponse([
          { type: "response.output_text.delta", delta: "recovered after socket close" },
          { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 4 } } },
        ]);
      }
    );

    expect(calls).toBe(1);
    expect(lines.some((line) => line.includes("socket close before any client-visible block"))).toBe(true);
    expect(output).toContain("recovered after socket close");
    expect(output).not.toContain("[Stream error:");
    expect(output).not.toContain("verbose: true");
    expect(output.match(/event: message_stop/g)?.length).toBe(1);
  });

  test("ECONNRESET before content uses the fast retry budget", async () => {
    let calls = 0;
    const resetError = Object.assign(new Error("read failed"), { code: "ECONNRESET" });
    const { lines, output } = await runResponseWithRetry(
      failingResponse([], resetError),
      async () => {
        calls++;
        return sseResponse([
          { type: "response.output_text.delta", delta: "reset recovered" },
          { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2 } } },
        ]);
      }
    );

    expect(calls).toBe(1);
    expect(lines.some((line) => line.includes("transparent retry 1/2"))).toBe(true);
    expect(output).toContain("reset recovered");
  });

  test("persistent pre-content socket closes exhaust two retries then terminate cleanly", async () => {
    let calls = 0;
    const { lines, output } = await runResponseWithRetry(
      failingResponse([], socketCloseError()),
      async () => {
        calls++;
        return failingResponse([], socketCloseError());
      }
    );

    expect(calls).toBe(2);
    expect(lines.some((line) => line.includes("transparent retry 2/2"))).toBe(true);
    expect(output).toContain("connection to the model provider was interrupted");
    expect(output).not.toContain("[Stream error:");
    expect(output).not.toContain("socket connection was closed unexpectedly");
    expect(output).not.toContain("verbose: true");
    expect(output.match(/event: message_stop/g)?.length).toBe(1);
  });

  test("a failed replacement fetch terminates without an unbounded retry", async () => {
    let calls = 0;
    const { output } = await runResponseWithRetry(
      failingResponse([], socketCloseError()),
      async () => {
        calls++;
        return null;
      }
    );

    expect(calls).toBe(1);
    expect(output).toContain("connection to the model provider was interrupted");
    expect(output).toContain('"stop_reason":"end_turn"');
    expect(output).toContain("event: message_stop");
  });

  test("socket close after partial text preserves content and never retries", async () => {
    let calls = 0;
    const { output } = await runResponseWithRetry(
      failingResponse(
        [{ type: "response.output_text.delta", delta: "partial answer" }],
        socketCloseError()
      ),
      async () => {
        calls++;
        return sseResponse([]);
      }
    );

    expect(calls).toBe(0);
    expect(output).toContain("partial answer");
    expect(output).toContain("connection to the model provider was interrupted");
    expect(output).not.toContain("[Stream error:");
    expect(output).not.toContain("verbose: true");
    const stops = [...output.matchAll(/event: content_block_stop\ndata: ([^\n]*)/g)].map((match) =>
      JSON.parse(match[1]).index
    );
    expect(stops).toEqual([0, 1]);
    expect(output.match(/event: message_stop/g)?.length).toBe(1);
  });

  test("socket close during a tool call closes its aliased block exactly once", async () => {
    let calls = 0;
    const { output } = await runResponseWithRetry(
      failingResponse(
        [
          {
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "item_1",
              call_id: "fc_1",
              name: "read_file",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item_1",
            delta: '{"path":"partial',
          },
        ],
        socketCloseError()
      ),
      async () => {
        calls++;
        return sseResponse([]);
      }
    );

    expect(calls).toBe(0);
    const stops = [...output.matchAll(/event: content_block_stop\ndata: ([^\n]*)/g)].map((match) =>
      JSON.parse(match[1]).index
    );
    expect(stops).toEqual([0, 1]);
    expect(output).toContain('"stop_reason":"end_turn"');
    expect(output).not.toContain('"stop_reason":"tool_use"');
    expect(output.match(/event: message_stop/g)?.length).toBe(1);
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

  test("invalid_prompt moderation flag is retried transparently (2026-09-10 Sol flag)", async () => {
    let calls = 0;
    const { lines, output } = await runWithRetry(
      [
        {
          type: "error",
          error: {
            code: "invalid_prompt",
            message:
              "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting",
          },
        },
      ],
      async () => {
        calls++;
        return sseResponse([
          { type: "response.output_text.delta", delta: "recovered from moderation flag" },
          { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 4 } } },
        ]);
      }
    );
    expect(calls).toBe(1);
    expect(
      lines.some((l) => l.includes("invalid_prompt") && l.includes("transparent retry 1/2"))
    ).toBe(true);
    expect(output).toContain("recovered from moderation flag");
    expect(output).not.toContain("[API Error:");
    expect(output).toContain("event: message_stop");
  });

  test("persistent invalid_prompt surfaces after the two fast retries", async () => {
    let calls = 0;
    const flag = {
      type: "error",
      error: {
        code: "invalid_prompt",
        message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
      },
    };
    const { lines, output } = await runWithRetry([flag], async () => {
      calls++;
      return sseResponse([flag]);
    });
    expect(calls).toBe(2);
    expect(lines.some((l) => l.includes("transparent retry 2/2"))).toBe(true);
    expect(output).toContain("[API Error: invalid_prompt");
    expect(output).toContain("event: message_stop");
  });
});

describe("#90 — the Sol/Codex lane closes its capture on every exit path", () => {
  // The marker is now emitted by the capture, at CLOSE. That is the one position
  // that also fires on a stream that HANGS, where the old completion-only marker
  // never did — which is why traffic-live.ps1's "NOT closed = HANG SUSPECTS"
  // count finally covers this lane.

  function sseResponse(events: Array<Record<string, unknown>>): Response {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseChunks(events)));
        controller.close();
      },
    });
    return new Response(stream, { headers: new Headers(SSE_HEADERS) });
  }

  function failingResponse(events: Array<Record<string, unknown>>, error: Error): Response {
    const stream = new ReadableStream({
      start(controller) {
        if (events.length > 0) {
          controller.enqueue(new TextEncoder().encode(sseChunks(events)));
        }
        setTimeout(() => controller.error(error), 1);
      },
    });
    return new Response(stream, { headers: new Headers(SSE_HEADERS) });
  }

  function socketCloseError(): Error {
    const cause = Object.assign(new Error("The socket connection was closed unexpectedly."), {
      code: "UND_ERR_SOCKET",
    });
    return Object.assign(new TypeError("fetch failed"), { cause });
  }

  async function runResponse(response: Response, retryUpstream?: () => Promise<Response | null>) {
    let output = "";
    const lines = await captureStdout(() => {
      const result = createResponsesStreamHandler(mockContext(), response, {
        modelName: "gpt-5.6-sol",
        ...(retryUpstream ? { retryUpstream, retryBackoffMs: [1, 1] as const } : {}),
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

  /** Replay a Responses-wire fixture from test-fixtures/sse-responses/ verbatim. */
  function fixtureResponse(name: string): Response {
    const body = readFileSync(
      join(__dirname, "..", "..", "..", "test-fixtures", "sse-responses", name)
    );
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    });
    return new Response(stream, { headers: new Headers(SSE_HEADERS) });
  }

  // AC of #90: "a regression test replays a captured Responses stream fixture and
  // asserts the capture is written and its token counts match the fixture."
  //
  // No REAL captured fixture can exist for this lane — the lane is what never
  // wrote a capture — so this seeds one, following the SEED-* convention of the
  // other parsers' fixtures. Once the lane is live on the hub, a capture from the
  // corpus can replace it and turn this into a true replay.
  test("replaying the SEED Responses fixture writes a capture whose tokens match", async () => {
    await withCapture(async (dir) => {
      const { lines, output } = await runResponse(
        fixtureResponse("SEED-responses-text-only.sse")
      );

      // The replay really flowed through the parser to the client...
      expect(output).toContain("Bonjour depuis la lane Sol.");
      expect(lines.some((l) => l.startsWith("  [resp] responses"))).toBe(true);

      // ...and the corpus row carries the fixture's own counts. These two fields
      // are exactly what traffic-consumption.py's usage_max() reads out of the
      // SSE body to attribute the Sol lane, so a Sol request stops being dropped
      // from the per-lane rollup.
      const { name, body } = await readCaptureFile(dir);
      expect(name).toMatch(/^resp-\d+-r\d+-.+-responses-gpt-5\.6-sol\.sse$/);
      expect(body).toContain('"input_tokens":1234');
      expect(body).toContain('"output_tokens":567');
      expect(body).toContain("event: message_stop");
    });
  });

  test("an interrupted stream closes its capture with stop=interrupted", async () => {
    await withCapture(async (dir) => {
      // Text already visible -> no retry is safe -> the interrupt is terminal.
      const { lines } = await runResponse(
        failingResponse(
          [{ type: "response.output_text.delta", delta: "partial" }],
          socketCloseError()
        )
      );
      const respLine = lines.find((l) => l.startsWith("  [resp] responses"));
      expect(respLine).toBeDefined();
      expect(respLine).toContain("closed=true stop=interrupted");

      const { body } = await readCaptureFile(dir);
      expect(body).toContain('"path":"interrupted"');
      // The partial text the client actually received is IN the capture — that
      // is what makes an offline replay of a killed turn possible.
      expect(body).toContain("partial");
    });
  });

  test("a deterministic API error closes its capture with path=api-error", async () => {
    await withCapture(async (dir) => {
      const { lines } = await runResponse(
        sseResponse([
          { type: "error", error: { code: "server_error", message: "boom, not retryable here" } },
        ])
      );
      const respLine = lines.find((l) => l.startsWith("  [resp] responses"));
      expect(respLine).toBeDefined();
      const { body } = await readCaptureFile(dir);
      expect(body).toContain('"path":"api-error"');
      expect(body).toContain('"error":"server_error"');
    });
  });

  test("a context overflow is ONE response, counted once by the capture", async () => {
    await withCapture(async (dir) => {
      const { lines } = await runResponse(
        sseResponse([
          {
            type: "error",
            error: {
              code: "context_length_exceeded",
              message: "Your input exceeds the context window of this model.",
            },
          },
        ])
      );
      // The relabelled diagnostic keeps the greppable field...
      expect(lines.some((l) => l.includes("[ResponsesSSE] CONTEXT-OVERFLOW"))).toBe(true);
      expect(lines.some((l) => l.includes("synthetic=true"))).toBe(true);
      // ...and must NOT inflate traffic-live.ps1's "$responses" count, which is
      // /\[resp\]/ — a second [resp] line here would double every overflow.
      expect(lines.some((l) => l.includes("[resp] responses CONTEXT-OVERFLOW"))).toBe(false);
      expect(lines.filter((l) => l.startsWith("  [resp] responses")).length).toBe(1);

      const { body } = await readCaptureFile(dir);
      expect(body).toContain('"synthetic":true');
      expect(body).toContain('"overflow"');
    });
  });

  test("a client cancel closes the capture with closed=false and clears the ping", async () => {
    await withCapture(async (dir) => {
      // Upstream never closes: the CLIENT is the one who walks away.
      const upstream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sseChunks([{ type: "response.output_text.delta", delta: "partial" }])
            )
          );
        },
      });
      const response = new Response(upstream, { headers: new Headers(SSE_HEADERS) });
      const lines = await captureStdout(async () => {
        const result = createResponsesStreamHandler(mockContext(), response, {
          modelName: "gpt-5.6-sol",
        }) as Response;
        const reader = result.body!.getReader();
        await reader.read();
        await reader.cancel();
        await Bun.sleep(60);
      });
      const respLine = lines.find((l) => l.startsWith("  [resp] responses"));
      expect(respLine).toBeDefined();
      expect(respLine).toContain("closed=false stop=client-cancel");

      const { body } = await readCaptureFile(dir);
      expect(body).toContain('"path":"cancel"');
    });
  });
});
