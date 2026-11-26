/**
 * A screen-read turn (the witness never arrived) still ends at Claude Code's own end record:
 * a main-chain `turn_duration` written after the screen turn began settles it, by the same
 * rule as a witnessed turn, so a background agent still running holds it open.
 *
 * The session is never started: the transcript is a real file read by the real follower,
 * and the screen turn, the gate and the phase are set directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionHookBinding } from "../hooks/session/binding.js";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";
import type { SettledTurn } from "./types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const LINE = "do the task";

interface Rig {
  s: PaneSessionImpl;
  settled: SettledTurn[];
  append: (...records: Array<Record<string, unknown>>) => void;
  evaluate: () => void;
  anomalies: () => Map<string, number>;
  /** one evaluation by the session's current phase, as a tick would run it */
  tick: () => void;
  phase: () => string;
}

interface RigOptions {
  hooks?: SessionHookBinding;
  delivery?: { file: string; text: string };
}

/** A hook binding whose hold never returns: the session stays SETTLING until a re-wake. */
function pendingHold(): SessionHookBinding {
  return {
    hasIdleWork: () => true,
    settle: () => new Promise(() => {}),
    holdBoundMs: () => 600_000,
    fireStart: () => {},
    fireBlocked: () => {},
    fireEnd: () => {},
  };
}

function rig(acceptedAt: number, ro: RigOptions = {}): Rig {
  const root = mkdtempSync("/tmp/pan-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const transcriptPath = join(root, "transcript.jsonl");
  writeFileSync(transcriptPath, "");
  const settled: SettledTurn[] = [];
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "unwitnessed-end-test",
    callerFlags: [],
    spawnModel: "unwitnessed-end-test",
    cwd: root,
    sessionUuid: crypto.randomUUID(),
    transcriptPath,
    slotEnv: {},
    shape: "interactive",
    readAvailable: true,
    parentEnv: { HOME: root, CLAUDE_CONFIG_DIR: configDir },
    timings: { corroborationMs: 0 },
    decide: (turn) => {
      settled.push(turn);
      return "continue";
    },
    onBlocked: () => "wait",
    ...(ro.hooks ? { hooks: ro.hooks } : {}),
  };
  const s = new PaneSessionImpl(opts, {
    paneId: "unwitnessed-end",
    sockPath: join(root, "m.sock"),
    root,
    ctlDir,
    turnDir,
  });
  cleanups.push(async () => {
    const watchdog = (s as any).holdWatchdog;
    if (watchdog) clearTimeout(watchdog);
    (s as any).client = null;
    (s as any).reapPromise = Promise.resolve();
    await s.shutdownReap("unwitnessed end test cleanup");
  });
  const a = s as any;
  a.phase = "RUNNING";
  a.turnIndex = 1;
  a.follower.openTurn({
    index: 1,
    offset: 0,
    witness: { kind: "text", text: LINE },
    ...(ro.delivery ? { delivery: ro.delivery } : {}),
  });
  if (ro.delivery)
    a.currentDelivery = { mode: "command", text: LINE, file: ro.delivery.file, lines: 1 };
  a.turnAcceptedAt = acceptedAt;
  a.turnSource = "screen";
  a.screenTurn = { echo: LINE, turnFile: null, acceptedAt, errorLogSize: 0 };
  a.client = {};
  a.gateTrusted = true;
  const evaluate = () => {
    a.gate = { ready: true, reason: null, dialog: null, detail: null, receivedAt: Date.now() };
    a.evalRunning(a.pollFollower(true));
  };
  return {
    s,
    settled,
    append: (...records) =>
      appendFileSync(transcriptPath, records.map((r) => `${JSON.stringify(r)}\n`).join("")),
    evaluate,
    anomalies: () => a.anomalies as Map<string, number>,
    tick: () => {
      a.gate = { ready: true, reason: null, dialog: null, detail: null, receivedAt: Date.now() };
      const view = a.pollFollower(true);
      if (a.phase === "SETTLING") a.evalSettling(view);
      else if (a.phase === "IDLE") a.evalIdle(view);
      else a.evalRunning(view);
    },
    phase: () => a.phase as string,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The prompt as Claude Code wrote it, which does not match the typed line. */
const garbledPrompt = (at: number) => ({
  type: "user",
  timestamp: iso(at),
  origin: { kind: "human" },
  message: { role: "user", content: "do the tsak" },
});
const answer = (id: string, text: string, at: number, stop = "end_turn") => ({
  type: "assistant",
  timestamp: iso(at),
  message: { id, role: "assistant", stop_reason: stop, content: [{ type: "text", text }] },
});
/** An end_turn message with no text: the answer must come from the screen. */
const emptyAnswer = (at: number) => ({
  type: "assistant",
  timestamp: iso(at),
  message: { id: "m1", role: "assistant", stop_reason: "end_turn", content: [] },
});
const turnDuration = (at: number, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "turn_duration",
  timestamp: iso(at),
  durationMs: 1000,
  ...extra,
});
const agentLaunch = (at: number) => ({
  type: "assistant",
  timestamp: iso(at),
  message: {
    id: "m-agent",
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tu-agent", name: "Agent", input: { prompt: "look" } }],
  },
});
const agentResult = (at: number) => ({
  type: "user",
  timestamp: iso(at),
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tu-agent", content: "launched" }],
  },
  toolUseResult: { isAsync: true, agentId: "agent-1", status: "async_launched" },
});
const agentDone = (at: number) => ({
  type: "user",
  timestamp: iso(at),
  origin: { kind: "task-notification" },
  message: {
    role: "user",
    content:
      "<task-notification><task-id>agent-1</task-id><status>completed</status></task-notification>",
  },
});

describe("a screen turn whose witness never arrives", () => {
  test("a later main-chain turn_duration settles it from the transcript's answer", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    r.append(garbledPrompt(start + 1000), answer("m1", "the answer", start + 2000));
    r.evaluate();
    expect(r.settled).toHaveLength(0);
    r.append(turnDuration(start + 3000));
    r.evaluate();
    expect(r.settled).toHaveLength(1);
    const t = r.settled[0]!;
    expect(t.answer).toBe("the answer");
    expect(t.captureSource).toBe("transcript");
    expect(t.settledBy).toBe("turn_duration");
    expect(t.stopReason).toBe("end_turn");
    expect(r.anomalies().get("unwitnessed_turn_duration")).toBe(1);
  });

  test("a background agent held open waits for the turn_duration after it finishes", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    r.append(
      garbledPrompt(start + 1000),
      agentLaunch(start + 2000),
      agentResult(start + 2100),
      answer("m1", "started a background agent", start + 3000),
      turnDuration(start + 3100, { pendingBackgroundAgentCount: 1 })
    );
    r.evaluate();
    expect(r.settled).toHaveLength(0);
    r.append(agentDone(start + 10_000), answer("m2", "the agent is done", start + 11_000));
    r.evaluate();
    expect(r.settled).toHaveLength(0);
    r.append(turnDuration(start + 12_000));
    r.evaluate();
    expect(r.settled).toHaveLength(1);
    expect(r.settled[0]!.answer).toBe("started a background agent\n\nthe agent is done");
    expect(r.settled[0]!.settledBy).toBe("turn_duration");
  });

  test("a turn_duration older than the screen turn does not settle it", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    r.append(answer("m0", "an earlier answer", start - 5000), turnDuration(start - 4000));
    r.evaluate();
    expect(r.settled).toHaveLength(0);
  });

  test("a sidechain turn_duration does not settle it", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    r.append(
      garbledPrompt(start + 1000),
      answer("m1", "working", start + 2000, "tool_use"),
      turnDuration(start + 3000, { isSidechain: true })
    );
    r.evaluate();
    expect(r.settled).toHaveLength(0);
  });

  test("with no transcript answer the screen answer is kept and the transcript ending still settles", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    r.append(
      garbledPrompt(start + 1000),
      {
        type: "assistant",
        timestamp: iso(start + 2000),
        message: { id: "m1", role: "assistant", stop_reason: "end_turn", content: [] },
      },
      turnDuration(start + 3000)
    );
    r.evaluate();
    expect(r.settled).toHaveLength(1);
    expect(r.settled[0]!.captureSource).toBe("screen");
    expect(r.settled[0]!.settledBy).toBe("turn_duration");
    expect(r.anomalies().get("screen_answer_may_be_truncated")).toBe(1);
  });

  test("a turn_duration whose time cannot be parsed does not settle it", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    r.append(garbledPrompt(start + 1000), answer("m1", "the answer", start + 2000), {
      ...turnDuration(start + 3000),
      timestamp: "not a time",
    });
    r.evaluate();
    expect(r.settled).toHaveLength(0);
  });

  test("with no magmux client the screen answer does not settle it", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    (r.s as any).client = null;
    r.append(garbledPrompt(start + 1000), emptyAnswer(start + 2000), turnDuration(start + 3000));
    r.evaluate();
    expect(r.settled).toHaveLength(0);
    expect(r.anomalies().get("unwitnessed_turn_duration")).toBeUndefined();
    expect(r.anomalies().get("screen_answer_may_be_truncated")).toBeUndefined();
  });

  test("with no magmux client the transcript answer still settles it", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    (r.s as any).client = null;
    r.append(
      garbledPrompt(start + 1000),
      answer("m1", "the answer", start + 2000),
      turnDuration(start + 3000)
    );
    r.evaluate();
    expect(r.settled).toHaveLength(1);
    expect(r.settled[0]!.answer).toBe("the answer");
    expect(r.settled[0]!.captureSource).toBe("transcript");
  });

  test("waiting on the live bottom counts a settle anomaly once, when it settles", () => {
    const start = Date.now() - 60_000;
    const r = rig(start, { delivery: { file: "/nonexistent/turn-1.md", text: `${LINE}\n` } });
    const a = r.s as any;
    a.scrollPos = { atBottom: false, lastDirection: "up" };
    a.returnToLiveBottom = async () => {};
    r.append(garbledPrompt(start + 1000), emptyAnswer(start + 2000), turnDuration(start + 3000));
    for (let i = 0; i < 3; i++) r.evaluate();
    expect(r.settled).toHaveLength(0);
    expect(r.anomalies().get("read_coverage_unverified")).toBeUndefined();
    a.scrollPos = { atBottom: true, lastDirection: null };
    r.evaluate();
    expect(r.settled).toHaveLength(1);
    expect(r.anomalies().get("read_coverage_unverified")).toBe(1);
  });
});

describe("a re-wake after an unwitnessed settle", () => {
  const settledOnShadow = (r: Rig, start: number) => {
    r.append(
      garbledPrompt(start + 1000),
      answer("m1", "the answer", start + 2000),
      turnDuration(start + 3000)
    );
    r.evaluate();
    expect(r.settled.length + ((r.s as any).heldTurn ? 1 : 0)).toBeGreaterThan(0);
  };

  test("a later main-chain answer during the hook hold ends the hold as a re-wake", () => {
    const start = Date.now() - 60_000;
    const r = rig(start, { hooks: pendingHold() });
    settledOnShadow(r, start);
    expect(r.phase()).toBe("SETTLING");
    r.tick();
    expect(r.phase()).toBe("SETTLING");
    r.append(answer("m2", "woken by a background agent", start + 20_000, "tool_use"));
    r.tick();
    expect(r.phase()).toBe("RUNNING");
    expect((r.s as any).rewakeOfSettled).toBe(true);
    expect((r.s as any).heldTurn).toBeNull();
  });

  test("with no later record the hook hold goes on", () => {
    const start = Date.now() - 60_000;
    const r = rig(start, { hooks: pendingHold() });
    settledOnShadow(r, start);
    for (let i = 0; i < 3; i++) r.tick();
    expect(r.phase()).toBe("SETTLING");
    expect((r.s as any).rewakeOfSettled).toBe(false);
  });

  test("a later main-chain answer while idle wakes the settled turn", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    settledOnShadow(r, start);
    expect(r.phase()).toBe("IDLE");
    r.tick();
    expect(r.phase()).toBe("IDLE");
    r.append(answer("m2", "woken by a background agent", start + 20_000, "tool_use"));
    r.tick();
    expect(r.phase()).toBe("RUNNING");
    expect((r.s as any).rewakeOfSettled).toBe(true);
  });

  test("with no later record the idle session stays idle", () => {
    const start = Date.now() - 60_000;
    const r = rig(start);
    settledOnShadow(r, start);
    for (let i = 0; i < 3; i++) r.tick();
    expect(r.phase()).toBe("IDLE");
    expect((r.s as any).rewakeOfSettled).toBe(false);
  });
});
