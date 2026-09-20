/**
 * S4-c — the prompt-token three-way split (upstream f9baf2e, "item 6"),
 * absorbed into THIS fork with its corpus stated honestly.
 *
 * CORPUS DIFFERENCE (measured 2026-09-20, before any code):
 *   (a) 0 `cache_write_tokens` fields on any OpenAI-shaped wire in our 17
 *       committed fixtures — cache-CREATION is structurally 0 on our lanes.
 *       Positive control: `cached_tokens` IS found (SEED-responses-cached-tokens
 *       .sse — a RESPONSES-wire fixture, out of this parser's scope), so a grep
 *       finding nothing here is an absence, not a blind instrument.
 *   (b) 0 degenerate fully-cached turns (prompt == cached) anywhere in the
 *       committed corpus. The degenerate row is therefore exercised on a
 *       constructed frame in the exact captured shape.
 * Upstream gated the same rows on its `grok-4.6` capture (20379/20352); we do
 * not have it, and the #99 netting pins in format-translation.test.ts
 * (900/1000, 750/1000) supply the real-provenance numbers instead.
 *
 * INTENDED DIVERGENCE FROM UPSTREAM (one): `splitPromptTokens` also reads
 * DeepSeek's `prompt_cache_hit_tokens` as a read-spelling. Upstream reads only
 * `prompt_tokens_details.cached_tokens`; THIS fork has read
 * `prompt_cache_hit_tokens` since #99 (pinned: "DeepSeek's
 * prompt_cache_hit_tokens is read too") — absorbing upstream verbatim would
 * silently drop DeepSeek's cache from the wire and regress our own table.
 *
 * CONVERGENCE RULINGS (which behavior wins per edge — a convergence is not an
 * identity):
 *   cache-read spelling   → OURS (two spellings, #99) over upstream's one.
 *   cache-creation field  → UPSTREAM (`cache_write_tokens`; 0 on our lanes).
 *   degenerate full-cache → UPSTREAM (unsplit) over our input_tokens:0 — a
 *                           latent CC double-count (measurement b).
 *   message_start seeds   → UPSTREAM (explicit 0s prevent NaN in raw sums).
 *   onTokenUpdate arg 1   → BOTH (already converged: full prompt_tokens).
 *   cost discount         → UPSTREAM verbatim (inert: no rate producer).
 *
 * Non-vacuity: written before the implementation. Named mutations, each of
 * which must turn exactly ONE named test red:
 *   M1 — drop the degenerate unsplit           → J′
 *   M2 — drop cache_creation_input_tokens from
 *        the emitted group                     → H′
 *   M3 — drop the two 0-seeds in message-start → SEEDS
 *   M4 — remove Math.min in computeCacheReadDiscount → TRACKER "never negative"
 *   M5 — pass the reduced value to onTokenUpdate      → I′
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createStreamingResponseHandler } from "./openai-sse.js";
import { splitPromptTokens } from "./usage-cache-split.js";
import { computeCacheReadDiscount, TokenTracker, type UsageCacheDetail } from "../token-tracker.js";

const FIXTURES_DIR = join(import.meta.dir, "../../../test-fixtures/sse-responses");

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

function frame(delta: any, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** A final usage-only frame — the exact shape a chat-completions turn closes with. */
function usageFrame(usage: object): string {
  return `data: ${JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    choices: [],
    usage,
  })}\n\n`;
}

interface RunOpts {
  toolSchemas?: any[];
  onTokenUpdate?: (input: number, output: number, detail?: UsageCacheDetail) => void;
}

async function run(raw: string, opts: RunOpts = {}): Promise<any[]> {
  const response = createStreamingResponseHandler(
    mockContext(),
    sseResponse(raw),
    { processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }) } as any,
    "test-model",
    undefined,
    opts.onTokenUpdate,
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

const deltaUsageOf = (events: any[]) =>
  events.filter((e) => e.type === "message_delta").pop()?.usage;
const startUsageOf = (events: any[]) =>
  events.find((e) => e.type === "message_start")?.message?.usage;

describe("S4-c: splitPromptTokens unit rows (adapted corpus)", () => {
  test("A′: the #99 numbers split 900/1000 into 100 fresh + 900 cached", () => {
    // The real-provenance numbers of THIS fork (format-translation.test.ts pin);
    // upstream's 20379/20352 capture is not in our tree.
    const split = splitPromptTokens({
      prompt_tokens: 1000,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 900 },
    });
    expect(split.promptTokens).toBe(1000);
    expect(split.inputTokens).toBe(100);
    expect(split.cacheReadTokens).toBe(900);
    expect(split.cacheCreationTokens).toBe(0);
  });

  test("A′-deepseek (INTENDED DIVERGENCE): prompt_cache_hit_tokens is read too", () => {
    // Upstream f9baf2e reads only cached_tokens. This fork has read DeepSeek's
    // spelling since #99 — dropping it here is exactly the regression M-A would
    // cause upstream-side. The test pins OUR winner of that convergence.
    const split = splitPromptTokens({
      prompt_tokens: 1000,
      completion_tokens: 20,
      prompt_cache_hit_tokens: 750,
    });
    expect(split.inputTokens).toBe(250);
    expect(split.cacheReadTokens).toBe(750);
  });

  test("C′: cache_write_tokens (OpenRouter spelling) is the creation counter", () => {
    // 0 occurrences on our lanes (measurement a) — the row is constructed in the
    // captured shape; a provider that does not report writes degrades to 0.
    const split = splitPromptTokens({
      prompt_tokens: 100,
      prompt_tokens_details: { cache_write_tokens: 40 },
    });
    expect(split.cacheCreationTokens).toBe(40);
    expect(split.inputTokens).toBe(60);
    expect(split.cacheReadTokens).toBe(0);
  });

  test("D′: no details → all ordinary input (backward compatible)", () => {
    const split = splitPromptTokens({ prompt_tokens: 1234, completion_tokens: 7 });
    expect(split.inputTokens).toBe(1234);
    expect(split.cacheReadTokens).toBe(0);
    expect(split.cacheCreationTokens).toBe(0);
  });

  test("E′: absent, null and nonsense usage never throw and never go negative", () => {
    for (const input of [undefined, null, "", 0, { prompt_tokens: -5 }, { prompt_tokens: "x" }]) {
      const split = splitPromptTokens(input);
      expect(split.promptTokens).toBe(0);
      expect(split.inputTokens).toBe(0);
      expect(split.cacheReadTokens).toBe(0);
      expect(split.cacheCreationTokens).toBe(0);
    }
  });

  test("F′: cached larger than the prompt is clamped, the sum invariant holds", () => {
    const split = splitPromptTokens({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 900 },
    });
    expect(split.cacheReadTokens).toBe(100);
    expect(split.cacheCreationTokens).toBe(0);
    expect(split.inputTokens).toBe(0);
    expect(split.inputTokens + split.cacheReadTokens + split.cacheCreationTokens).toBe(100);
  });

  test("F′-both: read + creation clamped against what is LEFT, sum still exact", () => {
    const split = splitPromptTokens({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 500 },
    });
    expect(split.cacheReadTokens).toBe(700);
    expect(split.cacheCreationTokens).toBe(300); // not 500 — the invariant wins
    expect(split.inputTokens).toBe(0);
    expect(split.inputTokens + split.cacheReadTokens + split.cacheCreationTokens).toBe(1000);
  });
});

describe("S4-c: openai-sse wire — all three input counters ship together", () => {
  test("G′: a cached turn emits 100 / 900 / 0, summing to the full context", async () => {
    const events = await run(
      frame({ content: "answer" }) + frame({}, "stop") +
        usageFrame({
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 900 },
        })
    );
    const usage = deltaUsageOf(events);
    expect(usage.input_tokens).toBe(100);
    expect(usage.cache_read_input_tokens).toBe(900);
    expect(usage.cache_creation_input_tokens).toBe(0);
    // The client re-derives the conversation size from exactly this sum (CC
    // 2.1.273 binary) — this assertion is the whole safety argument.
    expect(usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens)
      .toBe(1000);
  });

  test("H′: all four usage keys are PRESENT even when the cache ones are zero (M2)", async () => {
    // Replay a committed uncached SEED fixture — real capture, real parser.
    const raw = readFileSync(join(FIXTURES_DIR, "SEED-openai-text-only.sse"), "utf-8");
    const events = await run(raw);
    const usage = deltaUsageOf(events);
    expect(Object.keys(usage).sort()).toEqual([
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "input_tokens",
      "output_tokens",
    ]);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
  });

  test("J′: a fully-cached turn is reported UNSPLIT (M1) — CC discards input_tokens:0", async () => {
    // 0 such turns in the committed corpus (measurement b); the row is
    // constructed in the captured shape. A split 0/1000/0 would leave the
    // client's message_start seed standing beside a full-size cache read and
    // roughly double the reported context.
    const events = await run(
      frame({ content: "answer" }) + frame({}, "stop") +
        usageFrame({
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 1000 },
        })
    );
    const usage = deltaUsageOf(events);
    expect(usage.input_tokens).toBe(1000);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens)
      .toBe(1000);
  });

  test("SEEDS: message_start usage carries explicit 0s for both cache counters (M3)", async () => {
    // CC's usage merge only takes a delta > 0, so a delta reporting 0 falls back
    // to this seed; an ABSENT key left it undefined where the client sums the
    // three raw → NaN. Replayed on the committed SEED fixture.
    const raw = readFileSync(join(FIXTURES_DIR, "SEED-openai-text-only.sse"), "utf-8");
    const events = await run(raw);
    const usage = startUsageOf(events);
    expect(usage).toBeDefined();
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
  });

  test("I′: onTokenUpdate keeps the FULL prompt in arg 1; the split rides in arg 3 (M5)", async () => {
    const seen: Array<{ input: number; output: number; detail?: UsageCacheDetail }> = [];
    await run(
      frame({ content: "answer" }) + frame({}, "stop") +
        usageFrame({
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 900 },
        }),
      { onTokenUpdate: (input, output, detail) => seen.push({ input, output, detail }) }
    );
    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    expect(last.input).toBe(1000); // NOT the reduced 100
    expect(last.detail).toEqual({ cacheReadTokens: 900, cacheCreationTokens: 0 });
  });
});

describe("S4-c: TokenTracker cache discount (inert until a rate exists)", () => {
  const PRICING_NO_RATE = { inputCostPer1M: 2.0, outputCostPer1M: 8.0 } as any;
  const PRICING_WITH_RATE = {
    inputCostPer1M: 2.0,
    outputCostPer1M: 8.0,
    cacheReadCostPer1M: 0.2,
  } as any;
  const DETAIL: UsageCacheDetail = { cacheReadTokens: 20352, cacheCreationTokens: 0 };

  test("no cacheReadCostPer1M producer → discount exactly 0 (costs bit-identical)", () => {
    expect(computeCacheReadDiscount(PRICING_NO_RATE, 20379, DETAIL)).toBe(0);
  });

  test("a published rate subtracts the saving on the cached share", () => {
    // (20352 / 1M) × (2.0 − 0.2)
    expect(computeCacheReadDiscount(PRICING_WITH_RATE, 20379, DETAIL)).toBeCloseTo(
      (20352 / 1_000_000) * 1.8,
      12
    );
  });

  test("the Math.min against billedInput is load-bearing — never a negative turn (M4)", () => {
    // Delta strategy charges only the GROWTH: 27 tokens billed against a
    // 20352-token cache read. Unclamped, the session total goes negative.
    expect(computeCacheReadDiscount(PRICING_WITH_RATE, 27, DETAIL)).toBeCloseTo(
      (27 / 1_000_000) * 1.8,
      12
    );
  });

  test("zero/negative inputs short-circuit to 0", () => {
    expect(computeCacheReadDiscount(PRICING_WITH_RATE, 1000, undefined)).toBe(0);
    expect(computeCacheReadDiscount(PRICING_WITH_RATE, 0, DETAIL)).toBe(0);
    expect(
      computeCacheReadDiscount(PRICING_WITH_RATE, 100, { cacheReadTokens: 0, cacheCreationTokens: 5 })
    ).toBe(0);
    expect(computeCacheReadDiscount(PRICING_WITH_RATE, -1, DETAIL)).toBe(0);
  });

  test("TokenTracker.update with a detail and no rate → cost unchanged vs no detail", () => {
    // The writeFile is mocked away by pointing at an invalid port dir? No —
    // the tracker writes to ~/.claudish/tokens-<port>.json. Use a port that is
    // ours alone for the test run and read the cost back before/after.
    const withDetail = new TokenTracker(39991, {
      contextWindow: 100_000,
      providerName: "test",
      modelName: "model",
    });
    withDetail.update(1000, 20, DETAIL);
    const bare = new TokenTracker(39992, {
      contextWindow: 100_000,
      providerName: "test",
      modelName: "model",
    });
    bare.update(1000, 20);
    expect(withDetail.getTotalCost()).toBe(bare.getTotalCost());
  });
});
