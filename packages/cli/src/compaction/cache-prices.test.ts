import { describe, expect, test } from "bun:test";
import { cacheRatios, cacheTtlMs } from "./cache-prices.js";

/** The Claude API connection rates the catalog publishes, per million tokens. */
const SONNET_5_5 = { inputCostPer1M: 2, outputCostPer1M: 10, cacheReadCostPer1M: 0.1 };
const FABLE_5_2 = { inputCostPer1M: 8, outputCostPer1M: 40, cacheReadCostPer1M: 0.2 };
const OPUS_5_5 = { inputCostPer1M: 4, outputCostPer1M: 20, cacheReadCostPer1M: 0.2 };

describe("cacheRatios", () => {
  test("the read ratio is the catalog's cache-read rate over its input rate", () => {
    expect(cacheRatios(SONNET_5_5, { fiveMinute: 1, oneHour: 0 })?.readRatio).toBeCloseTo(0.05, 9);
    expect(cacheRatios(FABLE_5_2, { fiveMinute: 1, oneHour: 0 })?.readRatio).toBeCloseTo(0.025, 9);
    expect(cacheRatios(OPUS_5_5, { fiveMinute: 1, oneHour: 0 })?.readRatio).toBeCloseTo(0.05, 9);
  });

  test("the base price is the catalog's input rate", () => {
    expect(cacheRatios(FABLE_5_2, { fiveMinute: 1, oneHour: 0 })?.inputPerMTok).toBe(8);
  });

  test("a 5-minute write is 1.25x, a 1-hour write 2x", () => {
    expect(cacheRatios(SONNET_5_5, { fiveMinute: 100, oneHour: 0 })?.writeRatio).toBe(1.25);
    expect(cacheRatios(SONNET_5_5, { fiveMinute: 0, oneHour: 100 })?.writeRatio).toBe(2);
  });

  test("a mixed write is weighted by the tokens of each TTL", () => {
    const r = cacheRatios(SONNET_5_5, { fiveMinute: 300, oneHour: 100 });
    expect(r?.writeRatio).toBeCloseTo((300 * 1.25 + 100 * 2) / 400, 9);
  });

  test("no TTL split reported counts as a 5-minute write", () => {
    expect(cacheRatios(SONNET_5_5, undefined)?.writeRatio).toBe(1.25);
    expect(cacheRatios(SONNET_5_5, { fiveMinute: 0, oneHour: 0 })?.writeRatio).toBe(1.25);
  });

  test("a published cache-write rate replaces the 5-minute multiplier", () => {
    const r = cacheRatios({ ...SONNET_5_5, cacheWriteCostPer1M: 3 }, { fiveMinute: 1, oneHour: 0 });
    expect(r?.writeRatio).toBeCloseTo(1.5, 9);
  });

  test("no cache-read rate, an estimate or a zero input rate gives no ratios", () => {
    expect(cacheRatios({ inputCostPer1M: 2, outputCostPer1M: 10 }, undefined)).toBeUndefined();
    expect(cacheRatios({ ...SONNET_5_5, isEstimate: true }, undefined)).toBeUndefined();
    expect(cacheRatios({ ...SONNET_5_5, inputCostPer1M: 0 }, undefined)).toBeUndefined();
    expect(cacheRatios(undefined, undefined)).toBeUndefined();
  });
});

describe("cacheTtlMs", () => {
  test("5 minutes unless the last write was all 1-hour", () => {
    expect(cacheTtlMs(undefined)).toBe(300_000);
    expect(cacheTtlMs({ fiveMinute: 10, oneHour: 0 })).toBe(300_000);
    expect(cacheTtlMs({ fiveMinute: 10, oneHour: 10 })).toBe(300_000);
    expect(cacheTtlMs({ fiveMinute: 0, oneHour: 10 })).toBe(3_600_000);
  });
});
