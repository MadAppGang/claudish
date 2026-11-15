import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isolatedFile } from "../../test-helpers/claude-behaviour.js";
import { json, useSandbox } from "../../test-helpers/model-lineup-blind.js";
import type { ProxyServer } from "../../types.js";

interface TokenFile {
  output_tokens: number;
  billed_input_tokens: number;
  total_tokens: number;
  total_cost: number;
  input_tokens: number;
  model_name: string;
  context_window: number;
  started_at: unknown;
}

await isolatedFile(import.meta, async () => {
  const sandbox = useSandbox();
  const { TokenTracker, clearTokenFileTotals } = await import("./token-tracker.js");
  const { createProxyServer } = await import("../../proxy-server.js");

  function tracker(port: number, modelName: string, writesTokenFile = true) {
    return new TokenTracker(port, {
      providerName: "openrouter",
      modelName,
      contextWindow: 64000,
      writesTokenFile,
    });
  }

  // REQ-15, REQ-29
  test("TEST-42 switching between trackers sums 10+5+10 once and retains latest request context", () => {
    const path = sandbox().tokenFile;
    try {
      const first = tracker(0, "first-model");
      first.recordToolUse("Read");
      first.updateWithDelta(100, 10);
      const initial = json<TokenFile>(path);

      const second = tracker(0, "second-model");
      second.recordToolUse("Bash");
      second.updateWithDelta(50, 5);
      expect(json<TokenFile>(path).output_tokens).toBe(15);

      first.recordToolUse("Read");
      first.updateWithDelta(120, 10);
      const total = json<TokenFile>(path);
      expect(total.output_tokens).toBe(25);
      expect(total.billed_input_tokens).toBe(170);
      expect(total.total_tokens).toBe(195);
      expect(total.total_cost).toBeCloseTo(first.getTotalCost() + second.getTotalCost(), 12);
      expect(total.started_at).toEqual(initial.started_at);
      expect(total.input_tokens).toBe(120);
      expect(total.model_name).toBe("first-model");
      expect(total.context_window).toBe(64000);
      expect(first.getToolCallCount()).toBe(2);
      expect(second.getToolCallCount()).toBe(1);

      first.rewrite();
      second.rewrite();
      const repeated = json<TokenFile>(path);
      expect(repeated.output_tokens).toBe(25);
      expect(repeated.billed_input_tokens).toBe(170);
      expect(repeated.total_tokens).toBe(195);
      expect(repeated.total_cost).toBeCloseTo(total.total_cost, 12);
    } finally {
      clearTokenFileTotals(path);
    }
  });

  test("TEST-42 positive actual costs sum across trackers without rewrite duplication", () => {
    const path = sandbox().tokenFile;
    try {
      const first = tracker(0, "first");
      const second = tracker(0, "second");
      first.updateWithActualCost(100, 10, 0.25);
      second.updateWithActualCost(50, 5, 0.5);
      first.updateWithActualCost(120, 10, 0.125);
      expect(json<TokenFile>(path).total_cost).toBeCloseTo(0.875, 12);
      expect(json<TokenFile>(path).output_tokens).toBe(25);
      first.rewrite();
      second.rewrite();
      expect(json<TokenFile>(path).total_cost).toBeCloseTo(0.875, 12);
    } finally {
      clearTokenFileTotals(path);
    }
  });

  test("TEST-43 no-write advisor trackers neither create the file nor add to shared totals", () => {
    const path = sandbox().tokenFile;
    try {
      const advisor = tracker(0, "advisor", false);
      advisor.recordToolUse("Read");
      advisor.updateWithDelta(1000, 100);
      advisor.rewrite();
      expect(existsSync(path)).toBe(false);

      const main = tracker(0, "main");
      main.updateWithDelta(3, 7);
      const before = readFileSync(path, "utf8");
      advisor.updateWithDelta(2000, 100);
      advisor.rewrite();
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(json<TokenFile>(path).output_tokens).toBe(7);
      expect(json<TokenFile>(path).billed_input_tokens).toBe(3);
    } finally {
      clearTokenFileTotals(path);
    }
  });

  // REQ-30, §4 M3
  test("TEST-44 clearing the shared file totals makes a fresh tracker write 7 instead of 32", () => {
    const path = sandbox().tokenFile;
    try {
      const first = tracker(0, "first");
      const second = tracker(0, "second");
      first.updateWithDelta(100, 10);
      second.updateWithDelta(50, 5);
      first.updateWithDelta(120, 10);
      expect(json<TokenFile>(path).output_tokens).toBe(25);

      clearTokenFileTotals(path);
      tracker(0, "fresh").updateWithDelta(4, 7);

      expect(json<TokenFile>(path)).toMatchObject({
        output_tokens: 7,
        billed_input_tokens: 4,
        total_tokens: 11,
        model_name: "fresh",
      });
    } finally {
      clearTokenFileTotals(path);
    }
  });

  test("TEST-45 shutting down a proxy clears file totals before a same-process same-port proxy", async () => {
    const path = sandbox().tokenFile;
    let first: ProxyServer | undefined;
    let second: ProxyServer | undefined;
    try {
      first = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
        quiet: true,
        hooks: false,
      });
      const port = first.port;
      tracker(port, "old-proxy").updateWithDelta(100, 25);
      expect(json<TokenFile>(path).output_tokens).toBe(25);
      await first.shutdown();
      first = undefined;

      second = await createProxyServer(port, undefined, undefined, false, undefined, undefined, {
        quiet: true,
        hooks: false,
      });
      tracker(second.port, "new-proxy").updateWithDelta(4, 7);

      expect(second.port).toBe(port);
      expect(json<TokenFile>(path)).toMatchObject({
        output_tokens: 7,
        billed_input_tokens: 4,
        total_tokens: 11,
        model_name: "new-proxy",
      });
    } finally {
      if (second) await second.shutdown();
      if (first) await first.shutdown();
      clearTokenFileTotals(path);
    }
  }, 15_000);
});
