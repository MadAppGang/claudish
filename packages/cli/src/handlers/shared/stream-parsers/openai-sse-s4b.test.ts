/**
 * S4-b lot A — regression tests for the openai-sse.ts absorption (issue #28).
 *
 * Per-commit anchors, upstream sha → absorbed behavior:
 *  - 333026b: raw SSE payloads reach the debug log VERBATIM (the log is the
 *    fixture source of record; a 300-char cut yields a fixture JSON.parse
 *    rejects, and the parser's catch swallows that).
 *  - ea5258c: the chunk-loop catch logs instead of swallowing — everything a
 *    dropped chunk would have emitted is lost behind an HTTP 200 otherwise.
 *  - 92b72cb (stop_reason half): finish_reason "length"→max_tokens,
 *    "content_filter"→refusal, both outranking tool_use. A turn the provider
 *    cut off must not be reported as a turn the model chose to end.
 *  - baf19ef: tool-argument fragments that arrive BEFORE function.name are
 *    buffered and seeded into the tool — the dropped-head-of-JSON defect.
 *  - 321c2f0: a non-refusal error carried INSIDE a 200 stream (OpenRouter
 *    shape: empty choices + error object) is surfaced, not ignored. The
 *    refusal class keeps its #65 treatment (see policy-refusal.test.ts).
 *  - ae8c07f: message_start.usage seeds from the prior request's context size
 *    (Claude Code only lets a delta override when > 0, so the seed is what
 *    survives on turns without usage — a 0 there reads as an empty
 *    conversation and disarms auto-compaction); token carry-forward on the
 *    no-usage path takes the same value.
 *
 * Non-vacuity: written BEFORE the implementation; the pre-fix failure count
 * is measured with `git stash push` of the source files and published in the
 * PR body with the exact command and bun version.
 */

import { describe, expect, test } from "bun:test";
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

const adapter = {
  processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }),
};

interface RunOpts {
  priorInputTokens?: number;
  onTokenUpdate?: (input: number, output: number) => void;
  adapterOverride?: any;
}

async function run(raw: string, opts: RunOpts = {}): Promise<{ lines: string[]; output: string }> {
  const response = createStreamingResponseHandler(
    mockContext(),
    sseResponse(raw),
    opts.adapterOverride ?? adapter,
    "glm-5.3",
    undefined,
    opts.onTokenUpdate,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.priorInputTokens
  ) as Response;
  const lines: string[] = [];
  let output = "";
  const collected = await captureStdout(async () => {
    output = await drain(response);
  });
  lines.push(...collected);
  return { lines, output };
}

function textChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}
function finishChunk(reason: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
}

// ── 333026b — raw SSE log payload ─────────────────────────────────────────

describe("S4-b lot A: raw SSE log payload (333026b)", () => {
  test("short payload passes through verbatim", async () => {
    const mod = await import("./openai-sse.js");
    const fn = (mod as any).formatRawSseLogPayload;
    expect(typeof fn).toBe("function");
    expect(fn('{"choices":[{"delta":{"content":"hi"}}]}')).toBe(
      '{"choices":[{"delta":{"content":"hi"}}]}'
    );
  });

  test("a payload over the ceiling is cut once and unmistakably flagged", async () => {
    const mod = await import("./openai-sse.js");
    const fn = (mod as any).formatRawSseLogPayload;
    expect(typeof fn).toBe("function");
    const huge = "x".repeat(1_050_000);
    const out = fn(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("<<<CLAUDISH_SSE_TRUNCATED>>>");
    expect(out).toContain("original_chars=1050000");
  });

  test("the old 300-char cut corrupted fixtures — the verbatim form must parse back", async () => {
    const mod = await import("./openai-sse.js");
    const fn = (mod as any).formatRawSseLogPayload;
    expect(typeof fn).toBe("function");
    // A whole-chunk payload of 400 chars: what the debug log/fixture source
    // must carry. substring(0, 300) breaks JSON.parse; the absorbed function
    // must not.
    const payload = JSON.stringify({
      choices: [{ delta: { content: "a".repeat(330) } }],
    });
    expect(payload.length).toBeGreaterThan(300);
    expect(() => JSON.parse(payload.substring(0, 300))).toThrow();
    expect(() => JSON.parse(fn(payload))).not.toThrow();
  });
});

// ── 92b72cb — finish_reason → stop_reason ─────────────────────────────────

describe("S4-b lot A: finish_reason → stop_reason (92b72cb)", () => {
  test('finish_reason "length" reports max_tokens, not end_turn', async () => {
    const { output } = await run(textChunk("half an answ") + finishChunk("length") + "data: [DONE]\n\n");
    expect(output).toContain('"stop_reason":"max_tokens"');
    expect(output).not.toContain('"stop_reason":"end_turn"');
  });

  test('finish_reason "content_filter" reports refusal', async () => {
    const { output } = await run(textChunk("some text") + finishChunk("content_filter") + "data: [DONE]\n\n");
    expect(output).toContain('"stop_reason":"refusal"');
  });

  test('finish_reason "stop" with text stays end_turn (control)', async () => {
    const { output } = await run(textChunk("a full answer") + finishChunk("stop") + "data: [DONE]\n\n");
    expect(output).toContain('"stop_reason":"end_turn"');
  });

  test('"length" outranks tool_use — a truncated tool call is not dispatched as complete', async () => {
    const raw =
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Bash", arguments: '{"cmd":"ls"}' } }] } }],
      })}\n\n` +
      finishChunk("length") +
      "data: [DONE]\n\n";
    const { output } = await run(raw);
    expect(output).toContain('"stop_reason":"max_tokens"');
    expect(output).not.toContain('"stop_reason":"tool_use"');
  });
});

// ── baf19ef — argument fragments before function.name ────────────────────

describe("S4-b lot A: pending tool args before function.name (baf19ef)", () => {
  function toolJsonDeltas(output: string): string {
    // Concatenate the input_json_delta fragments in emitted order.
    let acc = "";
    for (const m of output.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)) {
      acc += JSON.parse(`"${m[1]}"`);
    }
    return acc;
  }

  test("arguments arriving BEFORE the name are seeded — the JSON head is not dropped", async () => {
    const raw =
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] } }],
      })}\n\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: 'ry": "x"}' } }] } }],
      })}\n\n` +
      finishChunk("tool_calls") +
      "data: [DONE]\n\n";
    const { output } = await run(raw);
    expect(output).toContain('"name":"search"');
    const json = toolJsonDeltas(output);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toEqual({ query: "x" });
  });

  test("name-then-arguments (OpenAI's own order) is unchanged (control)", async () => {
    const raw =
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: '{"query":"x"}' } }] } }],
      })}\n\n` +
      finishChunk("tool_calls") +
      "data: [DONE]\n\n";
    const { output } = await run(raw);
    const json = toolJsonDeltas(output);
    expect(JSON.parse(json)).toEqual({ query: "x" });
  });
});

// ── 321c2f0 — non-refusal error inside a 200 stream ──────────────────────

describe("S4-b lot A: non-refusal in-stream error surfaced (321c2f0)", () => {
  test("an OpenRouter-shaped error frame is surfaced, not silently ignored", async () => {
    const raw =
      textChunk("partial answer") +
      `data: ${JSON.stringify({
        id: "gen-1",
        model: "unknown",
        provider: "Google AI Studio",
        choices: [],
        error: {
          code: 400,
          message: "Upstream rejected the request",
          metadata: { error_type: "invalid_request", provider_code: "400" },
        },
      })}\n\n`;
    const { output } = await run(raw);
    // Prior text is preserved…
    expect(output).toContain("partial answer");
    // …and the error is surfaced through our error lane, with the vendor
    // named, as a well-formed terminal turn.
    expect(output).toContain("Upstream rejected the request");
    expect(output).toContain("Google AI Studio");
    expect(output).toContain("message_stop");
  });

  test("unit: describeInStreamError renders provider, code and message; no error → undefined", async () => {
    const mod = await import("./openai-sse.js");
    const fn = (mod as any).describeInStreamError;
    expect(typeof fn).toBe("function");
    expect(
      fn({
        provider: "Google AI Studio",
        error: { code: 400, message: "boom", metadata: { error_type: "invalid_request" } },
      })
    ).toBe("[Google AI Studio] 400 invalid_request boom");
    expect(fn({ error: "bare string" })).toBe("bare string");
    expect(fn({ choices: [{ delta: {} }] })).toBeUndefined();
    expect(fn(null)).toBeUndefined();
  });
});

// ── ae8c07f — message_start seed + token carry-forward ───────────────────

describe("S4-b lot A: message_start seed + token carry-forward (ae8c07f)", () => {
  test("message_start.usage seeds from priorInputTokens, not 0", async () => {
    const { output } = await run(textChunk("hi") + finishChunk("stop") + "data: [DONE]\n\n", {
      priorInputTokens: 5000,
    });
    expect(output).toContain('"usage":{"input_tokens":5000');
  });

  test("unknown first turn falls back to 100, still not 0", async () => {
    const { output } = await run(textChunk("hi") + finishChunk("stop") + "data: [DONE]\n\n");
    expect(output).toContain('"usage":{"input_tokens":100');
  });

  test("no-usage turn carries the prior context forward to onTokenUpdate, not 0", async () => {
    const calls: Array<[number, number]> = [];
    await run(textChunk("hi") + finishChunk("stop") + "data: [DONE]\n\n", {
      priorInputTokens: 5000,
      onTokenUpdate: (i, o) => calls.push([i, o]),
    });
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    expect(last[0]).toBe(5000);
    expect(last[1]).toBeGreaterThan(0);
  });

  test("a turn WITH usage reports the real numbers (control)", async () => {
    const calls: Array<[number, number]> = [];
    const raw =
      textChunk("hi") +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1234, completion_tokens: 42 } })}\n\n` +
      "data: [DONE]\n\n";
    await run(raw, { onTokenUpdate: (i, o) => calls.push([i, o]) });
    const last = calls[calls.length - 1];
    expect(last[0]).toBe(1234);
    expect(last[1]).toBe(42);
  });
});

// ── ea5258c — the chunk-loop catch logs ──────────────────────────────────

describe("S4-b lot A: chunk-processing error logged, stream survives (ea5258c)", () => {
  test("a throwing adapter produces a visible marker and the turn still terminates", async () => {
    const throwingAdapter = {
      processTextContent: () => {
        throw new Error("adapter exploded");
      },
    };
    const { lines, output } = await run(textChunk("lost to the throw") + finishChunk("stop") + "data: [DONE]\n\n", {
      adapterOverride: throwingAdapter,
    });
    // The dropped chunk is now diagnosable from the log…
    expect(lines.some((l) => l.includes("Chunk processing error") && l.includes("adapter exploded"))).toBe(
      true
    );
    // …and never-hang holds: the client turn terminates.
    expect(output).toContain("message_stop");
  });
});
