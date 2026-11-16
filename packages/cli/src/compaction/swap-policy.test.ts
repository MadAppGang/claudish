import { describe, expect, test } from "bun:test";
import { type SwapDecisionInput, breakEvenRequests, decideHistorySwap } from "./swap-policy.js";

/**
 * The measured figures of one history swap on a 200K window: the swap wrote
 * 60,897 tokens fresh to the cache and removed about 74,000, and Claude Code
 * compacted on its own about 6 requests later.
 */
const WRITTEN = 60_897;
const REMOVED = 74_000;
const LIMIT = 200_000;
const CC_POINT = 166_000;
/** 6 requests of 2,000 tokens each reach Claude Code's compaction point. */
const GROWTH = 2_000;
const COUNT = CC_POINT - 6 * GROWTH;

/** Sonnet 5.5 on the Claude API: $2 input, $0.10 cache read; a 5-minute cache write. */
const SONNET_5M = { inputPerMTok: 2, readRatio: 0.05, writeRatio: 1.25 };

function costInput(overrides: Partial<SwapDecisionInput> = {}): SwapDecisionInput {
  return {
    policy: "cost",
    count: COUNT,
    limit: LIMIT,
    precomputeAt: 0.5,
    applyAt: 0.7,
    ccCompactAt: CC_POINT,
    tailTokens: WRITTEN - 8_000,
    summaryTokens: 8_000,
    removedTokens: REMOVED,
    ratios: SONNET_5M,
    haikuCostUsd: 0,
    gapMs: 20_000,
    cacheTtlMs: 300_000,
    growthPerRequest: GROWTH,
    ...overrides,
  };
}

describe("breakEvenRequests", () => {
  test("Sonnet 5.5, 5-minute write: (1.25 - 0.05) x 60,897 / (0.05 x 74,000) is about 19.7", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.2 * WRITTEN) / (0.05 * REMOVED), 6);
    expect(n).toBeGreaterThan(19.7);
    expect(n).toBeLessThan(19.8);
  });

  test("Fable 5.2, 5-minute write: a 0.025 read ratio puts it at about 40", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: { inputPerMTok: 8, readRatio: 0.025, writeRatio: 1.25 },
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.225 * WRITTEN) / (0.025 * REMOVED), 6);
    expect(Math.round(n)).toBe(40);
  });

  test("Opus 5.5, 5-minute write: a 0.05 read ratio, the same as Sonnet 5.5", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: { inputPerMTok: 4, readRatio: 0.05, writeRatio: 1.25 },
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.2 * WRITTEN) / (0.05 * REMOVED), 6);
  });

  test("an older model with a 0.1 read ratio breaks even sooner, at about 9.5", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: { inputPerMTok: 3, readRatio: 0.1, writeRatio: 1.25 },
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.15 * WRITTEN) / (0.1 * REMOVED), 6);
    expect(Math.round(n)).toBe(9);
  });

  test("a 1-hour cache write (2x) on Sonnet 5.5 raises it to about 32", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: { ...SONNET_5M, writeRatio: 2 },
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.95 * WRITTEN) / (0.05 * REMOVED), 6);
    expect(Math.round(n)).toBe(32);
  });

  test("the Haiku cost counts as input tokens of the main model: $0.03 at $2/MTok is 15,000", () => {
    const without = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    const withHaiku = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0.03,
    });
    expect(withHaiku - without).toBeCloseTo(15_000 / (0.05 * REMOVED), 6);
  });

  test("the summary is written to the cache with the tail: L + S", () => {
    const split = breakEvenRequests({
      tailTokens: WRITTEN - 8_000,
      summaryTokens: 8_000,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    const whole = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    expect(split).toBeCloseTo(whole, 9);
  });

  test("a swap that removes nothing never breaks even", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: 0,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    expect(n).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("decideHistorySwap, policy cost", () => {
  test("at the measured figures it holds: 6 projected requests are fewer than nStar", () => {
    const d = decideHistorySwap(costInput());
    expect(d.swap).toBe(false);
    expect(d.projectedRequestsBeforeCcCompact).toBe(6);
    expect(d.nStar).toBeGreaterThan(19.7);
    expect(d.nStar).toBeLessThan(19.8);
    expect(d.reason).toContain("projected 6 < nStar");
  });

  test("it swaps when the next request is projected to cross Claude Code's compaction point", () => {
    const d = decideHistorySwap(costInput({ count: CC_POINT - GROWTH }));
    expect(d.swap).toBe(true);
    expect(d.projectedRequestsBeforeCcCompact).toBe(1);
    expect(d.reason).toContain("crosses Claude Code's compaction point");
  });

  test("it swaps when the count is already past Claude Code's compaction point", () => {
    const d = decideHistorySwap(costInput({ count: CC_POINT + 500 }));
    expect(d.swap).toBe(true);
    expect(d.projectedRequestsBeforeCcCompact).toBe(0);
  });

  test("it swaps on a cold cache: the gap is longer than the cache TTL", () => {
    const d = decideHistorySwap(costInput({ gapMs: 301_000 }));
    expect(d.swap).toBe(true);
    expect(d.reason).toContain("cold cache");
  });

  test("a cold cache below precomputeAt does not swap", () => {
    const d = decideHistorySwap(costInput({ gapMs: 301_000, count: 0.49 * LIMIT }));
    expect(d.swap).toBe(false);
  });

  test("a 1-hour cache is still warm after 6 minutes", () => {
    const d = decideHistorySwap(costInput({ gapMs: 360_000, cacheTtlMs: 3_600_000 }));
    expect(d.swap).toBe(false);
  });

  test("it swaps when the projected requests reach nStar", () => {
    // 30 requests of 1,000 tokens before Claude Code's point; nStar is about 19.7.
    const d = decideHistorySwap(costInput({ growthPerRequest: 1_000, count: CC_POINT - 30_000 }));
    expect(d.swap).toBe(true);
    expect(d.projectedRequestsBeforeCcCompact).toBe(30);
    expect(d.reason).toContain("projected 30 >= nStar");
  });

  test("with no price data it holds, and reports no nStar", () => {
    const d = decideHistorySwap(costInput({ ratios: undefined }));
    expect(d.swap).toBe(false);
    expect(d.nStar).toBeUndefined();
    expect(d.reason).toContain("no cache prices");
  });

  test("with no price data it still swaps before Claude Code's compaction point", () => {
    const d = decideHistorySwap(costInput({ ratios: undefined, count: CC_POINT - GROWTH }));
    expect(d.swap).toBe(true);
  });

  test("with no growth measured yet it holds, and reports no projection", () => {
    const d = decideHistorySwap(costInput({ growthPerRequest: undefined }));
    expect(d.swap).toBe(false);
    expect(d.projectedRequestsBeforeCcCompact).toBeUndefined();
  });

  test("below precomputeAt it holds", () => {
    const d = decideHistorySwap(costInput({ count: 0.49 * LIMIT }));
    expect(d.swap).toBe(false);
    expect(d.reason).toContain("below precomputeAt");
  });
});

describe("decideHistorySwap, policies threshold and early", () => {
  test("threshold swaps at applyAt, as before, whatever the cost", () => {
    const d = decideHistorySwap(
      costInput({ policy: "threshold", precomputeAt: 0.6, applyAt: 0.75, count: 0.75 * LIMIT })
    );
    expect(d.swap).toBe(true);
    expect(d.reason).toContain("applyAt");
  });

  test("threshold holds below applyAt, even when the cost model would swap", () => {
    const d = decideHistorySwap(
      costInput({
        policy: "threshold",
        precomputeAt: 0.6,
        applyAt: 0.75,
        count: 0.74 * LIMIT,
        gapMs: 3_600_000,
      })
    );
    expect(d.swap).toBe(false);
  });

  test("early swaps at its own applyAt", () => {
    const d = decideHistorySwap(
      costInput({ policy: "early", precomputeAt: 0.5, applyAt: 0.7, count: 0.7 * LIMIT })
    );
    expect(d.swap).toBe(true);
  });

  test("threshold still reports nStar and the projection for the log", () => {
    const d = decideHistorySwap(
      costInput({ policy: "threshold", precomputeAt: 0.6, applyAt: 0.75, count: 0.75 * LIMIT })
    );
    expect(d.nStar).toBeGreaterThan(19);
    expect(d.projectedRequestsBeforeCcCompact).toBe(Math.ceil((CC_POINT - 0.75 * LIMIT) / GROWTH));
  });
});
