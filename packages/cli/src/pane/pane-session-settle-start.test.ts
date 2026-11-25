/**
 * When the settle window of a draw wait starts, driven without a pane.
 *
 * A prompt that follows an admission whose copy may still be unread waits until the input box
 * has been unchanged for `DRAW_SETTLE_MS` (2 s) before it types. The evidence is the box itself:
 * a box the trusted connection has shown empty and unchanged for 2 s already, with nothing
 * written to the pane since, rules the copy out at once. The window counts from the latest of
 * the box's last observed change, the last write to the pane, and the first frame of the
 * trusted connection, never from the start of the admission.
 *
 * An admission whose deadline leaves no room for a send records `send_no_room:<step>`.
 *
 * The session is never started: the admission, the connection and the gate reading are set
 * directly, and the screen is built from keyframes by the real screen model, so a frame that
 * changes nothing visible keeps the box's last change where it was.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MagmuxReply } from "./magmux-client.js";
import { PaneSessionImpl, type PaneSessionOptions, readyTimeoutFor } from "./pane-session.js";
import { type MagmuxFrame, emptyScreen } from "./screen-model.js";

const LINE = "Reply with exactly PEAR.";
const SECOND = "Now reply with exactly PLUM.";
const COLS = 80;
const ROWS = 24;
const SETTLE_MS = 2_000;

const ACCEPTED: MagmuxReply = {
  ok: true,
  result: { accept: "confirmed", evidence: "history", enter: true },
};
const UNCONFIRMED: MagmuxReply = {
  ok: false,
  code: "not_accepted",
  reason: "unconfirmed",
  typed: true,
  error: "pane 0: Enter was pressed with no evidence",
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function session(): PaneSessionImpl {
  const root = mkdtempSync("/tmp/pss-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "settle-start-test",
    callerFlags: [],
    spawnModel: "settle-start-test",
    cwd: root,
    sessionUuid: crypto.randomUUID(),
    transcriptPath: join(root, "transcript.jsonl"),
    slotEnv: {},
    shape: "interactive",
    readAvailable: true,
    parentEnv: { HOME: root, CLAUDE_CONFIG_DIR: configDir },
    decide: () => "continue",
    onBlocked: () => "wait",
  };
  const s = new PaneSessionImpl(opts, {
    paneId: "settle-start",
    sockPath: join(root, "m.sock"),
    root,
    ctlDir,
    turnDir,
  });
  cleanups.push(async () => {
    (s as any).reapPromise = Promise.resolve();
    (s as any).client = null;
    await s.shutdownReap("settle start test cleanup");
  });
  return s;
}

/** A keyframe of a Claude Code screen whose input box (located by the cursor) shows `box`. */
function keyframe(box: string): MagmuxFrame {
  const rule = "─".repeat(COLS);
  const lines = Array.from({ length: ROWS }, () => "");
  lines[14] = rule;
  lines[15] = box ? `❯ ${box}` : "❯";
  lines[16] = rule;
  lines[17] = "  ? for shortcuts";
  return {
    type: "frame",
    pane: 0,
    rows: ROWS,
    cols: COLS,
    key: true,
    cur: { x: 2 + box.length, y: 15 },
    lines: lines.map((t, y) => ({ y, t })),
  };
}

interface Scripted {
  sends: Array<{ message: Record<string, unknown>; at: number; doneAt: number }>;
  /** the box text the screen shows */
  box: string;
  accepted: boolean;
}

/**
 * A scripted magmux connection: typed sends answer `typed` in order (the last repeating), every
 * other send answers ok. A keyframe of the box arrives every 100 ms through the session's own
 * frame path, so the screen changes only when the box does.
 */
function wire(s: PaneSessionImpl, typed: MagmuxReply[]): Scripted {
  const sc: Scripted = { sends: [], box: "", accepted: false };
  const any = s as any;
  let typedCount = 0;
  any.client = {
    get isClosed() {
      return false;
    },
    close() {},
    async request(message: Record<string, unknown>): Promise<MagmuxReply> {
      const at = Date.now();
      const reply =
        typeof message.text === "string" && message.noGate !== true
          ? (typed[Math.min(typedCount++, typed.length - 1)] as MagmuxReply)
          : ({ ok: true, result: {} } as MagmuxReply);
      sc.sends.push({ message: { ...message }, at, doneAt: Date.now() });
      return reply;
    },
  };
  any.gateTrusted = true;
  any.screen = emptyScreen(COLS, ROWS);
  const refresh = () => {
    any.onFrame(keyframe(sc.box), any.trustedGen);
    any.gate =
      sc.box === ""
        ? { ready: true, reason: null, dialog: null, detail: null, receivedAt: Date.now() }
        : {
            ready: false,
            reason: "box_not_empty",
            dialog: null,
            detail: "the input box already holds text",
            receivedAt: Date.now(),
          };
  };
  refresh();
  const timer = setInterval(refresh, 100);
  cleanups.push(() => clearInterval(timer));
  any.accept = () => {
    sc.accepted = true;
    any.admission = null;
  };
  // no evaluation loop runs here: the admissions under test are driven directly
  any.evaluate = () => {};
  return sc;
}

/** A typed-mode admission of `line`, live, with `boundMs` until its deadline. */
function admit(s: PaneSessionImpl, boundMs: number, line = LINE): any {
  const now = Date.now();
  const adm = {
    index: 1,
    item: { kind: "prompt", text: line },
    text: line,
    plan: { mode: "typed", line, witness: { kind: "text", text: line } },
    line,
    initial: false,
    startedAt: now,
    deadline: now + boundMs,
    step: "submit",
    inFlight: false,
    attempts: 0,
    submittedUnproven: null,
    panel: null,
    stopped: false,
    clearFirst: false,
    clearAfter: 0,
    awaitingDraw: null,
    drawState: "none",
    leftoverOf: null,
    leftoverCopy: null,
    uncleared: false,
    readWhole: false,
    mark: 0,
    copyReleased: false,
    writtenPart: null,
    lostType: null,
    last: null,
    noted: new Set<string>(),
    liveBottomClient: null,
  };
  const any = s as any;
  any.phase = "ADMITTING";
  any.admission = adm;
  return adm;
}

const isTyped = (m: Record<string, unknown>) => typeof m.text === "string" && m.noGate !== true;

/**
 * The first prompt: one SUBMIT answered `unconfirmed` (the whole line was in the box, its Enter
 * unproven), then expired. Its copy is remembered as read whole, so an empty box settled for the
 * window rules it out.
 */
async function expireUnconfirmed(s: PaneSessionImpl, sc: Scripted): Promise<void> {
  const adm = admit(s, 30_000);
  await (s as any).runAdmission(adm);
  expect(sc.sends.filter(({ message }) => isTyped(message))).toHaveLength(1);
  (s as any).admitExpired(adm);
  expect((s as any).unreadCopy).toBe(LINE);
  expect((s as any).unreadCopyReadWhole).toBe(true);
  (s as any).phase = "ADMITTING";
}

/** Runs SECOND's admission to its end; the time its one typed send was made. */
async function typeSecond(s: PaneSessionImpl, sc: Scripted): Promise<number> {
  const startedAt = Date.now();
  const adm = admit(s, 30_000, SECOND);
  await (s as any).runAdmission(adm);
  const typed = sc.sends.filter(({ message, at }) => at >= startedAt && isTyped(message));
  expect(typed.map(({ message }) => message.text)).toEqual([SECOND]);
  expect(sc.accepted).toBe(true);
  expect((s as any).unreadCopy).toBeNull();
  return typed[0]?.at as number;
}

function anomalies(s: PaneSessionImpl): Map<string, number> {
  return (s as any).anomalies as Map<string, number>;
}

describe("an inherited copy: the settle window starts at the box's last change", () => {
  test("a box empty and unchanged for longer than the window, nothing written since: typed at once", async () => {
    const s = session();
    const sc = wire(s, [UNCONFIRMED, ACCEPTED]);
    await expireUnconfirmed(s, sc);
    await Bun.sleep(SETTLE_MS + 500);
    const startedAt = Date.now();
    const typedAt = await typeSecond(s, sc);
    expect(anomalies(s).get("unread_copy_gone")).toBe(1);
    expect(typedAt - startedAt).toBeLessThan(500);
  }, 30_000);

  test("the box changed 500 ms before the admission: the full window from that change", async () => {
    const s = session();
    const sc = wire(s, [UNCONFIRMED, ACCEPTED]);
    await expireUnconfirmed(s, sc);
    sc.box = "draft";
    await Bun.sleep(SETTLE_MS + 500);
    sc.box = "";
    const emptiedAt = Date.now();
    await Bun.sleep(500);
    const typedAt = await typeSecond(s, sc);
    expect(typedAt - emptiedAt).toBeGreaterThanOrEqual(SETTLE_MS);
  }, 30_000);

  test("a write to the pane 500 ms before the admission: the full window from its reply", async () => {
    const s = session();
    const sc = wire(s, [UNCONFIRMED, ACCEPTED]);
    await expireUnconfirmed(s, sc);
    await Bun.sleep(SETTLE_MS + 500);
    expect(await (s as any).keys(["ctrl-e"])).toBe(true);
    const wroteAt = sc.sends.at(-1)?.doneAt as number;
    await Bun.sleep(500);
    const typedAt = await typeSecond(s, sc);
    expect(typedAt - wroteAt).toBeGreaterThanOrEqual(SETTLE_MS);
  }, 30_000);

  test("a connection trusted 500 ms before the admission: the full window from its first frame", async () => {
    const s = session();
    const sc = wire(s, [UNCONFIRMED, ACCEPTED]);
    await expireUnconfirmed(s, sc);
    await Bun.sleep(SETTLE_MS + 500);
    const any = s as any;
    // a reattach: the new connection is trusted before its first frame, which shows the same box
    any.noteTrusted(any.trustedGen + 1);
    const trustedAt = Date.now();
    await Bun.sleep(500);
    const typedAt = await typeSecond(s, sc);
    expect(typedAt - trustedAt).toBeGreaterThanOrEqual(SETTLE_MS);
  }, 30_000);
});

describe("an admission whose deadline leaves no room for a send", () => {
  test("records send_no_room:<step> and sends nothing", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    const adm = admit(s, 5_000);
    expect(readyTimeoutFor("submit", LINE, 5_000)).toBeNull();
    await (s as any).runAdmission(adm);
    expect(sc.sends).toEqual([]);
    expect(anomalies(s).get("send_no_room:submit")).toBe(1);
  }, 30_000);
});
