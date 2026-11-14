import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MODEL, catalog, connection, isolatedFile, temp } from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const { writeAllModelsCache, ALL_MODELS_CACHE_PATH } = await import(
    "./providers/all-models-cache.js"
  );
  const entries = [
    {
      modelId: MODEL,
      aliases: [],
      provider: "anthropic",
      contextWindow: 200000,
      aggregators: [
        connection("anthropic", "direct-api", MODEL + "-wire", {
          type: "tiered",
          input: 1,
          output: 5,
          tiers: [
            { maxInputTokens: 200000, input: 1, output: 5 },
            { input: 2, output: 10 },
          ],
        }),
      ],
    },
    {
      modelId: "claude-opus-x",
      aliases: [],
      provider: "anthropic",
      contextWindow: 200000,
      aggregators: [
        connection("anthropic", "direct-api", "claude-opus-x", {
          type: "flat",
          input: 1,
          output: 5,
        }),
      ],
    },
    {
      modelId: "claude-price-flat-test",
      aliases: [],
      provider: "anthropic",
      contextWindow: 200000,
      aggregators: [
        connection("anthropic", "direct-api", "claude-price-flat-wire", {
          type: "flat",
          input: 3,
          output: 15,
        }),
      ],
    },
  ];
  writeAllModelsCache(
    catalog(entries) as Parameters<typeof writeAllModelsCache>[0],
    ALL_MODELS_CACHE_PATH
  );
  const { warmPricingCache } = await import("./services/pricing-cache.js");
  await warmPricingCache();
  const { getModelPricing } = await import("./handlers/shared/remote-provider-types.js");
  const { connectionRequestRates } = await import("./providers/connection-price.js");
  const { createClaudeApiMeter } = await import("./handlers/claude-api-meter.js");
  const { mergeSseUsage } = await import("./handlers/shared/claude-api-usage.js");
  const { sseErrorTypeOf } = await import("./handlers/native-handler.js");
  const { computeTurnCost } = await import("./handlers/shared/token-tracker.js");
  const stats = await import("./stats.js");
  type Event = Parameters<typeof stats.recordStats>[0];
  const events: Event[] = [];
  let restore: (() => void) | undefined;
  let home: string;
  let previous: string | undefined;
  let port = 41000;
  beforeEach(() => {
    home = temp();
    previous = process.env.CLAUDISH_TOKEN_FILE;
    process.env.CLAUDISH_TOKEN_FILE = join(home, "tokens.json");
    events.length = 0;
    const observer = spyOn(stats, "recordStats").mockImplementation((event) => {
      events.push(event);
    });
    restore = () => observer.mockRestore();
  });
  afterEach(() => {
    restore?.();
    if (previous === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
    else process.env.CLAUDISH_TOKEN_FILE = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const tokens = () => JSON.parse(readFileSync(process.env.CLAUDISH_TOKEN_FILE!, "utf8"));
  const meter = (mainModel = MODEL) =>
    createClaudeApiMeter({ port: port++, mainModel, contextWindow: 200000 });

  test("B-51 prices canonical and wire ids from their own connection", () => {
    for (const id of [MODEL, MODEL + "-wire"])
      expect(getModelPricing("anthropic", id)).toMatchObject({
        inputCostPer1M: 1,
        outputCostPer1M: 5,
        isEstimate: true,
      });
    for (const id of ["claude-price-flat-test", "claude-price-flat-wire"]) {
      const price = getModelPricing("anthropic", id);
      expect(price).toMatchObject({ inputCostPer1M: 3, outputCostPer1M: 15 });
      expect(price.isEstimate).toBeUndefined();
    }
  });

  test("B-52 projects only measured connection request rates", () => {
    const rates = (pricing?: unknown) =>
      connectionRequestRates(
        connection("anthropic", "direct-api", MODEL, pricing) as Parameters<
          typeof connectionRequestRates
        >[0]
      );
    expect(rates({ type: "flat", input: 3, output: 15, cachedRead: 0.3 })).toEqual({
      inputCostPer1M: 3,
      outputCostPer1M: 15,
      cacheReadCostPer1M: 0.3,
    });
    expect(
      rates({
        type: "tiered",
        input: 1,
        output: 5,
        tiers: [
          { maxInputTokens: 10, input: 1, output: 5 },
          { input: 2, output: 10 },
        ],
      })
    ).toMatchObject({ inputCostPer1M: 1, outputCostPer1M: 5, isEstimate: true });
    expect(rates({ type: "free" })).toMatchObject({ inputCostPer1M: 0, outputCostPer1M: 0 });
    for (const price of [
      undefined,
      { type: "unavailable" },
      { type: "unknown" },
      { type: "flat", input: 0, output: 0 },
    ])
      expect(rates(price)).toBeUndefined();
  });

  test("B-53 records API stats and catalog-priced token cost", () => {
    meter().record({
      model: MODEL,
      status: 200,
      latencyMs: 10,
      usage: { input_tokens: 1000000, output_tokens: 100000 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider_name: "anthropic",
      model_id: MODEL,
      success: true,
      http_status: 200,
      stream_format: "anthropic-messages",
      adapter_name: "native-passthrough",
      invocation_mode: "explicit-model",
      is_free_model: false,
      input_tokens: 1000000,
      output_tokens: 100000,
    });
    expect(events[0].estimated_cost).toBeCloseTo(1.5, 8);
    expect(tokens()).toMatchObject({ provider_name: "Claude API", total_cost: 1.5 });
  });

  test("B-54 keeps per-model cumulative totals and side-turn context separate", () => {
    const m = meter("claude-opus-x");
    m.record({
      model: "claude-opus-x",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 1000000 },
    });
    m.record({ model: MODEL, status: 200, latencyMs: 1, usage: { input_tokens: 20000 } });
    m.record({
      model: "claude-opus-x",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 1000000 },
    });
    expect(events.map((e) => e.estimated_cost)).toEqual([1, 0.02, 2]);
    expect(tokens().total_cost).toBeCloseTo(2.02, 8);
    expect(Number(events[2].estimated_cost) + Number(events[1].estimated_cost)).toBeCloseTo(
      tokens().total_cost,
      8
    );

    events.length = 0;
    const separate = meter("claude-opus-x");
    separate.record({
      model: "claude-opus-x",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const mainContext = tokens().input_tokens;
    separate.record({
      model: MODEL,
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 200, output_tokens: 20 },
    });
    expect(events[1]).toMatchObject({ model_id: MODEL, input_tokens: 200, output_tokens: 20 });
    expect(tokens().input_tokens).toBe(mainContext);
  });

  test("B-55 counts usage but marks SSE error turns as failures", () => {
    for (const [streamErrorType, error_class, error_code] of [
      ["overloaded_error", "overload", "overloaded_error"],
      ["unknown_test_error", "http_error", "stream_error"],
    ]) {
      const m = meter();
      m.record({
        model: MODEL,
        status: 200,
        latencyMs: 1,
        streamErrorType,
        usage: { input_tokens: 100 },
      });
      const event = events.at(-1)!;
      expect(event).toMatchObject({ success: false, error_class, error_code, input_tokens: 100 });
      expect(Number(event.estimated_cost)).toBeGreaterThan(0);
      expect(tokens().total_cost).toBeGreaterThan(0);
    }
  });

  test("B-56 counts failed and cancelled usage without inventing zero usage", () => {
    const m = meter();
    m.record({
      model: MODEL,
      status: 0,
      latencyMs: 1,
      error: new Error("socket"),
      usage: { input_tokens: 100 },
    });
    expect(events[0]).toMatchObject({ success: false, input_tokens: 100, http_status: 0 });
    expect(Number(events[0].estimated_cost)).toBeGreaterThan(0);
    m.record({ model: MODEL, status: 502, latencyMs: 1, error: new Error("upstream") });
    expect(events[1]).toMatchObject({ http_status: 502, success: false });
    m.record({
      model: MODEL,
      status: 200,
      latencyMs: 1,
      cancelled: true,
      usage: { output_tokens: 5 },
    });
    expect(events[2]).toMatchObject({
      success: false,
      error_class: "cancelled",
      error_code: "client_cancelled",
      input_tokens: 100,
      output_tokens: 5,
    });
    const cost = tokens().total_cost;
    const counts = { in: events[2].input_tokens, out: events[2].output_tokens };
    m.record({
      model: MODEL,
      status: 200,
      latencyMs: 1,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(tokens().total_cost).toBe(cost);
    expect(events[3]).toMatchObject({
      input_tokens: counts.in,
      output_tokens: counts.out,
      estimated_cost: cost,
    });
  });

  test("B-57 merges SSE usage and recognizes error events", () => {
    const usage = {};
    mergeSseUsage(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}',
      usage
    );
    mergeSseUsage('data: {"type":"message_delta","usage":{"output_tokens":7}}', usage);
    expect(usage).toEqual({ input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 7 });
    mergeSseUsage("event: message_delta", usage);
    mergeSseUsage("data: invalid json", usage);
    expect(usage).toEqual({ input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 7 });
    expect(
      sseErrorTypeOf(["event: error", 'data: {"type":"error","error":{"type":"overloaded_error"}}'])
    ).toBe("overloaded_error");
    expect(
      sseErrorTypeOf([
        "event: message_delta",
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
      ])
    ).toBeUndefined();
  });

  test("B-58 computes turn cost from published rates", () => {
    expect(computeTurnCost({ inputCostPer1M: 1, outputCostPer1M: 5 }, 1000000, 100000)).toBe(1.5);
  });
});
