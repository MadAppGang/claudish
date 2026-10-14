/**
 * #444 — three-counter usage shape on the gemini and ollama lanes.
 *
 * Pre-#444, both parsers seeded message_start with `{ input_tokens: 0,
 * output_tokens: 0 }` and emitted a two-key terminal delta — the exact shape
 * the Codex lane carried before #186, with the same failure chain: the
 * client's per-key usage merge falls back to the seed for any delta key not
 * strictly > 0, so a seed without cache keys turns the three-way context sum
 * into NaN on every turn where the delta reports 0 cache (all of them, on
 * these wires). Fleet exposure measured at 0 responses (issue #444, both
 * lanes) — this is contract consistency, not an incident fix: the two parsers
 * are the last ones not deriving their usage from the shared shaper.
 *
 * The merge/sum models below are the documented client functions (2.1.273
 * bundle, extraction recorded in #186) — same as openai-responses-sse.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { createGeminiSseStream } from "./gemini-sse.js";
import { createOllamaJsonlStream } from "./ollama-jsonl.js";

const encoder = new TextEncoder();

function upstreamResponse(raw: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

/** Minimal Hono-context stand-in (same as lane-capture-coverage.test.ts). */
const ctx = { req: {} } as any;

async function drain(response: Response): Promise<string> {
  let out = "";
  await response.body!.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        out += new TextDecoder().decode(chunk, { stream: true });
      },
    })
  );
  return out;
}

/** usage object of the first `event: <name>` in the drained client stream. */
function usageAt(output: string, event: string, path?: string): any {
  const re = new RegExp(`event: ${event}\\ndata: ([^\\n]*)`);
  const m = output.match(re);
  if (!m) return null;
  const data = JSON.parse(m[1]);
  return path ? path.split(".").reduce((o: any, k: string) => o?.[k], data) : data.usage;
}

// Claude Code's per-key usage merge (2.1.273): a delta value overrides the
// seed ONLY when strictly > 0; an absent delta key falls back to the seed's.
function clientUsageMerge(seed: any, delta: any) {
  const pick = (k: string) => (delta[k] !== null && delta[k] > 0 ? delta[k] : seed[k]);
  return {
    input_tokens: pick("input_tokens"),
    cache_creation_input_tokens: pick("cache_creation_input_tokens"),
    cache_read_input_tokens: pick("cache_read_input_tokens"),
    output_tokens: delta.output_tokens ?? seed.output_tokens,
  };
}
// The raw, non-coalescing three-way sum feeding the context meter and the
// auto-compaction threshold.
const clientContextSum = (u: any) =>
  u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;

describe("#444 — the pre-fix shape makes the client's context sum NaN (reproduction)", () => {
  test("seed without cache keys + delta without cache keys → NaN", () => {
    // The exact literals both parsers emitted before #444: a bare seed and a
    // two-key delta. The merge resolves cache_creation_input_tokens against a
    // seed that never carried it.
    const oldSeed = { input_tokens: 0, output_tokens: 0 };
    const oldDelta = { input_tokens: 900, output_tokens: 120 };
    const merged = clientUsageMerge(oldSeed, oldDelta);
    expect(merged.cache_creation_input_tokens).toBeUndefined();
    expect(Number.isNaN(clientContextSum(merged))).toBe(true);
  });
});

describe("#444 — gemini lane", () => {
  const USAGE_META = {
    promptTokenCount: 1000,
    candidatesTokenCount: 214,
    cachedContentTokenCount: 900,
  };
  const RAW =
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\n\n` +
    `data: ${JSON.stringify({
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: USAGE_META,
    })}\n\n`;

  test("message_start seeds priorInputTokens and BOTH cache counters at explicit 0", async () => {
    const output = await drain(
      createGeminiSseStream(ctx, upstreamResponse(RAW), {
        modelName: "gemini-2.0-flash",
        priorInputTokens: 4321,
      })
    );
    const seed = usageAt(output, "message_start", "message.usage");
    expect(seed.input_tokens).toBe(4321);
    expect(seed.cache_read_input_tokens).toBe(0);
    expect(seed.cache_creation_input_tokens).toBe(0);
  });

  test("message_start falls back to the unknown-first-turn default (100)", async () => {
    const output = await drain(
      createGeminiSseStream(ctx, upstreamResponse(RAW), { modelName: "gemini-2.0-flash" })
    );
    const seed = usageAt(output, "message_start", "message.usage");
    expect(seed.input_tokens).toBe(100);
  });

  test("terminal delta: four keys, three input keys sum to promptTokenCount, cached mapped", async () => {
    const output = await drain(
      createGeminiSseStream(ctx, upstreamResponse(RAW), {
        modelName: "gemini-2.0-flash",
        priorInputTokens: 4321,
      })
    );
    const delta = usageAt(output, "message_delta");
    expect(Object.keys(delta).sort()).toEqual([
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "input_tokens",
      "output_tokens",
    ]);
    // cachedContentTokenCount (900 of 1000) maps to the openai cached share:
    // ordinary input nets it out, cache_read carries it, sum preserved.
    expect(delta.input_tokens).toBe(100);
    expect(delta.cache_read_input_tokens).toBe(900);
    expect(delta.cache_creation_input_tokens).toBe(0);
    expect(
      delta.input_tokens + delta.cache_read_input_tokens + delta.cache_creation_input_tokens
    ).toBe(1000);
    expect(delta.output_tokens).toBe(214);
    expect(output).toContain("event: message_stop");
  });

  test("merged over the seed: finite, exact context sum", async () => {
    const output = await drain(
      createGeminiSseStream(ctx, upstreamResponse(RAW), {
        modelName: "gemini-2.0-flash",
        priorInputTokens: 4321,
      })
    );
    const merged = clientUsageMerge(
      usageAt(output, "message_start", "message.usage"),
      usageAt(output, "message_delta")
    );
    expect(Number.isNaN(clientContextSum(merged))).toBe(false);
    expect(clientContextSum(merged)).toBe(1000);
  });

  test("a turn with NO usageMetadata still ends in the four-key shape (explicit zeros)", async () => {
    const RAW_NO_USAGE =
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\n\n` +
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })}\n\n`;
    const output = await drain(
      createGeminiSseStream(ctx, upstreamResponse(RAW_NO_USAGE), {
        modelName: "gemini-2.0-flash",
        priorInputTokens: 4321,
      })
    );
    const merged = clientUsageMerge(
      usageAt(output, "message_start", "message.usage"),
      usageAt(output, "message_delta")
    );
    // Delta zeros are discarded by the merge → the seed survives, finite: the
    // pre-#444 failure (NaN) is gone even on the degraded path.
    expect(Number.isNaN(clientContextSum(merged))).toBe(false);
    expect(clientContextSum(merged)).toBe(4321);
  });
});

describe("#444 — ollama lane", () => {
  const RAW =
    `${JSON.stringify({ message: { content: "hi" }, done: false })}\n` +
    `${JSON.stringify({ done: true, prompt_eval_count: 700, eval_count: 42 })}\n`;

  test("message_start seeds priorInputTokens and BOTH cache counters at explicit 0", async () => {
    const output = await drain(
      createOllamaJsonlStream(ctx, upstreamResponse(RAW), {
        modelName: "llama3.2",
        priorInputTokens: 4321,
      })
    );
    const seed = usageAt(output, "message_start", "message.usage");
    expect(seed.input_tokens).toBe(4321);
    expect(seed.cache_read_input_tokens).toBe(0);
    expect(seed.cache_creation_input_tokens).toBe(0);
  });

  test("terminal delta: four keys, no cache on this wire → all ordinary input", async () => {
    const output = await drain(
      createOllamaJsonlStream(ctx, upstreamResponse(RAW), {
        modelName: "llama3.2",
        priorInputTokens: 4321,
      })
    );
    const delta = usageAt(output, "message_delta");
    expect(Object.keys(delta).sort()).toEqual([
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "input_tokens",
      "output_tokens",
    ]);
    expect(delta.input_tokens).toBe(700);
    expect(delta.cache_read_input_tokens).toBe(0);
    expect(delta.cache_creation_input_tokens).toBe(0);
    expect(
      delta.input_tokens + delta.cache_read_input_tokens + delta.cache_creation_input_tokens
    ).toBe(700);
    expect(delta.output_tokens).toBe(42);
    expect(output).toContain("event: message_stop");
  });

  test("merged over the seed: finite, exact context sum", async () => {
    const output = await drain(
      createOllamaJsonlStream(ctx, upstreamResponse(RAW), {
        modelName: "llama3.2",
        priorInputTokens: 4321,
      })
    );
    const merged = clientUsageMerge(
      usageAt(output, "message_start", "message.usage"),
      usageAt(output, "message_delta")
    );
    expect(Number.isNaN(clientContextSum(merged))).toBe(false);
    expect(clientContextSum(merged)).toBe(700);
  });

  test("a turn whose done line carries no counts still ends finite (seed survives)", async () => {
    const RAW_NO_COUNTS =
      `${JSON.stringify({ message: { content: "hi" }, done: false })}\n` +
      `${JSON.stringify({ done: true })}\n`;
    const output = await drain(
      createOllamaJsonlStream(ctx, upstreamResponse(RAW_NO_COUNTS), {
        modelName: "llama3.2",
        priorInputTokens: 4321,
      })
    );
    const merged = clientUsageMerge(
      usageAt(output, "message_start", "message.usage"),
      usageAt(output, "message_delta")
    );
    expect(Number.isNaN(clientContextSum(merged))).toBe(false);
    expect(clientContextSum(merged)).toBe(4321);
  });
});
