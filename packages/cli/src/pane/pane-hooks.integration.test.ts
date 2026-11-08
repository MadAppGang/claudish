/**
 * The settle hold, `SETTLING` and the turn chain (hook-system architecture §7.3, §7.4,
 * §11.5 H-1 … H-34), against REAL magmux and the fake interactive child in scripted
 * mode (`fake-scripted`, `FAKE_SCRIPT`, `FAKE_KEYLOG`).
 *
 * The binding is a test double whose `settle()` returns a promise the test resolves,
 * except where a row says "real binding" (H-21, H-21b, H-24, the cap and the
 * sessionStart rows), which run `createSessionHookBinding` over a real engine. The
 * owner is the real MCP `SessionManager` (observed through get_output,
 * get_diagnostics and events.jsonl, whose `state` records give the row events) or the real team orchestrator
 * (response-<slot>.md and the slot's status row). Every test ends with the
 * no-orphan check.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookEngine } from "../hooks/engine.js";
import type { JournalEntry } from "../hooks/journal.js";
import type { HookDefinition } from "../hooks/public.js";
import { HookRegistry, type UserHookInput } from "../hooks/registry.js";
import {
  type HoldResult,
  type HoldTurnInfo,
  type SessionHookBinding,
  createSessionHookBinding,
} from "../hooks/session/binding.js";
import { SessionManager, sessionEventFor } from "../mcp-session/session-manager.js";
import type { SessionManagerOptions } from "../mcp-session/types.js";
import {
  type TeamHandle,
  type TeamRunOptions,
  cancelTeamRun,
  getStatus,
  setupSession,
  startModels,
} from "../team-orchestrator.js";
import type { CaptureResult, SlotState } from "./contract.js";
import { type PaneSession, type PaneSessionOptions, startPaneSession } from "./pane-session.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  newSessionUuid,
  waitNoOrphans,
} from "./test-helpers/hermetic-env.js";
import type { PaneSnapshot, SettledTurn } from "./types.js";

const T = 60_000;

/* ───────────────────────────── the test double binding ───────────────────────────── */

interface SettleCall {
  turn: HoldTurnInfo;
  signal: AbortSignal;
  resolve(r: HoldResult): void;
  reject(e: unknown): void;
}

function controlled(o: { idle?: boolean; bound?: number } = {}) {
  const calls: SettleCall[] = [];
  const dropped: Array<{ text: string; reason: string }> = [];
  const abandoned: Array<{ text: string; reason: string }> = [];
  const binding: SessionHookBinding = {
    hasIdleWork: () => o.idle ?? true,
    settle: (turn, signal) =>
      new Promise<HoldResult>((resolve, reject) => calls.push({ turn, signal, resolve, reject })),
    holdBoundMs: () => o.bound ?? 30_000,
    fireStart() {},
    fireBlocked() {},
    fireEnd() {},
    noteDropped: (item, reason) => void dropped.push({ text: item.text, reason }),
    abandon: (r, reason) => {
      for (const i of r.injections) abandoned.push({ text: i.text, reason });
    },
  };
  return { binding, calls, dropped, abandoned };
}

const inject = (text: string): HoldResult => ({
  injections: [{ text, hookIds: ["hook:t/x"], source: "sessionIdle" }],
});
const nothing: HoldResult = { injections: [] };

/* ───────────────────────────── engines for the real binding ───────────────────────────── */

function engineOf(...defs: Array<Omit<HookDefinition, "apiVersion">>) {
  const journal: JournalEntry[] = [];
  const users: UserHookInput[] = defs.map((d, i) => ({
    id: `hook:t/${d.id}`,
    module: "/hooks/t.ts",
    moduleIndex: 0,
    exportIndex: i,
    def: { apiVersion: 1, ...d } as HookDefinition,
  }));
  const engine = new HookEngine({
    registry: new HookRegistry([], users, undefined),
    config: {},
    hostMode: "mcp",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
  return { engine, journal };
}

const after = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

/**
 * An injected turn's admission bound in the never-accepted rows: enough for ONE gated send
 * of a short line (its budget, ~13 s with a 1 s readiness wait), so the line is typed and
 * magmux answers before the bound drops it.
 */
const HOOK_ADMIT_BOUND_MS = 16_000;

/* ───────────────────────────── helpers ───────────────────────────── */

interface TurnScript {
  writes?: Array<{ path: string; content: string }>;
  say?: string;
  partial?: string;
  ask?: string;
  noWitness?: boolean;
  exitOnSubmit?: number;
  noRead?: boolean;
  apiError?: string;
  delayMs?: number;
  rewake?: {
    delayMs: number;
    say: string;
    workingMs?: number;
    quietMs?: number;
    gateFile?: string;
    clearWithRecords?: boolean;
  };
  exitAfter?: number;
  exitDelayMs?: number;
}

const openEnvs = new Set<PaneTestEnv>();
afterAll(() => {
  for (const t of openEnvs) {
    killLeftovers({ sockRoot: t.sockRoot });
    t.cleanup();
  }
});

type Script = TurnScript[] | ((t: PaneTestEnv) => TurnScript[]);

function env(script: Script, extra: Record<string, string> = {}): PaneTestEnv {
  const t = makePaneTestEnv({
    CONTRACT_FAKE_MAX_MS: "60000",
    ...extra,
  });
  t.env.FAKE_SCRIPT = JSON.stringify(typeof script === "function" ? script(t) : script);
  t.env.FAKE_KEYLOG = join(t.tmp, "keylog.txt");
  openEnvs.add(t);
  return t;
}

function keylog(t: PaneTestEnv): string[] {
  const p = t.env.FAKE_KEYLOG as string;
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}

/** Occurrences of a whole line in the output. */
function lineCount(output: string, line: string): number {
  return output.split("\n").filter((l) => l === line).length;
}

async function until(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const TERMINAL: SlotState[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "EMPTY"];

interface Chan {
  t: PaneTestEnv;
  manager: SessionManager;
  id: string;
  /** the row event of every state the session entered, from events.jsonl `state` records */
  rowEvents(): string[];
  info(): ReturnType<SessionManager["getSession"]>;
  output(): string;
  anomalies(): readonly string[];
  terminal(ms?: number): Promise<ReturnType<SessionManager["getSession"]>>;
}

async function channel(o: {
  script: Script;
  /** null = an interactive (promptless) session; the test sends turn 1 */
  prompt?: string | null;
  binding?: SessionHookBinding | SessionManagerOptions["hookBinding"];
  engine?: HookEngine;
  timeoutSeconds?: number;
  timings?: PaneSessionOptions["timings"];
  magmuxBinary?: string;
  extraEnv?: Record<string, string>;
}): Promise<Chan> {
  const t = env(o.script, o.extraEnv);
  const b = o.binding;
  const manager = new SessionManager({
    maxSessions: 20,
    sessionsDir: join(t.tmp, "sessions"),
    hostPid: 1,
    parentEnv: t.env,
    paneTimings: { replStableMs: 200, corroborationMs: 200, ...o.timings },
    hookEngine: async () => o.engine ?? null,
    ...(b ? { hookBinding: typeof b === "function" ? b : () => b } : {}),
    ...(o.magmuxBinary ? { magmuxBinary: o.magmuxBinary } : {}),
  });
  const prompt = o.prompt === undefined ? "Reply with the first answer." : o.prompt;
  const id = await manager.createSession({
    model: "fake-scripted",
    cwd: t.cwd,
    ...(prompt ? { prompt } : {}),
    ...(o.timeoutSeconds ? { timeoutSeconds: o.timeoutSeconds } : {}),
  });
  return {
    t,
    manager,
    id,
    rowEvents: () =>
      eventsOf({ manager, id } as Chan)
        .filter((e) => e.type === "state")
        .map((e) => sessionEventFor({ state: e.to as SlotState, activity: null }).event),
    info: () => manager.getSession(id),
    output: () => manager.getOutput(id).output,
    anomalies: () => manager.getDiagnostics(id).anomalies,
    async terminal(ms = 30_000) {
      await until(() => TERMINAL.includes(manager.getSession(id).state), "a terminal state", ms);
      return manager.getSession(id);
    },
  };
}

/** Cancel whatever is live, wait for the reap, and prove nothing is left. */
async function done(c: Chan): Promise<void> {
  await c.manager.shutdownAll();
  const left = await waitNoOrphans({ sockRoot: c.t.sockRoot }, 10_000);
  killLeftovers({ sockRoot: c.t.sockRoot });
  openEnvs.delete(c.t);
  c.t.cleanup();
  expect(left).toEqual({ processes: [], files: [] });
}

function eventsOf(c: Chan): Array<Record<string, unknown>> {
  const p = join(c.manager.getDiagnostics(c.id).sessionDir, "events.jsonl");
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The pane's magmux pid, from its record. */
function magmuxPidOf(c: Chan): number {
  const pane = c.info().pane as string;
  const rec = JSON.parse(readFileSync(join(c.t.sockRoot, "panes", `${pane}.json`), "utf8"));
  return rec.magmuxPid as number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────────── team ───────────────────────────── */

interface Team {
  t: PaneTestEnv;
  handle: TeamHandle;
  slot: string;
  response(): string;
  state(): SlotState | undefined;
}

async function team(o: {
  script: Script;
  binding: SessionHookBinding;
  input?: string;
  extra?: TeamRunOptions;
  timings?: PaneSessionOptions["timings"];
}): Promise<Team> {
  const t = env(o.script);
  const path = join(t.tmp, "team");
  setupSession(path, ["fake-scripted"], o.input ?? "Reply with the first answer.");
  const handle = await startModels(path, {
    cwd: t.cwd,
    parentEnv: t.env,
    spawnPlanner: async () => ({ pinned: new Map<string, string>() }),
    paneTimings: { replStableMs: 200, corroborationMs: 200, ...o.timings },
    hookEngine: async () => null,
    hookBinding: () => o.binding,
    ...o.extra,
  });
  const slot = handle.slots["fake-scripted"] as string;
  return {
    t,
    handle,
    slot,
    response: () => {
      const p = join(path, `response-${slot}.md`);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    },
    state: () => getStatus(path).models[slot]?.state as SlotState | undefined,
  };
}

async function teamDone(x: Team): Promise<void> {
  await cancelTeamRun(x.handle.sessionPath, undefined, x.handle.runId).catch(() => undefined);
  await x.handle.done;
  const left = await waitNoOrphans({ sockRoot: x.t.sockRoot }, 10_000);
  killLeftovers({ sockRoot: x.t.sockRoot });
  openEnvs.delete(x.t);
  x.t.cleanup();
  expect(left).toEqual({ processes: [], files: [] });
}

/* ───────────────────────────── tests ───────────────────────────── */

describe.skipIf(!MAGMUX)(`the settle hold (§11.5) ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`, () => {
  describe.concurrent("the latch and the terminal paths of a hold (channel, one-shot)", () => {
    test(
      "H-1 latch: settle() once over ≥ 4 ticks; A1 already in get_output; RUNNING, activity hook, phase SETTLING",
      async () => {
        const ctl = controlled();
        const c = await channel({ script: [{ say: "ANS-ONE" }], binding: ctl.binding });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          await Bun.sleep(1_200); // ≥ 4 ticker ticks of 250 ms
          expect(ctl.calls.length).toBe(1);
          expect(ctl.calls[0]?.turn).toMatchObject({
            index: 1,
            answer: "ANS-ONE",
            hookCaused: false,
          });
          const info = c.info();
          expect(info.turnsCompleted).toBe(1);
          expect(info.state).toBe("RUNNING");
          expect(info.activity).toBe("hook");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          const diag = c.manager.getDiagnostics(c.id);
          expect(diag.phase).toBe("SETTLING");
          expect(diag.anomalies.some((a) => a.startsWith("illegal_transition"))).toBe(false);
          expect(c.rowEvents()).not.toContain("waiting_for_input");
          // the row event for RUNNING with activity "hook" is "running", never a tool named "hook"
          expect(sessionEventFor(info).event).toBe("running");
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-2 timeout during the hold: TIMEOUT, A1 once; a late injection changes nothing",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { say: "ANS-NEVER" }],
          binding: ctl.binding,
          timeoutSeconds: 5,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          const end = await c.terminal(15_000);
          expect(end.state).toBe("TIMEOUT");
          expect(ctl.calls[0]?.signal.aborted).toBe(true);
          expect(ctl.calls[0]?.signal.reason).toBe("terminal");
          ctl.calls[0]?.resolve(inject("HOOK-LATE"));
          await Bun.sleep(600);
          expect(c.info().state).toBe("TIMEOUT");
          expect(keylog(c.t)).not.toContain("HOOK-LATE");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-3 cancel during the hold: CANCELLED, A1 once; a late resolution is ignored",
      async () => {
        const ctl = controlled();
        const c = await channel({ script: [{ say: "ANS-ONE" }], binding: ctl.binding });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          c.manager.cancelSession(c.id);
          expect(c.info().state).toBe("CANCELLED");
          ctl.calls[0]?.resolve(inject("HOOK-LATE"));
          await Bun.sleep(500);
          expect(c.info().state).toBe("CANCELLED");
          expect(keylog(c.t)).not.toContain("HOOK-LATE");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-4 the child exits 0 during the hold (one-shot): COMPLETED on A1 with the exit note, never child_exited",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE", exitAfter: 0, exitDelayMs: 2_000 }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(end.reason).toBeNull();
          expect(end.detail ?? "").toContain("pane child exited 0");
          expect(ctl.calls[0]?.signal.aborted).toBe(true);
          expect(ctl.calls[0]?.signal.reason).toBe("exit");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-6 a fatal magmux stderr line during the hold: FAILED pane_lost; A1 once (published at record)",
      async () => {
        const ctl = controlled();
        const probe = makePaneTestEnv();
        const wrapper = join(probe.tmp, "magmux-wrapper.sh");
        const trigger = join(probe.tmp, "fatal-now");
        writeFileSync(
          wrapper,
          `#!/bin/bash
REAL=${JSON.stringify(MAGMUX)}
if [ "$1" = "--version" ]; then exec "$REAL" --version; fi
"$REAL" "$@" &
child=$!
trap 'kill -TERM $child 2>/dev/null; wait $child; exit 143' TERM
while kill -0 $child 2>/dev/null; do
  if [ -f "$H6_TRIGGER" ]; then rm -f "$H6_TRIGGER"; echo "magmux: socket lost (test)" >&2; fi
  sleep 0.05
done
wait $child
`
        );
        chmodSync(wrapper, 0o755);
        const c = await channel({
          script: [{ say: "ANS-ONE" }],
          binding: ctl.binding,
          magmuxBinary: wrapper,
          extraEnv: { H6_TRIGGER: trigger },
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          writeFileSync(trigger, "1");
          const end = await c.terminal();
          expect(end.state).toBe("FAILED");
          expect(end.reason).toBe("pane_lost");
          expect(end.detail ?? "").toContain("magmux: socket lost");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
          probe.cleanup();
        }
      },
      T
    );

    test(
      "H-7 timeout while a chain turn runs: TIMEOUT; get_output holds A1 then A2-part, each once",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { partial: "ANS-TWO-PART" }],
          binding: ctl.binding,
          timeoutSeconds: 6,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          const end = await c.terminal(15_000);
          expect(end.state).toBe("TIMEOUT");
          const out = c.output();
          expect(lineCount(out, "ANS-ONE")).toBe(1);
          expect(lineCount(out, "ANS-TWO-PART")).toBe(1);
          expect(out.indexOf("ANS-ONE")).toBeLessThan(out.indexOf("ANS-TWO-PART"));
          expect(keylog(c.t)).toContain("HOOK-PING");
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-8 timeout in the second hold: TIMEOUT; A1 and A2 each once, in order",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { say: "ANS-TWO" }],
          binding: ctl.binding,
          timeoutSeconds: 6,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          await until(() => ctl.calls.length === 2, "settle() 2");
          const end = await c.terminal(15_000);
          expect(end.state).toBe("TIMEOUT");
          const out = c.output();
          expect(lineCount(out, "ANS-ONE")).toBe(1);
          expect(lineCount(out, "ANS-TWO")).toBe(1);
          expect(out.indexOf("ANS-ONE")).toBeLessThan(out.indexOf("ANS-TWO"));
          expect(ctl.calls[1]?.turn).toMatchObject({ index: 2, hookCaused: true });
        } finally {
          await done(c);
        }
      },
      T
    );
  });

  describe.concurrent("team slots: chains, verdicts, terminal paths", () => {
    // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
    test(
      "MTL-229 team uses the head's written answer after a narration-only hook turn",
      async () => {
        const ctl = controlled();
        const content = "## Black-box test contracts\n答え 🍐 — chain deliverable.\n";
        let path = "";
        const x = await team({
          script: (t) => {
            path = join(t.cwd, "file-answer.md");
            return [
              { writes: [{ path, content }], say: "I wrote the deliverable." },
              { say: "The requested work is complete." },
            ];
          },
          binding: ctl.binding,
          input: "Read the task and write the deliverable.\nPreserve its bytes.",
          extra: { requirePattern: "[Bb]lack-box" },
        });
        const rootAnswer = join(import.meta.dir, "../../../..", "file-answer.md");
        try {
          expect(existsSync(rootAnswer)).toBe(false);
          await until(() => ctl.calls.length === 1, "head settle()");
          ctl.calls[0]?.resolve(inject("Confirm the work is complete."));
          await until(() => ctl.calls.length === 2, "hook turn settle()");
          ctl.calls[1]?.resolve(nothing);
          const status = await x.handle.done;
          const row = status.models[x.slot];
          expect(row?.state).toBe("COMPLETED");
          expect(row?.answerSource).toBe(`file:${path}`);
          expect(row?.anomalies).toContain(`answer was written to ${path}, not to the reply`);
          expect(readFileSync(path, "utf8")).toBe(content);
          expect(x.response()).toBe(content);
          expect(row?.outputSize).toBe(Buffer.byteLength(content));
        } finally {
          await teamDone(x);
          expect(existsSync(rootAnswer)).toBe(false);
        }
      },
      T
    );

    test(
      "H-9 team cancelled while chain turn 3 runs: response is A1\\n\\nA2\\n\\nA3-part, outputSize its byte length",
      async () => {
        const ctl = controlled();
        const x = await team({
          script: [{ say: "ANS-ONE" }, { say: "ANS-TWO" }, { partial: "ANS-3-PART" }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("HOOK-ONE"));
          await until(() => ctl.calls.length === 2, "settle() 2");
          ctl.calls[1]?.resolve(inject("HOOK-TWO"));
          const transcript = getStatus(x.handle.sessionPath).models[x.slot]
            ?.transcriptPath as string;
          await until(
            () => existsSync(transcript) && readFileSync(transcript, "utf8").includes("ANS-3-PART"),
            "the partial answer of turn 3"
          );
          await Bun.sleep(600); // let the follower read it
          await cancelTeamRun(x.handle.sessionPath, undefined, x.handle.runId);
          await until(() => x.state() === "CANCELLED", "CANCELLED");
          const want = "ANS-ONE\n\nANS-TWO\n\nANS-3-PART";
          expect(x.response()).toBe(want);
          expect(getStatus(x.handle.sessionPath).models[x.slot]?.outputSize).toBe(
            Buffer.byteLength(want, "utf8")
          );
        } finally {
          await teamDone(x);
        }
      },
      T
    );

    test(
      "H-10 team cancelled in the second hold: response is A1\\n\\nA2",
      async () => {
        const ctl = controlled();
        const x = await team({
          script: [{ say: "ANS-ONE" }, { say: "ANS-TWO" }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("HOOK-ONE"));
          await until(() => ctl.calls.length === 2, "settle() 2");
          // the chain so far is already on disk at record, before any verdict
          expect(x.response()).toBe("ANS-ONE\n\nANS-TWO");
          await cancelTeamRun(x.handle.sessionPath, undefined, x.handle.runId);
          await until(() => x.state() === "CANCELLED", "CANCELLED");
          expect(x.response()).toBe("ANS-ONE\n\nANS-TWO");
        } finally {
          await teamDone(x);
        }
      },
      T
    );

    for (const [pattern, state] of [
      ["^VOTE", "COMPLETED"],
      ["^NOPE", "EMPTY"],
    ] as const) {
      test(
        `H-11 require_pattern ${pattern} on a chain: one verdict, response A1\\n\\nA2, ${state}`,
        async () => {
          const ctl = controlled();
          const x = await team({
            script: [{ say: "thinking about it" }, { say: "VOTE: yes" }],
            binding: ctl.binding,
            extra: { requirePattern: pattern },
          });
          try {
            await until(() => ctl.calls.length === 1, "settle() 1");
            ctl.calls[0]?.resolve(inject("HOOK-PING"));
            await until(() => ctl.calls.length === 2, "settle() 2");
            ctl.calls[1]?.resolve(nothing);
            const status = await x.handle.done;
            expect(x.response()).toBe("thinking about it\n\nVOTE: yes");
            expect(status.models[x.slot]?.state).toBe(state);
            if (state === "EMPTY")
              expect(status.models[x.slot]?.error?.reason).toBe("shape_mismatch");
          } finally {
            await teamDone(x);
          }
        },
        T
      );
    }

    test(
      "H-12 team blocked mid-chain: FAILED blocked; response is A1\\n\\nB2",
      async () => {
        const ctl = controlled();
        const x = await team({
          script: [{ say: "ANS-ONE" }, { ask: "ANS-B2" }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          const status = await x.handle.done;
          expect(status.models[x.slot]?.state).toBe("FAILED");
          expect(status.models[x.slot]?.error?.reason).toBe("blocked");
          expect(x.response()).toBe("ANS-ONE\n\nANS-B2");
        } finally {
          await teamDone(x);
        }
      },
      T
    );

    test(
      "H-14 team: an injected turn never accepted → slot COMPLETED, response A1, nothing left RUNNING",
      async () => {
        const ctl = controlled();
        const x = await team({
          script: [{ say: "ANS-ONE" }, { noWitness: true }],
          binding: ctl.binding,
          // room for one gated send; magmux answers `unconfirmed`, the bound drops the item
          timings: { admitTimeoutMs: HOOK_ADMIT_BOUND_MS },
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          const status = await x.handle.done;
          expect(status.models[x.slot]?.state).toBe("COMPLETED");
          expect(x.response()).toBe("ANS-ONE");
          expect(ctl.dropped).toEqual([{ text: "HOOK-PING", reason: "send_not_accepted" }]);
          for (const m of Object.values(getStatus(x.handle.sessionPath).models))
            expect(["RUNNING", "AWAITING_INPUT"]).not.toContain(m.state);
          expect(keylog(x.t)).toContain("HOOK-PING");
        } finally {
          await teamDone(x);
        }
      },
      T
    );

    test(
      "H-32 team variant: the child exits 0 during an injected admission → slot COMPLETED, response A1",
      async () => {
        const ctl = controlled();
        const x = await team({
          script: [{ say: "ANS-ONE" }, { exitOnSubmit: 0 }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          const status = await x.handle.done;
          expect(status.models[x.slot]?.state).toBe("COMPLETED");
          expect(x.response()).toBe("ANS-ONE");
        } finally {
          await teamDone(x);
        }
      },
      T
    );
  });

  describe.concurrent("injected turns never accepted, and caller input during a hold", () => {
    test(
      "H-13 one-shot: no witness → hook_injection_dropped:send_not_accepted, COMPLETED on A1, never AWAITING_INPUT",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { noWitness: true }],
          binding: ctl.binding,
          // room for one gated send; magmux answers `unconfirmed`, the bound drops the item
          timings: { admitTimeoutMs: HOOK_ADMIT_BOUND_MS },
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(c.anomalies()).toContain("hook_injection_dropped:send_not_accepted");
          expect(c.rowEvents()).not.toContain("waiting_for_input");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          expect(ctl.dropped).toEqual([{ text: "HOOK-PING", reason: "send_not_accepted" }]);
          // typed and submitted, never accepted: not dropped before a send was made
          expect(keylog(c.t)).toContain("HOOK-PING");
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-15 interactive: no witness → AWAITING_INPUT (today's admit_abandoned), the anomaly, A1 once",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { noWitness: true }],
          binding: ctl.binding,
          prompt: null,
          // room for one gated send; magmux answers `unconfirmed`, the bound drops the item
          timings: { admitTimeoutMs: HOOK_ADMIT_BOUND_MS },
        });
        try {
          await until(() => c.info().state === "AWAITING_INPUT", "boot");
          c.manager.sendInput(c.id, "Reply with the first answer.");
          await until(() => ctl.calls.length === 1, "settle()");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          await until(
            () => c.anomalies().includes("hook_injection_dropped:send_not_accepted"),
            "the anomaly"
          );
          await until(() => c.info().state === "AWAITING_INPUT", "AWAITING_INPUT");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          expect(keylog(c.t)).toContain("HOOK-PING");
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-16 send_input during a hold: the hold ends in that step (caller), CALLER runs, a late HOOK never",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { say: "ANS-CALLER" }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          const r = c.manager.sendInput(c.id, "CALLER");
          // admitted in this very step, so nothing is left queued (as for any send whose own
          // step settles a turn, session-manager.test G-row); see the P6 deviation note
          expect(r).toEqual({ success: true, queued: 0 });
          expect(ctl.calls[0]?.signal.aborted).toBe(true);
          expect(ctl.calls[0]?.signal.reason).toBe("caller");
          expect(c.manager.getDiagnostics(c.id).phase).toBe("ADMITTING");
          ctl.calls[0]?.resolve(inject("HOOK"));
          await until(() => c.info().turnsCompleted === 2, "turn 2");
          await until(() => ctl.calls.length === 2, "the second hold");
          ctl.calls[1]?.resolve(nothing);
          await until(() => c.info().state === "AWAITING_INPUT", "AWAITING_INPUT");
          expect(keylog(c.t)).toContain("CALLER");
          expect(keylog(c.t)).not.toContain("HOOK");
          expect(c.info().shape).toBe("interactive");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          expect(lineCount(c.output(), "ANS-CALLER")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-17 a hold that never resolves (bound 30 s) does not delay the caller: CALLER admitted at once, no watchdog",
      async () => {
        const ctl = controlled({ bound: 30_000 });
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { say: "ANS-CALLER" }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          const t0 = Date.now();
          c.manager.sendInput(c.id, "CALLER");
          await until(() => keylog(c.t).includes("CALLER"), "CALLER typed", 2_000);
          expect(Date.now() - t0).toBeLessThan(1_500);
          expect(c.anomalies()).not.toContain("hook_hold_watchdog");
          expect(TERMINAL).not.toContain(c.info().state);
        } finally {
          await done(c);
        }
      },
      T
    );
  });

  describe.concurrent("the chain head's prompt-read result", () => {
    const filePrompt = "Line one of the task.\nLine two of the task.";

    test(
      "H-18 head delivered as a file and not read: FAILED prompt_not_read; get_output holds A1 and A2",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ noRead: true, say: "ANS-ONE" }, { say: "ANS-TWO" }],
          binding: ctl.binding,
          prompt: filePrompt,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          await until(() => ctl.calls.length === 2, "settle() 2");
          ctl.calls[1]?.resolve(nothing);
          const end = await c.terminal();
          expect(end.state).toBe("FAILED");
          expect(end.reason).toBe("prompt_not_read");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          expect(lineCount(c.output(), "ANS-TWO")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-19 head read in full: COMPLETED",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { say: "ANS-TWO" }],
          binding: ctl.binding,
          prompt: filePrompt,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          await until(() => ctl.calls.length === 2, "settle() 2");
          ctl.calls[1]?.resolve(nothing);
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          // no wait opened between chain turns
          expect(c.rowEvents()).not.toContain("waiting_for_input");
          const waits = join(c.manager.getDiagnostics(c.id).sessionDir, "waits.jsonl");
          expect(existsSync(waits) ? readFileSync(waits, "utf8") : "").toBe("");
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-20 a hook turn delivered as a file and not read: COMPLETED; anomaly hook_injection_not_read",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { noRead: true, say: "ANS-TWO" }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("A hook turn\nthat goes as a file."));
          await until(() => ctl.calls.length === 2, "settle() 2");
          ctl.calls[1]?.resolve(nothing);
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(c.anomalies()).toContain("hook_injection_not_read");
          expect(c.anomalies()).not.toContain("prompt_not_read");
        } finally {
          await done(c);
        }
      },
      T
    );
  });

  describe.concurrent("sessionStart and the hold bound (real binding)", () => {
    test(
      "H-21 a sessionStart injection still running at the first settle holds it: turn 2 runs LATE; one verdict",
      async () => {
        const { engine } = engineOf({
          id: "late",
          on: { sessionStart: () => after(2_000, [{ type: "injectUserTurn", text: "LATE" }]) },
        });
        const c = await channel({ script: [{ say: "ANS-ONE" }, { say: "ANS-TWO" }], engine });
        try {
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(end.turnsCompleted).toBe(2);
          expect(keylog(c.t)).toContain("LATE");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          expect(lineCount(c.output(), "ANS-TWO")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-21 control: the hook returns after its timeout → COMPLETED after turn 1, journal timeout, no turn 2",
      async () => {
        const { engine, journal } = engineOf({
          id: "late",
          timeoutMs: 800,
          on: { sessionStart: () => after(2_000, [{ type: "injectUserTurn", text: "LATE" }]) },
        });
        const c = await channel({ script: [{ say: "ANS-ONE" }, { say: "ANS-TWO" }], engine });
        try {
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(end.turnsCompleted).toBe(1);
          expect(keylog(c.t)).not.toContain("LATE");
          expect(journal.some((j) => j.hookId === "hook:t/late" && j.decision === "timeout")).toBe(
            true
          );
        } finally {
          await done(c);
        }
      },
      T
    );

    for (const [delay, late] of [
      [2_500, true],
      [4_500, false],
    ] as const) {
      test(
        `H-21b sessionStart (timeout 4 s) returns at ${delay} ms, inbox bound 200 ms: no watchdog; ${late ? "turn 2 runs LATE" : "COMPLETED after turn 1"}`,
        async () => {
          const { engine, journal } = engineOf({
            id: "late",
            timeoutMs: 4_000,
            on: { sessionStart: () => after(delay, [{ type: "injectUserTurn", text: "LATE" }]) },
          });
          const t0 = Date.now();
          const c = await channel({
            script: [{ say: "ANS-ONE" }, { say: "ANS-TWO" }],
            engine,
            binding: ({ session, inboxPath }) =>
              createSessionHookBinding(engine, session, inboxPath, { inboxBoundMs: 200 }),
          });
          try {
            const end = await c.terminal();
            expect(end.state).toBe("COMPLETED");
            expect(c.anomalies()).not.toContain("hook_hold_watchdog");
            if (late) {
              expect(end.turnsCompleted).toBe(2);
              expect(keylog(c.t)).toContain("LATE");
              expect(lineCount(c.output(), "ANS-TWO")).toBe(1);
            } else {
              expect(end.turnsCompleted).toBe(1);
              expect(keylog(c.t)).not.toContain("LATE");
              expect(journal.some((j) => j.decision === "timeout")).toBe(true);
              expect(Date.now() - t0).toBeGreaterThanOrEqual(3_500);
            }
            expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          } finally {
            await done(c);
          }
        },
        T
      );
    }

    test(
      "a sessionStart injection that returns before turn 1 settles is delivered after turn 1 (callerSeq survives)",
      async () => {
        const { engine } = engineOf({
          id: "start",
          on: { sessionStart: () => [{ type: "injectUserTurn", text: "EARLY" }] },
        });
        const c = await channel({
          script: [{ say: "ANS-ONE", delayMs: 600 }, { say: "ANS-TWO" }],
          engine,
        });
        try {
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(end.turnsCompleted).toBe(2);
          const typed = keylog(c.t);
          expect(typed.indexOf("EARLY")).toBeGreaterThan(0); // after the initial prompt
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "cap: an idle hook that always injects gets 3 hook-caused turns, then dropped capped; one verdict",
      async () => {
        let n = 0;
        const { engine } = engineOf({
          id: "more",
          on: { sessionIdle: () => [{ type: "injectUserTurn", text: `MORE-${++n}` }] },
        });
        const c = await channel({
          script: [
            { say: "ANS-1" },
            { say: "ANS-2" },
            { say: "ANS-3" },
            { say: "ANS-4" },
            { say: "ANS-5" },
          ],
          engine,
        });
        try {
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(end.turnsCompleted).toBe(4);
          expect(keylog(c.t).filter((l) => l.startsWith("MORE-"))).toEqual([
            "MORE-1",
            "MORE-2",
            "MORE-3",
          ]);
          expect(c.anomalies()).toContain("hook_injection_dropped:capped");
          expect(c.rowEvents()).not.toContain("waiting_for_input");
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "a hook item queued during a QUESTION waits, and no Esc is ever sent for it",
      async () => {
        const { engine } = engineOf({
          id: "start",
          on: { sessionStart: () => after(800, [{ type: "injectUserTurn", text: "WAITING" }]) },
        });
        const c = await channel({ script: [{ ask: "" }], engine });
        try {
          await until(() => c.manager.getDiagnostics(c.id).phase === "QUESTION", "QUESTION");
          await until(
            () => c.manager.getDiagnostics(c.id).pendingHookInputs === 1,
            "the queued hook item"
          );
          await Bun.sleep(1_200);
          expect(c.manager.getDiagnostics(c.id).phase).toBe("QUESTION");
          expect(keylog(c.t)).not.toContain("<ESC>");
          expect(keylog(c.t)).not.toContain("WAITING");
          expect(c.manager.getDiagnostics(c.id).pendingInputs).toBe(0);
        } finally {
          await done(c);
        }
      },
      T
    );
  });

  describe.concurrent("errors, the watchdog, re-wake", () => {
    test(
      "H-22 settle() rejects: concluded with no injection; hook_hold_error; COMPLETED; A1 once",
      async () => {
        const ctl = controlled();
        const c = await channel({ script: [{ say: "ANS-ONE" }], binding: ctl.binding });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          ctl.calls[0]?.reject(new Error("binding broke"));
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(c.anomalies()).toContain("hook_hold_error");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-23 settle() hangs, bound 300 ms: concluded at ~300 ms; hook_hold_watchdog; a later resolve changes nothing",
      async () => {
        const ctl = controlled({ bound: 300 });
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { say: "ANS-X" }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          const t0 = Date.now();
          const end = await c.terminal();
          // The anomaly below names the watchdog as the cause; this bound only separates the
          // 300 ms watchdog (plus the turn's own finish, 1074 ms on a loaded CI runner) from a
          // hold left to the 30 s default.
          expect(Date.now() - t0).toBeLessThan(2_000);
          expect(end.state).toBe("COMPLETED");
          expect(c.anomalies()).toContain("hook_hold_watchdog");
          expect(ctl.calls[0]?.signal.reason).toBe("watchdog");
          ctl.calls[0]?.resolve(inject("HOOK-LATE"));
          await Bun.sleep(500);
          expect(keylog(c.t)).not.toContain("HOOK-LATE");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-24 re-wake during a hold (real binding): S dropped, the drained proxy P is delivered next; A1 and A1b once",
      async () => {
        let idleCalls = 0;
        let firstSignal: AbortSignal | null = null;
        const { engine } = engineOf({
          id: "idle",
          on: {
            sessionIdle: (ctx) => {
              idleCalls++;
              if (idleCalls === 1) {
                firstSignal = ctx.signal;
                return new Promise((r) =>
                  ctx.signal.addEventListener("abort", () =>
                    r([{ type: "injectUserTurn", text: "S" }])
                  )
                );
              }
              return [];
            },
          },
        });
        const c = await channel({
          script: [
            { say: "ANS-ONE", rewake: { delayMs: 1_500, say: "ANS-ONE-B" } },
            { say: "ANS-P" },
          ],
          engine,
          prompt: null,
        });
        try {
          await until(() => c.info().state === "AWAITING_INPUT", "boot");
          const inboxPath = join(c.manager.getDiagnostics(c.id).sessionDir, "hook-inbox.jsonl");
          writeFileSync(
            inboxPath,
            [
              { v: 1, kind: "stop", req: "r1" },
              { v: 1, kind: "inject", req: "r1", hookId: "hook:c/p", text: "INJECTED-P", at: "x" },
              { v: 1, kind: "end", req: "r1" },
            ]
              .map((l) => `${JSON.stringify(l)}\n`)
              .join("")
          );
          c.manager.sendInput(c.id, "Reply with the first answer.");
          await until(
            () => keylog(c.t).includes("INJECTED-P"),
            "P delivered as the next turn",
            25_000
          );
          expect((firstSignal as AbortSignal | null)?.reason).toBe("rewake");
          await until(
            () => c.info().turnsCompleted === 2 && c.info().state === "AWAITING_INPUT",
            "turn 2"
          );
          expect(keylog(c.t)).not.toContain("S");
          const out = c.output();
          expect(lineCount(out, "ANS-ONE")).toBe(1);
          expect(lineCount(out, "ANS-ONE-B")).toBe(1);
          expect(lineCount(out, "ANS-P")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );
  });

  describe.concurrent("the exit paths of a hold (M-1)", () => {
    for (const code of [0, 1]) {
      test(
        `H-5 interactive, the child exits ${code} during the hold: ${code === 0 ? "COMPLETED through exit_clean" : "FAILED child_exited"}; A1 once`,
        async () => {
          const ctl = controlled();
          const c = await channel({
            script: [{ say: "ANS-ONE", exitAfter: code, exitDelayMs: 2_000 }],
            binding: ctl.binding,
            prompt: null,
          });
          try {
            await until(() => c.info().state === "AWAITING_INPUT", "boot");
            c.manager.sendInput(c.id, "Reply with the first answer.");
            await until(() => ctl.calls.length === 1, "settle()");
            const end = await c.terminal();
            if (code === 0) {
              expect(end.state).toBe("COMPLETED");
            } else {
              expect(end.state).toBe("FAILED");
              expect(end.reason).toBe("child_exited");
            }
            expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          } finally {
            await done(c);
          }
        },
        T
      );
    }

    test(
      "H-29 magmux killed during the hold (one-shot): COMPLETED on A1, detail 'magmux exited', signal reason exit",
      async () => {
        const ctl = controlled();
        const c = await channel({ script: [{ say: "ANS-ONE" }], binding: ctl.binding });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          process.kill(magmuxPidOf(c), "SIGKILL");
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(end.detail ?? "").toContain("magmux exited");
          expect(ctl.calls[0]?.signal.reason).toBe("exit");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-30 magmux killed during the hold (interactive): FAILED pane_lost with today's 'magmux exited' detail; A1 once",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }],
          binding: ctl.binding,
          prompt: null,
        });
        try {
          await until(() => c.info().state === "AWAITING_INPUT", "boot");
          c.manager.sendInput(c.id, "Reply with the first answer.");
          await until(() => ctl.calls.length === 1, "settle()");
          process.kill(magmuxPidOf(c), "SIGKILL");
          const end = await c.terminal();
          expect(end.state).toBe("FAILED");
          expect(end.reason).toBe("pane_lost");
          expect(end.detail ?? "").toContain("magmux exited");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-31 the hold ends inside the exit-capture window: dropped pane_exited, nothing typed, COMPLETED with the exit note",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE", exitAfter: 0, exitDelayMs: 2_000 }],
          binding: ctl.binding,
          timings: { exitCaptureDelayMs: 500 },
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          const pid = c.info().panePid as number;
          await until(() => !pidAlive(pid), "the child's exit", 10_000);
          await Bun.sleep(100);
          ctl.calls[0]?.resolve(inject("HOOK-X"));
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(end.detail ?? "").toContain("pane child exited 0");
          expect(c.anomalies()).toContain("hook_injection_dropped:pane_exited");
          expect(keylog(c.t)).not.toContain("HOOK-X");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-32 one-shot: the child exits 0 during an injected admission → send_not_accepted; COMPLETED on A1 with the exit note",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { exitOnSubmit: 0 }],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "settle()");
          ctl.calls[0]?.resolve(inject("HOOK-PING"));
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          expect(end.detail ?? "").toContain("pane child exited 0");
          expect(c.anomalies()).toContain("hook_injection_dropped:send_not_accepted");
          expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
        } finally {
          await done(c);
        }
      },
      T
    );

    for (const code of [0, 1]) {
      test(
        `H-33 interactive: the child exits ${code} during an injected admission → the anomaly; ${code === 0 ? "COMPLETED (exit_clean)" : "FAILED child_exited"}`,
        async () => {
          const ctl = controlled();
          const c = await channel({
            script: [{ say: "ANS-ONE" }, { exitOnSubmit: code }],
            binding: ctl.binding,
            prompt: null,
          });
          try {
            await until(() => c.info().state === "AWAITING_INPUT", "boot");
            c.manager.sendInput(c.id, "Reply with the first answer.");
            await until(() => ctl.calls.length === 1, "settle()");
            ctl.calls[0]?.resolve(inject("HOOK-PING"));
            const end = await c.terminal();
            expect(c.anomalies()).toContain("hook_injection_dropped:send_not_accepted");
            if (code === 0) expect(end.state).toBe("COMPLETED");
            else {
              expect(end.state).toBe("FAILED");
              expect(end.reason).toBe("child_exited");
            }
            expect(lineCount(c.output(), "ANS-ONE")).toBe(1);
          } finally {
            await done(c);
          }
        },
        T
      );
    }

    test(
      "H-34 interactive: an unread hook-turn file is hook_injection_not_read, never prompt_not_read",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { noRead: true, say: "ANS-TWO" }],
          binding: ctl.binding,
          prompt: null,
        });
        try {
          await until(() => c.info().state === "AWAITING_INPUT", "boot");
          c.manager.sendInput(c.id, "Reply with the first answer.");
          await until(() => ctl.calls.length === 1, "settle() 1");
          ctl.calls[0]?.resolve(inject("A hook turn\nthat goes as a file."));
          await until(() => ctl.calls.length === 2, "settle() 2");
          ctl.calls[1]?.resolve(nothing);
          await until(
            () => c.info().state === "AWAITING_INPUT" && c.info().turnsCompleted === 2,
            "idle"
          );
          await Bun.sleep(400);
          expect(c.anomalies()).toContain("hook_injection_not_read");
          const keys = eventsOf(c)
            .filter((e) => e.type === "anomaly")
            .map((e) => e.key);
          expect(keys).not.toContain("prompt_not_read");
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "H-34 control: a caller send_input delivered as a file and not read → prompt_not_read as today",
      async () => {
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { noRead: true, say: "ANS-TWO" }],
          prompt: null,
        });
        try {
          await until(() => c.info().state === "AWAITING_INPUT", "boot");
          c.manager.sendInput(c.id, "Reply with the first answer.");
          await until(
            () => c.info().turnsCompleted === 1 && c.info().state === "AWAITING_INPUT",
            "turn 1"
          );
          c.manager.sendInput(c.id, "A caller turn\nthat goes as a file.");
          await until(
            () => c.info().turnsCompleted === 2 && c.info().state === "AWAITING_INPUT",
            "turn 2"
          );
          await Bun.sleep(400);
          const keys = eventsOf(c)
            .filter((e) => e.type === "anomaly")
            .map((e) => e.key);
          expect(keys).toContain("prompt_not_read");
        } finally {
          await done(c);
        }
      },
      T
    );
  });

  /* ───────────────────────── PaneSession directly (snapshot, no-hold, no binding) ───────────────────────── */

  describe.concurrent(
    "PaneSession: the snapshot during a hold, the no-hold paths, no binding",
    () => {
      interface Direct {
        s: PaneSession;
        t: PaneTestEnv;
        uuid: string;
        transitions: Array<[SlotState, SlotState]>;
        recorded: SettledTurn[];
        decided: SettledTurn[];
      }

      async function direct(o: {
        script: Script;
        hooks?: SessionHookBinding;
        exitCaptureDelayMs?: number;
      }): Promise<Direct> {
        const t = env(o.script);
        const uuid = newSessionUuid();
        const transitions: Array<[SlotState, SlotState]> = [];
        const recorded: SettledTurn[] = [];
        const decided: SettledTurn[] = [];
        const s = await startPaneSession({
          kind: "t",
          label: "01",
          callerFlags: [],
          spawnModel: "fake-scripted",
          cwd: t.cwd,
          sessionUuid: uuid,
          transcriptPath: t.transcriptPathFor(uuid),
          slotEnv: {},
          shape: "one-shot",
          initialPrompt: "Reply with the first answer.",
          readAvailable: true,
          parentEnv: t.env,
          sockRoot: t.sockRoot,
          decide: (turn) => {
            decided.push(turn);
            return { state: "COMPLETED" };
          },
          onBlocked: () => ({ state: "FAILED", reason: "blocked" }),
          onTransition: (x) => void transitions.push([x.from, x.to]),
          onTurnRecorded: (turn) => void recorded.push(turn),
          timings: {
            replStableMs: 200,
            corroborationMs: 200,
            ...(o.exitCaptureDelayMs ? { exitCaptureDelayMs: o.exitCaptureDelayMs } : {}),
          },
          ...(o.hooks ? { hooks: o.hooks } : {}),
        });
        return { s, t, uuid, transitions, recorded, decided };
      }

      async function directDone(d: Direct): Promise<PaneSnapshot> {
        d.s.cancel();
        await d.s.reaped();
        const left = await waitNoOrphans({ sockRoot: d.t.sockRoot, ids: [d.uuid] });
        killLeftovers({ sockRoot: d.t.sockRoot, ids: [d.uuid] });
        openEnvs.delete(d.t);
        d.t.cleanup();
        expect(left).toEqual({ processes: [], files: [] });
        return d.s.snapshot();
      }

      // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
      test(
        "MTL-229 settled chain retains the head's Write after a narration-only hook turn",
        async () => {
          const ctl = controlled();
          const content = "## Black-box test contracts\nThe head wrote this answer.\n";
          let path = "";
          const d = await direct({
            script: (t) => {
              path = join(t.cwd, "file-answer.md");
              return [
                { writes: [{ path, content }], say: "I wrote the deliverable." },
                { say: "The requested work is complete." },
              ];
            },
            hooks: ctl.binding,
          });
          const rootAnswer = join(import.meta.dir, "../../../..", "file-answer.md");
          try {
            expect(existsSync(rootAnswer)).toBe(false);
            await until(() => ctl.calls.length === 1, "head settle()");
            expect(d.recorded[0]?.writtenFiles).toEqual([path]);
            ctl.calls[0]?.resolve(inject("Confirm the work is complete."));
            await until(() => ctl.calls.length === 2, "hook turn settle()");
            ctl.calls[1]?.resolve(nothing);
            await d.s.terminal;
            expect(d.decided).toHaveLength(1);
            expect(d.decided[0]?.hookCaused).toBe(true);
            expect(d.decided[0]?.hookTurns).toBe(1);
            expect(d.decided[0]?.answer).toBe("The requested work is complete.");
            expect(d.decided[0]?.writtenFiles).toEqual([path]);
            expect(readFileSync(path, "utf8")).toBe(content);
          } finally {
            await directDone(d);
            expect(existsSync(rootAnswer)).toBe(false);
          }
        },
        T
      );

      // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
      test(
        "MTL-229 settled chain de-duplicates Writes in head-first first-write order",
        async () => {
          const ctl = controlled();
          let head = "";
          let shared = "";
          let tail = "";
          const d = await direct({
            script: (t) => {
              head = join(t.cwd, "z-head.md");
              shared = join(t.cwd, "a-shared.md");
              tail = join(t.cwd, "b-tail.md");
              return [
                {
                  writes: [
                    { path: head, content: "Head only" },
                    { path: shared, content: "Head version" },
                  ],
                  say: "I wrote the files.",
                },
                {
                  writes: [
                    { path: shared, content: "Hook version" },
                    { path: tail, content: "Hook only" },
                  ],
                  say: "I updated the files.",
                },
              ];
            },
            hooks: ctl.binding,
          });
          const rootPaths = ["z-head.md", "a-shared.md", "b-tail.md"].map((name) =>
            join(import.meta.dir, "../../../..", name)
          );
          try {
            expect(rootPaths.some(existsSync)).toBe(false);
            await until(() => ctl.calls.length === 1, "head settle()");
            expect(d.recorded[0]?.writtenFiles).toEqual([head, shared]);
            ctl.calls[0]?.resolve(inject("Update the shared file and write the last file."));
            await until(() => ctl.calls.length === 2, "hook turn settle()");
            ctl.calls[1]?.resolve(nothing);
            await d.s.terminal;
            expect(d.decided).toHaveLength(1);
            expect(d.decided[0]?.writtenFiles).toEqual([head, shared, tail]);
            expect(readFileSync(head, "utf8")).toBe("Head only");
            expect(readFileSync(shared, "utf8")).toBe("Hook version");
            expect(readFileSync(tail, "utf8")).toBe("Hook only");
          } finally {
            await directDone(d);
            expect(rootPaths.some(existsSync)).toBe(false);
          }
        },
        T
      );

      test(
        "H-25 snapshot during a hold: state RUNNING, activity hook, phase SETTLING, turnEndRecordMissing false",
        async () => {
          const ctl = controlled();
          const d = await direct({ script: [{ say: "ANS-ONE" }], hooks: ctl.binding });
          try {
            await until(() => ctl.calls.length === 1, "settle()");
            const snap = d.s.snapshot();
            expect(snap.state).toBe("RUNNING");
            expect(snap.activity).toBe("hook");
            expect(snap.phase).toBe("SETTLING");
            expect(snap.turnEndRecordMissing).toBe(false);
            expect(snap.pendingHookInputs).toBe(0);
            // published at record, before any transition; not yet decided
            expect(d.recorded.map((r) => r.answer)).toEqual(["ANS-ONE"]);
            expect(d.decided).toEqual([]);
            expect(d.s.chainText()).toBe("ANS-ONE");
          } finally {
            await directDone(d);
          }
        },
        T
      );

      test(
        "H-26 hasIdleWork false: SETTLING never entered, settle() never called, the verdict in the settling step",
        async () => {
          const ctl = controlled({ idle: false });
          const d = await direct({ script: [{ say: "ANS-ONE" }], hooks: ctl.binding });
          try {
            await d.s.terminal;
            expect(ctl.calls).toEqual([]);
            expect(d.transitions).toEqual([
              ["STARTING", "RUNNING"],
              ["RUNNING", "COMPLETED"],
            ]);
            expect(d.recorded).toHaveLength(1);
            expect(d.decided).toHaveLength(1);
            expect(d.s.snapshot().anomalies.some((a) => a.startsWith("illegal_transition"))).toBe(
              false
            );
          } finally {
            await directDone(d);
          }
        },
        T
      );

      test(
        "H-27 end record and exit in the same tick: no hold, settle() never called, COMPLETED with the exit note",
        async () => {
          const ctl = controlled();
          const d = await direct({
            script: [{ say: "ANS-ONE", exitAfter: 0, exitDelayMs: 0 }],
            hooks: ctl.binding,
          });
          try {
            const snap = await d.s.terminal;
            expect(ctl.calls).toEqual([]);
            expect(snap.state).toBe("COMPLETED");
            expect(snap.detail ?? "").toContain("pane child exited 0");
            expect(d.decided.map((t) => t.answer)).toEqual(["ANS-ONE"]);
          } finally {
            await directDone(d);
          }
        },
        T
      );

      test(
        "H-27b the end record settles inside the exit-capture window: the exit note keeps its code",
        async () => {
          // The interleaving H-27 hits under load, made deterministic: the exit event is
          // processed (the pane is known dead) and the session is still capturing the final
          // screen when a tick settles the turn on its end record. The note must carry the
          // code the exit event reported, never a bare "pane child exited".
          const ctl = controlled();
          const d = await direct({
            script: [{ delayMs: 1000, say: "ANS-ONE" }],
            hooks: ctl.binding,
            exitCaptureDelayMs: 4000,
          });
          try {
            await until(
              () => d.transitions.some(([, to]) => to === "RUNNING"),
              "the turn is RUNNING"
            );
            const exit = (
              d.s as unknown as { onPaneExit(e: { exitCode: number; lastLine: string }): void }
            ).onPaneExit.bind(d.s);
            exit({ exitCode: 0, lastLine: "" });
            const snap = await d.s.terminal;
            expect(ctl.calls).toEqual([]);
            expect(snap.state).toBe("COMPLETED");
            expect(snap.detail ?? "").toContain("pane child exited 0");
            expect(d.decided.map((t) => t.answer)).toEqual(["ANS-ONE"]);
          } finally {
            await directDone(d);
          }
        },
        T
      );

      test(
        "H-28 binding absent: today's events — no record callback, no SETTLING, chain fields at their no-hook values",
        async () => {
          const d = await direct({ script: [{ say: "ANS-ONE" }] });
          try {
            const snap = await d.s.terminal;
            expect(snap.state).toBe("COMPLETED");
            expect(d.recorded).toEqual([]);
            expect(d.transitions).toEqual([
              ["STARTING", "RUNNING"],
              ["RUNNING", "COMPLETED"],
            ]);
            const turn = d.decided[0] as SettledTurn;
            expect(turn.chainAnswers).toEqual([]);
            expect(turn.chainDelivery).toEqual(turn.delivery);
            expect(turn.hookTurns).toBe(0);
            expect(turn.hookCaused).toBe(false);
            expect(snap.pendingHookInputs).toBe(0);
          } finally {
            await directDone(d);
          }
        },
        T
      );
    }
  );

  describe.concurrent("the hold's result is applied only on current evidence", () => {
    const screenShows = (c: Chan, text: string) =>
      (c.manager.captureSession(c.id) as CaptureResult).lines.some((l) => l.includes(text));
    /** The fake starts its re-wake when this file exists: after the test saw the hold. */
    const gateFile = () => join(tmpdir(), `claudish-rewake-gate-${randomUUID()}`);

    test(
      "a re-wake whose working row shows before its records: the injection is never typed; its result is abandoned rewake",
      async () => {
        const ctl = controlled();
        const gate = gateFile();
        const c = await channel({
          script: [
            {
              say: "ANS-ONE",
              rewake: { gateFile: gate, delayMs: 100, workingMs: 2_500, say: "ANS-ONE-B" },
            },
            { say: "ANS-NEVER" },
          ],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "the hold");
          writeFileSync(gate, "");
          // The screen shows the re-woken turn working; the transcript has nothing of it yet.
          await until(() => screenShows(c, "Simmering"), "the re-wake's working row");
          ctl.calls[0]?.resolve(inject("HOOK-LATE"));
          await until(
            () => ctl.calls.length === 2 || keylog(c.t).includes("HOOK-LATE"),
            "the re-settle, or the injection typed over the running turn"
          );
          expect(keylog(c.t)).not.toContain("HOOK-LATE");
          expect(ctl.abandoned).toEqual([{ text: "HOOK-LATE", reason: "rewake" }]);
          expect(ctl.calls[1]?.turn.index).toBe(1);
          expect(ctl.calls[1]?.turn.answer).toContain("ANS-ONE-B");
          ctl.calls[1]?.resolve(nothing);
          const end = await c.terminal();
          expect(end.state).toBe("COMPLETED");
          const out = c.output();
          expect(lineCount(out, "ANS-ONE")).toBe(1);
          expect(lineCount(out, "ANS-ONE-B")).toBe(1);
        } finally {
          rmSync(gate, { force: true });
          await done(c);
        }
      },
      T
    );

    test(
      "a re-wake already in the transcript, with no frame since: the result arrives, the injection is never typed",
      async () => {
        const ctl = controlled();
        const gate = gateFile();
        const c = await channel({
          script: [
            {
              say: "ANS-ONE",
              rewake: { gateFile: gate, delayMs: 100, quietMs: 3_000, say: "ANS-ONE-B" },
            },
            { say: "ANS-NEVER" },
          ],
          binding: ctl.binding,
        });
        try {
          await until(() => ctl.calls.length === 1, "the hold");
          writeFileSync(gate, "");
          const transcript = c.t.transcriptPathFor(c.info().claudeSessionId as string);
          // Resolve the instant the re-wake's records are on disk: the pane's last poll
          // (frame-debounced, or the 1 s backstop) is older than them.
          const end = Date.now() + 20_000;
          while (!readFileSync(transcript, "utf8").includes("ANS-ONE-B")) {
            if (Date.now() > end) throw new Error("timed out waiting for the re-wake's records");
            await Bun.sleep(2);
          }
          ctl.calls[0]?.resolve(inject("HOOK-LATE"));
          await until(
            () => ctl.calls.length === 2 || keylog(c.t).includes("HOOK-LATE"),
            "the re-settle, or the injection typed over the running turn"
          );
          expect(keylog(c.t)).not.toContain("HOOK-LATE");
          // Either the result came back (abandoned rewake), or, rarely, the pane's own
          // backstop poll saw the records first and ended the hold before it arrived.
          if ((ctl.calls[0]?.signal.reason as string | undefined) !== "rewake")
            expect(ctl.abandoned).toEqual([{ text: "HOOK-LATE", reason: "rewake" }]);
          ctl.calls[1]?.resolve(nothing);
          expect((await c.terminal()).state).toBe("COMPLETED");
          expect(lineCount(c.output(), "ANS-ONE-B")).toBe(1);
        } finally {
          rmSync(gate, { force: true });
          await done(c);
        }
      },
      T
    );

    test(
      "a result that waited for a working row: a re-wake written as the row clears ends the hold; the injection is never typed",
      async () => {
        const ctl = controlled();
        const gate = gateFile();
        const c = await channel({
          script: [
            {
              say: "ANS-ONE",
              rewake: {
                gateFile: gate,
                delayMs: 100,
                workingMs: 1_500,
                clearWithRecords: true,
                quietMs: 3_000,
                say: "ANS-ONE-B",
              },
            },
            { say: "ANS-NEVER" },
          ],
          binding: ctl.binding,
          // A frame polls only 3 s after the last poll, so the frame that clears the row,
          // 1.5 s after the result's own read, comes with a view that predates the records.
          timings: { pollDebounceMs: 3_000, pollBackstopMs: 6_000 },
        });
        try {
          await until(() => ctl.calls.length === 1, "the hold");
          writeFileSync(gate, "");
          // The result arrives while the screen shows work, so it waits for the screen.
          await until(() => screenShows(c, "Simmering"), "the working row");
          ctl.calls[0]?.resolve(inject("HOOK-LATE"));
          // The row then clears in the same instant the re-wake's records land: only a
          // read made at admission sees them.
          await until(
            () => ctl.calls.length === 2 || keylog(c.t).includes("HOOK-LATE"),
            "the re-settle, or the injection typed over the running turn"
          );
          expect(keylog(c.t)).not.toContain("HOOK-LATE");
          expect(ctl.abandoned).toEqual([{ text: "HOOK-LATE", reason: "rewake" }]);
          ctl.calls[1]?.resolve(nothing);
          expect((await c.terminal()).state).toBe("COMPLETED");
          expect(lineCount(c.output(), "ANS-ONE-B")).toBe(1);
        } finally {
          rmSync(gate, { force: true });
          await done(c);
        }
      },
      T
    );
  });

  describe.concurrent("hook text never reaches the command path", () => {
    test(
      "an injection that starts with a slash is dropped delivery_unavailable and never typed",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ say: "ANS-ONE" }, { say: "ANS-NEVER" }],
          binding: ctl.binding,
          prompt: null,
        });
        try {
          await until(() => c.info().state === "AWAITING_INPUT", "boot");
          c.manager.sendInput(c.id, "Reply with the first answer.");
          await until(() => ctl.calls.length === 1, "the hold");
          // the double skips the action rules a real binding applies
          ctl.calls[0]?.resolve(inject("/model opus"));
          await until(
            () => c.info().state === "AWAITING_INPUT" && c.info().turnsCompleted === 1,
            "idle after the dropped injection"
          );
          await Bun.sleep(300);
          expect(keylog(c.t)).toEqual(["Reply with the first answer."]);
          expect(ctl.dropped).toEqual([{ text: "/model opus", reason: "delivery_unavailable" }]);
        } finally {
          await done(c);
        }
      },
      T
    );
  });

  describe.concurrent("an interactive turn a hook follows gets its own verdict", () => {
    test(
      "turn 1 ends in an API error: FAILED api_error before any injection; the injection is dropped session_ended",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ apiError: "API Error: 500 upstream failed" }, { say: "ANS-NEVER" }],
          binding: ctl.binding,
          prompt: null,
        });
        try {
          await until(() => c.info().state === "AWAITING_INPUT", "boot");
          c.manager.sendInput(c.id, "Reply with the first answer.");
          await until(() => ctl.calls.length === 1, "the hold");
          ctl.calls[0]?.resolve(inject("HOOK-AFTER-ERROR"));
          await until(
            () => TERMINAL.includes(c.info().state) || keylog(c.t).includes("HOOK-AFTER-ERROR"),
            "the verdict, or the injection typed"
          );
          expect(keylog(c.t)).not.toContain("HOOK-AFTER-ERROR");
          const end = await c.terminal();
          expect(end.state).toBe("FAILED");
          expect(end.reason).toBe("api_error");
          expect(ctl.dropped).toEqual([{ text: "HOOK-AFTER-ERROR", reason: "session_ended" }]);
        } finally {
          await done(c);
        }
      },
      T
    );

    test(
      "turn 1's task file was not read: prompt_not_read is recorded, then the injection is the next turn",
      async () => {
        const ctl = controlled();
        const c = await channel({
          script: [{ noRead: true, say: "ANS-ONE" }, { say: "ANS-TWO" }],
          binding: ctl.binding,
          prompt: null,
        });
        try {
          await until(() => c.info().state === "AWAITING_INPUT", "boot");
          c.manager.sendInput(c.id, "A caller turn\nthat goes as a file.");
          await until(() => ctl.calls.length === 1, "the hold");
          ctl.calls[0]?.resolve(inject("HOOK-NEXT"));
          await until(() => ctl.calls.length === 2, "the injected turn's hold");
          ctl.calls[1]?.resolve(nothing);
          await until(
            () => c.info().state === "AWAITING_INPUT" && c.info().turnsCompleted === 2,
            "idle"
          );
          expect(keylog(c.t)).toContain("HOOK-NEXT");
          const notRead = eventsOf(c).filter(
            (e) => e.type === "anomaly" && e.key === "prompt_not_read"
          );
          expect(notRead.map((e) => e.turn)).toEqual([1]);
        } finally {
          await done(c);
        }
      },
      T
    );
  });
});
