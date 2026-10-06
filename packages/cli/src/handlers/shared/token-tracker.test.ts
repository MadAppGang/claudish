import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSessionStats } from "../../session/session-stats.js";
import { resolveTokenFilePath } from "../../session/token-file.js";
import { TokenTracker, computeCacheReadDiscount } from "./token-tracker.js";

interface TokenFile {
  input_tokens: number;
  output_tokens: number;
  context_left_percent: number;
}

const createdTokenFiles = new Set<string>();
const originalTokenFile = process.env.CLAUDISH_TOKEN_FILE;
let nextPort = 50_000 + (process.pid % 10_000);

function createTracker(contextWindow = 400_000): {
  tracker: TokenTracker;
  tokenFile: string;
} {
  let tokenFile: string;
  let port: number;

  do {
    port = nextPort++;
    tokenFile = join(tmpdir(), `claudish-token-tracker-${process.pid}-${port}.json`);
  } while (existsSync(tokenFile));

  createdTokenFiles.add(tokenFile);
  process.env.CLAUDISH_TOKEN_FILE = tokenFile;

  return {
    tracker: new TokenTracker(port, {
      contextWindow,
      providerName: "openai",
      modelName: "test-model",
    }),
    tokenFile,
  };
}

function readTokenFile(path: string): TokenFile {
  return JSON.parse(readFileSync(path, "utf8")) as TokenFile;
}

afterEach(() => {
  for (const path of createdTokenFiles) {
    if (existsSync(path)) unlinkSync(path);
  }
  createdTokenFiles.clear();
  if (originalTokenFile === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
  else process.env.CLAUDISH_TOKEN_FILE = originalTokenFile;
});

describe("the token file path: one rule for the writer and its readers", () => {
  test("with no override the tracker writes where resolveTokenFilePath says, $HOME first", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-token-home-"));
    const savedHome = process.env.HOME;
    const port = nextPort++;
    try {
      process.env.HOME = home; // Bun's os.homedir() would ignore this
      delete process.env.CLAUDISH_TOKEN_FILE;
      const expected = join(home, ".claudish", `tokens-${port}.json`);
      expect(resolveTokenFilePath(port)).toBe(expected);
      const tracker = new TokenTracker(port, {
        contextWindow: 400_000,
        providerName: "openai",
        modelName: "test-model",
      });
      tracker.updateWithDelta(1_000, 10);
      expect(readTokenFile(expected).input_tokens).toBe(1_000);
      // the end-of-session summary reads the same file
      expect(readSessionStats(port)).not.toBeNull();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("source guard: token-tracker.ts never builds the path itself (no os.homedir)", () => {
    const src = readFileSync(join(import.meta.dir, "token-tracker.ts"), "utf8");
    expect(src).toContain("resolveTokenFilePath(this.port)");
    expect(src).not.toMatch(/homedir\(/);
  });
});

describe("TokenTracker live input-token tracking", () => {
  test("grow then compact writes the current context and recovers context-left percentage", () => {
    const { tracker, tokenFile } = createTracker();

    tracker.updateWithDelta(300_000, 10);
    const beforeCompaction = readTokenFile(tokenFile);

    tracker.updateWithDelta(20_000, 10);
    const afterCompaction = readTokenFile(tokenFile);

    expect(beforeCompaction.input_tokens).toBe(300_000);
    expect(afterCompaction.input_tokens).toBe(20_000);
    expect(afterCompaction.input_tokens).not.toBe(300_000);
    expect(afterCompaction.context_left_percent).toBeGreaterThan(
      beforeCompaction.context_left_percent
    );
    expect(afterCompaction.context_left_percent).toBe(95);
    expect(tracker.getInputTokens()).toBe(300_000);
    expect(tracker.getLastInputTokens()).toBe(20_000);
  });

  test("an ambiguous decrease re-baselines both billing and live input tokens", () => {
    const { tracker, tokenFile } = createTracker();

    tracker.updateWithDelta(300_000, 10);
    tracker.updateWithDelta(200_000, 10);

    expect(tracker.getInputTokens()).toBe(200_000);
    expect(tracker.getLastInputTokens()).toBe(200_000);
    expect(readTokenFile(tokenFile).input_tokens).toBe(200_000);
  });

  const syncCases: Array<{
    name: string;
    update: (tracker: TokenTracker) => void;
    expected: number;
  }> = [
    {
      name: "update",
      update: (tracker) => tracker.update(12_345, 2),
      expected: 12_345,
    },
    {
      name: "updateLocal",
      update: (tracker) => tracker.updateLocal(23_456, 3),
      expected: 23_456,
    },
    {
      name: "accumulateBoth",
      update: (tracker) => {
        tracker.accumulateBoth(10_000, 1);
        tracker.accumulateBoth(2_345, 2);
      },
      expected: 12_345,
    },
    {
      name: "updateWithActualCost",
      update: (tracker) => tracker.updateWithActualCost(34_567, 4, 0.25),
      expected: 34_567,
    },
  ];

  for (const { name, update, expected } of syncCases) {
    test(`${name} keeps the latest real input count in sync`, () => {
      const { tracker, tokenFile } = createTracker();

      update(tracker);

      expect(tracker.getLastInputTokens()).toBe(expected);
      expect(readTokenFile(tokenFile).input_tokens).toBe(expected);
    });
  }

  test("rewrite uses the last real input count after the billing baseline stays high", () => {
    const { tracker, tokenFile } = createTracker();

    tracker.updateWithDelta(300_000, 10);
    tracker.updateWithDelta(20_000, 10);
    unlinkSync(tokenFile);

    tracker.rewrite();

    expect(tracker.getInputTokens()).toBe(300_000);
    expect(tracker.getLastInputTokens()).toBe(20_000);
    expect(readTokenFile(tokenFile).input_tokens).toBe(20_000);
  });
});

describe("TokenTracker tool-name accounting", () => {
  test("redacts malformed names without changing unknown, normal, or total counts", () => {
    const { tracker } = createTracker();
    const malformed = 'web_search_query_listOpposed["private argument value"]';

    tracker.recordToolUse(malformed);
    tracker.recordToolUse("   ");
    tracker.recordToolUse("Read");
    tracker.recordToolUse("Read");

    const toolCalls = tracker.getToolCalls();
    expect(toolCalls).toEqual([
      { name: "Read", count: 2 },
      { name: "malformed", count: 1 },
      { name: "unknown", count: 1 },
    ]);
    expect(JSON.stringify(toolCalls)).not.toContain(malformed);
    expect(tracker.getToolCallCount()).toBe(4);
  });
});

/**
 * Item 6's money half.
 *
 * The capture numbers below come from
 * `test-fixtures/sse-responses/grok-4.6-openai-advisor-turn1.sse`
 * (`prompt_tokens: 20379`, `prompt_tokens_details.cached_tokens: 20352`) — the
 * turn that makes the clamp necessary, because the delta strategy charges the
 * 27-token GROWTH while the cache read is three orders of magnitude larger.
 *
 * `cacheReadCostPer1M` has no producer in the tree by design (its absence is the
 * rule "price a cache read as ordinary input"), so the only way to reach a
 * non-zero discount at all is to hand `computeCacheReadDiscount` a pricing
 * object. That is why the arithmetic is pinned on the exported function and the
 * "nothing changed" property is pinned on the tracker itself.
 */
describe("TokenTracker cache-read discount", () => {
  const CAPTURE_PROMPT_TOKENS = 20_379;
  const CAPTURE_CACHED_TOKENS = 20_352;
  const CAPTURE_GROWTH = CAPTURE_PROMPT_TOKENS - CAPTURE_CACHED_TOKENS; // 27
  const detail = { cacheReadTokens: CAPTURE_CACHED_TOKENS, cacheCreationTokens: 0 };

  test("no cache rate anywhere means the discount is EXACTLY zero", () => {
    const pricing = { inputCostPer1M: 3, outputCostPer1M: 15 };
    expect(computeCacheReadDiscount(pricing, CAPTURE_PROMPT_TOKENS, detail)).toBe(0);
  });

  test("a rate equal to the input rate is also exactly zero", () => {
    const pricing = { inputCostPer1M: 3, outputCostPer1M: 15, cacheReadCostPer1M: 3 };
    expect(computeCacheReadDiscount(pricing, CAPTURE_PROMPT_TOKENS, detail)).toBe(0);
  });

  test("a cache rate ABOVE the input rate never becomes a surcharge", () => {
    const pricing = { inputCostPer1M: 3, outputCostPer1M: 15, cacheReadCostPer1M: 9 };
    expect(computeCacheReadDiscount(pricing, CAPTURE_PROMPT_TOKENS, detail)).toBe(0);
  });

  test("the discount is clamped to what the strategy actually charged", () => {
    const pricing = { inputCostPer1M: 3, outputCostPer1M: 15, cacheReadCostPer1M: 0.3 };
    // Delta strategy: it charged 27 tokens, so at most 27 tokens may be discounted.
    const clamped = computeCacheReadDiscount(pricing, CAPTURE_GROWTH, detail);
    expect(clamped).toBeCloseTo((CAPTURE_GROWTH / 1_000_000) * 2.7, 12);

    // Unclamped, the same inputs would subtract three orders of magnitude more
    // than the charge — this is the number that drove sessionTotalCost negative.
    const unclamped = (CAPTURE_CACHED_TOKENS / 1_000_000) * 2.7;
    const charged = (CAPTURE_GROWTH / 1_000_000) * 3;
    expect(charged - unclamped).toBeLessThan(0);
    expect(charged - clamped).toBeGreaterThanOrEqual(0);
  });

  test("an assignment strategy discounts against the full context it charged", () => {
    const pricing = { inputCostPer1M: 3, outputCostPer1M: 15, cacheReadCostPer1M: 0.3 };
    expect(computeCacheReadDiscount(pricing, CAPTURE_PROMPT_TOKENS, detail)).toBeCloseTo(
      (CAPTURE_CACHED_TOKENS / 1_000_000) * 2.7,
      12
    );
  });

  test("no detail, or a zero cache read, is zero", () => {
    const pricing = { inputCostPer1M: 3, outputCostPer1M: 15, cacheReadCostPer1M: 0.3 };
    expect(computeCacheReadDiscount(pricing, 1000, undefined)).toBe(0);
    expect(
      computeCacheReadDiscount(pricing, 1000, { cacheReadTokens: 0, cacheCreationTokens: 0 })
    ).toBe(0);
  });

  test("every strategy's cost is bit-identical with and without the detail today", () => {
    // The whole safety claim for shipping this: with no cache rate in the tree,
    // passing the split changes nothing, for all five strategies.
    const run = (withDetail: boolean) => {
      const totals: number[] = [];
      const d = withDetail ? detail : undefined;

      const a = createTracker().tracker;
      a.update(CAPTURE_PROMPT_TOKENS, 100, d);
      a.update(CAPTURE_PROMPT_TOKENS + 500, 100, d);
      totals.push(a.getTotalCost());

      const b = createTracker().tracker;
      b.updateWithDelta(CAPTURE_PROMPT_TOKENS, 100, d);
      b.updateWithDelta(CAPTURE_PROMPT_TOKENS + 500, 100, d);
      totals.push(b.getTotalCost());

      const c = createTracker().tracker;
      c.accumulateBoth(CAPTURE_PROMPT_TOKENS, 100, d);
      c.accumulateBoth(CAPTURE_PROMPT_TOKENS, 100, d);
      totals.push(c.getTotalCost());

      const e = createTracker().tracker;
      e.updateWithActualCost(CAPTURE_PROMPT_TOKENS, 100, undefined, d);
      e.updateWithActualCost(CAPTURE_PROMPT_TOKENS, 100, 0.25, d);
      totals.push(e.getTotalCost());

      const f = createTracker().tracker;
      f.updateLocal(CAPTURE_PROMPT_TOKENS, 100, d);
      totals.push(f.getTotalCost());

      return totals;
    };

    expect(run(true)).toEqual(run(false));
  });

  test("session cost never goes negative on the real cached turn", () => {
    const { tracker } = createTracker();
    tracker.updateWithDelta(CAPTURE_PROMPT_TOKENS, 100, detail);
    tracker.updateWithDelta(CAPTURE_PROMPT_TOKENS + CAPTURE_GROWTH, 5, detail);
    expect(tracker.getTotalCost()).toBeGreaterThanOrEqual(0);
  });
});
