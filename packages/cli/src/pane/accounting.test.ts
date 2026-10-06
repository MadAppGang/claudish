import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeRouteFor } from "../providers/native-route.js";
import { readTokenStatsAt } from "../team-stats.js";
import {
  mergeAccounting,
  parsePinnedSpec,
  readTokenFileCached,
  resolveProvider,
  tokenFileHasData,
} from "./accounting.js";
import { toSlotRow } from "./slot-row.js";
import { FIXTURES } from "./test-helpers/fixtures.js";
import type { PaneSnapshot } from "./types.js";

/** Token files are real proxy outputs (a served foreign session, and the initialised zeros). */
const FOREIGN = join(FIXTURES, "token-files", "foreign-grok.json");
const ZEROS = join(FIXTURES, "token-files", "initialised-zeros.json");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function snap(over: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return {
    paneId: "c1-k0-t01-abcdef",
    phase: "RUNNING",
    state: "RUNNING",
    reason: null,
    detail: null,
    activity: "Bash",
    lastActivityAt: "2026-10-06T01:00:00.000Z",
    idleSeconds: 0,
    turnsCompleted: 0,
    tokensIn: 33324,
    tokensOut: 44,
    toolCalls: 2,
    liveAnswerBytes: 0,
    exitCode: null,
    captureSource: null,
    turnSource: "transcript",
    pendingInputs: 0,
    connected: true,
    startedAt: "2026-10-06T00:59:00.000Z",
    endedAt: null,
    transcriptPath: "/x.jsonl",
    panePid: 1,
    screenTail: "",
    anomalies: [],
    ...over,
  };
}

describe("mergeAccounting", () => {
  test("a served token file is authoritative: billed_input_tokens (never input_tokens), output, cost, Σ tool calls", () => {
    const tf = readTokenStatsAt(FOREIGN)!;
    expect(tf.billed_input_tokens).toBe(221807);
    expect(tf.input_tokens).toBe(39594); // the CURRENT context, not the session's input
    const a = mergeAccounting(snap(), tf);
    expect(a).toEqual({
      tokensIn: 221807,
      tokensOut: 21435,
      costUsd: 0.30754699999999996,
      toolCalls: 59 + 26 + 14 + 10,
      provider: "X-ai",
    });
  });

  test("the initialised zeros carry no data: tokens and tool calls come from the transcript, cost is null", () => {
    const tf = readTokenStatsAt(ZEROS)!;
    expect(tokenFileHasData(tf)).toBe(false);
    expect(mergeAccounting(snap(), tf)).toEqual({
      tokensIn: 33324,
      tokensOut: 44,
      costUsd: null,
      toolCalls: 2,
      provider: null,
    });
  });

  test("no token file (a native route writes none): transcript accounting, cost null", () => {
    expect(mergeAccounting(snap(), null, { model: "haiku", spawnModel: null })).toEqual({
      tokensIn: 33324,
      tokensOut: 44,
      costUsd: null,
      toolCalls: 2,
      provider: "Anthropic (Native)",
    });
  });
});

describe("resolveProvider (M11)", () => {
  test("the token file's provider_name wins (served-by)", () => {
    expect(
      resolveProvider({
        model: "grok-4.7",
        spawnModel: "xai@grok-4.7",
        tokenFile: readTokenStatsAt(FOREIGN),
      })
    ).toBe("X-ai");
  });

  test("a native name resolves through nativeRouteFor before any route lookup", () => {
    for (const m of ["haiku", "claude-opus-5", "opus"]) {
      expect(nativeRouteFor(m)).not.toBeNull();
      expect(resolveProvider({ model: m, spawnModel: null, tokenFile: null })).toBe(
        "Anthropic (Native)"
      );
    }
  });

  test("a native model never yields a token file with a different provider", () => {
    expect(
      resolveProvider({ model: "haiku", spawnModel: null, tokenFile: readTokenStatsAt(ZEROS) })
    ).toBe("Anthropic (Native)");
  });

  test("a pinned single-hop spec names its provider; a chain or a bare name is not known yet", () => {
    expect(
      resolveProvider({ model: "grok-4.7", spawnModel: "xai@grok-4.7", tokenFile: null })
    ).toBe("xAI");
    expect(
      resolveProvider({ model: "glm-5", spawnModel: "zgo@glm-5+or@z-ai/glm-5", tokenFile: null })
    ).toBeNull();
    expect(resolveProvider({ model: "kimi-k3", spawnModel: null, tokenFile: null })).toBeNull();
  });

  test("parsePinnedSpec", () => {
    expect(parsePinnedSpec("or@qwen/qwen3.8-max")).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3.8-max",
    });
    expect(parsePinnedSpec("a@x+b@y")).toBeNull();
    expect(parsePinnedSpec("bare-name")).toBeNull();
    expect(parsePinnedSpec(null)).toBeNull();
  });
});

describe("readTokenFileCached", () => {
  test("re-reads only when mtime or size changes; a missing file is null", () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-acct-"));
    dirs.push(dir);
    const p = join(dir, "tokens.json");
    expect(readTokenFileCached(p)).toBeNull();
    copyFileSync(ZEROS, p);
    const fixed = new Date("2026-10-06T00:00:00Z");
    utimesSync(p, fixed, fixed);
    expect(readTokenFileCached(p)?.total_tokens).toBe(0);
    copyFileSync(FOREIGN, p);
    utimesSync(p, fixed, fixed);
    // same mtime, different size → re-read
    expect(readTokenFileCached(p)?.provider_name).toBe("X-ai");
    writeFileSync(p, "{partial");
    expect(readTokenFileCached(p)).toBeNull();
  });
});

describe("toSlotRow (§8 B)", () => {
  test("a running row: idle seconds from last activity, activity kept, reason null", () => {
    const now = Date.parse("2026-10-06T01:00:07.900Z");
    const row = toSlotRow(
      { slot: "01", model: "haiku", spawnModel: null },
      snap(),
      mergeAccounting(snap(), null, { model: "haiku", spawnModel: null }),
      now
    );
    expect(row).toEqual({
      slot: "01",
      model: "haiku",
      provider: "Anthropic (Native)",
      state: "RUNNING",
      reason: null,
      tokens_in: 33324,
      tokens_out: 44,
      cost_usd: null,
      tool_calls: 2,
      turns_completed: 0,
      last_activity_at: "2026-10-06T01:00:00.000Z",
      idle_seconds: 7,
      activity: "Bash",
      pane: "c1-k0-t01-abcdef",
    });
    expect(Object.keys(row).sort()).toEqual(
      [
        "activity",
        "cost_usd",
        "idle_seconds",
        "last_activity_at",
        "model",
        "pane",
        "provider",
        "reason",
        "slot",
        "state",
        "tokens_in",
        "tokens_out",
        "tool_calls",
        "turns_completed",
      ].sort()
    );
  });

  test("terminal rows: idle_seconds and activity null; COMPLETED has no reason; FAILED keeps it", () => {
    const acct = mergeAccounting(snap(), readTokenStatsAt(FOREIGN));
    const done = toSlotRow(
      { slot: "02", model: "grok-4.7", spawnModel: "xai@grok-4.7" },
      snap({ state: "COMPLETED", phase: "COMPLETED", reason: null, activity: "x" }),
      acct
    );
    expect([done.idle_seconds, done.activity, done.reason]).toEqual([null, null, null]);
    const failed = toSlotRow(
      { slot: "03", model: "m", spawnModel: null },
      snap({ state: "FAILED", phase: "FAILED", reason: "api_error" }),
      acct
    );
    expect(failed.reason).toBe("api_error");
    expect(failed.idle_seconds).toBeNull();
  });

  test("a pane that never spawned has pane null", () => {
    const row = toSlotRow(
      { slot: "04", model: "m", spawnModel: null },
      snap({ paneId: "", state: "FAILED", phase: "FAILED", reason: "pane_lost" }),
      mergeAccounting(snap(), null)
    );
    expect(row.pane).toBeNull();
  });
});
