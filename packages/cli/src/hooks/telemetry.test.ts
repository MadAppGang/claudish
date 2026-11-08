import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SessionReport,
  contextBucket,
  contextFillPct,
  pendingReports,
  recordTelemetryDecision,
  recordTelemetryTurn,
  resetTelemetryState,
  setSessionContextWindow,
  setTelemetryConsent,
  spoolPendingSync,
} from "./telemetry/aggregate.js";
import { drainOutbox, resetDrainState } from "./telemetry/upload.js";

const originalFetch = globalThis.fetch;

let tempDir: string;
let outbox: string;
let fetchCalls: number;

beforeEach(() => {
  resetTelemetryState();
  setSessionContextWindow(0);
  resetDrainState();
  tempDir = mkdtempSync(join(tmpdir(), "claudish-behavior-telemetry-"));
  outbox = join(tempDir, "behavior-outbox.jsonl");
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("fetch stub not configured");
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  resetTelemetryState();
  resetDrainState();
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

function recordTurn(sessionId: string, model = "gpt-5.6-codex", inputTokens = 0): void {
  recordTelemetryTurn({
    sessionId,
    model,
    provider: "openai-codex",
    inputTokens,
  });
}

function report(overrides: Partial<SessionReport> = {}): SessionReport {
  return {
    schema_version: 1,
    session_id: "a".repeat(64),
    started_at: "2026-08-05T00:00:00.000Z",
    ended_at: "2026-08-05T00:01:00.000Z",
    claudish_version: "test",
    platform: "darwin",
    model_id: "gpt-5.6-codex",
    provider_name: "openai-codex",
    context_bucket: "0-50k",
    turns: 1,
    decisions: [],
    ...overrides,
  };
}

function writeOutbox(value: SessionReport): void {
  writeFileSync(outbox, `${JSON.stringify(value)}\n`);
}

function stubStatus(status: number): void {
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
}

describe("behavior telemetry aggregation", () => {
  it("collects nothing without telemetry consent", () => {
    setTelemetryConsent(false);

    recordTurn("raw-session");
    recordTelemetryDecision({
      sessionId: "raw-session",
      model: "gpt-5.6-codex",
      provider: "openai-codex",
      surface: "tool_call",
      decision: "repaired",
      ruleId: "plan-mode/plan-file-path",
      toolName: "Write",
    });

    expect(pendingReports()).toEqual([]);
  });

  it("hashes session ids as lowercase hex without retaining the raw id", () => {
    const rawSessionId = "raw-session-id-that-must-never-be-uploaded";
    setTelemetryConsent(true);

    recordTurn(rawSessionId);

    const [pending] = pendingReports();
    expect(pending.session_id).toMatch(/^[0-9a-f]{64}$/);
    expect(pending.session_id).not.toContain(rawSessionId);
    expect(JSON.stringify(pending)).not.toContain(rawSessionId);
  });

  it("uses different session hashes for different models in the same raw session", () => {
    setTelemetryConsent(true);

    recordTurn("shared-raw-session", "gpt-5.6-codex");
    recordTurn("shared-raw-session", "gpt-5.6-sol");

    const pending = pendingReports();
    expect(pending).toHaveLength(2);
    expect(pending.map((item) => item.model_id).sort()).toEqual(["gpt-5.6-codex", "gpt-5.6-sol"]);
    expect(new Set(pending.map((item) => item.session_id)).size).toBe(2);
  });

  it("maps every context bucket boundary to the closed server values", () => {
    const cases = [
      [0, "0-50k"],
      [49_999, "0-50k"],
      [50_000, "50-100k"],
      [99_999, "50-100k"],
      [100_000, "100-150k"],
      [149_999, "100-150k"],
      [150_000, "150-200k"],
      [199_999, "150-200k"],
      [200_000, "200k+"],
      [1_000_000, "200k+"],
    ] as const;

    expect(cases.map(([tokens, expected]) => [contextBucket(tokens), expected])).toEqual(
      cases.map(([, expected]) => [expected, expected])
    );
  });

  it("distinguishes context pressure when absolute-token buckets collide", () => {
    expect(contextFillPct(178_000, 200_000)).toBe(89);
    expect(contextFillPct(178_000, 1_000_000)).toBe(18);
    expect([contextBucket(178_000), contextBucket(178_000)]).toEqual(["150-200k", "150-200k"]);
  });

  it("rounds context fill to the nearest integer percent", () => {
    expect(contextFillPct(149, 200)).toBe(75);
    expect(contextFillPct(151, 200)).toBe(76);
  });

  it("clamps context fill to 0 through 100", () => {
    expect(contextFillPct(250_000, 200_000)).toBe(100);
  });

  it("does not calculate context fill without a window or peak tokens", () => {
    setSessionContextWindow(0);
    expect(contextFillPct(178_000)).toBeUndefined();

    setSessionContextWindow(200_000);
    expect(contextFillPct(0)).toBeUndefined();
  });

  it("emits context fill alongside the unchanged absolute-token bucket", () => {
    setSessionContextWindow(372_000);
    setTelemetryConsent(true);

    recordTurn("fill-session", "gpt-5.6-codex", 178_000);

    const pending = pendingReports()[0];
    expect(pending.context_fill_pct).toBe(48);
    expect(pending.context_bucket).toBe("150-200k");
  });

  it("omits context fill from the payload when the window is unknown", () => {
    setSessionContextWindow(0);
    setTelemetryConsent(true);

    recordTurn("unknown-window-session", "gpt-5.6-codex", 178_000);

    const pending = pendingReports()[0];
    expect("context_fill_pct" in pending).toBe(false);
    expect(pending.context_bucket).toBe("150-200k");
  });

  it("emits the bucket for peak input tokens rather than the final turn", () => {
    setSessionContextWindow(200_000);
    setTelemetryConsent(true);

    recordTurn("peak-session", "gpt-5.6-codex", 40_000);
    recordTurn("peak-session", "gpt-5.6-codex", 178_000);
    recordTurn("peak-session", "gpt-5.6-codex", 12_000);

    const pending = pendingReports()[0];
    expect(pending.context_bucket).toBe("150-200k");
    expect(pending.context_fill_pct).toBe(89);
  });

  it("aggregates decision counts and path relations by rule, surface, and tool", () => {
    setTelemetryConsent(true);
    const common = {
      sessionId: "decision-session",
      model: "gpt-5.6-codex",
      provider: "openai-codex",
      ruleId: "plan-mode/plan-file-path",
    } as const;

    recordTelemetryDecision({
      ...common,
      surface: "tool_call",
      toolName: "Write",
      decision: "repaired",
      pathRelation: "same_dir_wrong_name",
    });
    recordTelemetryDecision({
      ...common,
      surface: "tool_call",
      toolName: "Write",
      decision: "repaired",
      pathRelation: "same_dir_wrong_name",
    });
    recordTelemetryDecision({
      ...common,
      surface: "tool_call",
      toolName: "Write",
      decision: "warned",
      pathRelation: "outside_expected_dir",
    });
    recordTelemetryDecision({
      ...common,
      surface: "tool_call",
      toolName: "Read",
      decision: "matched",
    });
    recordTelemetryDecision({
      ...common,
      surface: "request",
      toolName: "Write",
      decision: "warned",
    });

    const decisions = pendingReports()[0].decisions;
    expect(decisions).toHaveLength(3);
    expect(
      decisions.map(({ rule_id, surface, tool_name }) => [rule_id, surface, tool_name])
    ).toEqual([
      ["plan-mode/plan-file-path", "tool_call", "Write"],
      ["plan-mode/plan-file-path", "tool_call", "Read"],
      ["plan-mode/plan-file-path", "request", "Write"],
    ]);
    expect(decisions[0].counts).toEqual({ repaired: 2, warned: 1 });
    expect(decisions[0].path_relations).toEqual({
      same_dir_wrong_name: 2,
      outside_expected_dir: 1,
    });
  });

  it("spools one JSON line per report, clears pending state, and returns the count", () => {
    setTelemetryConsent(true);
    recordTurn("first-session", "gpt-5.6-codex", 10_000);
    recordTurn("second-session", "gpt-5.6-sol", 60_000);

    expect(spoolPendingSync(outbox)).toBe(2);
    expect(pendingReports()).toEqual([]);

    const lines = readFileSync(outbox, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).model_id).sort()).toEqual([
      "gpt-5.6-codex",
      "gpt-5.6-sol",
    ]);
  });

  it("does not spool when there are zero turns and zero decisions", () => {
    setTelemetryConsent(true);

    expect(spoolPendingSync(outbox)).toBe(0);
    expect(pendingReports()).toEqual([]);
    expect(existsSync(outbox)).toBe(false);
  });
});

describe("behavior telemetry upload", () => {
  it("removes an accepted report from the outbox", async () => {
    writeOutbox(report());
    stubStatus(202);

    expect(await drainOutbox(outbox)).toEqual({ sent: 1, kept: 0 });
    expect(fetchCalls).toBe(1);
    expect(existsSync(outbox)).toBe(false);
  });

  it("drops a malformed report rejected with 400", async () => {
    writeOutbox(report());
    stubStatus(400);

    expect(await drainOutbox(outbox)).toEqual({ sent: 0, kept: 0 });
    expect(fetchCalls).toBe(1);
    expect(existsSync(outbox)).toBe(false);
  });

  for (const status of [429, 503]) {
    it(`keeps a report rejected with ${status} for a later run`, async () => {
      const pending = report();
      writeOutbox(pending);
      stubStatus(status);

      expect(await drainOutbox(outbox)).toEqual({ sent: 0, kept: 1 });
      expect(fetchCalls).toBe(1);
      expect(readFileSync(outbox, "utf8")).toBe(`${JSON.stringify(pending)}\n`);
    });
  }

  it("keeps a report when fetch throws offline", async () => {
    const pending = report();
    writeOutbox(pending);
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;

    expect(await drainOutbox(outbox)).toEqual({ sent: 0, kept: 1 });
    expect(fetchCalls).toBe(1);
    expect(readFileSync(outbox, "utf8")).toBe(`${JSON.stringify(pending)}\n`);
  });

  it("drains only once per process until reset", async () => {
    const pending = report();
    writeOutbox(pending);
    stubStatus(202);

    expect(await drainOutbox(outbox)).toEqual({ sent: 1, kept: 0 });
    expect(fetchCalls).toBe(1);

    writeOutbox(pending);
    expect(await drainOutbox(outbox)).toEqual({ sent: 0, kept: 0 });
    expect(fetchCalls).toBe(1);
    expect(existsSync(outbox)).toBe(true);

    resetDrainState();
    expect(await drainOutbox(outbox)).toEqual({ sent: 1, kept: 0 });
    expect(fetchCalls).toBe(2);
    expect(existsSync(outbox)).toBe(false);
  });

  it("skips malformed and torn lines without blocking a valid report", async () => {
    const valid = report();
    writeFileSync(outbox, `{"torn":\n${JSON.stringify(valid)}\nnot-json\n`);
    stubStatus(202);

    expect(await drainOutbox(outbox)).toEqual({ sent: 1, kept: 0 });
    expect(fetchCalls).toBe(1);
    expect(existsSync(outbox)).toBe(false);
  });
});
