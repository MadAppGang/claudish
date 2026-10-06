/**
 * PaneSession against REAL magmux and the fake interactive child (architecture §12.3).
 * Every test builds its own hermetic env and sockRoot and ends with the no-orphan check:
 * no process whose argv carries the sockRoot or the session id, nothing left in the pane
 * pgid, and no socket, record or launcher dir in the sockRoot.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotState } from "./contract.js";
import {
  type PaneBlock,
  type PaneSession,
  type PaneSessionOptions,
  startPaneSession,
} from "./pane-session.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  newSessionUuid,
  waitNoOrphans,
} from "./test-helpers/hermetic-env.js";
import type { FinalVerdict, PaneSnapshot, SettledTurn } from "./types.js";

const sha8 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);

/** Runs not yet finished: a test that throws before `finish` is cleaned up at the end. */
const open = new Set<Run>();
afterAll(async () => {
  for (const r of open) {
    r.s.cancel();
    await r.s.reaped();
    killLeftovers({ sockRoot: r.t.sockRoot, ids: [r.uuid] });
    r.t.cleanup();
  }
});

interface Run {
  s: PaneSession;
  t: PaneTestEnv;
  uuid: string;
  transitions: Array<[SlotState, SlotState]>;
  turns: SettledTurn[];
  blocks: PaneBlock[];
}

/** team-like policy: verdict at the first settle; api error → FAILED; question → FAILED blocked */
function teamDecide(turn: SettledTurn): FinalVerdict {
  if (turn.apiError) return { state: "FAILED", reason: "api_error", detail: turn.apiError.text };
  if (turn.delivery.complete === false) return { state: "FAILED", reason: "prompt_not_read" };
  if (!turn.answer.trim()) return { state: "EMPTY", reason: "empty_output" };
  return { state: "COMPLETED" };
}

async function start(
  scenario: string,
  over: Partial<PaneSessionOptions> & { env?: Record<string, string> } = {}
): Promise<Run> {
  const t = makePaneTestEnv(over.env ?? {});
  const uuid = newSessionUuid();
  const transitions: Array<[SlotState, SlotState]> = [];
  const turns: SettledTurn[] = [];
  const blocks: PaneBlock[] = [];
  const { env: _e, decide, onBlocked, ...rest } = over;
  const s = await startPaneSession({
    kind: "t",
    label: "01",
    callerFlags: [],
    spawnModel: scenario.startsWith("contract") ? scenario : `fake-${scenario}`,
    cwd: t.cwd,
    sessionUuid: uuid,
    transcriptPath: t.transcriptPathFor(uuid),
    slotEnv: {},
    shape: "one-shot",
    initialPrompt: "Reply with exactly PEAR.",
    readAvailable: true,
    parentEnv: t.env,
    sockRoot: t.sockRoot,
    decide: (turn) => {
      turns.push(turn);
      return decide ? decide(turn) : teamDecide(turn);
    },
    onBlocked: (b) => {
      blocks.push(b);
      return onBlocked ? onBlocked(b) : { state: "FAILED", reason: "blocked", detail: b.text };
    },
    onTransition: (x) => transitions.push([x.from, x.to]),
    timings: {
      replStableMs: 200,
      bootStaticMs: 800,
      corroborationMs: 200,
      ...(rest.timings ?? {}),
    },
    ...rest,
  });
  const run = { s, t, uuid, transitions, turns, blocks };
  open.add(run);
  return run;
}

/** Run to terminal, then reap, and prove nothing is left. */
async function finish(r: Run, ms = 20_000): Promise<PaneSnapshot> {
  try {
    const snap = await Promise.race([
      r.s.terminal,
      Bun.sleep(ms).then(() => {
        throw new Error(`no terminal state in ${ms} ms: ${JSON.stringify(r.s.snapshot())}`);
      }),
    ]);
    return snap;
  } finally {
    open.delete(r);
    r.s.cancel();
    await r.s.reaped();
    const left = await waitNoOrphans({
      sockRoot: r.t.sockRoot,
      ids: [r.uuid],
      pgids: [r.s.snapshot().panePid ?? 0],
    });
    killLeftovers({ sockRoot: r.t.sockRoot, ids: [r.uuid] });
    r.t.cleanup();
    expect(left).toEqual({ processes: [], files: [] });
  }
}

async function until(
  r: Run,
  pred: (s: PaneSnapshot) => boolean,
  ms = 15_000
): Promise<PaneSnapshot> {
  const end = Date.now() + ms;
  for (;;) {
    const s = r.s.snapshot();
    if (pred(s)) return s;
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms: ${JSON.stringify(s)}`);
    await Bun.sleep(50);
  }
}

const T = 40_000;

describe.skipIf(!MAGMUX)(
  `PaneSession, real magmux + fake child (${MAGMUX ? "" : NO_MAGMUX_MESSAGE})`,
  () => {
    describe.concurrent("happy path and delivery", () => {
      test(
        "answer: STARTING → RUNNING → COMPLETED on turn_duration, the typed line's hash, all reaped",
        async () => {
          const r = await start("answer");
          await r.s.ready;
          expect(r.s.snapshot().state).toBe("RUNNING");
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(r.transitions).toEqual([
            ["STARTING", "RUNNING"],
            ["RUNNING", "COMPLETED"],
          ]);
          expect(r.turns[0]?.answer).toBe(`ANSWER fake-answer ${sha8("Reply with exactly PEAR.")}`);
          expect(r.turns[0]?.settledBy).toBe("turn_duration");
          expect(r.turns[0]?.delivery.mode).toBe("typed");
          expect(snap.turnsCompleted).toBe(1);
          expect(snap.tokensIn).toBeGreaterThan(0);
          expect(snap.claudeCodeVersion).toBe("2.1.290");
        },
        T
      );

      test(
        "a multi-line prompt goes by file; Read coverage complete; the reconstructed hash equals the prompt's",
        async () => {
          const prompt = "First line.\n\tSecond line with a tab.\n! leading bang\nlast";
          const r = await start("answer", { initialPrompt: prompt });
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          const turn = r.turns[0] as SettledTurn;
          expect(turn.delivery).toMatchObject({
            mode: "file",
            linesTotal: 4,
            linesRead: 4,
            complete: true,
          });
          expect(turn.answer).toBe(`ANSWER fake-answer ${sha8(prompt)}`);
          expect(snap.toolCalls).toBe(1);
        },
        T
      );

      test(
        "long_line: a 25,000-char line is split with ↩ and joined back losslessly",
        async () => {
          const prompt = `${"word ".repeat(5000)}\nend`;
          const r = await start("long_line", { initialPrompt: prompt });
          await finish(r);
          expect(r.turns[0]?.answer).toBe(`ANSWER fake-long_line ${sha8(prompt)}`);
          expect(r.turns[0]?.delivery.complete).toBe(true);
        },
        T
      );

      test(
        "narrate_then_read: the answer starts after the Read result; ^VERDICT: matches; preamble counted",
        async () => {
          const r = await start("narrate_then_read", {
            initialPrompt: "Review this.\nReply VERDICT: ok",
            decide: (turn) =>
              /^VERDICT:/.test(turn.answer)
                ? { state: "COMPLETED" }
                : { state: "EMPTY", reason: "shape_mismatch" },
          });
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(r.turns[0]?.answer).toBe("VERDICT: ok");
          expect(r.turns[0]?.delivery.preambleBytes).toBeGreaterThan(0);
        },
        T
      );

      test(
        "partial_read / no_read: complete false → the team policy fails prompt_not_read",
        async () => {
          for (const sc of ["partial_read", "no_read"]) {
            const r = await start(sc, { initialPrompt: "a\nb\nc\nd\ne\nf" });
            const snap = await finish(r);
            expect(snap.state).toBe("FAILED");
            expect(snap.reason).toBe("prompt_not_read");
            expect(r.turns[0]?.delivery.complete).toBe(false);
            expect(r.turns[0]?.delivery.linesRead ?? 0).toBeLessThan(6);
          }
        },
        T * 2
      );

      test(
        "menu_eats_enter: the line still in the box at +resend → Enter again (resent_enter)",
        async () => {
          const r = await start("menu_eats_enter", { timings: { resendAfterMs: 800 } });
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(snap.anomalies).toContain("resent_enter");
        },
        T
      );

      test(
        "immediate_write: a witness written at once is still found (offset taken before delivery)",
        async () => {
          const snap = await finish(await start("immediate_write"));
          expect(snap.state).toBe("COMPLETED");
        },
        T
      );
    });

    describe.concurrent("settle paths", () => {
      test(
        "quiet: path S after the secondary window, with the anomaly",
        async () => {
          const r = await start("quiet", { timings: { secondaryQuietMs: 1000 } });
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(r.turns[0]?.settledBy).toBe("quiet");
          expect(snap.anomalies).toContain("settled_without_turn_duration");
        },
        T
      );

      test(
        "quiet_no_summary: never settles (activity finishing); cancel → CANCELLED",
        async () => {
          const r = await start("quiet_no_summary", { timings: { secondaryQuietMs: 500 } });
          await until(r, (s) => s.activity === "finishing");
          await Bun.sleep(1500);
          expect(r.s.snapshot().state).toBe("RUNNING");
          expect(r.s.cancel()).toEqual({ changed: true, state: "CANCELLED" });
          expect(r.s.cancel()).toEqual({ changed: false, state: "CANCELLED" });
          const snap = await finish(r);
          expect(snap.reason).toBe("cancelled");
          expect(r.turns).toHaveLength(0);
        },
        T
      );

      test(
        "hookless_quiet: turn 2 settles by S once turn 1 proved the session hook-less",
        async () => {
          const r = await start("hookless_quiet", {
            shape: "interactive",
            decide: () => "continue",
            timings: { secondaryQuietMs: 800 },
          });
          await until(r, (s) => s.state === "AWAITING_INPUT" && s.turnsCompleted === 1);
          r.s.send("second turn please");
          await until(r, (s) => s.turnsCompleted === 2);
          expect(r.turns.map((t) => t.settledBy)).toEqual(["turn_duration", "quiet"]);
          await finish(r);
        },
        T
      );

      // The secondary window is chosen ABOVE the re-wake gap (2 × the corpus p99, §2.8), so the
      // gap here is shorter than the window under test; a longer gap would open path S.
      test(
        "rewake: no settle before the late turn_duration; both texts in one answer",
        async () => {
          const r = await start("rewake", {
            env: { FAKE_GAP_MS_REWAKE: "2000" },
            timings: { secondaryQuietMs: 4000 },
          });
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(r.turns).toHaveLength(1);
          expect(r.turns[0]?.answer).toContain("LATE second message");
          expect(r.turns[0]?.answer.startsWith("ANSWER")).toBe(true);
        },
        T
      );

      test(
        "slow_stop_hook: nothing settles during the hook (3 × window); P after it",
        async () => {
          const r = await start("slow_stop_hook", {
            env: { FAKE_GAP_MS_HOOK: "3000" },
            timings: { secondaryQuietMs: 1000 },
          });
          await until(r, (s) => s.activity === "finishing");
          const at = Date.now();
          const snap = await finish(r);
          expect(Date.now() - at).toBeGreaterThan(2000);
          expect(snap.state).toBe("COMPLETED");
          expect(r.turns[0]?.settledBy).toBe("turn_duration");
        },
        T
      );

      test(
        "bg_rewake: waits for the background agent (activity background), then settles",
        async () => {
          const r = await start("bg_rewake", { env: { FAKE_GAP_MS_BG: "1500" } });
          await until(r, (s) => s.activity === "background");
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(r.turns[0]?.answer).toContain("ANSWER");
        },
        T
      );

      test(
        "bg_server: settles at turn_duration with background_shell_open; the reap ends the shell",
        async () => {
          const r = await start("bg_server");
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(
            snap.anomalies.some((a) => a.startsWith("background_shell_open: fake-dev-server"))
          ).toBe(true);
        },
        T
      );

      test(
        "compaction keeps one answer; max_tokens ends in a max_output_tokens API error; null stop settles",
        async () => {
          const c = await start("compaction");
          await finish(c);
          expect(c.turns[0]?.answer).toContain("before compaction");
          expect(c.turns[0]?.answer).toContain("ANSWER");
          const m = await start("max_tokens");
          const ms = await finish(m);
          expect(ms.reason).toBe("api_error");
          expect(m.turns[0]?.apiError?.category).toBe("max_output_tokens");
          const n = await start("null_stop");
          await finish(n);
          expect(n.turns[0]?.stopReason).toBeNull();
        },
        T * 2
      );

      test(
        "api_error → FAILED api_error; refusal continues to the fallback answer",
        async () => {
          const a = await start("api_error");
          const as = await finish(a);
          expect(as.reason).toBe("api_error");
          expect(a.turns[0]?.apiError?.status).toBe(401);
          const f = await start("refusal");
          const fs = await finish(f);
          expect(fs.state).toBe("COMPLETED");
          expect(f.turns).toHaveLength(1);
        },
        T
      );
    });

    describe.concurrent("blocked, interrupts and permission", () => {
      test(
        "ask_user (team): FAILED blocked with the question text, in one net transition",
        async () => {
          const r = await start("ask_user");
          const snap = await finish(r);
          expect(snap.state).toBe("FAILED");
          expect(snap.reason).toBe("blocked");
          expect(snap.detail).toBe("Which fruit do you prefer?");
          expect(r.transitions).toEqual([
            ["STARTING", "RUNNING"],
            ["RUNNING", "FAILED"],
          ]);
        },
        T
      );

      test(
        "ask_user_send (channel): AWAITING_INPUT; a send presses Esc → path I settles; the text is turn 2",
        async () => {
          const r = await start("ask_user_send", {
            shape: "interactive",
            onBlocked: () => "wait",
            decide: () => "continue",
          });
          const blocked = await until(
            r,
            (s) => s.state === "AWAITING_INPUT" && s.activity === "AskUserQuestion"
          );
          expect(blocked.phase).toBe("QUESTION");
          expect(r.s.send("Pear, please")).toEqual({ ok: true, queued: 1 });
          await until(r, (s) => s.turnsCompleted === 2);
          expect(r.turns[0]?.stopReason).toBe("interrupted");
          expect(r.turns[0]?.settledBy).toBe("interrupt");
          expect(r.turns[1]?.answer).toBe(`ANSWER fake-ask_user_send ${sha8("Pear, please")}`);
          await finish(r);
        },
        T
      );

      test(
        "interrupt_td: the interrupt with a turn_duration settles once",
        async () => {
          const r = await start("interrupt_td", {
            shape: "interactive",
            onBlocked: () => "wait",
            decide: () => "continue",
          });
          await until(r, (s) => s.phase === "QUESTION");
          r.s.send("next");
          await until(r, (s) => s.turnsCompleted === 2);
          expect(r.turns).toHaveLength(2);
          await finish(r);
        },
        T
      );

      test(
        "permission: AWAITING_PERMISSION with the tool as activity; cancel ends it",
        async () => {
          const r = await start("permission", {
            shape: "interactive",
            onBlocked: () => "wait",
            decide: () => "continue",
          });
          const s = await until(r, (x) => x.state === "AWAITING_PERMISSION");
          expect(s.activity).toBe("Write");
          expect(r.blocks[0]?.kind).toBe("permission");
          r.s.cancel();
          expect((await finish(r)).state).toBe("CANCELLED");
        },
        T
      );

      test(
        "tool_slow_numbered: numbered prose over a running Bash is NOT a dialog (R3-H1)",
        async () => {
          const r = await start("tool_slow_numbered", { env: { FAKE_GAP_MS_TOOL: "2500" } });
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(r.blocks).toHaveLength(0);
        },
        T
      );
    });

    describe.concurrent("exit paths", () => {
      test(
        "exit_mid_turn → FAILED child_exited with the code",
        async () => {
          const snap = await finish(await start("exit_mid_turn"));
          expect(snap.reason).toBe("child_exited");
          expect(snap.exitCode).toBe(3);
          expect(snap.detail).toContain("code 3");
        },
        T
      );

      test(
        "exit_after_settle / exit_before_td: the verdict comes from the turn, not child_exited",
        async () => {
          const a = await start("exit_after_settle");
          expect((await finish(a)).state).toBe("COMPLETED");
          const b = await start("exit_before_td");
          expect((await finish(b)).state).toBe("COMPLETED");
          expect(b.turns[0]?.settledBy).toBe("exit");
        },
        T
      );

      test(
        "interactive_exit_after_settle: turn_continue then exit_clean → COMPLETED",
        async () => {
          const r = await start("interactive_exit_after_settle", {
            shape: "interactive",
            decide: () => "continue",
          });
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(snap.turnsCompleted).toBe(1);
        },
        T
      );

      test(
        "turn2_exit0: turn 2 accepted, exit 0 before answering → FAILED child_exited (C3)",
        async () => {
          const r = await start("turn2_exit0", { shape: "interactive", decide: () => "continue" });
          await until(r, (s) => s.turnsCompleted === 1 && s.state === "AWAITING_INPUT");
          r.s.send("turn two");
          const snap = await finish(r);
          expect(snap.reason).toBe("child_exited");
        },
        T
      );

      test(
        "idle_exit: a promptless session's /exit → COMPLETED via exit_clean",
        async () => {
          const r = await start("answer", {
            shape: "interactive",
            initialPrompt: undefined,
            decide: () => "continue",
          });
          await r.s.ready;
          expect(r.s.snapshot().state).toBe("AWAITING_INPUT");
          r.s.send("/exit");
          expect((await finish(r)).state).toBe("COMPLETED");
        },
        T
      );

      test(
        "an unknown --agent → FAILED agent_rejected with the child's own line",
        async () => {
          const r = await start("answer", { callerFlags: ["--agent", "zzz-not-real"] });
          const snap = await finish(r);
          expect(snap.reason).toBe("agent_rejected");
          expect(snap.detail).toContain("--agent 'zzz-not-real' not found.");
        },
        T
      );
    });

    describe.concurrent("boot and admission bounds", () => {
      test(
        "named dialog → first_run_dialog; unnamed choice → boot_blocked (text in detail)",
        async () => {
          const a = await start("dialog_trust");
          const as = await finish(a);
          expect(as.reason).toBe("first_run_dialog");
          expect(as.detail).toContain("Is this a project you created or one you trust");
          const b = await start("dialog_unknown");
          expect((await finish(b)).reason).toBe("boot_blocked");
        },
        T
      );

      test(
        "slow_boot with a 1 s boot bound → boot_timeout",
        async () => {
          const snap = await finish(await start("slow_boot", { bootTimeoutMs: 1000 }));
          expect(snap.reason).toBe("boot_timeout");
        },
        T
      );

      test(
        "ignore_input: the created prompt never accepted → FAILED prompt_not_accepted",
        async () => {
          const snap = await finish(
            await start("ignore_input", { admitTimeoutMs: 2500, timings: { resendAfterMs: 1000 } })
          );
          expect(snap.reason).toBe("prompt_not_accepted");
        },
        T
      );

      test(
        "promptless_first_send_ignored: AWAITING_INPUT → RUNNING → AWAITING_INPUT, never STARTING or FAILED",
        async () => {
          const r = await start("promptless_first_send_ignored", {
            shape: "interactive",
            initialPrompt: undefined,
            decide: () => "continue",
            admitTimeoutMs: 2000,
            timings: { resendAfterMs: 800, degradedEntryMs: 800 },
          });
          await r.s.ready;
          r.s.send("first, ignored");
          await until(
            r,
            (s) => s.anomalies.includes("send_not_accepted") && s.state === "AWAITING_INPUT"
          );
          r.s.send("second, answered");
          await until(r, (s) => s.turnsCompleted === 1);
          await finish(r);
          expect(r.transitions.slice(0, 3)).toEqual([
            ["STARTING", "AWAITING_INPUT"],
            ["AWAITING_INPUT", "RUNNING"],
            ["RUNNING", "AWAITING_INPUT"],
          ]);
          expect(r.transitions.some(([, to]) => to === "STARTING" || to === "FAILED")).toBe(false);
        },
        T
      );

      test(
        "timeoutMs → TIMEOUT (the caller's own deadline)",
        async () => {
          const r = await start("contract-fake-model", {
            initialPrompt: "@@HANG@@",
            timeoutMs: 3500,
          });
          expect((await finish(r)).state).toBe("TIMEOUT");
        },
        T
      );
    });

    describe.concurrent("degraded mode", () => {
      test(
        "slow_prompt_hook: degraded entry, then the late witness reverts to the transcript",
        async () => {
          const r = await start("slow_prompt_hook", {
            env: { FAKE_GAP_MS_PROMPT_HOOK: "5000" },
            timings: { degradedEntryMs: 1500, resendAfterMs: 1500 },
          });
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(snap.anomalies).toContain("degraded_mode");
          expect(snap.anomalies).toContain("degraded_reverted");
          expect(r.turns[0]?.captureSource).toBe("transcript");
        },
        T
      );

      test(
        "no_transcript / missing_no_warning: settles from the screen, captureSource screen",
        async () => {
          for (const sc of ["no_transcript", "missing_no_warning"]) {
            const r = await start(sc, {
              timings: { degradedEntryMs: 800, screenSettleQuietMs: 300 },
            });
            const snap = await finish(r);
            expect(snap.state).toBe("COMPLETED");
            expect(r.turns[0]?.captureSource).toBe("screen");
            expect(r.turns[0]?.answer).toContain("ANSWER");
            expect(snap.turnSource).toBe("screen");
          }
        },
        T * 2
      );

      test(
        "screen_api_error: a degraded turn with an error row → FAILED api_error",
        async () => {
          const r = await start("screen_api_error", {
            timings: { degradedEntryMs: 800, screenSettleQuietMs: 300 },
          });
          const snap = await finish(r);
          expect(snap.reason).toBe("api_error");
        },
        T
      );
    });

    describe.concurrent("screen, capture, transport", () => {
      test(
        "capture: seq 0 means no frame; since_seq unchanged; spans on request; final after terminal",
        async () => {
          const r = await start("answer");
          await r.s.ready;
          const c1 = r.s.capture(undefined, { spans: true });
          expect("lines" in c1 && c1.lines.length === 50 && c1.cols === 160).toBe(true);
          expect("spans" in c1 && Array.isArray(c1.spans)).toBe(true);
          const same = r.s.capture((c1 as { seq: number }).seq);
          expect(same).toMatchObject({ unchanged: true });
          await r.s.terminal;
          const fin = r.s.capture();
          expect(fin.final).toBe(true);
          await finish(r);
        },
        T
      );

      test(
        "status_tick: a ticking status row under the box does not hold the settle; seq advances",
        async () => {
          const r = await start("status_tick", {
            shape: "interactive",
            decide: () => "continue",
            initialPrompt: undefined,
          });
          await r.s.ready;
          const s0 = r.s.capture().seq;
          await Bun.sleep(2200);
          expect(r.s.capture().seq).toBeGreaterThan(s0);
          r.s.send("go");
          await until(r, (s) => s.turnsCompleted === 1);
          await finish(r);
        },
        T
      );

      test(
        "idle_suggestion: faint ghost text reads as an empty box",
        async () => {
          expect((await finish(await start("idle_suggestion"))).state).toBe("COMPLETED");
        },
        T
      );

      test(
        "subscriber drop: our socket closes while magmux lives → reconnect, no state change, seq continues",
        async () => {
          const r = await start("tool_slow", { env: { FAKE_GAP_MS_TOOL: "4000" } });
          await until(r, (s) => s.activity === "Bash");
          const seq = r.s.capture().seq;
          (r.s as unknown as { client: { close(): void } }).client.close();
          await until(r, (s) => s.anomalies.includes("socket_reconnected") && s.connected);
          expect(r.s.snapshot().state).toBe("RUNNING");
          const snap = await finish(r);
          expect(snap.state).toBe("COMPLETED");
          expect(r.s.capture().seq).toBeGreaterThanOrEqual(seq);
        },
        T
      );

      test(
        "sends while RUNNING queue; the settle-then-admit step reports no AWAITING_INPUT (net onTransition)",
        async () => {
          const r = await start("tool_slow", {
            shape: "interactive",
            decide: () => "continue",
            env: { FAKE_GAP_MS_TOOL: "1500" },
          });
          await until(r, (s) => s.activity === "Bash");
          expect(r.s.send("queued one")).toEqual({ ok: true, queued: 1 });
          expect(r.s.snapshot().pendingInputs).toBe(1);
          await until(r, (s) => s.turnsCompleted === 2, 20_000);
          const toAwaiting = r.transitions.filter(([, to]) => to === "AWAITING_INPUT");
          expect(toAwaiting).toHaveLength(1); // only after turn 2
          await finish(r);
        },
        T
      );

      test(
        "send validation: /clear and /resume are unsupported; a terminal session refuses",
        async () => {
          const r = await start("answer");
          expect(r.s.send("/clear")).toEqual({ ok: false, reason: "unsupported_command" });
          await r.s.terminal;
          expect(r.s.send("x")).toEqual({ ok: false, reason: "terminal" });
          await finish(r);
        },
        T
      );

      test(
        "env_probe: the pane's env and cwd — no terminal identity, no profile sourced, markers set",
        async () => {
          const probe = join("/tmp", `pane-probe-${process.pid}-${Date.now()}.json`);
          const canary = join("/tmp", `pane-canary-${process.pid}-${Date.now()}`);
          const r0 = makePaneTestEnv();
          r0.cleanup();
          const r = await start("env_probe", {
            env: {
              FAKE_PROBE_FILE: probe,
              TMUX: "/tmp/tmux,1,0",
              TERM_PROGRAM: "iTerm.app",
              CLAUDE_CODE_SESSION_ID: "host",
            },
          });
          mkdirSync(r.t.home, { recursive: true });
          writeFileSync(
            join(r.t.home, ".zprofile"),
            `touch ${canary}\nexport CLAUDE_CONFIG_DIR=/nope\ncd /\n`
          );
          await finish(r);
          const p = JSON.parse(readFileSync(probe, "utf8")) as {
            env: Record<string, string>;
            cwd: string;
          };
          expect(p.env.TMUX).toBeUndefined();
          expect(p.env.TERM_PROGRAM).toBeUndefined();
          expect(p.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
          expect(p.env.CLAUDISH_PANE_CHILD).toBe("1");
          expect(p.env.CLAUDISH_PANE_ENV).toBeDefined();
          expect(JSON.parse(p.env.CLAUDISH_PANE_ENV as string).SHELL).toBe("/bin/zsh");
          expect(p.env.SHELL.endsWith("/sh-shim")).toBe(true);
          expect(p.env.CLAUDE_CONFIG_DIR).toBe(r.t.configDir);
          expect(p.cwd.endsWith("/cwd")).toBe(true);
          expect(existsSync(canary)).toBe(false);
        },
        T
      );

      test(
        "five sessions at once: unique ids, all reaped",
        async () => {
          const runs = await Promise.all(["a", "b", "c", "d", "e"].map(() => start("answer")));
          expect(new Set(runs.map((r) => r.s.paneId)).size).toBe(5);
          const snaps = await Promise.all(runs.map((r) => finish(r)));
          expect(snaps.every((s) => s.state === "COMPLETED")).toBe(true);
        },
        T
      );
    });
  }
);
