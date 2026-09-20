/**
 * Regression tests for the pre-visible transparent re-forward (issue #170).
 *
 * An upstream that dies AFTER the response headers but BEFORE a single
 * client-visible event used to cost a whole agent turn: the stream finalized
 * cleanly (never-hang held) but with a notice instead of an answer, even though
 * nothing had been forwarded that would prevent re-issuing the request.
 *
 * Measured cause: a hub restart cuts every in-flight SSE on every relaying
 * machine at once (13 restarts in one morning on 2026-09-20, 9-13 activeStreams
 * each). The streams that had not yet emitted are the recoverable subset.
 *
 * ⚠ This file calls `controller.error()` on purpose, to simulate an upstream
 * socket death — that IS how the never-hang behavior is tested. A reviewer
 * grepping for `controller.error(` per CLAUDE.md must exclude `*.test.ts`;
 * the invariant covers production sources only.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropicPassthroughStream } from "./anthropic-sse.js";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

const KILL_SWITCH = "CLAUDISH_PREVISIBLE_REFORWARD_MAX";

function mockContext() {
  const headers = new Headers();
  const c: any = {
    header: (k: string, v: string) => headers.set(k, v),
    json: () => null,
    headers,
    req: {},
    body: (stream: ReadableStream, init?: any) => new Response(stream, init),
  };
  return c;
}

function sseResponse(raw: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    }),
    { status: 200, headers: SSE_HEADERS }
  );
}

/** Headers arrived, then the socket dies having delivered nothing. */
function dyingResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("ECONNRESET (simulated upstream death)"));
      },
    }),
    { status: 200, headers: SSE_HEADERS }
  );
}

/**
 * Bytes DELIVERED, consumed, and then the socket dies.
 *
 * `pull` is load-bearing: enqueueing and then calling `controller.error()` from
 * the same `start()` discards the queued chunk (per the streams spec, error()
 * clears the queue), so the reader would see only the error and the fixture
 * would silently encode the opposite of what it claims — a pre-visible death
 * rather than a post-visible one. Written that way first, it made the negative
 * control fail against correct code.
 */
function dyingAfterDelivering(raw: string): Response {
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(raw));
          return;
        }
        controller.error(new Error("ECONNRESET (simulated upstream death)"));
      },
    }),
    { status: 200, headers: SSE_HEADERS }
  );
}

/** Headers arrived, then a graceful close with zero events — `docker stop`. */
function emptyResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    { status: 200, headers: SSE_HEADERS }
  );
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const GOOD_STREAM =
  "event: message_start\n" +
  `data: ${JSON.stringify({
    type: "message_start",
    message: { id: "msg_recovered", model: "glm-5.3", usage: { input_tokens: 5, output_tokens: 0 } },
  })}\n\n` +
  "event: content_block_start\n" +
  `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
  "event: content_block_delta\n" +
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered after upstream death" } })}\n\n` +
  "event: content_block_stop\n" +
  `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
  "event: message_delta\n" +
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n` +
  "event: message_stop\n" +
  `data: ${JSON.stringify({ type: "message_stop" })}\n\n`;

/** message_start + one real delta, THEN the socket dies. Nothing is recoverable. */
const VISIBLE_THEN_DEATH =
  "event: message_start\n" +
  `data: ${JSON.stringify({
    type: "message_start",
    message: { id: "msg_original", model: "glm-5.3", usage: { input_tokens: 5, output_tokens: 0 } },
  })}\n\n` +
  "event: content_block_start\n" +
  `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
  "event: content_block_delta\n" +
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial answer" } })}\n\n`;

function run(upstream: Response, retryUpstream?: () => Promise<Response | null>) {
  return createAnthropicPassthroughStream(mockContext(), upstream, {
    modelName: "glm-5.3",
    capture: false,
    ...(retryUpstream ? { retryUpstream } : {}),
  }) as Response;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

afterEach(() => {
  delete process.env[KILL_SWITCH];
});

describe("#170 pre-visible upstream death → bounded transparent re-forward", () => {
  test("socket reset before any event: the replacement stream reaches the client, message_start is not duplicated", async () => {
    let calls = 0;
    const out = await drain(
      run(dyingResponse(), async () => {
        calls++;
        return sseResponse(GOOD_STREAM);
      })
    );
    expect(calls).toBe(1);
    expect(out).toContain("recovered after upstream death");
    // The whole point: exactly ONE message_start reaches the client. A second
    // would break Claude Code, which is why the gate is "nothing visible yet".
    expect(occurrences(out, '"type":"message_start"')).toBe(1);
    expect(out).toContain("message_stop");
    // No error notice: the turn was recovered, not finalized.
    expect(out).not.toContain("upstream read error");
  });

  test("graceful close with zero events (docker stop) takes the same recovery", async () => {
    let calls = 0;
    const out = await drain(
      run(emptyResponse(), async () => {
        calls++;
        return sseResponse(GOOD_STREAM);
      })
    );
    expect(calls).toBe(1);
    expect(out).toContain("recovered after upstream death");
    expect(occurrences(out, '"type":"message_start"')).toBe(1);
    expect(out).toContain("message_stop");
  });

  test("NEGATIVE CONTROL — death after a client-visible event is NOT re-forwarded", async () => {
    let calls = 0;
    const out = await drain(
      run(dyingAfterDelivering(VISIBLE_THEN_DEATH), async () => {
        calls++;
        return sseResponse(GOOD_STREAM);
      })
    );
    // Past message_start / an open block, a replacement stream would duplicate
    // what the client already holds. The gate must refuse it.
    expect(calls).toBe(0);
    expect(out).toContain("partial answer");
    expect(out).not.toContain("recovered after upstream death");
    expect(occurrences(out, '"type":"message_start"')).toBe(1);
    // Still terminated cleanly — the pre-existing graceful finalization.
    expect(out).toContain("message_stop");
  });

  test("no retryUpstream (the relay before #170, and every test harness): finalizes as before", async () => {
    const out = await drain(run(dyingResponse()));
    expect(out).toContain('"type":"message_start"');
    expect(out).toContain("upstream read error");
    expect(out).toContain("message_stop");
  });

  test("re-forward returning null / non-ok / bodyless surfaces the original death", async () => {
    for (const reply of [
      null,
      new Response("nope", { status: 502 }),
      new Response(null, { status: 200, headers: SSE_HEADERS }),
    ]) {
      let calls = 0;
      const out = await drain(
        run(dyingResponse(), async () => {
          calls++;
          return reply;
        })
      );
      expect(calls).toBe(1);
      expect(out).toContain("upstream read error");
      expect(out).toContain("message_stop");
      expect(occurrences(out, '"type":"message_start"')).toBe(1);
    }
  });

  test("bounded: a re-forward that keeps dying stops at the ladder length, then finalizes", async () => {
    let calls = 0;
    const out = await drain(
      run(dyingResponse(), async () => {
        calls++;
        return dyingResponse();
      })
    );
    // Ladder is [400, 1200] → at most 2 re-forwards, so at most 3 upstream calls
    // in total. An unbounded recovery would trade a lost turn for a hung one.
    expect(calls).toBe(2);
    expect(out).toContain("upstream read error");
    expect(out).toContain("message_stop");
    expect(occurrences(out, '"type":"message_stop"')).toBe(1);
  }, 15_000);

  test("POSITIVE CONTROL — kill switch at 0 restores the pre-#170 behavior exactly", async () => {
    process.env[KILL_SWITCH] = "0";
    let calls = 0;
    const out = await drain(
      run(dyingResponse(), async () => {
        calls++;
        return sseResponse(GOOD_STREAM);
      })
    );
    // The gate is real in both directions: with the switch off, a re-forward is
    // available and still never fired.
    expect(calls).toBe(0);
    expect(out).toContain("upstream read error");
    expect(out).toContain("message_stop");
  });

  test("kill switch at 1 narrows the bound to a single re-forward", async () => {
    process.env[KILL_SWITCH] = "1";
    let calls = 0;
    const out = await drain(
      run(dyingResponse(), async () => {
        calls++;
        return dyingResponse();
      })
    );
    expect(calls).toBe(1);
    expect(out).toContain("message_stop");
  });
});
