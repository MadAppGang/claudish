/**
 * Unit and process-level regression tests for the channel's interactive pane transport
 * (architecture §7, §12.4).
 *
 * Process-level tests drive `SessionManager` directly: every session is the fake
 * interactive child (`CLAUDISH_BIN`, pane/test-helpers/fake-interactive-child.ts) inside a
 * real headless magmux, built from a hermetic environment passed as `parentEnv` — this
 * file never mutates `process.env`, never resolves the installed claudish and never
 * touches ~/.claudish/sessions. After each such test every pane is gone (no process,
 * socket, record or launcher dir under the test's sockRoot).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mapEventToTaskStatus } from "../mcp-server.js";
import { ContractErrorException, type SlotState, checkChildFlags } from "../pane/index.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import { transcriptRecords } from "../pane/test-helpers/transcript-fixtures.js";
import { projectsDir, transcriptPathFor } from "../session/session-discovery.js";
import {
  SessionManager,
  channelEventFor,
  normaliseTimeoutSeconds,
  sessionRowOf,
  toMetaRecord,
} from "./session-manager.js";
import type { ChannelEvent, SessionInfo, SessionManagerOptions } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGNAL_CHILD_TS = join(__dirname, "test-helpers", "stats-buffer-signal-child.ts");
const TERMINAL_EVENTS = ["completed", "failed", "cancelled", "timeout"];
const T_PANE = 30_000;

function waitUntil(predicate: () => boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

/** A SessionInfo with every field set, for the pure record and row tests. */
function sampleInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "abcd1234",
    model: "glm-5",
    spawnModel: "gc@glm-5",
    provider: "GLM Coding",
    state: "EMPTY",
    shape: "one-shot",
    pane: "c1-x-sabcd1234-aaaaaa",
    panePid: 4242,
    startedAt: "2026-10-06T00:00:00.000Z",
    completedAt: "2026-10-06T00:00:10.000Z",
    exitCode: null,
    turnsCompleted: 1,
    tokensIn: 1000,
    tokensOut: 50,
    costUsd: 0.01,
    toolCalls: 3,
    lastActivityAt: "2026-10-06T00:00:09.000Z",
    elapsedSeconds: 10,
    idleSeconds: null,
    activity: null,
    reason: "shape_mismatch",
    detail: "no match",
    pendingInputs: 0,
    claudeSessionId: "11111111-2222-3333-4444-555555555555",
    transcriptPath: "/nonexistent/projects/x/11111111-2222-3333-4444-555555555555.jsonl",
    captureSource: "transcript",
    turnSource: "transcript",
    timeoutSeconds: 600,
    ...over,
  };
}

// ─── pure ────────────────────────────────────────────────────────────────────

describe("exported channel seams (pure)", () => {
  test("timeout projects to SEP-1686 failed instead of falling through to working", () => {
    expect(mapEventToTaskStatus("timeout")).toBe("failed");
    expect(mapEventToTaskStatus("timeout")).not.toBe("working");
    expect(mapEventToTaskStatus("genuinely_unknown_event")).toBe("working");
    for (const [event, status] of [
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      ["awaiting_permission", "input_required"],
    ] as const) {
      expect(mapEventToTaskStatus(event)).toBe(status);
    }
  });

  test("channelEventFor maps every SlotState (§3.4)", () => {
    const cases: Array<[SlotState, string | null, string, string | null]> = [
      ["STARTING", null, "starting", null],
      ["RUNNING", "thinking", "running", null],
      ["RUNNING", "finishing", "running", null],
      ["RUNNING", "background", "running", null],
      ["RUNNING", null, "running", null],
      ["RUNNING", "Bash", "tool_executing", "Bash"],
      ["AWAITING_INPUT", null, "waiting_for_input", null],
      ["AWAITING_INPUT", "AskUserQuestion", "waiting_for_input", null],
      ["AWAITING_PERMISSION", "Edit", "awaiting_permission", null],
      ["COMPLETED", null, "completed", null],
      ["FAILED", null, "failed", null],
      ["EMPTY", null, "failed", null],
      ["CANCELLED", null, "cancelled", null],
      ["TIMEOUT", null, "timeout", null],
    ];
    for (const [state, activity, event, tool] of cases) {
      expect(channelEventFor({ state, activity }), `${state}/${activity}`).toEqual({
        event: event as ReturnType<typeof channelEventFor>["event"],
        tool,
      });
    }
  });

  test("normaliseTimeoutSeconds clamps to an integer in 1..3600", () => {
    expect(normaliseTimeoutSeconds(90.5)).toBe(91);
    expect(normaliseTimeoutSeconds(0)).toBe(1);
    expect(normaliseTimeoutSeconds(7200)).toBe(3600);
    expect(normaliseTimeoutSeconds(undefined)).toBe(600);
  });

  test("toMetaRecord keeps every 10.4.0 key under its 10.4.0 name, plus the pane keys", () => {
    const meta = toMetaRecord(sampleInfo({ parentClaudeSessionId: "parent-1" }), "/work");
    for (const key of [
      "sessionId",
      "model",
      "spawnModel",
      "status",
      "pid",
      "startedAt",
      "completedAt",
      "exitCode",
      "turnsCompleted",
      "tokensUsed",
      "elapsedSeconds",
      "idleSeconds",
      "costUsd",
      "toolCallCount",
      "terminalReason",
      "claudeSessionId",
      "parentClaudeSessionId",
      "transcriptPath",
    ])
      expect(meta, key).toHaveProperty(key);
    // EMPTY is a failure to the monitor; the SlotState rides beside it.
    expect(meta.status).toBe("failed");
    expect(meta.state).toBe("EMPTY");
    expect(meta.terminalReason).toBe("shape_mismatch");
    expect(meta.toolCallCount).toBe(3);
    expect(meta.tokensUsed).toBe(1050);
    expect(meta.pid).toBe(4242);
    expect(meta.cwd).toBe("/work");
    // one name per fact
    for (const dup of ["toolCalls", "reason", "panePid"]) expect(meta).not.toHaveProperty(dup);
    // not proven → absent, never an empty value
    expect(toMetaRecord(sampleInfo(), "/w")).not.toHaveProperty("parentClaudeSessionId");
    for (const [state, status] of [
      ["COMPLETED", "completed"],
      ["FAILED", "failed"],
      ["CANCELLED", "cancelled"],
      ["TIMEOUT", "timeout"],
    ] as const)
      expect(toMetaRecord(sampleInfo({ state }), "/w").status).toBe(status);
  });

  test("sessionRowOf yields exactly the SessionRow keys; terminal rows drop idle and activity", () => {
    const row = sessionRowOf(sampleInfo({ idleSeconds: 5, activity: "Bash" }));
    expect(Object.keys(row).sort()).toEqual(
      [
        "slot",
        "model",
        "provider",
        "state",
        "reason",
        "tokens_in",
        "tokens_out",
        "cost_usd",
        "tool_calls",
        "turns_completed",
        "last_activity_at",
        "idle_seconds",
        "activity",
        "pane",
        "session_id",
        "started_at",
        "completed_at",
        "elapsed_seconds",
      ].sort()
    );
    expect(row.slot).toBe(row.session_id);
    expect(row.idle_seconds).toBeNull();
    expect(row.activity).toBeNull();
    expect(row.reason).toBe("shape_mismatch");
    const live = sessionRowOf(
      sampleInfo({ state: "RUNNING", reason: null, idleSeconds: 5, activity: "Bash" })
    );
    expect(live.idle_seconds).toBe(5);
    expect(live.activity).toBe("Bash");
    expect(sessionRowOf(sampleInfo({ state: "COMPLETED", reason: null })).reason).toBeNull();
  });

  test("G4: transport-owned, print-only and positional flags are refused before anything starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudish-g4-"));
    try {
      const manager = new SessionManager({ sessionsDir: join(root, "s"), hostPid: 1 });
      for (const flags of [
        ["-p"],
        ["--print"],
        ["--output-format", "json"],
        ["--output-format=json"],
        ["--input-format", "stream-json"],
        ["--session-id", "x"],
        ["--stdin"],
        ["--max-turns", "3"],
        ["--max-budget-usd", "1"],
        ["--allowedTools", "Read", "Bash"],
      ]) {
        await expect(
          manager.createSession({ model: "m", claudishFlags: flags }),
          JSON.stringify(flags)
        ).rejects.toThrow(/^invalid_args: /);
      }
      // a refused session leaves no record
      expect(existsSync(join(root, "s"))).toBe(false);
      expect(checkChildFlags(["--effort", "high", "--agent", "dev:reviewer"]).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── disk reader (pure) ────────────────────────────────────────────────────

describe("SessionManager disk reader", () => {
  let root: string;
  let sessionsDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudish-disk-reader-"));
    sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    manager = new SessionManager({
      sessionsDir,
      hostPid: 1,
      parentEnv: { HOME: join(root, "home"), CLAUDE_CONFIG_DIR: join(root, "home", ".claude") },
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("unknown ids: the readers throw not found, the mutators answer unknown_session", () => {
    expect(() => manager.getSession("nonexistent")).toThrow("not found");
    expect(() => manager.getOutput("bad-id")).toThrow("not found");
    expect(manager.sendInput("does-not-exist", "hello")).toEqual({
      success: false,
      reason: "unknown_session",
      state: null,
    });
    const err = captureError(() => manager.cancelSession("ghost-session"));
    expect(err).toBeInstanceOf(ContractErrorException);
    expect((err as ContractErrorException).code).toBe("unknown_session");
    const cap = captureError(() => manager.captureSession("ghost-session"));
    expect((cap as ContractErrorException).code).toBe("unknown_session");
  });

  test("a 10.4.0-generation meta.json (status, no state) reads into the closed set", () => {
    const write = (id: string, meta: Record<string, unknown>) => {
      mkdirSync(join(sessionsDir, id), { recursive: true });
      writeFileSync(join(sessionsDir, id, "meta.json"), JSON.stringify(meta));
    };
    const base = {
      model: "m",
      startedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T00:01:00.000Z",
      turnsCompleted: 2,
      toolCallCount: 3,
      costUsd: 0.5,
      tokensUsed: 100,
      exitCode: 143,
      terminalReason: "user_cancelled",
    };
    write("old-cancelled", { ...base, sessionId: "old-cancelled", status: "cancelled" });
    write("old-completed", { ...base, sessionId: "old-completed", status: "completed" });
    write("old-timeout", { ...base, sessionId: "old-timeout", status: "timeout" });
    write("old-finishing", { ...base, sessionId: "old-finishing", status: "finishing" });

    const cancelled = manager.getSession("old-cancelled");
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.reason).toBe("cancelled");
    expect(cancelled.toolCalls).toBe(3);
    expect(cancelled.costUsd).toBe(0.5);
    expect(cancelled.turnsCompleted).toBe(2);
    expect(cancelled.exitCode).toBe(143);
    expect(cancelled.elapsedSeconds).toBe(60);
    expect(cancelled.panePid).toBeNull();
    expect(manager.getSession("old-completed")).toMatchObject({ state: "COMPLETED", reason: null });
    expect(manager.getSession("old-timeout")).toMatchObject({
      state: "TIMEOUT",
      reason: "timeout",
    });
    // a non-terminal pre-contract value is FAILED with reason null (§8 B)
    expect(manager.getSession("old-finishing")).toMatchObject({ state: "FAILED", reason: null });
    expect(manager.getDiagnostics("old-cancelled")).toMatchObject({
      state: "CANCELLED",
      event: "cancelled",
      phase: null,
      connected: false,
    });
  });

  test("a pane-generation meta.json round-trips through toMetaRecord; a stale transcript path is re-derived", () => {
    const cwd = join(root, "work dir_1");
    mkdirSync(cwd, { recursive: true });
    const info = sampleInfo({
      sessionId: "pane-gen",
      shape: "interactive",
      parentClaudeSessionId: "parent-9",
    });
    mkdirSync(join(sessionsDir, "pane-gen"), { recursive: true });
    writeFileSync(
      join(sessionsDir, "pane-gen", "meta.json"),
      JSON.stringify(toMetaRecord(info, cwd))
    );
    writeFileSync(join(sessionsDir, "pane-gen", "screen.txt"), "❯ final screen\n");

    const read = manager.getSession("pane-gen");
    expect(read).toMatchObject({
      sessionId: "pane-gen",
      model: "glm-5",
      spawnModel: "gc@glm-5",
      provider: "GLM Coding",
      state: "EMPTY",
      reason: "shape_mismatch",
      detail: "no match",
      shape: "interactive",
      pane: info.pane,
      panePid: null,
      tokensIn: 1000,
      tokensOut: 50,
      costUsd: 0.01,
      toolCalls: 3,
      turnsCompleted: 1,
      timeoutSeconds: 600,
      parentClaudeSessionId: "parent-9",
      idleSeconds: null,
    });
    expect(read.transcriptPath).toBe(
      transcriptPathFor(
        cwd,
        info.claudeSessionId,
        projectsDir({ HOME: join(root, "home"), CLAUDE_CONFIG_DIR: join(root, "home", ".claude") })
      )
    );
    expect(manager.getDiagnostics("pane-gen").screenTail).toBe("❯ final screen");
  });

  test("D3: hostile session ids are rejected before disk lookup", () => {
    const outside = join(root, "outside");
    mkdirSync(join(outside, "victim"), { recursive: true });
    writeFileSync(join(outside, "victim", "meta.json"), JSON.stringify({ model: "LEAKED" }));
    for (const id of [
      "../outside/victim",
      "..%2Foutside",
      "../../etc",
      "..",
      ".",
      "/etc/passwd",
      "a/b",
      "a\\b",
      "with\0null",
      "",
      ".hidden",
      "x".repeat(200),
    ]) {
      expect(() => manager.getSession(id), JSON.stringify(id)).toThrow("not found");
    }
  });

  test("D4: malformed disk records degrade to diagnostics instead of throwing", () => {
    const cases: Array<[string, string | null]> = [
      ["nometa", null],
      ["halfwritten", '{"sessionId":"halfwr'],
      ["emptymeta", ""],
      [
        "wrongtypes",
        JSON.stringify({
          sessionId: 42,
          model: null,
          status: "banana",
          state: "BANANA",
          tokensUsed: "lots",
          pid: 1,
          startedAt: [],
          elapsedSeconds: Number.NaN,
        }),
      ],
      ["notjson", "[1,2,3]"],
    ];
    for (const [id, meta] of cases) {
      const dir = join(sessionsDir, id);
      mkdirSync(dir, { recursive: true });
      if (meta !== null) writeFileSync(join(dir, "meta.json"), meta);
      if (id === "halfwritten") writeFileSync(join(dir, "output.log"), "partial answer\n");

      const info = manager.getSession(id);
      const output = manager.getOutput(id);
      const diagnostics = manager.getDiagnostics(id);
      expect(info.sessionId).toBe(id);
      expect(info.panePid).toBeNull();
      expect(info.state).toBe("FAILED");
      expect(typeof info.toolCalls).toBe("number");
      expect(Number.isFinite(info.elapsedSeconds)).toBe(true);
      expect(typeof output.output).toBe("string");
      expect(typeof diagnostics.screenTail).toBe("string");
      if (id !== "wrongtypes") {
        expect(diagnostics.anomalies.length, id).toBeGreaterThan(0);
      }
    }
    expect(manager.getOutput("halfwritten").output).toContain("partial answer");
  });

  test("D5: disk diagnostics stay bounded for a 4 MB event log", () => {
    const id = "bigsession";
    const dir = join(sessionsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        sessionId: id,
        model: "m",
        status: "failed",
        startedAt: new Date().toISOString(),
      })
    );
    const frames: string[] = [];
    let eventBytes = 0;
    for (let i = 0; eventBytes < 4 * 1024 * 1024; i++) {
      const frame = `${JSON.stringify({ type: "state", i, pad: "x".repeat(2000) })}\n`;
      frames.push(frame);
      eventBytes += Buffer.byteLength(frame);
    }
    writeFileSync(join(dir, "events.jsonl"), frames.join(""));

    const diagnostics = manager.getDiagnostics(id, 200);
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThan(512 * 1024);
    expect(diagnostics.eventsTotal).toBeLessThan(512);
    expect(diagnostics.recentEvents).toHaveLength(200);
    expect(diagnostics.recentEvents.every((event) => event.preview.length <= 800)).toBe(true);
  });
});

// ─── panes ────────────────────────────────────────────────────────────────

describe.skipIf(!MAGMUX)(
  `SessionManager on panes (${MAGMUX ? "magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    let t: PaneTestEnv;
    let sessionsDir: string;
    let managers: SessionManager[];

    beforeEach(() => {
      t = makePaneTestEnv();
      sessionsDir = join(t.tmp, "sessions");
      managers = [];
    });

    afterEach(async () => {
      for (const m of managers) await m.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot }, 10_000);
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    });

    function makeManager(opts: SessionManagerOptions = {}): SessionManager {
      const manager = new SessionManager({
        maxSessions: 20,
        sessionsDir,
        hostPid: 1,
        parentEnv: t.env,
        paneTimings: { replStableMs: 200 },
        ...opts,
      });
      managers.push(manager);
      return manager;
    }

    function create(
      manager: SessionManager,
      opts: { model?: string; prompt?: string; timeoutSeconds?: number; spawnModel?: string } = {}
    ): Promise<string> {
      return manager.createSession({ model: "fake-answer", cwd: t.cwd, ...opts });
    }

    async function waitForState(
      manager: SessionManager,
      id: string,
      states: readonly SlotState[],
      timeoutMs = 15_000
    ): Promise<void> {
      await waitUntil(() => states.includes(manager.getSession(id).state), timeoutMs);
    }

    const waitForMeta = (id: string, timeoutMs = 15_000) =>
      waitUntil(() => existsSync(join(sessionsDir, id, "meta.json")), timeoutMs).then(() =>
        JSON.parse(readFileSync(join(sessionsDir, id, "meta.json"), "utf-8"))
      );

    test(
      "createSession returns unique ids; a promptless session is STARTING, then AWAITING_INPUT once booted",
      async () => {
        const manager = makeManager();
        const id1 = await create(manager);
        const id2 = await create(manager);
        expect(id1).not.toBe(id2);
        const info = manager.getSession(id1);
        expect(info.sessionId).toBe(id1);
        expect(info.model).toBe("fake-answer");
        expect(info.shape).toBe("interactive");
        expect(typeof info.startedAt).toBe("string");
        expect(info.completedAt).toBeNull();
        expect(info.exitCode).toBeNull();
        expect(info.pane).not.toBeNull();
        expect(["STARTING", "AWAITING_INPUT"]).toContain(info.state);
        await waitForState(manager, id1, ["AWAITING_INPUT"]);
        expect(manager.getSession(id1).panePid).not.toBeNull();
        expect(manager.listSessions(false).map((s) => s.sessionId)).toEqual(
          expect.arrayContaining([id1, id2])
        );
      },
      T_PANE
    );

    test(
      "spawnModel changes argv while SessionInfo keeps the requested model; the argv is interactive",
      async () => {
        const probe = join(t.tmp, "probe-{session}.json");
        const manager = makeManager({ parentEnv: { ...t.env, FAKE_PROBE_FILE: probe } });
        const pinned = await create(manager, { model: "glm-5", spawnModel: "fake-env_probe" });
        const bare = await create(manager, { model: "fake-env_probe" });
        const argvOf = (id: string) => {
          const path = probe.replace("{session}", manager.getSession(id).claudeSessionId);
          return waitUntil(() => existsSync(path)).then(
            () => (JSON.parse(readFileSync(path, "utf-8")) as { argv: string[] }).argv
          );
        };
        const a = await argvOf(pinned);
        expect(a[a.indexOf("--model") + 1]).toBe("fake-env_probe");
        expect(a[0]).toBe("-i");
        for (const banned of ["-p", "--print", "--stdin", "--output-format", "--input-format"])
          expect(a).not.toContain(banned);
        expect(manager.getSession(pinned).model).toBe("glm-5");
        expect(manager.getSession(pinned).spawnModel).toBe("fake-env_probe");
        const b = await argvOf(bare);
        expect(b[b.indexOf("--model") + 1]).toBe("fake-env_probe");
        expect(manager.getSession(bare).spawnModel).toBeNull();
      },
      T_PANE
    );

    test(
      "listSessions excludes a completed session unless includeCompleted; meta.json is written at completion",
      async () => {
        const manager = makeManager();
        const id = await create(manager, { prompt: "hello" });
        await waitForState(manager, id, ["COMPLETED"]);
        expect(manager.listSessions(false).some((s) => s.sessionId === id)).toBe(false);
        expect(manager.listSessions(true).some((s) => s.sessionId === id)).toBe(true);
        const meta = await waitForMeta(id);
        expect(meta.sessionId).toBe(id);
        expect(meta.model).toBe("fake-answer");
        expect(meta.status).toBe("completed");
        expect(meta.state).toBe("COMPLETED");
        expect(meta.turnsCompleted).toBe(1);
        expect(meta.terminalReason).toBeNull();
        expect(typeof meta.startedAt).toBe("string");
        expect(typeof meta.completedAt).toBe("string");
      },
      T_PANE
    );

    test(
      "maxSessions limit: the 3rd session throws when the limit is 2",
      async () => {
        const limited = makeManager({ maxSessions: 2 });
        await create(limited);
        await create(limited);
        await expect(create(limited)).rejects.toThrow(/Max sessions/);
      },
      T_PANE
    );

    test(
      "cancelSession: CANCELLED at once, idempotent, and listed with includeCompleted",
      async () => {
        const manager = makeManager();
        const id = await create(manager);
        await waitUntil(() => manager.getSession(id).panePid !== null);
        expect(manager.cancelSession(id)).toEqual({
          session_id: id,
          state: "CANCELLED",
          changed: true,
        });
        expect(manager.getSession(id).state).toBe("CANCELLED");
        expect(manager.cancelSession(id)).toEqual({
          session_id: id,
          state: "CANCELLED",
          changed: false,
        });
        const found = manager.listSessions(true).find((s) => s.sessionId === id);
        expect(found?.state).toBe("CANCELLED");
        expect(found?.reason).toBe("cancelled");
      },
      T_PANE
    );

    test(
      "a finished one-shot session refuses send_input and cancel changes nothing",
      async () => {
        const manager = makeManager();
        const id = await create(manager, { prompt: "hello" });
        await waitForState(manager, id, ["COMPLETED"]);
        expect(manager.sendInput(id, "some input")).toEqual({
          success: false,
          reason: "terminal",
          state: "COMPLETED",
        });
        expect(manager.cancelSession(id).changed).toBe(false);
      },
      T_PANE
    );

    test(
      "send_input whose own step settles the one-shot turn: the session goes interactive and the text is turn 2",
      async () => {
        const manager = makeManager();
        const id = await create(manager, { model: "fake-td_withheld", prompt: "first" });
        // the answer is in, its turn_duration is not: the turn waits ("finishing")
        await waitUntil(() => manager.getSession(id).activity === "finishing", 15_000);
        await Bun.sleep(800); // past the 500 ms corroboration window of that answer
        // Claude Code writes the end-of-turn record; the send arrives before any poll of ours
        const td = transcriptRecords("tools-session")[29] as Record<string, unknown>;
        expect(td.subtype).toBe("turn_duration");
        appendFileSync(manager.getSession(id).transcriptPath, `${JSON.stringify(td)}\n`);
        expect(manager.sendInput(id, "second")).toEqual({ success: true, queued: 0 });
        await waitUntil(
          () =>
            manager.getSession(id).turnsCompleted === 2 &&
            manager.getSession(id).state === "AWAITING_INPUT",
          15_000
        );
        const info = manager.getSession(id);
        expect(info.shape).toBe("interactive");
        expect(manager.getOutput(id).output).toContain(
          `ANSWER fake-td_withheld ${createHash("sha1").update("second").digest("hex").slice(0, 8)}`
        );
      },
      T_PANE
    );

    test(
      "getOutput returns the answer prose, never raw records; tail_lines returns the last N",
      async () => {
        const manager = makeManager();
        const one = await create(manager, { prompt: "hello world" });
        await waitForState(manager, one, ["COMPLETED"]);
        const output = manager.getOutput(one);
        expect(output.sessionId).toBe(one);
        expect(output.state).toBe("COMPLETED");
        expect(output.output).toMatch(/^ANSWER fake-answer [0-9a-f]{8}/);
        expect(output.output).not.toContain('"type":"assistant"');

        const id = await create(manager);
        for (const [i, text] of ["first", "second", "third"].entries()) {
          await waitForState(manager, id, ["AWAITING_INPUT"]);
          expect(manager.sendInput(id, text).success).toBe(true);
          await waitUntil(
            () =>
              manager.getSession(id).turnsCompleted === i + 1 &&
              manager.getSession(id).state === "AWAITING_INPUT",
            15_000
          );
        }
        const full = manager.getOutput(id);
        const tail = manager.getOutput(id, 2);
        const fullLines = full.output.split("\n");
        expect(full.output.match(/ANSWER fake-answer/g)).toHaveLength(3);
        expect(tail.output).toBe(fullLines.slice(-2).join("\n"));
        expect(tail.totalLines).toBe(full.totalLines);
        expect(tail.output).not.toBe(full.output);
        expect(full.totalLines).toBeGreaterThanOrEqual(3);
      },
      T_PANE
    );

    test(
      "10.4.0 edit: a one-shot session's frames are exactly running → completed",
      async () => {
        const events: Array<{ sessionId: string; event: ChannelEvent }> = [];
        const manager = makeManager({
          onStateChange: (sessionId, event) => events.push({ sessionId, event }),
        });
        const id = await create(manager, { prompt: "trigger events" });
        await waitForState(manager, id, ["COMPLETED"]);
        expect(events.map(({ event }) => event.type)).toEqual(["running", "completed"]);
        for (const observed of events) {
          expect(observed.sessionId).toBe(id);
          expect(observed.event.model).toBe("fake-answer");
        }
      },
      T_PANE
    );

    test(
      "10.4.0 edit: a promptless session's first frame is waiting_for_input, after boot",
      async () => {
        const events: string[] = [];
        const manager = makeManager({ onStateChange: (_sid, e) => events.push(e.type) });
        const id = await create(manager);
        expect(events).not.toContain("waiting_for_input");
        await waitForState(manager, id, ["AWAITING_INPUT"]);
        await waitUntil(() => events.length > 0);
        expect(events[0]).toBe("waiting_for_input");
        expect(events).not.toContain("starting");
      },
      T_PANE
    );

    test(
      "G1/G2: a timeout stays TIMEOUT in memory, meta and on the wire, with a send queued while RUNNING",
      async () => {
        const events: ChannelEvent[] = [];
        const manager = makeManager({ onStateChange: (_sid, event) => events.push(event) });
        const id = await create(manager, {
          model: "contract-fake-model",
          prompt: "work forever @@HANG@@",
          timeoutSeconds: 6,
        });
        await waitForState(manager, id, ["RUNNING"]);
        const queued = manager.sendInput(id, "later");
        expect(queued.success).toBe(true);
        expect(queued.success && queued.queued).toBeGreaterThanOrEqual(1);
        expect(manager.getSession(id).state).toBe("RUNNING");

        await waitForState(manager, id, ["TIMEOUT"], 15_000);
        const meta = await waitForMeta(id);
        const info = manager.getSession(id);
        const terminalWireEvents = events
          .map((e) => e.type)
          .filter((x) => TERMINAL_EVENTS.includes(x));

        expect(info.state).toBe("TIMEOUT");
        expect(info.reason).toBe("timeout");
        expect(meta.status).toBe("timeout");
        expect(meta.state).toBe("TIMEOUT");
        expect(meta.terminalReason).toBe("timeout");
        // RB4: claudish ended the pane, so there is no child exit code.
        expect(info.exitCode).toBeNull();
        expect(meta.exitCode).toBeNull();
        expect(terminalWireEvents).toEqual(["timeout"]);
      },
      T_PANE
    );

    test(
      "G7: a promptless session takes a send while STARTING (queued) and answers it",
      async () => {
        const manager = makeManager();
        const id = await create(manager, { timeoutSeconds: 30 });
        expect(manager.getSession(id).state).toBe("STARTING");
        const r = manager.sendInput(id, "first interactive turn");
        expect(r).toEqual({ success: true, queued: 1 });
        await waitUntil(
          () =>
            manager.getSession(id).state === "AWAITING_INPUT" &&
            manager.getOutput(id).output.includes("ANSWER fake-answer"),
          15_000
        );
        expect(existsSync(join(sessionsDir, id, "prompt.md"))).toBe(false);
        expect(manager.getSession(id).turnsCompleted).toBe(1);
        expect(manager.cancelSession(id).changed).toBe(true);
      },
      T_PANE
    );

    test(
      "D1/D2: a new manager recovers a finished session from disk, read-only",
      async () => {
        const manager = makeManager();
        const id = await create(manager, { prompt: "DELTA" });
        await waitForState(manager, id, ["COMPLETED"]);
        await waitForMeta(id);

        const liveInfo = manager.getSession(id);
        const liveOutput = manager.getOutput(id);
        const recovered = makeManager();

        const info = recovered.getSession(id);
        const output = recovered.getOutput(id);
        const diagnostics = recovered.getDiagnostics(id);
        expect(info).toMatchObject({
          sessionId: id,
          model: liveInfo.model,
          state: "COMPLETED",
          turnsCompleted: liveInfo.turnsCompleted,
          exitCode: liveInfo.exitCode,
          tokensIn: liveInfo.tokensIn,
          tokensOut: liveInfo.tokensOut,
          claudeSessionId: liveInfo.claudeSessionId,
          transcriptPath: liveInfo.transcriptPath,
        });
        expect(output).toMatchObject({ sessionId: id, state: "COMPLETED", turnsCompleted: 1 });
        expect(output.output.trimEnd()).toBe(liveOutput.output.trimEnd());
        expect(diagnostics).toMatchObject({
          sessionId: id,
          state: "COMPLETED",
          event: "completed",
        });
        expect(diagnostics.outputBytes).toBeGreaterThan(0);
        expect(diagnostics.eventsTotal).toBeGreaterThan(0);
        // every record claudish writes carries its own `at`
        expect(diagnostics.recentEvents.every((e) => /^\d{4}-\d\d-\d\dT/.test(e.at))).toBe(true);
        expect(diagnostics.screenTail.length).toBeGreaterThan(0);

        // D2: structurally read-only
        expect(info.panePid).toBeNull();
        expect(recovered.sendInput(id, "hello")).toMatchObject({
          success: false,
          reason: "unknown_session",
        });
        expect(
          (captureError(() => recovered.cancelSession(id)) as ContractErrorException).code
        ).toBe("unknown_session");
      },
      T_PANE
    );
  }
);

// ─── signal exit codes ───────────────────────────────────────────────────

interface ExitObservation {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

async function runSignalChild(signal: "SIGTERM" | "SIGINT"): Promise<ExitObservation> {
  const child = spawn(process.execPath, ["run", SIGNAL_CHILD_TS], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  try {
    await waitUntil(() => stdout.includes("ready"), 3000);
    const exit = new Promise<ExitObservation>((resolve) => {
      child.once("exit", (code, observedSignal) => {
        resolve({ code, signal: observedSignal as NodeJS.Signals | null, stderr });
      });
    });
    child.kill(signal);
    return await Promise.race([
      exit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`signal child did not exit after ${signal}`)), 3000)
      ),
    ]);
  } finally {
    stopChild(child);
  }
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
}

describe("claudish signal exit codes", () => {
  test("G3: module-load signal handlers preserve SIGTERM=143 and SIGINT=130", async () => {
    const term = await runSignalChild("SIGTERM");
    const interrupt = await runSignalChild("SIGINT");

    expect({ code: term.code, signal: term.signal, stderr: term.stderr }).toEqual({
      code: 143,
      signal: null,
      stderr: "",
    });
    expect({ code: interrupt.code, signal: interrupt.signal, stderr: interrupt.stderr }).toEqual({
      code: 130,
      signal: null,
      stderr: "",
    });
  }, 10_000);
});
