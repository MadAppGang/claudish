import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireSigningLease } from "../../redact.js";
import { readSessionStats } from "../../session/session-stats.js";
import { resolveTokenFilePath } from "../../session/token-file.js";
import { TokenTracker, computeCacheReadDiscount, stripProviderPrefix } from "./token-tracker.js";

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

describe("TokenTracker allowance contract", () => {
  test("F16 token-file gap labels use explicit seconds, never report epoch names", () => {
    const { tracker, tokenFile } = createTracker();
    const now = Date.now();
    const gapStartSec = Math.floor(now / 1000) + 3600;
    const gapEndSec = gapStartSec + 43 * 3600;
    tracker.setAllowanceLabel({
      level: "warn",
      remainingPct: 50,
      gapStartSec,
      gapEndSec,
      observedAt: now,
    });
    tracker.updateWithDelta(1000, 10);
    const allowance = JSON.parse(readFileSync(tokenFile, "utf8")).allowance;
    expect(allowance).toMatchObject({ level: "warn", remainingPct: 50, gapStartSec, gapEndSec });
    expect(allowance).not.toHaveProperty("gapStartEpoch");
    expect(allowance).not.toHaveProperty("gapEndEpoch");
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

describe("TokenTracker in-band API error record", () => {
  test("records the code and time of an in-band error and keeps every token field", () => {
    const { tracker, tokenFile } = createTracker();
    tracker.update(1000, 10);
    const before = Date.now();
    tracker.recordInBandApiError("cyber_policy");
    const file = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(file.in_band_api_error.code).toBe("cyber_policy");
    expect(Date.parse(file.in_band_api_error.at)).toBeGreaterThanOrEqual(before);
    expect(Object.keys(file.in_band_api_error).sort()).toEqual(["at", "code"]);
    expect(file.input_tokens).toBe(1000);
    expect(file.output_tokens).toBe(10);
    expect(file.total_tokens).toBe(1010);
    expect(file.provider_name).toBeDefined();
  });

  test("a later token update keeps the record, and a later error replaces it", () => {
    const { tracker, tokenFile } = createTracker();
    tracker.recordInBandApiError("server_is_overloaded");
    tracker.update(2000, 5);
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).in_band_api_error.code).toBe(
      "server_is_overloaded"
    );
    tracker.recordInBandApiError("cyber_policy");
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).in_band_api_error.code).toBe("cyber_policy");
  });

  test("another tracker writing the same file keeps the record", () => {
    const { tracker, tokenFile } = createTracker();
    tracker.recordInBandApiError("cyber_policy");
    const other = new TokenTracker(1, {
      contextWindow: 1000,
      providerName: "openai",
      modelName: "other-model",
    });
    other.update(100, 1);
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).in_band_api_error.code).toBe("cyber_policy");
  });

  test("a code that is not an identifier is stored as `malformed`, never verbatim", () => {
    const { tracker, tokenFile } = createTracker();
    tracker.recordInBandApiError("key=abc123 rejected");
    const raw = readFileSync(tokenFile, "utf8");
    expect(JSON.parse(raw).in_band_api_error.code).toBe("malformed");
    expect(raw).not.toContain("abc123");
  });

  test("a code whose first word is a registered signing value is stored as `malformed`", () => {
    const { tracker, tokenFile } = createTracker();
    const signingValue = "opaqueSigningValue0123456789";
    const lease = acquireSigningLease();
    lease.add([signingValue]);
    try {
      tracker.recordInBandApiError(`${signingValue} rejected`);
    } finally {
      lease.release();
    }
    const raw = readFileSync(tokenFile, "utf8");
    expect(JSON.parse(raw).in_band_api_error.code).toBe("malformed");
    expect(raw).not.toContain(signingValue);
  });

  test("an ordinary code is stored unchanged while a signing value is registered", () => {
    const { tracker, tokenFile } = createTracker();
    const lease = acquireSigningLease();
    lease.add(["opaqueSigningValue0123456789"]);
    try {
      tracker.recordInBandApiError("cyber_policy");
    } finally {
      lease.release();
    }
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).in_band_api_error.code).toBe("cyber_policy");
  });

  test("a code holding whitespace is stored as its first word, the key the marker parses to", () => {
    const { tracker, tokenFile } = createTracker();
    tracker.recordInBandApiError("bad code");
    const raw = readFileSync(tokenFile, "utf8");
    expect(JSON.parse(raw).in_band_api_error.code).toBe("bad");
    expect(raw).not.toContain("bad code");
  });

  test("a tracker that never writes the token file records nothing", () => {
    const { tokenFile } = createTracker();
    const panel = new TokenTracker(2, {
      contextWindow: 1000,
      providerName: "openai",
      modelName: "panel",
      writesTokenFile: false,
    });
    panel.recordInBandApiError("cyber_policy");
    expect(existsSync(tokenFile)).toBe(false);
  });
});

describe("TokenTracker token file write: a reader never sees half of it", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      chmodSync(d, 0o755);
      rmSync(d, { recursive: true, force: true });
    }
  });

  function trackerIn(dir: string): { tracker: TokenTracker; tokenFile: string } {
    const tokenFile = join(dir, "01.json");
    process.env.CLAUDISH_TOKEN_FILE = tokenFile;
    return {
      tracker: new TokenTracker(nextPort++, {
        contextWindow: 400_000,
        providerName: "openai",
        modelName: "test-model",
      }),
      tokenFile,
    };
  }

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "claudish-token-atomic-"));
    dirs.push(d);
    return d;
  }

  /** Every byte a descriptor opened before a rewrite still reads. */
  function readAll(fd: number): string {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(4096);
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  test("a rewrite replaces the file whole: a reader holding the old file reads it complete", () => {
    const dir = tempDir();
    const { tracker, tokenFile } = trackerIn(dir);
    tracker.update(1000, 10);
    tracker.recordInBandApiError("cyber_policy");
    const fd = openSync(tokenFile, "r");
    try {
      tracker.update(2000, 5);
      const before = JSON.parse(readAll(fd));
      expect(before.input_tokens).toBe(1000);
      expect(before.in_band_api_error.code).toBe("cyber_policy");
    } finally {
      closeSync(fd);
    }
    const after = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(after.input_tokens).toBe(2000);
    expect(after.in_band_api_error.code).toBe("cyber_policy");
    for (const key of ["output_tokens", "total_tokens", "provider_name", "context_window"])
      expect(after).toHaveProperty(key);
    expect(readdirSync(dir)).toEqual(["01.json"]);
  });

  test("a write that cannot complete leaves the previous file intact and no temp file", () => {
    const dir = tempDir();
    const { tracker, tokenFile } = trackerIn(dir);
    tracker.update(1000, 10);
    const previous = readFileSync(tokenFile, "utf8");
    const ino = statSync(tokenFile).ino;
    chmodSync(dir, 0o555);
    tracker.update(2000, 5);
    chmodSync(dir, 0o755);
    expect(readFileSync(tokenFile, "utf8")).toBe(previous);
    expect(statSync(tokenFile).ino).toBe(ino);
    expect(readdirSync(dir)).toEqual(["01.json"]);
  });

  test("a rename that fails removes its temp file", () => {
    const dir = tempDir();
    const { tracker, tokenFile } = trackerIn(dir);
    mkdirSync(join(tokenFile, "occupied"), { recursive: true });
    tracker.update(1000, 10);
    expect(readdirSync(dir)).toEqual(["01.json"]);
    expect(statSync(tokenFile).isDirectory()).toBe(true);
  });
});

describe("stripProviderPrefix", () => {
  test("removes a provider@ routing prefix", () => {
    expect(stripProviderPrefix("qtoken@qwen3.7-plus")).toBe("qwen3.7-plus");
  });

  test("leaves a bare name unchanged", () => {
    expect(stripProviderPrefix("gpt-5")).toBe("gpt-5");
  });

  test("keeps the leading @ of a preset wire id", () => {
    expect(stripProviderPrefix("@preset/example")).toBe("@preset/example");
  });

  test("removes only the provider from a preset spec", () => {
    expect(stripProviderPrefix("openrouter@@preset/example")).toBe("@preset/example");
  });
});
