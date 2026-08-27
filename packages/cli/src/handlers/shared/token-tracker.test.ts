import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenTracker } from "./token-tracker.js";

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
