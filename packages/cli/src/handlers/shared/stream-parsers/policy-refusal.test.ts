/**
 * Regression tests for invalid_prompt-class upstream refusals (issue #65).
 *
 * AC v2 (arbitration 2026-09-12, "retry transparent borné d'abord, surface si
 * persistant"):
 *  - lane coverage: anthropic-sse and openai-sse now retry transparently and
 *    surface labeled when persistent (previously: anthropic surfaced with no
 *    retry, openai DROPPED the in-stream error chunk entirely → unexplained
 *    "empty response")
 *  - counting marker: [PolicyRefusal] lane/model/provider, forceConsole, on
 *    every detected refusal — responses lane included
 *  - no content mutation: the retry re-sends the identical body
 */

import { describe, expect, test } from "bun:test";
import { createResponsesStreamHandler } from "./openai-responses-sse.js";
import { createStreamingResponseHandler } from "./openai-sse.js";
import { createAnthropicPassthroughStream } from "./anthropic-sse.js";
import { isPolicyRefusal } from "./policy-refusal.js";

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
    // openai-sse / anthropic-sse wrap their stream via c.body(stream, init)
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

const FLAG_MSG =
  "Invalid prompt: your prompt was flagged as potentially violating our usage policy.";

// ── shared classification ────────────────────────────────────────────────

describe("isPolicyRefusal classification (#65)", () => {
  test("matches the exact OpenAI code and the usage-policy message patterns", () => {
    expect(isPolicyRefusal("invalid_prompt", null)).toBe(true);
    expect(isPolicyRefusal(undefined, FLAG_MSG)).toBe(true);
    expect(isPolicyRefusal(undefined, "The prompt was flagged by our safety systems.")).toBe(true);
    expect(isPolicyRefusal(undefined, "This request violates the usage policy.")).toBe(true);
  });

  test("does NOT match transport errors, quota walls, or rate limits", () => {
    expect(isPolicyRefusal("server_error", "boom")).toBe(false);
    expect(isPolicyRefusal("429", "rate limit exceeded, resets at 19:17")).toBe(false);
    expect(isPolicyRefusal(undefined, "insufficient balance")).toBe(false);
    expect(isPolicyRefusal("context_length_exceeded", "too many tokens")).toBe(false);
  });
});

// ── openai-sse lane ──────────────────────────────────────────────────────

describe("#65 openai-sse lane — in-stream policy refusal", () => {
  const flagChunk = `data: ${JSON.stringify({
    error: { code: "invalid_prompt", message: FLAG_MSG },
  })}\n\n`;

  // The openai lane needs a minimal adapter for its text path.
  const adapter = {
    processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }),
  };

  async function run(
    raw: string,
    retryUpstream?: () => Promise<Response | null>
  ): Promise<{ lines: string[]; output: string }> {
    const response = createStreamingResponseHandler(
      mockContext(),
      sseResponse(raw),
      adapter,
      "glm-5.3",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      retryUpstream
        ? { retryUpstream, retryBackoffMs: [1, 1], providerName: "zai" }
        : undefined
    ) as Response;
    const lines: string[] = [];
    let output = "";
    const collected = await captureStdout(async () => {
      output = await drain(response);
    });
    lines.push(...collected);
    return { lines, output };
  }

  test("retry-transparent: identical body re-sent, client sees only the recovered stream", async () => {
    let calls = 0;
    const { lines, output } = await run(flagChunk, async () => {
      calls++;
      return sseResponse(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "recovered from flag" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`
      );
    });
    expect(calls).toBe(1);
    expect(lines.some((l) => l.includes("[PolicyRefusal]") && l.includes("lane=openai") && l.includes("model=glm-5.3") && l.includes("provider=zai") && l.includes("action=retry"))).toBe(true);
    expect(lines.some((l) => l.includes("transparent retry 1/2"))).toBe(true);
    expect(output).toContain("recovered from flag");
    expect(output).not.toContain("policy refusal");
    expect(output).toContain("message_stop");
  });

  test("persistent refusal surfaces as a labeled terminal turn after the two retries", async () => {
    let calls = 0;
    const { lines, output } = await run(flagChunk, async () => {
      calls++;
      return sseResponse(flagChunk);
    });
    expect(calls).toBe(2);
    expect(lines.some((l) => l.includes("transparent retry 2/2"))).toBe(true);
    expect(lines.some((l) => l.includes("action=surface"))).toBe(true);
    expect(output).toContain("[Upstream policy refusal — invalid_prompt:");
    expect(output).toContain("message_stop");
    // well-formed turn: end_turn, never a bare refusal
    expect(output).toContain('"stop_reason":"end_turn"');
  });

  test("a refusal after visible content is never retried (no duplication), surfaces labeled", async () => {
    let calls = 0;
    const { output } = await run(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "partial answer" } }],
      })}\n\n` + flagChunk,
      async () => {
        calls++;
        return sseResponse(flagChunk);
      }
    );
    expect(calls).toBe(0);
    expect(output).toContain("partial answer");
    expect(output).toContain("[Upstream policy refusal — invalid_prompt:");
    expect(output).toContain("message_stop");
  });
});

// ── anthropic-sse lane ───────────────────────────────────────────────────

describe("#65 anthropic-sse lane — in-stream policy refusal", () => {
  // Z.AI-shaped: no code field, the class lives in the message. Arrives as
  // `event: error` + data payload with HTTP 200.
  const flagEvents =
    "event: error\n" +
    `data: ${JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: FLAG_MSG },
    })}\n\n`;

  async function run(
    raw: string,
    retryUpstream?: () => Promise<Response | null>
  ): Promise<{ lines: string[]; output: string }> {
    const response = createAnthropicPassthroughStream(mockContext(), sseResponse(raw), {
      modelName: "glm-5.3",
      ...(retryUpstream
        ? { retryUpstream, retryBackoffMs: [1, 1] as const, providerName: "zai" }
        : {}),
    }) as Response;
    const lines: string[] = [];
    let output = "";
    const collected = await captureStdout(async () => {
      output = await drain(response);
    });
    lines.push(...collected);
    return { lines, output };
  }

  test("retry-transparent: refusal before message_start re-issued, client sees only the recovered stream", async () => {
    let calls = 0;
    const recovered =
      "event: message_start\n" +
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_recovered", model: "glm-5.3", usage: { input_tokens: 5, output_tokens: 0 } },
      })}\n\n` +
      "event: content_block_start\n" +
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
      "event: content_block_delta\n" +
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered from flag" } })}\n\n` +
      "event: content_block_stop\n" +
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
      "event: message_delta\n" +
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n` +
      "event: message_stop\n" +
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    const { lines, output } = await run(flagEvents, async () => {
      calls++;
      return sseResponse(recovered);
    });
    expect(calls).toBe(1);
    expect(lines.some((l) => l.includes("[PolicyRefusal]") && l.includes("lane=anthropic") && l.includes("model=glm-5.3") && l.includes("provider=zai") && l.includes("action=retry"))).toBe(true);
    expect(lines.some((l) => l.includes("transparent retry 1/2"))).toBe(true);
    expect(output).toContain("recovered from flag");
    // exactly ONE message_start — the retried stream's (the refused attempt
    // never reached the client)
    expect(output.match(/event: message_start/g)?.length).toBe(1);
    expect(output).not.toContain("policy refusal");
    expect(output).toContain("event: message_stop");
  });

  test("persistent refusal surfaces labeled after the two retries", async () => {
    let calls = 0;
    const { lines, output } = await run(flagEvents, async () => {
      calls++;
      return sseResponse(flagEvents);
    });
    expect(calls).toBe(2);
    expect(lines.some((l) => l.includes("transparent retry 2/2"))).toBe(true);
    expect(lines.some((l) => l.includes("action=surface"))).toBe(true);
    expect(output).toContain("[Upstream policy refusal — invalid_prompt:");
    expect(output).toContain("event: message_stop");
  });

  test("a refusal AFTER message_start is never retried (a retry would duplicate message_start)", async () => {
    let calls = 0;
    const { output } = await run(
      "event: message_start\n" +
        `data: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg_x", model: "glm-5.3", usage: { input_tokens: 5, output_tokens: 0 } },
        })}\n\n` +
        flagEvents,
      async () => {
        calls++;
        return sseResponse(flagEvents);
      }
    );
    expect(calls).toBe(0);
    expect(output).toContain("[Upstream policy refusal — invalid_prompt:");
    expect(output).toContain("event: message_stop");
  });

  test("non-policy in-stream errors keep the pre-existing generic surface (no marker, no retry)", async () => {
    let calls = 0;
    const rateLimit =
      "event: error\n" +
      `data: ${JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "1302 rate limit exceeded" },
      })}\n\n`;
    const { lines, output } = await run(rateLimit, async () => {
      calls++;
      return sseResponse(rateLimit);
    });
    expect(calls).toBe(0);
    expect(lines.some((l) => l.includes("[PolicyRefusal]"))).toBe(false);
    expect(output).toContain("rate limited");
    expect(output).toContain("event: message_stop");
  });
});

// ── responses lane marker (AC2 — behavior already covered by its own suite) ──

describe("#65 responses lane — [PolicyRefusal] counting marker", () => {
  test("retried refusal emits the marker with lane/model/provider and action=retry", async () => {
    let calls = 0;
    const response = createResponsesStreamHandler(
      mockContext(),
      sseResponse(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { code: "invalid_prompt", message: FLAG_MSG },
        })}\n\n`
      ),
      {
        modelName: "gpt-5.6-sol",
        providerName: "codex",
        retryBackoffMs: [1, 1],
        retryUpstream: async () => {
          calls++;
          return sseResponse(
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: "recovered",
            })}\n\n` +
              `event: response.completed\ndata: ${JSON.stringify({
                type: "response.completed",
                response: { usage: { input_tokens: 9, output_tokens: 3 } },
              })}\n\n`
          );
        },
      }
    ) as Response;
    let output = "";
    const lines = await captureStdout(async () => {
      output = await drain(response);
    });
    expect(calls).toBe(1);
    expect(
      lines.some(
        (l) =>
          l.includes("[PolicyRefusal]") &&
          l.includes("lane=responses") &&
          l.includes("model=gpt-5.6-sol") &&
          l.includes("provider=codex") &&
          l.includes("action=retry")
      )
    ).toBe(true);
    expect(output).toContain("recovered");
  });
});
