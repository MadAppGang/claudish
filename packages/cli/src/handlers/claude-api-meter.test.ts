import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../providers/catalog-client.js";
import { getDynamicPricingSync } from "../services/pricing-cache.js";
import * as stats from "../stats.js";
import { createClaudeApiMeter } from "./claude-api-meter.js";
import { registerDynamicPricingLookup } from "./shared/remote-provider-types.js";

type Event = Parameters<typeof stats.recordStats>[0];

describe("createClaudeApiMeter running input", () => {
  const events: Event[] = [];
  let dir: string;
  let previous: string | undefined;
  let restore: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-api-meter-"));
    previous = process.env.CLAUDISH_TOKEN_FILE;
    process.env.CLAUDISH_TOKEN_FILE = join(dir, "tokens.json");
    events.length = 0;
    const spy = spyOn(stats, "recordStats").mockImplementation((event) => {
      events.push(event);
    });
    restore = () => spy.mockRestore();
  });

  afterEach(() => {
    restore?.();
    if (previous === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
    else process.env.CLAUDISH_TOKEN_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const meter = () =>
    createClaudeApiMeter({ port: 47311, mainModel: "claude-meter-test", contextWindow: 200000 });

  test("an output-only usage keeps the model's last reported input", () => {
    const m = meter();
    m.record({
      model: "claude-meter-test",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 100 },
    });
    m.record({
      model: "claude-meter-test",
      status: 200,
      latencyMs: 1,
      cancelled: true,
      usage: { output_tokens: 5 },
    });
    expect(events[1]).toMatchObject({ input_tokens: 100, output_tokens: 5 });
  });

  test("a later reported input replaces the earlier one", () => {
    const m = meter();
    m.record({
      model: "claude-meter-test",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 100 },
    });
    m.record({
      model: "claude-meter-test",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 1 },
    });
    expect(events[1]).toMatchObject({ input_tokens: 50, output_tokens: 1 });
  });
});

describe("createClaudeApiMeter prices each turn at its published band", () => {
  const events: Event[] = [];
  let dir: string;
  let previous: string | undefined;
  let restore: (() => void) | undefined;
  const BANDED = "claude-band-test";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-api-meter-band-"));
    previous = process.env.CLAUDISH_TOKEN_FILE;
    process.env.CLAUDISH_TOKEN_FILE = join(dir, "tokens.json");
    events.length = 0;
    const spy = spyOn(stats, "recordStats").mockImplementation((event) => {
      events.push(event);
    });
    restore = () => spy.mockRestore();
    // What `warmPricingCache` installs at startup, without its disk read.
    registerDynamicPricingLookup(getDynamicPricingSync);
    // The bands the catalog publishes for claude-haiku-5-5 on the Claude API.
    _setCatalogEntriesForTest([
      {
        modelId: BANDED,
        aliases: [],
        provider: "anthropic",
        contextWindow: 1000000,
        aggregators: [
          {
            sourceProviderId: "anthropic",
            sourceCollectorId: "test-data",
            confidence: "api_official",
            routeStatus: "mapped",
            route: { routeId: "anthropic", routeProfileId: "direct-api" },
            externalModelId: BANDED,
            pricing: {
              type: "tiered",
              input: 0.1,
              output: 0.5,
              cachedRead: 0.01,
              tiers: [
                { maxInputTokens: 100000, input: 0.1, output: 0.5, cachedRead: 0.01 },
                { maxInputTokens: 1000000, input: 0.5, output: 2.5, cachedRead: 0.05 },
              ],
            },
          },
        ],
      },
    ] as unknown as Parameters<typeof _setCatalogEntriesForTest>[0]);
  });

  afterEach(() => {
    restore?.();
    _resetCatalogClient();
    if (previous === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
    else process.env.CLAUDISH_TOKEN_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const meter = (mainModel: string) =>
    createClaudeApiMeter({ port: 47312, mainModel, contextWindow: 1000000 });

  test("a main turn above the first band's limit pays the second band", () => {
    const m = meter(BANDED);
    m.record({ model: BANDED, status: 200, latencyMs: 1, usage: { input_tokens: 150000 } });
    expect(events[0]?.estimated_cost).toBeCloseTo(0.075, 10);
  });

  test("a main turn inside the first band pays the first band", () => {
    const m = meter(BANDED);
    m.record({ model: BANDED, status: 200, latencyMs: 1, usage: { input_tokens: 50000 } });
    expect(events[0]?.estimated_cost).toBeCloseTo(0.005, 10);
  });

  test("a turn above every band's limit pays the last band", () => {
    const m = meter(BANDED);
    m.record({ model: BANDED, status: 200, latencyMs: 1, usage: { input_tokens: 2000000 } });
    expect(events[0]?.estimated_cost).toBeCloseTo(1, 10);
  });

  test("a side turn above the first band's limit pays the second band", () => {
    const m = meter("claude-other-main-test");
    m.record({ model: BANDED, status: 200, latencyMs: 1, usage: { input_tokens: 150000 } });
    expect(events[0]?.estimated_cost).toBeCloseTo(0.075, 10);
  });

  test("the band's output and cache-read rates apply, with cache in the band's input", () => {
    const m = meter(BANDED);
    m.record({
      model: BANDED,
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 50000, cache_read_input_tokens: 100000, output_tokens: 10000 },
    });
    // 150,000 input at $0.50/M, less 100,000 cache reads at ($0.50 - $0.05)/M,
    // plus 10,000 output at $2.50/M.
    expect(events[0]?.estimated_cost).toBeCloseTo(0.075 - 0.045 + 0.025, 10);
  });
});
