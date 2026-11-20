// Made-up requests around Haiku 5.5's 100,000-token band edge. Each expected
// cost is worked out by hand from the catalog prices per 1M tokens: up to the
// edge input 0.10, output 0.50, cached read 0.01; above it 0.50, 2.50, 0.05.
import { describe, expect, test } from "bun:test";
import { bandOf, priceOf, requestCost, totalInput } from "./pricing";

const haiku = priceOf("claude-haiku-5-5")!;
const sonnet = priceOf("claude-sonnet-5-5")!;

describe("Haiku 5.5 bands", () => {
  test("a request under the edge pays the lower band", () => {
    // 50,000 x 0.10 + 1,000 x 0.50 = 5,500 per 1M
    expect(requestCost(haiku, { input: 50_000, output: 1_000 })).toBeCloseTo(0.0055, 10);
  });

  test("a request whose cached reads take it over the edge pays the upper band on every token", () => {
    // 10,000 x 0.50 + 140,000 x 0.05 + 2,000 x 2.50 = 17,000 per 1M
    const u = { input: 10_000, read: 140_000, output: 2_000 };
    expect(totalInput(u)).toBe(150_000);
    expect(bandOf(haiku, u).upper).toBe(true);
    expect(requestCost(haiku, u)).toBeCloseTo(0.017, 10);
  });

  test("exactly 100,000 input tokens is still the lower band", () => {
    expect(bandOf(haiku, { input: 100_000 }).upper).toBe(false);
    expect(requestCost(haiku, { input: 100_000 })).toBeCloseTo(0.01, 10);
  });

  test("100,001 input tokens is the upper band", () => {
    expect(bandOf(haiku, { input: 100_001 }).upper).toBe(true);
    expect(requestCost(haiku, { input: 100_001 })).toBeCloseTo(0.0500005, 10);
  });

  test("a 1-hour cache write above the edge costs 2x the upper input price", () => {
    // 120,000 x 0.50 x 2 = 120,000 per 1M
    expect(requestCost(haiku, { input: 0, w1h: 120_000 })).toBeCloseTo(0.12, 10);
  });

  test("a set crossing the edge: total cost and the share above it", () => {
    const set = [
      { input: 30_000, output: 500 }, // 3,000 + 250 = 3,250
      { input: 2_000, read: 90_000, output: 800 }, // 200 + 900 + 400 = 1,500
      { input: 3_000, read: 110_000, output: 1_000 }, // 1,500 + 5,500 + 2,500 = 9,500
      { input: 1_000, w5m: 20_000, read: 120_000, output: 600 }, // 500 + 12,500 + 6,000 + 1,500 = 20,500
    ];
    const total = set.reduce((s, u) => s + requestCost(haiku, u), 0);
    expect(total).toBeCloseTo(0.03475, 10);
    expect(set.filter((u) => bandOf(haiku, u).upper).length).toBe(2);
  });
});

describe("the edge rule", () => {
  // 10,000 fresh + 30,000 written (5 min) + 80,000 read = 120,000 in all.
  const u = { input: 10_000, w5m: 30_000, read: 80_000, output: 1_000 };

  test("all-input (the default) counts cache writes and reads: upper band", () => {
    expect(totalInput(u)).toBe(120_000);
    expect(totalInput(u, "all-input")).toBe(120_000);
    // 10,000 x 0.50 + 30,000 x 0.50 x 1.25 + 80,000 x 0.05 + 1,000 x 2.50 = 30,250 per 1M
    expect(requestCost(haiku, u)).toBeCloseTo(0.03025, 10);
  });

  test("no-cache-reads counts fresh input and cache writes: lower band", () => {
    expect(totalInput(u, "no-cache-reads")).toBe(40_000);
    expect(bandOf(haiku, u, "no-cache-reads").upper).toBe(false);
    // 10,000 x 0.10 + 30,000 x 0.10 x 1.25 + 80,000 x 0.01 + 1,000 x 0.50 = 6,050 per 1M
    expect(requestCost(haiku, u, "no-cache-reads")).toBeCloseTo(0.00605, 10);
  });

  test("fresh-input counts only uncached input", () => {
    expect(totalInput(u, "fresh-input")).toBe(10_000);
    expect(bandOf(haiku, { input: 100_001, read: 5 }, "fresh-input").upper).toBe(true);
  });
});

describe("a model with no upper band", () => {
  test("Sonnet 5.5 at 300,000 input tokens keeps its one price", () => {
    expect(bandOf(sonnet, { input: 300_000 }).upper).toBe(false);
    expect(requestCost(sonnet, { input: 300_000 })).toBeCloseTo(0.6, 10);
  });
});
