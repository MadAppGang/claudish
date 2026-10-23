import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { formatInBandApiError } from "../../../../in-band-api-error.js";
import { createResponsesStreamHandler } from "../openai-responses-sse.js";
import { MAX_LEG_RETRIES } from "./responses-turn.js";
import type { StallClock } from "./stall-guard.js";

const base = new URL("../../../../test-fixtures/sse-responses/", import.meta.url);
const wire = (name: string) => readFileSync(new URL(name, base), "utf8");
const healthy = () => new Response(wire("codex-zero-delta-multicall.sse"));
const broken = () => new Response(wire("codex-parallel-degenerate-stall.sse"));
const decode = (s: string): any[] =>
  s
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
const encode = (events: any[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const types = (events: any[], type: string) => events.filter((e) => e.type === type);
const tools = (events: any[]) =>
  types(events, "content_block_start").filter((e) => e.content_block.type === "tool_use");
type Opts = Parameters<typeof createResponsesStreamHandler>[2];
function run(first: Response, options: Partial<Opts> = {}) {
  return createResponsesStreamHandler({} as Context, first, {
    modelName: "capture-model",
    ...options,
  });
}
function fakeClock(at = 0) {
  let now = at;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: StallClock & { advance(ms: number): void } = {
    now: () => now,
    setTimeout(fn, ms) {
      const key = ++id;
      timers.set(key, { at: now + ms, fn });
      return key;
    },
    clearTimeout(key) {
      timers.delete(key as number);
    },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers]
          .filter(([, v]) => v.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
  return clock;
}
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function pending(onCancel: () => void, prefix?: string) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (prefix) controller.enqueue(new TextEncoder().encode(prefix));
      },
      cancel() {
        onCancel();
      },
    })
  );
}

describe("REQ-9 transparent retry lifecycle", () => {
  test("REQ-9 TEST-9 retries a degenerate leg into healthy calls with one lifecycle and contiguous indices", async () => {
    let requests = 0;
    const events = decode(
      await run(broken(), {
        retry: {
          issueLeg: async () => {
            requests++;
            return { kind: "ok", response: healthy(), headersAt: 0 };
          },
          stallClock: fakeClock(),
        },
      }).text()
    );
    expect(requests).toBe(1);
    expect(types(events, "message_start")).toHaveLength(1);
    expect(types(events, "message_stop")).toHaveLength(1);
    expect(tools(events).map((e) => e.content_block.name)).toEqual(["Read", "Read", "Read"]);
    expect(types(events, "content_block_start").map((e) => e.index)).toEqual([0, 1, 2]);
    expect(types(events, "error")).toEqual([]);
  });

  test("REQ-9 TEST-9 retains closed commentary across retry and continues indices after cancelling the old reader", async () => {
    // Derived from gpt-5.6-sol-responses-turn1's real commentary and V0-21's real degenerate wrapper.
    const native = decode(wire("gpt-5.6-sol-responses-turn1.sse"));
    const firstTool = native.findIndex(
      (e) => e.type === "response.output_item.added" && e.item.type === "function_call"
    );
    const commentary = native.slice(0, firstTool);
    const bad = decode(wire("codex-parallel-degenerate-stall.sse")).filter(
      (e) => !["response.created", "response.in_progress", "keepalive"].includes(e.type)
    );
    for (const e of bad) if ("output_index" in e) e.output_index = 1;
    let cancelled = false;
    let requests = 0;
    const events = decode(
      await run(
        pending(
          () => {
            cancelled = true;
          },
          encode([...commentary, ...bad])
        ),
        {
          retry: {
            stallClock: fakeClock(),
            issueLeg: async () => {
              expect(cancelled).toBe(true);
              requests++;
              return { kind: "ok", response: healthy(), headersAt: 0 };
            },
          },
        }
      ).text()
    );
    expect(requests).toBe(1);
    expect(types(events, "content_block_start").map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(
      types(events, "content_block_delta")
        .filter((e) => e.delta.type === "text_delta")
        .map((e) => e.delta.text)
        .join("")
    ).toBe(
      commentary
        .filter((e) => e.type === "response.output_text.delta")
        .map((e) => e.delta)
        .join("")
    );
    expect(types(events, "message_start")).toHaveLength(1);
    expect(types(events, "message_stop")).toHaveLength(1);
    expect(tools(events)).toHaveLength(3);
  });

  test("REQ-9 TEST-10 exhausts exactly two retries with SSE error and no tools", async () => {
    let requests = 0;
    const events = decode(
      await run(broken(), {
        retry: {
          issueLeg: async () => {
            requests++;
            return { kind: "ok", response: broken(), headersAt: 0 };
          },
          stallClock: fakeClock(),
        },
      }).text()
    );
    expect(MAX_LEG_RETRIES).toBe(2);
    expect(requests).toBe(2);
    expect(tools(events)).toEqual([]);
    expect(types(events, "error")).toHaveLength(1);
    expect(types(events, "error")[0].error.message).toContain("3 attempts");
    expect(types(events, "message_delta").some((e) => e.delta.stop_reason === "tool_use")).toBe(
      false
    );
  });
});

describe("REQ-10 no replay of committed or unfinished ordinary tools", () => {
  for (const completed of [true, false]) {
    test(`REQ-10 TEST-11 ${completed ? "completed" : "unfinished"} tool beside degeneration is never retried`, async () => {
      // Derived from V0-1's first real Read and V0-21's wrapper/terminal events.
      const real = decode(wire("codex-zero-delta-multicall.sse"));
      const firstAdded = real.find((e) => e.type === "response.output_item.added");
      const prefix = completed
        ? real.slice(0, real.indexOf(real.find((e) => e.type === "response.output_item.done")) + 1)
        : [real[0], real[1], firstAdded];
      const wrapper = decode(wire("codex-parallel-degenerate-stall.sse")).filter(
        (e) => !["response.created", "response.in_progress", "keepalive"].includes(e.type)
      );
      for (const e of wrapper) if ("output_index" in e) e.output_index = 1;
      let requests = 0;
      const events = decode(
        await run(new Response(encode([...prefix, ...wrapper])), {
          retry: {
            issueLeg: async () => {
              requests++;
              return { kind: "ok", response: healthy(), headersAt: 0 };
            },
            stallClock: fakeClock(),
          },
        }).text()
      );
      expect(requests).toBe(0);
      expect(tools(events).map((e) => e.content_block.name)).toEqual(["Read"]);
      if (completed) {
        expect(types(events, "error")).toEqual([]);
        expect(types(events, "message_delta").at(-1).delta.stop_reason).toBe("tool_use");
      } else {
        expect(types(events, "error")).toHaveLength(1);
        expect(types(events, "message_delta").some((e) => e.delta.stop_reason === "tool_use")).toBe(
          false
        );
      }
    });
  }
});

describe("REQ-11/REQ-13 stalled streams and downstream cancellation", () => {
  test("REQ-11 TEST-12 measures from headers, cancels before retry and gives final attempt 300 seconds", async () => {
    const clock = fakeClock(12000);
    const cancelled: number[] = [];
    const issues: number[] = [];
    // Real V0-21 created/in-progress/keepalive events must not disarm the stall clock.
    const preOutput = decode(wire("codex-parallel-degenerate-stall.sse")).filter((e) =>
      ["response.created", "response.in_progress", "keepalive"].includes(e.type)
    );
    const output = run(
      pending(() => cancelled.push(1), encode(preOutput)),
      {
        retry: {
          firstHeadersAt: 0,
          stall: { thresholdMs: 150000, finalThresholdMs: 300000 },
          stallClock: clock,
          issueLeg: async () => {
            const attempt = issues.length + 2;
            expect(cancelled).toHaveLength(attempt - 1);
            issues.push(clock.now());
            return {
              kind: "ok",
              response: pending(() => cancelled.push(attempt)),
              headersAt: clock.now(),
            };
          },
        },
      }
    ).text();
    await flush();
    clock.advance(137999);
    await flush();
    expect(issues).toEqual([]);
    clock.advance(1);
    await flush();
    expect(issues).toEqual([150000]);
    clock.advance(149999);
    await flush();
    expect(issues).toHaveLength(1);
    clock.advance(1);
    await flush();
    expect(issues).toEqual([150000, 300000]);
    clock.advance(299999);
    await flush();
    expect(cancelled).toEqual([1, 2]);
    clock.advance(1);
    await flush();
    const events = decode(await output);
    expect(cancelled).toEqual([1, 2, 3]);
    expect(types(events, "error")).toHaveLength(1);
    expect(types(events, "error")[0].error.message).toContain("300");
    expect(tools(events)).toEqual([]);
  });

  test("REQ-11 TEST-14 a real output-item event disarms the guard while the stream stays open", async () => {
    // Derived from V0-1: only its opening through the first real tool item, then no further bytes.
    const opening = decode(wire("codex-zero-delta-multicall.sse")).slice(0, 3);
    const clock = fakeClock();
    let requests = 0;
    let cancelled = false;
    const response = run(
      pending(() => {
        cancelled = true;
      }, encode(opening)),
      {
        retry: {
          firstHeadersAt: 0,
          stallClock: clock,
          stall: { thresholdMs: 150000, finalThresholdMs: 300000 },
          issueLeg: async () => {
            requests++;
            return { kind: "ok", response: healthy(), headersAt: 0 };
          },
        },
      }
    );
    const reader = response.body!.getReader();
    await reader.read();
    await flush();
    clock.advance(600000);
    await flush();
    expect(requests).toBe(0);
    expect(cancelled).toBe(false);
    await reader.cancel();
    await flush();
    expect(cancelled).toBe(true);
  });

  test("REQ-13 TEST-15 cancelling during a stall cancels the reader and issues no next leg", async () => {
    const clock = fakeClock();
    let cancelled = false;
    let requests = 0;
    const usageEvents: unknown[] = [];
    const response = run(
      pending(() => {
        cancelled = true;
      }),
      {
        onExtraBilledInput: (n) => usageEvents.push(n),
        onTurnSummary: (s) => usageEvents.push(s),
        onTokenUpdate: (input, output) => usageEvents.push({ input, output }),
        retry: {
          firstHeadersAt: 0,
          stall: { thresholdMs: 150000, finalThresholdMs: 300000 },
          stallClock: clock,
          issueLeg: async () => {
            requests++;
            return { kind: "ok", response: healthy(), headersAt: 0 };
          },
        },
      }
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await flush();
    clock.advance(600000);
    await flush();
    expect(cancelled).toBe(true);
    expect(requests).toBe(0);
    expect(usageEvents).toEqual([]);
  });

  test("REQ-13 TEST-15 cancelling during a retry fetch aborts the issuer signal", async () => {
    let issuedSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = run(broken(), {
      retry: {
        stallClock: fakeClock(),
        issueLeg: async (_body, signal) => {
          issuedSignal = signal;
          entered();
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true })
          );
        },
      },
    });
    const reader = response.body!.getReader();
    await reader.read();
    await started;
    await reader.cancel();
    await flush();
    expect(issuedSignal?.aborted).toBe(true);
  });
});

test("REQ-14 TEST-16 H12 throwing onApiError hook produces terminal SSE error", async () => {
  // Derived from V0-1's real opening and REAL_CONTEXT_LENGTH_ERROR, the captured API error
  // preserved verbatim in the existing openai-responses-sse.test.ts. No invented protocol.
  const existing = readFileSync(
    new URL("../openai-responses-sse.test.ts", import.meta.url),
    "utf8"
  );
  const realError = existing.match(/const REAL_CONTEXT_LENGTH_ERROR =\s*'([^']+)'/u)?.[1];
  if (!realError) throw new Error("Real captured error test data is missing");
  const opening = decode(wire("codex-zero-delta-multicall.sse")).slice(0, 2);
  const first = new Response(encode(opening) + `data: ${realError}\n\n`);
  const events = decode(
    await run(first, {
      onApiError() {
        throw new Error("T1 hook failure");
      },
    }).text()
  );
  expect(types(events, "error")).toHaveLength(1);
  expect(types(events, "message_delta").some((e) => e.delta.stop_reason === "tool_use")).toBe(
    false
  );
});

test("a terminal billing error emits exactly the shared in-band marker with end_turn", async () => {
  // Use the same real Responses error-event path as H12 above, with code/message
  // taken from session d9560db8's captured billing error rather than a context overflow.
  const existing = readFileSync(
    new URL("../openai-responses-sse.test.ts", import.meta.url),
    "utf8"
  );
  const realError = existing.match(/const REAL_CONTEXT_LENGTH_ERROR =\s*'([^']+)'/u)?.[1];
  if (!realError) throw new Error("Real captured error test data is missing");
  const marker = readFileSync(
    new URL(
      "../../../../test-fixtures/mcp-model-check/credit-balance-exhausted-20261023.txt",
      import.meta.url
    ),
    "utf8"
  ).trim();
  const code = "credit_balance_exhausted";
  const message = marker.slice(`[API Error: ${code} `.length, -1);
  const errorEvent = JSON.parse(realError);
  errorEvent.error.code = code;
  errorEvent.error.message = message;
  const opening = decode(wire("codex-zero-delta-multicall.sse")).slice(0, 2);
  const reported: Array<[string, string]> = [];
  const events = decode(
    await run(new Response(encode([...opening, errorEvent])), {
      onApiError(errorCode, errorMessage) {
        reported.push([errorCode, errorMessage]);
      },
    }).text()
  );
  const text = types(events, "content_block_delta")
    .filter((e) => e.delta.type === "text_delta")
    .map((e) => e.delta.text)
    .join("");
  expect(text).toBe(formatInBandApiError(code, message));
  expect(text).toBe(`\n\n${marker}`);
  expect(reported).toEqual([[code, message]]);
  expect(types(events, "error")).toEqual([]);
  expect(types(events, "message_delta").map((e) => e.delta.stop_reason)).toEqual(["end_turn"]);
  expect(types(events, "message_stop")).toHaveLength(1);
});

test("REQ-15 TEST-17 drains degenerate usage and reports earlier billing before one final context update", async () => {
  const recorded: unknown[] = [];
  const events = decode(
    await run(broken(), {
      // Real native second-leg usage differs from V0-21, proving the context figure is the LAST leg's input.
      retry: {
        stallClock: fakeClock(),
        issueLeg: async () => ({
          kind: "ok",
          response: new Response(wire("gpt-5.6-sol-responses-toolsonly-turn1.sse")),
          headersAt: 0,
        }),
      },
      onExtraBilledInput: (input, detail) => recorded.push({ extra: input, detail }),
      onTurnSummary: (summary) => recorded.push({ summary }),
      onTokenUpdate: (input, output) => recorded.push({ input, output }),
    }).text()
  );
  expect(tools(events)).toHaveLength(3);
  expect(recorded).toHaveLength(3);
  expect(recorded[0]).toMatchObject({ extra: 39429 });
  expect(recorded[1]).toEqual({ summary: { legs: 2, legRetries: 1 } });
  expect(recorded[2]).toEqual({ input: 97, output: 32065 });
  expect(types(events, "message_delta").at(-1).usage).toMatchObject({
    input_tokens: 97,
    output_tokens: 32065,
  });
});
