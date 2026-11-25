/**
 * The admission loop after a `text_mismatch` whose box stayed EMPTY, driven without a pane.
 *
 * Claude Code can draw its input box and then not read stdin for many seconds (measured
 * under concurrent boot: about 20 s). Every byte sent meanwhile queues unread, and when it
 * resumes it reads the backlog in one long read, inside which it ignores ctrl-u (measured
 * on Claude Code 2.1.330 for a read of about 64 bytes or more). So a clear and a new copy
 * sent onto a box that shows nothing land as copies joined end to end. After such a reply
 * claudish types no further copy and sends no ctrl-u until the box shows text that has stopped
 * changing: the line itself is then submitted with Enter alone; any other text is cleared and
 * the line typed again, now that Claude Code is visibly reading.
 *
 * The session is never started: the admission, the connection, the gate reading and the
 * screen are set directly, and a scripted client answers each send.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { classifySendReply, mismatchBoxStayedEmpty, writtenPrefix } from "./input-gate.js";
import type { MagmuxReply } from "./magmux-client.js";
import { MIN_MAGMUX_VERSION } from "./pane-launch.js";
import {
  PaneSessionImpl,
  type PaneSessionOptions,
  boxShowsLine,
  clearKeyCount,
  matchBoxText,
  mayHaveTyped,
  readyTimeoutFor,
} from "./pane-session.js";
import * as paneSession from "./pane-session.js";
import type { ScreenState } from "./screen-model.js";
import { wrapPrompt } from "./test-helpers/repl-wrap.js";

const LINE = "Reply with exactly PEAR.";
const COLS = 80;
const ROWS = 24;
const STAYED_EMPTY =
  "pane 0: the input box does not hold what was typed (the input box is empty; it stayed empty on every read of the whole 3s verify window (never drawn), but an empty box does not prove Claude Code read the text, so it was not retyped (a second copy could land behind the first, unread)); Enter was not pressed, nothing was submitted, and the box may hold partial text";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function session(): PaneSessionImpl {
  const root = mkdtempSync("/tmp/pem-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "empty-box-mismatch-test",
    callerFlags: [],
    spawnModel: "empty-box-mismatch-test",
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
    paneId: "empty-box-mismatch",
    sockPath: join(root, "m.sock"),
    root,
    ctlDir,
    turnDir,
  });
  cleanups.push(async () => {
    (s as any).reapPromise = Promise.resolve();
    await s.shutdownReap("empty box mismatch test cleanup");
  });
  return s;
}

/**
 * A Claude Code screen whose input box (located by the cursor) shows `text`, one box row per
 * `\n`, behind `glyph` (`❯` the normal prompt, `!` bash mode).
 */
function screenWith(text: string, glyph = "❯", menu: readonly string[] = []): ScreenState {
  const rule = "─".repeat(COLS);
  const lines = Array.from({ length: ROWS }, () => "");
  // a slash menu is drawn directly above the top rule, its last row nearest it
  menu.forEach((row, i) => {
    lines[14 - menu.length + i] = row;
  });
  const rows = text.split("\n");
  lines[14] = rule;
  // the box prompt is the glyph + NO-BREAK SPACE; an empty box is the glyph alone; a
  // wrapped row is indented two spaces
  rows.forEach((row, i) => {
    lines[15 + i] = i === 0 ? (row ? `${glyph}\u00a0${row}` : glyph) : `  ${row}`;
  });
  const last = 15 + rows.length - 1;
  lines[last + 1] = rule;
  lines[last + 2] = "  ? for shortcuts";
  return {
    seq: 1,
    cols: COLS,
    rows: ROWS,
    cursor: { x: 2 + (rows.at(-1) ?? "").length, y: last },
    lines,
    spans: lines.map(() => []),
    alt: true,
    changedAt: Date.now(),
    aboveBoxChangedAt: 0,
    // a screen built fresh on every refresh: its box counts as drawn just now
    boxChangedAt: Date.now(),
  };
}

/** A permission dialog drawn where the input box was: no rules, so no box is located. */
function dialogScreen(): ScreenState {
  const lines = Array.from({ length: ROWS }, () => "");
  lines[12] = " Bash command";
  lines[14] = " Do you want to proceed?";
  lines[15] = " \u276f 1. Yes";
  lines[16] = "   2. No";
  return { ...screenWith(""), lines, cursor: { x: 0, y: 15 }, spans: lines.map(() => []) };
}

interface Scripted {
  sends: Array<{ message: Record<string, unknown>; at: number }>;
  /** the box text the fake SCREEN shows */
  box: string;
  /** the box text the gate reading sees; null follows `box` */
  gateBox: string | null;
  /** the box prompt glyph: `❯` normal, `!` bash mode */
  glyph: string;
  /** rows of a slash menu drawn above the box (none: no menu) */
  menu: string[];
  /** false: the connection is down, so no frame or gate reading arrives */
  connected: boolean;
  /** false: a dialog is drawn over the input box, so no box is located */
  located: boolean;
  /** true: every ctrl-u send fails (the socket dropped), and the box keeps its text */
  keysFail: boolean;
  accepted: boolean;
}

const ACCEPTED: MagmuxReply = {
  ok: true,
  result: { accept: "confirmed", evidence: "history", enter: true },
};

/**
 * Wires a scripted magmux connection: typed sends answer `typed` and Enter-only sends answer
 * `enter`, each in order with the last repeating (Enter-only defaults to accepted with history
 * evidence); a ctrl-u send empties the box. The screen and gate reading refresh every 100 ms.
 */
function wire(
  s: PaneSessionImpl,
  typed: MagmuxReply[],
  enter: MagmuxReply[] = [ACCEPTED]
): Scripted {
  const sc: Scripted = {
    sends: [],
    box: "",
    gateBox: null,
    glyph: "❯",
    menu: [],
    connected: true,
    located: true,
    keysFail: false,
    accepted: false,
  };
  let typedCount = 0;
  let enterCount = 0;
  const any = s as any;
  const next = (list: MagmuxReply[], n: number) =>
    list[Math.min(n, list.length - 1)] as MagmuxReply;
  const client = {
    get isClosed() {
      return !sc.connected;
    },
    close() {},
    async request(message: Record<string, unknown>): Promise<MagmuxReply> {
      sc.sends.push({ message: { ...message }, at: Date.now() });
      if (message.noGate === true) {
        const clear = ((message.keys as string[] | undefined) ?? []).includes("ctrl-u");
        if (clear && sc.keysFail)
          return { ok: false, code: "client_lost", error: "socket closed" } as MagmuxReply;
        if (((message.keys as string[] | undefined) ?? []).includes("ctrl-u")) sc.box = "";
        return { ok: true, result: {} };
      }
      if (typeof message.text === "string") return next(typed, typedCount++);
      return next(enter, enterCount++);
    },
  };
  any.client = client;
  any.gateTrusted = true;
  const refresh = () => {
    any.gateTrusted = sc.connected;
    if (!sc.connected) return;
    if (!sc.located) {
      any.screen = dialogScreen();
      any.gate = {
        ready: false,
        reason: "dialog:permission",
        dialog: "permission",
        detail: "a permission dialog is open",
        receivedAt: Date.now(),
      };
      return;
    }
    any.screen = screenWith(sc.box, sc.glyph, sc.menu);
    const gateBox = sc.gateBox ?? sc.box;
    any.gate =
      gateBox === ""
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
  // acceptance ends the admission; the session's phase machine is not under test here
  any.accept = () => {
    sc.accepted = true;
    any.admission = null;
  };
  return sc;
}

/**
 * Runs `adm`'s loop for 5 s, over twice the 2 s the box must hold still, and ends it with its
 * deadline still far enough away for a send: a loop that sent nothing had time and room to.
 */
async function runWithRoomToSend(s: PaneSessionImpl, adm: any): Promise<void> {
  const any = s as any;
  const done = any.runAdmission(adm) as Promise<void>;
  await Bun.sleep(5_000);
  expect(readyTimeoutFor(adm.step, adm.line, adm.deadline - Date.now())).not.toBeNull();
  if (any.admission === adm) any.admission = null;
  await done;
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
    initial: true,
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

const mismatchEmpty: MagmuxReply = {
  ok: false,
  code: "not_accepted",
  reason: "text_mismatch",
  typed: true,
  boxEmpty: true,
  error: STAYED_EMPTY,
};

const isTyped = (m: Record<string, unknown>) => typeof m.text === "string";
const isClear = (m: Record<string, unknown>) =>
  m.noGate === true && Array.isArray(m.keys) && (m.keys as string[]).includes("ctrl-u");
const isEnterOnly = (m: Record<string, unknown>) =>
  m.noGate !== true && !isTyped(m) && Array.isArray(m.keys) && (m.keys as string[])[0] === "enter";
const isEscape = (m: Record<string, unknown>) =>
  Array.isArray(m.keys) && (m.keys as string[]).includes("escape");

function messagesOf(sc: Scripted, from = 0, to = Number.POSITIVE_INFINITY) {
  return sc.sends.filter(({ at }) => at >= from && at < to).map(({ message }) => message);
}

/** Starts the loop; resolves (with the loop's own promise) once the first reply left the box empty. */
async function startLoop(
  s: PaneSessionImpl,
  adm: any,
  sc: Scripted
): Promise<{ done: Promise<void> }> {
  const done = (s as any).runAdmission(adm) as Promise<void>;
  for (let i = 0; i < 200 && !(sc.sends.length > 0 && adm.awaitingDraw !== null); i++)
    await Bun.sleep(25);
  return { done };
}

describe("a text_mismatch whose box stayed empty", () => {
  test("types no second copy and sends no ctrl-u until the box shows text, then submits the drawn line with Enter", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, mismatchEmpty]);
    const adm = admit(s, 30_000);
    const { done: loop } = await startLoop(s, adm, sc);
    // Claude Code is not reading: the box shows nothing for 3.5 s, then the one copy is drawn
    await Bun.sleep(3_500);
    const drawnAt = Date.now();
    sc.box = LINE;
    await loop;
    expect(messagesOf(sc, 0, drawnAt).filter(isTyped)).toHaveLength(1);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(sc.sends.at(-1)?.message).toMatchObject({ keys: ["enter"] });
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("a second copy drawn 1 s after the first: no key between the draws, then the joined copies are cleared and the line typed once", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    const adm = admit(s, 30_000);
    const { done: loop } = await startLoop(s, adm, sc);
    await Bun.sleep(1_000);
    const firstDraw = Date.now();
    sc.box = LINE;
    // magmux's retype behind its clear, read in a second read: the ctrl-u was lost in it
    await Bun.sleep(1_000);
    const secondDraw = Date.now();
    sc.box = LINE + LINE;
    await loop;
    expect(messagesOf(sc, firstDraw, secondDraw)).toEqual([]);
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(0);
    const after = messagesOf(sc, secondDraw);
    const clearAt = after.findIndex(isClear);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(after.slice(clearAt + 1).filter(isTyped)).toHaveLength(1);
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("a partial draw that grows: no key until it stops growing, then Enter alone", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty]);
    const adm = admit(s, 30_000);
    const { done: loop } = await startLoop(s, adm, sc);
    const firstDraw = Date.now();
    sc.box = "Reply";
    await Bun.sleep(700);
    sc.box = "Reply with";
    await Bun.sleep(700);
    const lastDraw = Date.now();
    sc.box = LINE;
    await loop;
    // nothing while it grew, nor within 1.5 s of its last change
    expect(messagesOf(sc, firstDraw, lastDraw + 1_500)).toEqual([]);
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(sc.sends.at(-1)?.message).toMatchObject({ keys: ["enter"] });
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("a gate reading of box_not_empty ahead of the frame is waited out, not cleared", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty]);
    const adm = admit(s, 30_000);
    const { done: loop } = await startLoop(s, adm, sc);
    sc.gateBox = LINE;
    await Bun.sleep(1_000);
    sc.gateBox = null;
    sc.box = LINE;
    await loop;
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(sc.sends.at(-1)?.message).toMatchObject({ keys: ["enter"] });
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("Enter alone answered still_in_box: no ctrl-u and no second copy after it, only the record can accept", async () => {
    const s = session();
    const stillInBox: MagmuxReply = {
      ok: false,
      code: "not_accepted",
      reason: "still_in_box",
      typed: false,
      error: "pane 0: the text is still in the input box after Enter",
    };
    const sc = wire(s, [mismatchEmpty, ACCEPTED], [stillInBox, ACCEPTED]);
    const adm = admit(s, 30_000);
    const { done: loop } = await startLoop(s, adm, sc);
    sc.box = LINE;
    await loop;
    const all = messagesOf(sc);
    expect(all.filter(isClear)).toHaveLength(0);
    expect(all.filter(isTyped)).toHaveLength(1);
    expect(all.at(-1)).toMatchObject({ keys: ["enter"] });
    expect(adm.submittedUnproven).toBe("still_in_box");
    expect(sc.accepted).toBe(false);
  }, 20_000);

  test("Enter alone answered busy dialog:select on a plain prompt: no panel handling, the Enter is tried again", async () => {
    const s = session();
    const select: MagmuxReply = {
      ok: false,
      code: "busy",
      reason: "dialog:select",
      error: "pane 0: a selection dialog is open",
    };
    const sc = wire(s, [mismatchEmpty], [select, ACCEPTED]);
    const adm = admit(s, 30_000);
    const { done: loop } = await startLoop(s, adm, sc);
    sc.box = LINE;
    await loop;
    expect(adm.panel).toBeNull();
    expect(messagesOf(sc).filter(isEscape)).toHaveLength(0);
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(2);
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("Enter alone answered unconfirmed on a plain prompt: no panel, only the witness can accept", async () => {
    const s = session();
    const unconfirmed: MagmuxReply = {
      ok: false,
      code: "not_accepted",
      reason: "unconfirmed",
      typed: false,
      error: "pane 0: Enter was pressed with no evidence",
    };
    const sc = wire(s, [mismatchEmpty], [unconfirmed]);
    const adm = admit(s, 30_000);
    const { done: loop } = await startLoop(s, adm, sc);
    sc.box = LINE;
    await loop;
    expect(adm.panel).toBeNull();
    expect(adm.submittedUnproven).toBe("unconfirmed");
    expect(messagesOf(sc).filter(isEscape)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
  }, 20_000);

  test("a box that stays empty to the deadline ends with one copy sent and a detail that says so", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty]);
    const adm = admit(s, 16_000);
    await (s as any).runAdmission(adm);
    const messages = messagesOf(sc);
    expect(messages.filter(isTyped)).toHaveLength(1);
    expect(messages.filter(isClear)).toHaveLength(0);
    expect(sc.accepted).toBe(false);
    const line = (s as any).notAcceptedLine(adm) as string;
    expect(line).toContain("not_accepted text_mismatch");
    expect(line).toContain("the input box stayed empty");
  }, 20_000);
});

describe("after an empty-box mismatch: what the box must show before a key is sent", () => {
  test("the start of the line, held for more than the settle window, is waited out: no key until the whole line is drawn", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty]);
    const adm = admit(s, 30_000);
    const { done } = await startLoop(s, adm, sc);
    const firstRead = Date.now();
    sc.box = "Reply with";
    // the second read of the same copy, 2.5 s later
    await Bun.sleep(2_500);
    const secondRead = Date.now();
    sc.box = LINE;
    await done;
    expect(messagesOf(sc, firstRead, secondRead)).toEqual([]);
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(sc.sends.at(-1)?.message).toMatchObject({ keys: ["enter"] });
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("a foreign leftover that is no part of the line is cleared and the line typed again", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    const adm = admit(s, 30_000);
    const { done } = await startLoop(s, adm, sc);
    const drawnAt = Date.now();
    sc.box = "hello there";
    await done;
    const after = messagesOf(sc, drawnAt);
    const clearAt = after.findIndex(isClear);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(after.slice(clearAt + 1).filter(isTyped)).toHaveLength(1);
    expect(after.filter(isEnterOnly)).toHaveLength(0);
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("a socket drop after the line is drawn: no Enter until a frame after the reconnect has settled for the whole window", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty]);
    const adm = admit(s, 30_000);
    const { done } = await startLoop(s, adm, sc);
    sc.box = LINE;
    await Bun.sleep(500);
    sc.connected = false;
    await Bun.sleep(3_000);
    const reconnectAt = Date.now();
    sc.connected = true;
    await done;
    const enters = sc.sends.filter(({ message }) => isEnterOnly(message));
    expect(enters).toHaveLength(1);
    // the settle window (2 s) counts from the first fresh frame, at most 100 ms after reconnecting
    expect((enters[0]?.at ?? 0) - reconnectAt).toBeGreaterThanOrEqual(1_900);
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("the line in a bash-mode (`!`) box is other text: cleared, never submitted with Enter alone", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    const adm = admit(s, 30_000);
    const { done } = await startLoop(s, adm, sc);
    sc.glyph = "!";
    sc.box = LINE;
    const realKeys = (s as any).keys.bind(s);
    (s as any).keys = async (ks: string[]) => {
      const r = await realKeys(ks);
      // the clear empties the box and the typed resend lands in the normal prompt
      if (ks.includes("ctrl-u")) sc.glyph = "❯";
      return r;
    };
    await done;
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(0);
    expect(messagesOf(sc).filter(isClear).length).toBeGreaterThanOrEqual(1);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(2);
    expect(sc.accepted).toBe(true);
  }, 20_000);
});

describe("the Enter-only send is sized for one Enter key, whatever the line's length", () => {
  const long = "word ".repeat(103).trim();
  test("a 514-character line leaves room for its Enter where typing it again would not fit", () => {
    expect(readyTimeoutFor("submit", long, 13_900)).toBeNull();
    expect(readyTimeoutFor("enter", long, 13_900)).not.toBeNull();
    expect(readyTimeoutFor("enter", long, 13_900)).toBe(readyTimeoutFor("enter", "x", 13_900));
  });
});

describe("boxShowsLine: the box text against the line, across wrap breaks", () => {
  test("a line wrapped at a space (the space dropped at the row end) is the line", () => {
    expect(boxShowsLine("Reply with\nexactly PEAR.", LINE)).toBe(true);
  });
  test("a line wrapped inside a word is the line", () => {
    expect(boxShowsLine("Reply with exac\ntly PEAR.", LINE)).toBe(true);
  });
  test("a wrap at a double space drops both spaces at the row boundary only", () => {
    expect(boxShowsLine("a\nb", "a  b")).toBe(true);
    expect(boxShowsLine("a\n b", "a  b")).toBe(true);
  });
  test("a doubled space inside a row is other text", () => {
    expect(boxShowsLine("a  b", "a b")).toBe(false);
    expect(boxShowsLine("Reply  with exactly PEAR.", LINE)).toBe(false);
  });
  test("a space missing inside a row is other text", () => {
    expect(boxShowsLine("ab", "a b")).toBe(false);
    expect(boxShowsLine("a b", "ab")).toBe(false);
  });
  test("two copies joined are other text; the start of the line is a prefix", () => {
    expect(matchBoxText(LINE + LINE, LINE)).toBe("other");
    expect(matchBoxText("Reply with", LINE)).toBe("prefix");
    expect(matchBoxText("Reply with\nexac", LINE)).toBe("prefix");
    expect(matchBoxText("Reply wiht", LINE)).toBe("other");
  });
  test("the compared line is not trimmed: its visible part before trailing spaces is a prefix", () => {
    // the box strips each row's trailing whitespace, so spaces still unread look the same as none
    expect(matchBoxText(LINE, `${LINE}   `)).toBe("prefix");
    expect(boxShowsLine(LINE, `${LINE}   `)).toBe(false);
  });
});

describe("mismatchBoxStayedEmpty: magmux's boxEmpty field, else its own 0.20.2 prose", () => {
  const reply = (error: string, extra: Record<string, unknown> = {}): MagmuxReply =>
    ({
      ok: false,
      code: "not_accepted",
      reason: "text_mismatch",
      typed: true,
      error,
      ...extra,
    }) as MagmuxReply;
  const held = (verdict: string) =>
    `pane 0: the input box does not hold what was typed (${verdict}); Enter was not pressed, nothing was submitted, and the box may hold partial text`;
  const empty = (clause: string) => held(`the input box is empty${clause}`);

  // Each from magmux 0.20.2's source, fmt values filled in.
  const emptyCases: Array<[string, string]> = [
    ["the judgeBox empty-box verdict, no clause", empty("")],
    [
      "stayed empty, no stdin reset, the deadline cut the verify window",
      empty(
        "; it stayed empty but the terminal showed no stdin reset, and the deadline left less than the 3s verify window that tells a silent drop from a slow draw, so the text was not retyped"
      ),
    ],
    [
      "stayed empty, no stdin reset, not seen empty on every read",
      empty(
        "; it stayed empty but the terminal showed no stdin reset, and the box was not seen empty on every read for the whole 3s verify window, so the text was not retyped"
      ),
    ],
    [
      "stayed empty on every read (never drawn)",
      empty(
        "; it stayed empty on every read of the whole 3s verify window (never drawn), but an empty box does not prove Claude Code read the text, so it was not retyped (a second copy could land behind the first, unread)"
      ),
    ],
  ];
  for (const [name, error] of emptyCases) {
    test(`empty: ${name}`, () => {
      expect(mismatchBoxStayedEmpty(classifySendReply(reply(error)))).toBe(true);
    });
  }

  const heldCases: Array<[string, string]> = [
    [
      "judgeBox: new paste tokens",
      held("the box holds more than was typed: 2 new paste tokens where one was pasted"),
    ],
    [
      "judgeBox: more non-space runes",
      held("the box holds more than was typed: 42 non-space runes where 21 were typed"),
    ],
    ["judgeBox: fewer non-space runes", held("the box holds 9 of 21 non-space runes")],
    [
      "judgeBox: bash mode",
      held("the input box is in bash mode (`!`) and the send did not start with `!`"),
    ],
  ];
  for (const [name, error] of heldCases) {
    test(`not empty: ${name}`, () => {
      expect(mismatchBoxStayedEmpty(classifySendReply(reply(error)))).toBe(false);
    });
  }

  test("boxEmpty: true outranks prose that says the box holds text", () => {
    const out = classifySendReply(reply(heldCases[1]?.[1] as string, { boxEmpty: true }));
    expect(mismatchBoxStayedEmpty(out)).toBe(true);
  });

  test("boxEmpty: false outranks prose that says the box is empty", () => {
    const out = classifySendReply(reply(empty(""), { boxEmpty: false }));
    expect(mismatchBoxStayedEmpty(out)).toBe(false);
  });

  test("a reply that may have been submitted is not, whatever boxEmpty says", () => {
    const out = classifySendReply(
      reply(
        "pane 0: the input box stayed empty after typing (the input box is empty); it is unknown whether another writer's Enter submitted it, so check the conversation before sending it again; magmux pressed no Enter",
        { maybeSubmitted: true, boxEmpty: true }
      )
    );
    expect(mismatchBoxStayedEmpty(out)).toBe(false);
  });
});

describe("a text_mismatch whose box shows other text", () => {
  test("waits for the box to settle instead of clearing at once", async () => {
    const s = session();
    wire(s, []);
    const adm = admit(s, 30_000);
    await (s as any).onNotAccepted(
      adm,
      classifySendReply(
        reply2(held2("the box holds more than was typed: 42 non-space runes where 21 were typed"))
      ),
      "submit"
    );
    // the settle rules decide (`awaitDraw`): settled other text is cleared, the start of the
    // line is waited out
    expect(adm.clearFirst).toBe(false);
    expect(adm.awaitingDraw).not.toBeNull();
  }, 10_000);
});

function reply2(error: string): MagmuxReply {
  return { ok: false, code: "not_accepted", reason: "text_mismatch", typed: true, error };
}

function held2(verdict: string): string {
  return `pane 0: the input box does not hold what was typed (${verdict}); Enter was not pressed, nothing was submitted, and the box may hold partial text`;
}

describe("after an empty-box mismatch: text that ends with the start of the line", () => {
  test("other text followed by the start of the line is waited out, never cleared", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    const adm = admit(s, 30_000);
    const { done } = await startLoop(s, adm, sc);
    // a foreign draft, then the first read of our copy; the rest still unread
    sc.box = "draft text Reply with";
    await Bun.sleep(3_000);
    const heldUntil = Date.now();
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    // the rest of the copy is read: the whole line follows the draft, which is now cleared
    sc.box = `draft text ${LINE}`;
    await done;
    const after = messagesOf(sc, heldUntil);
    expect(after.findIndex(isClear)).toBeGreaterThanOrEqual(0);
    expect(after.filter(isEnterOnly)).toHaveLength(0);
    expect(sc.accepted).toBe(true);
  }, 20_000);

  test("matchBoxText reads text ending in the start of the line as a prefix", () => {
    expect(matchBoxText("draft text Reply with", LINE)).toBe("prefix");
    expect(matchBoxText("draft text\nReply with exac", LINE)).toBe("prefix");
    expect(matchBoxText(`draft text ${LINE}`, LINE)).toBe("other");
    expect(matchBoxText("draft text", LINE)).toBe("other");
  });

  // Lines whose end is also their start: a tail of "draft + line" or "line + line" is then a
  // proper prefix too, but the whole line read to its end decides first.
  const overlapping = [
    "explain the issue",
    "show the status",
    '"hello"',
    "Reply with exactly PEAR",
    "abcab",
  ];
  for (const line of overlapping) {
    test(`a line whose end overlaps its start: ${line}`, () => {
      expect(matchBoxText(line, line)).toBe("line");
      expect(matchBoxText(`draft ${line}`, line)).toBe("other");
      expect(matchBoxText(`draft${line}`, line)).toBe("other");
      expect(matchBoxText(line + line, line)).toBe("other");
      expect(matchBoxText(`draft text ${line.slice(0, -1)}`, line)).toBe("prefix");
      expect(matchBoxText(line.slice(0, -1), line)).toBe("prefix");
    });
  }

  test("a wrapped draft followed by the whole line is other text", () => {
    expect(matchBoxText("draft show the\nstatus", "show the status")).toBe("other");
    expect(matchBoxText("draft show the\nstat", "show the status")).toBe("prefix");
  });

  test("a box that showed the start of the line and went back to empty reports it stayed empty", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty]);
    const adm = admit(s, 16_000);
    const { done } = await startLoop(s, adm, sc);
    sc.box = "Reply wi";
    await Bun.sleep(1_000);
    sc.box = "";
    await done;
    const line = (s as any).notAcceptedLine(adm) as string;
    expect(line).toContain("the input box stayed empty");
    expect(line).not.toContain("start of the typed text");
  }, 20_000);
});

describe("the Enter-only budget at its boundary", () => {
  test("an Enter-only send needs its fixed part, the client slack and a 250 ms ready wait", () => {
    expect(readyTimeoutFor("enter", LINE, 13_074)).toBe(250);
    expect(readyTimeoutFor("enter", LINE, 13_073)).toBeNull();
    // an exact line first drawn 14 177 ms into a 30 s admission settles with 13 823 ms left
    expect(readyTimeoutFor("enter", LINE, 30_000 - 14_177 - 2_000)).not.toBeNull();
  });

  test("a line that settles with about 13.4 s left still gets its Enter", async () => {
    // 15.6 s: the typed SUBMIT fits (13 844 ms for this line), and the settle ends with
    // 13.4 s left, between the Enter-only need (13 074 ms) and the old one (13 824 ms)
    const s = session();
    const sc = wire(s, [mismatchEmpty]);
    const adm = admit(s, 15_600);
    const { done } = await startLoop(s, adm, sc);
    sc.box = LINE;
    await done;
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(1);
    expect(sc.accepted).toBe(true);
  }, 20_000);
});

describe("an Enter-only step answered empty_box", () => {
  test("on a plain prompt counts gate_line_left_box, and nothing is typed again", async () => {
    const s = session();
    const emptyBox: MagmuxReply = {
      ok: false,
      code: "not_accepted",
      reason: "empty_box",
      error: "pane 0: the input box is empty; Enter was not pressed",
    };
    const sc = wire(s, [mismatchEmpty], [emptyBox]);
    const adm = admit(s, 16_000);
    const { done } = await startLoop(s, adm, sc);
    sc.box = LINE;
    await done;
    const anomalies = s.snapshot().anomalies;
    expect(anomalies).toContain("gate_line_left_box");
    expect(anomalies).not.toContain("gate_command_left_box");
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
  }, 20_000);
});

/**
 * A magmux connection driven through the session's real `attach` and `onFrame`: it answers
 * `capabilities`, `watch` and a `list` bound to the session (held until `releaseList`), and
 * hands every `send` to the shared script.
 */
class AttachClient {
  isClosed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private release: () => void = () => {};
  private readonly listHeld: Promise<void>;
  constructor(
    private readonly bound: Record<string, unknown>,
    private readonly send: (m: Record<string, unknown>) => MagmuxReply
  ) {
    this.listHeld = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  on(event: string, cb: (event: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, value: unknown = {}): void {
    if (event === "disconnected") this.isClosed = true;
    for (const cb of this.listeners.get(event) ?? []) cb(value);
  }
  releaseList(): void {
    this.release();
  }
  async request(msg: Record<string, unknown>): Promise<MagmuxReply> {
    if (this.isClosed) return { ok: false, code: "client_closed", error: "closed" };
    switch (msg.type) {
      case "capabilities":
        return {
          ok: true,
          result: { protocol: 1, version: MIN_MAGMUX_VERSION, verbs: ["watch", "list", "send"] },
        };
      case "watch":
        return { ok: true, result: {} };
      case "list":
        await this.listHeld;
        return { ok: true, result: { panes: [this.bound] } };
      default:
        return this.send(msg);
    }
  }
  close(): void {
    if (!this.isClosed) this.emit("disconnected");
  }
}

/** A keyframe drawing `screenWith(box)`: every row, and the cursor in the box. */
function keyframe(box: string): Record<string, unknown> {
  const s = screenWith(box);
  return {
    type: "frame",
    pane: 0,
    key: true,
    cols: s.cols,
    rows: s.rows,
    cur: s.cursor,
    alt: true,
    lines: s.lines.map((t, y) => ({ y, t })),
  };
}

/** The session wired for real connections: `connect` attaches one, `client` builds one. */
function attached(s: PaneSessionImpl, typed: MagmuxReply[]) {
  const any = s as any;
  const state = {
    sends: [] as Array<{ message: Record<string, unknown>; at: number }>,
    accepted: false,
  };
  // only the frame and trust paths are under test: the phase machine stays still
  any.evaluate = () => {};
  any.accept = () => {
    state.accepted = true;
    any.admission = null;
  };
  let typedCount = 0;
  const bound = {
    pane: 0,
    bound: "named",
    sessionId: any.o.sessionUuid,
    transcriptPath: any.o.transcriptPath,
    gateBasis: "declared",
    input: { ready: false, reason: "box_not_empty", detail: "the input box already holds text" },
  };
  const send = (m: Record<string, unknown>): MagmuxReply => {
    state.sends.push({ message: { ...m }, at: Date.now() });
    if (m.noGate === true) return { ok: true, result: {} };
    if (typeof m.text === "string")
      return typed[Math.min(typedCount++, typed.length - 1)] as MagmuxReply;
    return ACCEPTED;
  };
  const clients: AttachClient[] = [];
  cleanups.push(() => {
    for (const c of clients) c.close();
  });
  const client = (): AttachClient => {
    const c = new AttachClient(bound, send);
    clients.push(c);
    return c;
  };
  /** A new connection through `attach`; its keyframe lands before the `list` reply that trusts it. */
  const connect = async (box: string, reconnect: boolean): Promise<AttachClient> => {
    const c = client();
    const attaching = any.attach(c, reconnect) as Promise<void>;
    for (let i = 0; i < 100 && any.client !== c; i++) await Bun.sleep(1);
    await Bun.sleep(5);
    c.emit("frame", keyframe(box));
    c.releaseList();
    await attaching;
    return c;
  };
  return { state, connect, client };
}

/** Starts the loop and waits for its empty-box mismatch. */
async function runToMismatch(s: PaneSessionImpl, adm: any): Promise<Promise<void>[]> {
  const done = (s as any).runAdmission(adm) as Promise<void>;
  for (let i = 0; i < 200 && adm.awaitingDraw === null; i++) await Bun.sleep(10);
  return [done];
}

describe("after an empty-box mismatch: only frames of the trusted connection settle the box", () => {
  test("an identical keyframe after a reconnect is fresh: Enter once it has settled for the whole window", async () => {
    const s = session();
    const { state, connect } = attached(s, [mismatchEmpty]);
    const first = await connect("", false);
    const adm = admit(s, 20_000);
    const [done] = await runToMismatch(s, adm);
    first.emit("frame", keyframe(LINE));
    await Bun.sleep(500);
    first.emit("disconnected");
    await Bun.sleep(3_000);
    // the same box as before the drop: applyFrame keeps the same screen object
    await connect(LINE, true);
    const trustedAt = Date.now();
    await done;
    const enters = state.sends.filter(({ message }) => isEnterOnly(message));
    expect(enters).toHaveLength(1);
    expect((enters[0]?.at ?? 0) - trustedAt).toBeGreaterThanOrEqual(1_900);
    expect(state.accepted).toBe(true);
  }, 30_000);

  test("a drop and reattach completed between two polls restarts the settle window", async () => {
    const s = session();
    const { state, connect, client } = attached(s, [mismatchEmpty]);
    const first = await connect("", false);
    const adm = admit(s, 20_000);
    const [done] = await runToMismatch(s, adm);
    first.emit("frame", keyframe(LINE));
    await Bun.sleep(1_500);
    // the drop, the redial and its trust all happen with no timer turn in between, so the
    // admission's 25 ms poll never sees the connection down
    const next = client();
    next.releaseList();
    first.emit("disconnected");
    const attaching = (s as any).attach(next, true) as Promise<void>;
    next.emit("frame", keyframe(LINE));
    await attaching;
    const trustedAt = Date.now();
    expect((s as any).gateTrusted).toBe(true);
    await done;
    const enters = state.sends.filter(({ message }) => isEnterOnly(message));
    expect(enters).toHaveLength(1);
    expect((enters[0]?.at ?? 0) - trustedAt).toBeGreaterThanOrEqual(1_900);
    expect(state.accepted).toBe(true);
  }, 30_000);
});

describe("an admission that expires while its copy may be unread", () => {
  const SECOND = "Now reply with exactly PLUM.";

  /** The first prompt: typed once, its box empty to the deadline, then expired. */
  async function expireFirst(s: PaneSessionImpl, sc: Scripted): Promise<void> {
    const adm = admit(s, 15_000);
    adm.initial = false;
    await (s as any).runAdmission(adm);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    (s as any).admitExpired(adm);
    // the session has to stay usable: this test drives the next admission itself
    (s as any).phase = "ADMITTING";
  }

  test("the next prompt types nothing until the old copy shows, then clears it and types its own line once", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    await expireFirst(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 30_000, SECOND);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    await Bun.sleep(2_000);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    // the old copy starts to draw: the start of ITS line, never cleared while its tail is unread
    sc.box = "Reply with";
    await Bun.sleep(2_500);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    sc.box = LINE;
    await done;
    const after = messagesOf(sc, secondAt);
    const clearAt = after.findIndex(isClear);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(after.slice(0, clearAt).filter(isTyped)).toHaveLength(0);
    const typed = after.filter(isTyped);
    expect(typed).toHaveLength(1);
    expect(typed[0]?.text).toBe(SECOND);
    expect(after.filter(isEnterOnly)).toHaveLength(0);
    expect(sc.accepted).toBe(true);
    expect((s as any).unreadCopy).toBeNull();
  }, 60_000);

  test("a box that stays empty: the next prompt expires too, with no typed send, and the copy is still remembered", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    await expireFirst(s, sc);
    const secondAt = Date.now();
    // 16 s: a typed send of SECOND would fit, so an empty send list proves the wait
    const adm = admit(s, 16_000, SECOND);
    adm.initial = false;
    await (s as any).runAdmission(adm);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    expect(sc.accepted).toBe(false);
    const line = (s as any).notAcceptedLine(adm) as string;
    expect(line).toContain("an earlier prompt");
    (s as any).admitExpired(adm);
    expect((s as any).unreadCopy).toBe(LINE);
  }, 60_000);

  test("the whole old copy shows and the box empties again: forgotten, and the next prompt types its line", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    await expireFirst(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 30_000, SECOND);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    // the whole earlier line, for less than the settle window, then an empty box
    sc.box = LINE;
    await Bun.sleep(1_000);
    sc.box = "";
    await done;
    const after = messagesOf(sc, secondAt);
    expect(after.filter(isClear)).toHaveLength(0);
    expect(after.filter(isTyped).map((m) => m.text)).toEqual([SECOND]);
    expect(sc.accepted).toBe(true);
    expect((s as any).unreadCopy).toBeNull();
  }, 60_000);

  /**
   * The next prompt after `expireFirst`, at a 16 s bound (a typed send of SECOND would fit):
   * `shows` is drawn for 1 s, the trust epoch moves if `reconnect`, then the box is empty to
   * the deadline. Nothing may be typed or cleared, and the copy stays remembered.
   */
  async function emptiedWithoutGone(shows: string, reconnect: boolean): Promise<void> {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    await expireFirst(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 16_000, SECOND);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = shows;
    await Bun.sleep(1_000);
    sc.box = "";
    if (reconnect) {
      // a drop and reattach between two polls, whose first frame shows the box empty: only
      // the trust epoch says the connection changed
      (s as any).screen = screenWith("");
      (s as any).trustEpoch++;
    }
    await done;
    expect(messagesOf(sc, secondAt)).toEqual([]);
    expect(sc.accepted).toBe(false);
    expect((s as any).notAcceptedLine(adm) as string).toContain("an earlier prompt");
    (s as any).admitExpired(adm);
    expect((s as any).unreadCopy).toBe(LINE);
  }

  test("the start of the old copy, a reconnect, then an empty box: still waiting, nothing typed", async () => {
    await emptiedWithoutGone("Reply with", true);
  }, 60_000);

  test("the start of the old copy, then an empty box: its tail may be unread, nothing typed", async () => {
    await emptiedWithoutGone("Reply with", false);
  }, 60_000);

  test("the whole old copy, a reconnect, then an empty box: what showed before the reconnect does not count", async () => {
    await emptiedWithoutGone(LINE, true);
  }, 60_000);

  test("the whole old copy, then no box located (a dialog over it): no reading counts as empty, nothing typed", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    await expireFirst(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 16_000, SECOND);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = LINE;
    await Bun.sleep(1_000);
    sc.located = false;
    await Bun.sleep(3_000);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    await done;
    expect(messagesOf(sc, secondAt)).toEqual([]);
    (s as any).admitExpired(adm);
    expect((s as any).unreadCopy).toBe(LINE);
  }, 60_000);

  test("a submit whose reply was lost, then expiry: the next prompt types nothing until the copy shows", async () => {
    const lost = { ok: false, code: "client_timeout", error: "no reply in time" } as MagmuxReply;
    const s = session();
    const sc = wire(s, [lost, ACCEPTED]);
    const first = admit(s, 15_000);
    first.initial = false;
    await (s as any).runAdmission(first);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    (s as any).admitExpired(first);
    expect((s as any).unreadCopy).toBe(LINE);
    (s as any).phase = "ADMITTING";
    // the scripted reply came back at once: the next prompt's sends start on a later millisecond
    await Bun.sleep(5);
    const secondAt = Date.now();
    const adm = admit(s, 30_000, SECOND);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    await Bun.sleep(2_500);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    sc.box = LINE;
    await done;
    const after = messagesOf(sc, secondAt);
    expect(after.filter(isClear)).toHaveLength(1);
    expect(after.filter(isTyped).map((m) => m.text)).toEqual([SECOND]);
    expect(after.findIndex(isClear)).toBeLessThan(after.findIndex(isTyped));
    expect(sc.accepted).toBe(true);
  }, 60_000);

  test("an admission stopped after a send that may have typed: its copy is remembered", async () => {
    const s = session();
    const sc = wire(s, [{ ok: false, code: "unheard_of", error: "?" } as MagmuxReply]);
    const adm = admit(s, 15_000);
    adm.initial = false;
    await (s as any).runAdmission(adm);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect((s as any).admission).toBeNull();
    expect((s as any).unreadCopy).toBe(LINE);
  }, 30_000);

  test("a clear whose ctrl-u was not sent keeps the copy and the flag; the next clear is sized for it", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    (s as any).unreadCopy = long;
    const adm = admit(s, 30_000, SECOND);
    adm.initial = false;
    adm.clearFirst = true;
    adm.clearAfter = Date.now() - 1_000;
    const want = clearKeyCount(long, 1, COLS);
    expect(want).toBeGreaterThan(clearKeyCount(SECOND, 1, COLS));
    sc.keysFail = true;
    await (s as any).clearLeftover(adm);
    expect((s as any).unreadCopy).toBe(long);
    expect(adm.clearFirst).toBe(true);
    sc.keysFail = false;
    await (s as any).clearLeftover(adm);
    const clears = messagesOf(sc).filter(isClear);
    expect(clears.map((m) => (m.keys as string[]).length)).toEqual([want, want]);
    expect((s as any).unreadCopy).toBeNull();
    expect(adm.clearFirst).toBe(false);
  }, 30_000);

  test("/quit while a copy may be unread: nothing typed while the box is empty, then cleared and typed", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    (s as any).unreadCopy = LINE;
    const quit = (s as any).submitControl("/quit") as Promise<void>;
    await Bun.sleep(3_000);
    expect(messagesOf(sc)).toEqual([]);
    sc.box = LINE;
    await quit;
    const sent = messagesOf(sc);
    expect(sent.filter(isTyped).map((m) => m.text)).toEqual(["/quit"]);
    expect(sent.findIndex(isClear)).toBe(0);
    expect((s as any).unreadCopy).toBeNull();
  }, 30_000);

  test("/quit whose copy never shows: the session's end stops the wait, and nothing is typed", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    (s as any).unreadCopy = LINE;
    const quit = (s as any).submitControl("/quit") as Promise<void>;
    await Bun.sleep(1_500);
    s.cancel();
    await quit;
    expect(messagesOf(sc).filter(isTyped)).toEqual([]);
  }, 30_000);

  test("the earlier copy's own record accepts a waiting prompt of the same text: nothing typed, the copy forgotten", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED]);
    await expireFirst(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 30_000);
    adm.initial = false;
    adm.index = 2;
    (s as any).turnIndex = 2;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    await Bun.sleep(1_000);
    (s as any).evalAdmission({ current: { index: 2, acceptedAt: new Date().toISOString() } });
    await done;
    expect(sc.accepted).toBe(true);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    expect((s as any).unreadCopy).toBeNull();
  }, 60_000);
});

describe("a text_mismatch whose box holds part of the line", () => {
  const partial: MagmuxReply = {
    ok: false,
    code: "not_accepted",
    reason: "text_mismatch",
    typed: true,
    boxEmpty: false,
    error:
      "pane 0: the input box does not hold what was typed (the box holds 9 of 21 non-space runes); Enter was not pressed, nothing was submitted, and the box may hold partial text",
  };

  test("waits while the box shows the start of the line, then sends Enter alone once the line is drawn", async () => {
    const s = session();
    const sc = wire(s, [partial]);
    const adm = admit(s, 30_000);
    const done = (s as any).runAdmission(adm) as Promise<void>;
    for (let i = 0; i < 200 && sc.sends.length === 0; i++) await Bun.sleep(5);
    // magmux saw the first write drawn; the rest of the copy is unread
    sc.box = "Reply with";
    await Bun.sleep(3_000);
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    sc.box = LINE;
    await done;
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(sc.sends.at(-1)?.message).toMatchObject({ keys: ["enter"] });
    expect(sc.accepted).toBe(true);
  }, 20_000);
});

describe("mayHaveTyped: which replies can leave a copy unread", () => {
  const outcome = (r: MagmuxReply) => classifySendReply(r);
  const reply = (fields: Record<string, unknown>) =>
    ({ ok: false, error: "x", ...fields }) as MagmuxReply;
  test("a send that may have typed and was not seen whole in the box", () => {
    expect(mayHaveTyped("submit", outcome(mismatchEmpty))).toBe(true);
    expect(mayHaveTyped("submit", outcome(reply({ code: "client_timeout" })))).toBe(true);
    expect(mayHaveTyped("type", outcome(reply({ code: "unheard_of" })))).toBe(true);
    expect(
      mayHaveTyped("submit", outcome(reply({ code: "busy", reason: "box_not_empty", typed: true })))
    ).toBe(true);
  });
  test("nothing written, Enter seen with evidence, the whole line verified before Enter, or an Enter-only send", () => {
    expect(mayHaveTyped("submit", outcome(ACCEPTED))).toBe(false);
    expect(mayHaveTyped("submit", outcome(reply({ code: "client_closed" })))).toBe(false);
    expect(mayHaveTyped("submit", outcome(reply({ code: "bad_request" })))).toBe(false);
    expect(
      mayHaveTyped(
        "submit",
        outcome(reply({ code: "busy", reason: "box_not_empty", typed: false }))
      )
    ).toBe(false);
    expect(
      mayHaveTyped(
        "submit",
        outcome(reply({ code: "not_accepted", reason: "unconfirmed", typed: true }))
      )
    ).toBe(false);
    expect(
      mayHaveTyped(
        "submit",
        outcome(reply({ code: "not_accepted", reason: "still_in_box", typed: true }))
      )
    ).toBe(false);
    expect(mayHaveTyped("enter", outcome(mismatchEmpty))).toBe(false);
  });
});

const NEXT_LINE = "Now reply with exactly PLUM.";
const LOST: MagmuxReply = {
  ok: false,
  code: "client_timeout",
  error: "no reply in time",
} as MagmuxReply;
const IN_BOX: MagmuxReply = { ok: true, result: { accept: "in_box", waitedMs: 10 } } as MagmuxReply;
const BUSY_TYPED: MagmuxReply = {
  ok: false,
  code: "busy",
  reason: "typing_in_progress",
  typed: true,
  error: "typed, Enter withheld",
} as MagmuxReply;
const THIRD = "Then reply with exactly FIG.";
const CMD = "/pear now";

/** A command admission (TYPE, then its own Enter) of `CMD`. */
function admitCommand(s: PaneSessionImpl, boundMs: number): any {
  const adm = admit(s, boundMs, CMD);
  adm.initial = false;
  adm.plan = { mode: "command", line: CMD, witness: { kind: "command", name: "pear", line: CMD } };
  adm.step = "type";
  return adm;
}

/** Appends a main-chain user record of `content` to the session's transcript. */
function writeRecord(s: PaneSessionImpl, content: string): void {
  appendFileSync(
    (s as any).o.transcriptPath as string,
    `${JSON.stringify({
      type: "user",
      isSidechain: false,
      isMeta: false,
      message: { role: "user", content },
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    })}\n`
  );
}

/** The first admission's SUBMIT reply is lost, and it expires: its copy is remembered. */
async function lostSubmit(s: PaneSessionImpl, sc: Scripted): Promise<void> {
  const first = admit(s, 15_000);
  first.initial = false;
  await (s as any).runAdmission(first);
  expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
  (s as any).admitExpired(first);
  expect((s as any).unreadCopy).toBe(LINE);
  (s as any).phase = "ADMITTING";
  await Bun.sleep(5);
}

describe("a remembered copy whose own record lands", () => {
  test("lost SUBMIT reply, empty box, its record written while the next prompt waits: forgotten, the next prompt typed once", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    await lostSubmit(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 30_000, NEXT_LINE);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    await Bun.sleep(1_000);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    writeRecord(s, LINE);
    (s as any).pollFollower(true);
    expect((s as any).unreadCopy).toBeNull();
    await done;
    const after = messagesOf(sc, secondAt);
    expect(after.filter(isClear)).toHaveLength(0);
    expect(after.filter(isTyped).map((m) => m.text)).toEqual([NEXT_LINE]);
    expect(sc.accepted).toBe(true);
    // and the prompt after that types at once: no copy is remembered
    (s as any).phase = "ADMITTING";
    sc.accepted = false;
    await Bun.sleep(5);
    const thirdAt = Date.now();
    const third = admit(s, 15_000, THIRD);
    third.initial = false;
    await (s as any).runAdmission(third);
    const typed = messagesOf(sc, thirdAt).filter(isTyped);
    expect(typed.map((m) => m.text)).toEqual([THIRD]);
    expect(sc.sends.find((x) => x.message === typed[0])?.at ?? 0).toBeLessThan(thirdAt + 1_000);
  }, 60_000);

  test("its record never lands: the next prompt expires typing nothing, and the copy stays", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    await lostSubmit(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 16_000, NEXT_LINE);
    adm.initial = false;
    await (s as any).runAdmission(adm);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    (s as any).admitExpired(adm);
    expect((s as any).unreadCopy).toBe(LINE);
  }, 60_000);

  test("its record lands while the session is idle: forgotten, the next prompt types at once", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    await lostSubmit(s, sc);
    writeRecord(s, `${LINE}${LINE}`);
    (s as any).pollFollower(true);
    expect((s as any).unreadCopy).toBeNull();
    const secondAt = Date.now();
    const adm = admit(s, 15_000, NEXT_LINE);
    adm.initial = false;
    await (s as any).runAdmission(adm);
    expect(
      messagesOf(sc, secondAt)
        .filter(isTyped)
        .map((m) => m.text)
    ).toEqual([NEXT_LINE]);
  }, 60_000);
});

describe("proof that the whole line was in the box leaves no unread bytes behind", () => {
  test("a TYPE verified in the box (in_box), then its Enter reply lost, then expiry: remembered as read whole, no key withheld", async () => {
    const s = session();
    const sc = wire(s, [IN_BOX], [LOST]);
    const adm = admitCommand(s, 30_000);
    const done = (s as any).runAdmission(adm) as Promise<void>;
    // the line drawn in the box once typed, as magmux verified it
    sc.box = CMD;
    await done;
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(1);
    (s as any).admitExpired(adm);
    expect((s as any).unreadCopy).toBe(adm.line);
    expect((s as any).unreadCopyReadWhole).toBe(true);
    expect((s as any).keysWithheld()).toBe(false);
  }, 30_000);

  test("a mismatch whose box then draws the whole line, then its Enter reply lost, then expiry: remembered as read whole, no key withheld", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty], [LOST]);
    const adm = admit(s, 30_000);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    await Bun.sleep(500);
    sc.box = LINE;
    await done;
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(1);
    (s as any).admitExpired(adm);
    expect((s as any).unreadCopy).toBe(adm.line);
    expect((s as any).unreadCopyReadWhole).toBe(true);
    expect((s as any).keysWithheld()).toBe(false);
  }, 30_000);
});

describe("replies that may have typed wait for the box before any clear", () => {
  test("a TYPE whose reply was lost: no ctrl-u and no second copy until the box settles", async () => {
    const s = session();
    const sc = wire(s, [LOST, IN_BOX], [ACCEPTED]);
    const adm = admitCommand(s, 30_000);
    const done = (s as any).runAdmission(adm) as Promise<void>;
    await Bun.sleep(2_500);
    expect(messagesOf(sc).filter(isClear)).toEqual([]);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    sc.box = CMD;
    await done;
    expect(messagesOf(sc).filter(isClear)).toEqual([]);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(1);
    expect(sc.accepted).toBe(true);
  }, 30_000);

  test("busy with the text typed: no ctrl-u and no second copy until the box settles", async () => {
    const s = session();
    const sc = wire(s, [BUSY_TYPED, ACCEPTED], [ACCEPTED]);
    const adm = admit(s, 30_000);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    await Bun.sleep(2_500);
    expect(messagesOf(sc).filter(isClear)).toEqual([]);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    sc.box = LINE;
    await done;
    expect(messagesOf(sc).filter(isClear)).toEqual([]);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(1);
    expect(sc.accepted).toBe(true);
  }, 30_000);
});

describe("without the Read tool", () => {
  test("a send_input follow-up with spaces at its ends is typed trimmed and recorded as typed_normalized", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    (s as any).o.readAvailable = false;
    (s as any).phase = "IDLE";
    s.send(`  ${LINE}  `);
    for (let i = 0; i < 80 && messagesOf(sc).filter(isTyped).length === 0; i++) await Bun.sleep(25);
    expect(
      messagesOf(sc)
        .filter(isTyped)
        .map((m) => m.text)
    ).toEqual([LINE]);
    expect(s.snapshot().anomalies).toContain("typed_normalized");
  }, 30_000);
});

describe("a send magmux stopped partway", () => {
  // 200 runes with no space: 7 writes of up to 32 runes; the first 2 carry 64
  const LONG = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  const mismatchStopped = (counts: Record<string, unknown>): MagmuxReply =>
    ({
      ok: false,
      code: "not_accepted",
      reason: "text_mismatch",
      typed: true,
      boxEmpty: false,
      error:
        "typing stopped after 2 of 7 writes (deadline), so the rest of the text was never written",
      ...counts,
    }) as MagmuxReply;

  test("writes 2 of 7 (deadline), the box settled on the written part: cleared, typed once more, no wait to the deadline", async () => {
    const s = session();
    const sc = wire(s, [
      mismatchStopped({ writes: 2, writesTotal: 7, typingStopped: "deadline" }),
      ACCEPTED,
    ]);
    sc.gateBox = null;
    const adm = admit(s, 30_000, LONG);
    adm.initial = false;
    const at = Date.now();
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = LONG.slice(0, 64);
    await done;
    const sent = messagesOf(sc);
    expect(sent.filter(isTyped)).toHaveLength(2);
    expect(sent.filter(isClear)).toHaveLength(1);
    expect(sent.findIndex(isClear)).toBeLessThan(sent.findLastIndex(isTyped));
    expect(sc.accepted).toBe(true);
    expect(Date.now() - at).toBeLessThan(10_000);
    expect(s.snapshot().anomalies).toContain("typing_stopped:deadline");
  }, 40_000);

  test("the same box with no counts: the start of the line is waited on, never cleared", async () => {
    const s = session();
    const sc = wire(s, [mismatchStopped({}), ACCEPTED]);
    const adm = admit(s, 20_000, LONG);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = LONG.slice(0, 64);
    await done;
    const sent = messagesOf(sc);
    expect(sent.filter(isTyped)).toHaveLength(1);
    expect(sent.filter(isClear)).toHaveLength(0);
    expect(sc.accepted).toBe(false);
  }, 30_000);
});

describe("the copy watch is set whenever a copy is remembered", () => {
  const CMD_WITNESS = { kind: "command" as const, name: "pear", line: CMD };
  const cmdRecord =
    "<command-message>pear</command-message>\n<command-name>/pear</command-name>\n<command-args>now</command-args>";

  /** The follower's turn for the admission `adm` (as `startAdmission` opens it). */
  function openFollowerTurn(s: PaneSessionImpl, adm: any): void {
    const any = s as any;
    any.turnIndex = adm.index;
    any.follower.openTurn({
      index: adm.index,
      offset: any.follower.size(),
      witness: adm.plan.witness,
      delivery: null,
    });
  }

  test("the copy shown whole, then gone, its record not yet polled: read while it is watched, accepted, nothing typed", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    await lostSubmit(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 30_000);
    adm.initial = false;
    adm.index = 2;
    openFollowerTurn(s, adm);
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = LINE;
    await Bun.sleep(1_000);
    // submitted: its record is in the transcript, read by the real follower at "gone"
    writeRecord(s, LINE);
    sc.box = "";
    await done;
    expect(sc.accepted).toBe(true);
    expect(messagesOf(sc, secondAt)).toEqual([]);
    expect((s as any).unreadCopy).toBeNull();
  }, 60_000);

  test("a held command whose own copy is remembered: its one record accepts it, nothing typed", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    (s as any).rememberCopy(CMD, CMD_WITNESS, 0);
    (s as any).phase = "ADMITTING";
    const secondAt = Date.now();
    const adm = admitCommand(s, 30_000);
    adm.index = 2;
    openFollowerTurn(s, adm);
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = CMD;
    await Bun.sleep(1_000);
    writeRecord(s, cmdRecord);
    sc.box = "";
    await done;
    expect(sc.accepted).toBe(true);
    expect(messagesOf(sc, secondAt)).toEqual([]);
  }, 60_000);

  test("a copy released by its record while /exit waits on it: /exit is typed once", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    (s as any).phase = "IDLE";
    (s as any).rememberCopy(LINE, { kind: "text", text: LINE }, 0);
    const sent = (s as any).submitControl("/exit") as Promise<void>;
    await Bun.sleep(1_000);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(0);
    writeRecord(s, LINE);
    (s as any).pollFollower(true);
    const r = await Promise.race([
      sent.then(() => "sent"),
      Bun.sleep(15_000).then(() => "still waiting"),
    ]);
    expect(r).toBe("sent");
    expect(
      messagesOf(sc)
        .filter(isTyped)
        .map((m) => m.text)
    ).toEqual(["/exit"]);
  }, 30_000);

  test("the expired copy's record read in the evaluate that starts the queued prompt: released, the prompt typed once", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    const any = s as any;
    const first = admit(s, 15_000);
    first.initial = false;
    await any.runAdmission(first);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    // the next prompt is queued; the copy's record lands; the deadline passes and one evaluate
    // expires the first admission and starts the next, with its own poll debounced away
    any.q.items.push({ kind: "caller", text: NEXT_LINE });
    writeRecord(s, LINE);
    first.deadline = Date.now() - 1;
    any.lastPollAt = Date.now();
    any.framePending = false;
    await Bun.sleep(5);
    const at = Date.now();
    any.evaluate();
    for (let i = 0; i < 300 && !sc.accepted; i++) await Bun.sleep(50);
    expect(any.unreadCopy).toBeNull();
    expect(
      messagesOf(sc, at)
        .filter(isTyped)
        .map((m) => m.text)
    ).toEqual([NEXT_LINE]);
  }, 60_000);
});

describe("the partly-written rule, everywhere a stopped send can be waited on", () => {
  // 200 runes in 7 writes; the first 2 writes carry 64 runes
  const LONG9 = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  // the same length, with rune 64 (the end of write 2) an ASCII space
  const SPACED = `${"b".repeat(63)} ${"c".repeat(136)}`;
  const stoppedReply = (extra: Record<string, unknown>): MagmuxReply =>
    ({
      ok: false,
      code: "not_accepted",
      reason: "text_mismatch",
      typed: true,
      boxEmpty: false,
      error:
        "typing stopped after 2 of 7 writes (deadline), so the rest of the text was never written",
      writes: 2,
      writesTotal: 7,
      typingStopped: "deadline",
      ...extra,
    }) as MagmuxReply;

  async function retypedOnce(
    line: string,
    reply: MagmuxReply,
    during?: (sc: Scripted) => Promise<void>
  ) {
    const s = session();
    const sc = wire(s, [reply, ACCEPTED]);
    sc.gateBox = null;
    const adm = admit(s, 30_000, line);
    adm.initial = false;
    const at = Date.now();
    const done = (s as any).runAdmission(adm) as Promise<void>;
    if (during) await during(sc);
    sc.box = line.slice(0, 64);
    await done;
    const sent = messagesOf(sc);
    expect(sent.filter(isTyped)).toHaveLength(2);
    expect(sent.filter(isClear)).toHaveLength(1);
    expect(sc.accepted).toBe(true);
    return { s, ms: Date.now() - at };
  }

  test("a written part that ends in an ASCII space (dropped from the drawn row) settles: cleared, typed once more", async () => {
    const { ms } = await retypedOnce(SPACED, stoppedReply({}));
    expect(ms).toBeLessThan(10_000);
  }, 40_000);

  test("a busy reply that typed and says it stopped partway: cleared, typed once more", async () => {
    const busy = {
      ok: false,
      code: "busy",
      reason: "terminal_not_ready",
      typed: true,
      writes: 2,
      writesTotal: 7,
      typingStopped: "not_ready",
      error:
        "typing stopped after 2 of 7 writes (not_ready), so the rest of the text was never written",
    } as MagmuxReply;
    const { ms } = await retypedOnce(LONG9, busy);
    expect(ms).toBeLessThan(12_000);
  }, 40_000);

  test("a stop for a runtime dialog keeps the written part: once the dialog closes, cleared, typed once more", async () => {
    const { s } = await retypedOnce(
      LONG9,
      stoppedReply({ typingStopped: "dialog" }),
      async (sc) => {
        for (let i = 0; i < 400 && sc.sends.length === 0; i++) await Bun.sleep(5);
        sc.located = false;
        await Bun.sleep(1_500);
        sc.located = true;
      }
    );
    expect(s.snapshot().anomalies).toContain("typing_stopped:dialog");
  }, 40_000);

  test("a stopped send that expires before its box settles: the next prompt clears the written part and types once", async () => {
    const s = session();
    const sc = wire(s, [stoppedReply({}), ACCEPTED]);
    sc.gateBox = null;
    const any = s as any;
    const first = admit(s, 20_000, LONG9);
    first.initial = false;
    await any.runAdmission(first);
    any.admitExpired(first);
    expect(any.unreadCopy).toBe(LONG9);
    any.phase = "ADMITTING";
    await Bun.sleep(5);
    const at = Date.now();
    const adm = admit(s, 30_000, NEXT_LINE);
    adm.initial = false;
    adm.index = 2;
    const done = any.runAdmission(adm) as Promise<void>;
    sc.box = LONG9.slice(0, 64);
    await done;
    const after = messagesOf(sc, at);
    expect(after.filter(isClear)).toHaveLength(1);
    expect(after.filter(isTyped).map((m) => m.text)).toEqual([NEXT_LINE]);
    expect(sc.accepted).toBe(true);
  }, 90_000);

  test("/exit waiting on a stopped send's copy: the written part settled is cleared, then /exit typed once", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    const any = s as any;
    any.phase = "IDLE";
    any.rememberCopy(LONG9, { kind: "text", text: LONG9 }, 0, LONG9.slice(0, 64));
    sc.box = LONG9.slice(0, 64);
    const sent = any.submitControl("/exit") as Promise<void>;
    const r = await Promise.race([
      sent.then(() => "sent"),
      Bun.sleep(15_000).then(() => "still waiting"),
    ]);
    expect(r).toBe("sent");
    expect(messagesOf(sc).filter(isClear)).toHaveLength(1);
    expect(
      messagesOf(sc)
        .filter(isTyped)
        .map((m) => m.text)
    ).toEqual(["/exit"]);
  }, 30_000);
});

describe("a late record, unproven spaces, and keys while a copy may be unread", () => {
  /** The follower's turn for the admission `adm` (as `startAdmission` opens it). */
  function openTurnFor(s: PaneSessionImpl, adm: any): void {
    const any = s as any;
    any.turnIndex = adm.index;
    any.follower.openTurn({
      index: adm.index,
      offset: any.follower.size(),
      witness: adm.plan.witness,
      delivery: null,
    });
  }

  test("the same line shown whole and gone, its record landing 3 s later (a slow prompt hook): nothing typed, accepted by that record", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    await lostSubmit(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 30_000);
    adm.initial = false;
    adm.index = 2;
    openTurnFor(s, adm);
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = LINE;
    await Bun.sleep(1_000);
    sc.box = "";
    // "gone" is read at about 2 s of an empty box; the record lands after it
    await Bun.sleep(3_000);
    expect(messagesOf(sc, secondAt).filter(isTyped)).toHaveLength(0);
    writeRecord(s, LINE);
    await done;
    expect(sc.accepted).toBe(true);
    expect(messagesOf(sc, secondAt)).toEqual([]);
  }, 60_000);

  test("the same line gone and no record before the deadline: expires with nothing typed, the copy still remembered", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    await lostSubmit(s, sc);
    const secondAt = Date.now();
    const adm = admit(s, 10_000);
    adm.initial = false;
    adm.index = 2;
    openTurnFor(s, adm);
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = LINE;
    await Bun.sleep(1_000);
    sc.box = "";
    await done;
    expect(messagesOf(sc, secondAt)).toEqual([]);
    (s as any).admitExpired(adm);
    expect((s as any).unreadCopy).toBe(LINE);
  }, 60_000);

  /** The second admission of `LINE` waits on the lost submit's copy, which shows whole, leaves, and is never recorded. */
  async function goneUnrecorded(s: PaneSessionImpl, sc: Scripted): Promise<any> {
    await lostSubmit(s, sc);
    const adm = admit(s, 8_000);
    adm.initial = false;
    adm.index = 2;
    openTurnFor(s, adm);
    const done = (s as any).runAdmission(adm) as Promise<void>;
    sc.box = LINE;
    await Bun.sleep(1_000);
    sc.box = "";
    await done;
    return adm;
  }

  test("a copy that left the box whole and is never recorded: after the deadline the detail says so, keys go again, a different prompt is typed and submitted, scroll works", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    const any = s as any;
    const adm = await goneUnrecorded(s, sc);
    expect(String(any.notAcceptedLine(adm))).toContain(
      "nothing was typed: an earlier copy of this prompt left the input box, and its transcript record did not appear in"
    );
    any.admitExpired(adm);
    expect(any.unreadCopy).toBe(LINE);
    expect(any.keysWithheld()).toBe(false);
    any.phase = "ADMITTING";
    const nextAt = Date.now();
    const next = admit(s, 30_000, NEXT_LINE);
    next.initial = false;
    next.index = 3;
    openTurnFor(s, next);
    await any.runAdmission(next);
    expect(messagesOf(sc, nextAt).filter(isTyped)).toEqual([
      expect.objectContaining({ text: NEXT_LINE }),
    ]);
    expect(sc.accepted).toBe(true);
    expect(any.unreadCopy).toBeNull();
    any.phase = "IDLE";
    any.screen = { ...any.screen, seq: 5 };
    const before = sc.sends.length;
    await s.scroll({ by: -3 });
    expect(sc.sends.length).toBe(before + 1);
  }, 60_000);

  test("a copy that left the box whole and is never recorded: /exit is typed once, with no wait for that record", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    const any = s as any;
    const adm = await goneUnrecorded(s, sc);
    any.admitExpired(adm);
    any.phase = "IDLE";
    const exitAt = Date.now();
    const sent = await Promise.race([
      (any.submitControl("/exit") as Promise<void>).then(() => true),
      Bun.sleep(8_000).then(() => false),
    ]);
    expect(sent).toBe(true);
    expect(messagesOf(sc, exitAt).filter(isTyped)).toEqual([
      expect.objectContaining({ text: "/exit" }),
    ]);
    any.phase = "COMPLETED";
  }, 60_000);

  test("a copy that left the box whole and is never recorded: the next prompt of the same text types nothing and waits for that record", async () => {
    const s = session();
    const sc = wire(s, [LOST, ACCEPTED]);
    const any = s as any;
    const adm = await goneUnrecorded(s, sc);
    any.admitExpired(adm);
    any.phase = "ADMITTING";
    const againAt = Date.now();
    const again = admit(s, 30_000);
    again.initial = false;
    again.index = 3;
    openTurnFor(s, again);
    await runWithRoomToSend(s, again);
    expect(messagesOf(sc, againAt)).toEqual([]);
    expect(s.snapshot().anomalies).toContain("unread_copy_gone_unrecorded ×2");
    expect(sc.accepted).toBe(false);
  }, 60_000);

  test("a longer copy gone (PEARPEAR), its record landing while the shorter line's send is out (PEAR): that record does not accept the shorter line", async () => {
    const OLD = "PEARPEAR";
    const NEW = "PEAR";
    const s = session();
    const sc = wire(s, [LOST]);
    const any = s as any;
    any.rememberCopy(OLD, { kind: "text", text: OLD }, any.follower.size());
    const adm = admit(s, 20_000, NEW);
    adm.initial = false;
    adm.index = 2;
    openTurnFor(s, adm);
    const request = any.client.request as (m: Record<string, unknown>) => Promise<MagmuxReply>;
    any.client.request = async (m: Record<string, unknown>) => {
      if (m.text === NEW) {
        // the departed copy's record, written before the new line's Enter
        writeRecord(s, OLD);
        await Bun.sleep(500);
      }
      return request(m);
    };
    const done = any.runAdmission(adm) as Promise<void>;
    sc.box = OLD;
    await Bun.sleep(1_000);
    sc.box = "";
    await done;
    expect(messagesOf(sc).filter(isTyped)).toEqual([expect.objectContaining({ text: NEW })]);
    expect(sc.accepted).toBe(false);
    // read now, as the next evaluate would: the departed copy's record is no witness of PEAR
    expect(any.witnessNow()).toBe(false);
  }, 40_000);

  // 10 runes, 200 spaces, 10 runes, 100 spaces, 30 runes: 11 writes; the first 7 end 4 spaces into the second run
  const BLANK_ROW = `${"a".repeat(10)}${" ".repeat(200)}${"b".repeat(10)}${" ".repeat(100)}${"c".repeat(30)}`;
  test("a written part ending in spaces, its first space run wrapped across a blank row at 80 columns: never cleared, waited on", async () => {
    const s = session();
    const stopped7: MagmuxReply = {
      ok: false,
      code: "not_accepted",
      reason: "text_mismatch",
      typed: true,
      boxEmpty: false,
      error:
        "typing stopped after 7 of 11 writes (deadline), so the rest of the text was never written",
      writes: 7,
      writesTotal: 11,
      typingStopped: "deadline",
    } as MagmuxReply;
    const sc = wire(s, [stopped7, ACCEPTED]);
    sc.gateBox = null;
    const adm = admit(s, 30_000, BLANK_ROW);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    // the written part as the 80-column box draws it: each row's trailing spaces dropped, the
    // cursor right after the last row's text, so none of the part's 4 final spaces is proved
    sc.box = wrapPrompt(writtenPrefix(BLANK_ROW, 7), COLS)
      .map((row) => row.slice(2).replace(/\s+$/, ""))
      .join("\n");
    await done;
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(sc.accepted).toBe(false);
  }, 60_000);

  test("matchBoxText: a blank wrapped row inside a space run reads as the start of the line", () => {
    const shown = wrapPrompt(writtenPrefix(BLANK_ROW, 7), COLS)
      .map((row) => row.slice(2).replace(/\s+$/, ""))
      .join("\n");
    expect(shown.split("\n")[1]).toBe("");
    expect(matchBoxText(shown, BLANK_ROW)).toBe("prefix");
  });

  test("a departed copy's late record (PEARPEAR) while a copy of PEAR is watched: the watched copy stays unseen, and nothing is typed behind it", async () => {
    const OLD = "PEARPEAR";
    const NEW = "PEAR";
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    const any = s as any;
    const after = any.follower.size();
    any.follower.refuseDeparted({ kind: "text", text: OLD }, after);
    any.rememberCopy(NEW, { kind: "text", text: NEW }, after);
    writeRecord(s, OLD);
    any.pollFollower(true);
    expect(any.unreadCopy).toBe(NEW);
    expect(any.follower.copySeen()).toBe(false);
    // a later prompt still waits on the PEAR copy: the box shows nothing, so nothing is typed
    const adm = admit(s, 30_000, NEXT_LINE);
    adm.initial = false;
    adm.index = 2;
    openTurnFor(s, adm);
    await runWithRoomToSend(s, adm);
    expect(messagesOf(sc).filter(isTyped)).toEqual([]);
    expect(any.unreadCopy).toBe(NEW);
  }, 30_000);

  // a one-line slash command wrapped at 80 columns: the first row's last cell is a no-break space
  const NBSP_CMD = `/rename ${"x".repeat(69)} ${"y".repeat(40)}`;
  test("a wrapped command whose first row ends in a no-break space, stopped partway: read as a prefix, never cleared", async () => {
    const s = session();
    const stopped3: MagmuxReply = {
      ok: false,
      code: "not_accepted",
      reason: "text_mismatch",
      typed: true,
      boxEmpty: false,
      error:
        "typing stopped after 3 of 4 writes (deadline), so the rest of the text was never written",
      writes: 3,
      writesTotal: 4,
      typingStopped: "deadline",
    } as MagmuxReply;
    const sc = wire(s, [stopped3, ACCEPTED]);
    sc.gateBox = null;
    const adm = admit(s, 30_000, NBSP_CMD);
    adm.initial = false;
    adm.plan = {
      mode: "command",
      line: NBSP_CMD,
      witness: { kind: "command", name: "rename", line: NBSP_CMD },
    };
    adm.step = "type";
    const done = (s as any).runAdmission(adm) as Promise<void>;
    // still drawing: the first row whole (its no-break space dropped with the row's end), and
    // 12 of the 18 written y's on the second
    const drawing = `${NBSP_CMD.slice(0, 77)}\n${"y".repeat(12)}`;
    sc.box = drawing;
    await done;
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(matchBoxText(drawing, NBSP_CMD)).toBe("prefix");
  }, 60_000);

  test("matchBoxText: a no-break space at a row end, dropped by the row strip, is skipped at the wrap", () => {
    expect(matchBoxText(`${NBSP_CMD.slice(0, 77)}\n${"y".repeat(40)}`, NBSP_CMD)).toBe("line");
    expect(matchBoxText(`${NBSP_CMD.slice(0, 77)}\n${"y".repeat(12)}`, NBSP_CMD)).toBe("prefix");
  });

  /** The whole line drawn after a mismatch, its Enter reply lost, then expiry. */
  async function enterLostAfterWholeLine(s: PaneSessionImpl, sc: Scripted): Promise<void> {
    const first = admit(s, 30_000);
    first.initial = false;
    openTurnFor(s, first);
    const done = (s as any).runAdmission(first) as Promise<void>;
    await Bun.sleep(500);
    sc.box = LINE;
    await done;
    expect(messagesOf(sc).filter(isEnterOnly)).toHaveLength(1);
    // Enter went: the box empties
    sc.box = "";
    (s as any).admitExpired(first);
    (s as any).phase = "ADMITTING";
    await Bun.sleep(5);
  }

  test("the whole line drawn, its Enter reply lost, expiry, the same text again: its first record accepts the retry, which sends nothing", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED], [LOST, ACCEPTED]);
    await enterLostAfterWholeLine(s, sc);
    const retryAt = Date.now();
    const retry = admit(s, 30_000);
    retry.initial = false;
    retry.index = 2;
    openTurnFor(s, retry);
    const done = (s as any).runAdmission(retry) as Promise<void>;
    await Bun.sleep(3_000);
    expect(messagesOf(sc, retryAt)).toEqual([]);
    writeRecord(s, LINE);
    await done;
    expect(messagesOf(sc, retryAt)).toEqual([]);
    expect(sc.accepted).toBe(true);
  }, 60_000);

  test("the whole line drawn, its Enter reply lost, expiry, then a different line: typed once", async () => {
    const s = session();
    const sc = wire(s, [mismatchEmpty, ACCEPTED], [LOST, ACCEPTED]);
    await enterLostAfterWholeLine(s, sc);
    const nextAt = Date.now();
    const next = admit(s, 30_000, NEXT_LINE);
    next.initial = false;
    next.index = 2;
    openTurnFor(s, next);
    await (s as any).runAdmission(next);
    expect(messagesOf(sc, nextAt).filter(isTyped)).toEqual([
      expect.objectContaining({ text: NEXT_LINE }),
    ]);
    expect(sc.accepted).toBe(true);
  }, 60_000);

  test("a command whose menu highlights another item while keys are withheld: no Escape, and no Enter", async () => {
    const s = session();
    const sc = wire(s, [IN_BOX]);
    const any = s as any;
    const adm = admitCommand(s, 30_000);
    const request = any.client.request as (m: Record<string, unknown>) => Promise<MagmuxReply>;
    any.client.request = async (m: Record<string, unknown>) => {
      if (m.text === CMD) {
        // another prompt's copy remembered while the TYPE is out: keys are withheld
        any.rememberCopy(NEXT_LINE, { kind: "text", text: NEXT_LINE }, any.follower.size());
        sc.box = CMD;
        sc.menu = ["  ❯ /pear-other   another command", "    /pear          the typed one"];
      }
      return request(m);
    };
    await any.runAdmission(adm);
    const sent = messagesOf(sc);
    expect(sent.filter(isEscape)).toHaveLength(0);
    expect(sent.filter(isEnterOnly)).toHaveLength(0);
    expect(s.snapshot().anomalies).toContain("menu_unverified");
    expect(sc.accepted).toBe(false);
  }, 60_000);

  // 32 runes, 96 spaces, then the rest: writes 4 of 7 carry the 32 runes and all 96 spaces
  const GAPPED = `${"x".repeat(32)}${" ".repeat(96)}${"y".repeat(72)}`;
  const stopped4: MagmuxReply = {
    ok: false,
    code: "not_accepted",
    reason: "text_mismatch",
    typed: true,
    boxEmpty: false,
    error:
      "typing stopped after 4 of 7 writes (deadline), so the rest of the text was never written",
    writes: 4,
    writesTotal: 7,
    typingStopped: "deadline",
  } as MagmuxReply;

  test("a written part whose spaces the screen does not show (the cursor after the text): never cleared, waited on", async () => {
    const s = session();
    const sc = wire(s, [stopped4, ACCEPTED]);
    sc.gateBox = null;
    const adm = admit(s, 14_000, GAPPED);
    adm.initial = false;
    const done = (s as any).runAdmission(adm) as Promise<void>;
    // only the first write drawn: the cursor sits right after it, none of the 96 spaces shown
    sc.box = GAPPED.slice(0, 32);
    await done;
    expect(messagesOf(sc).filter(isClear)).toHaveLength(0);
    expect(messagesOf(sc).filter(isTyped)).toHaveLength(1);
    expect(sc.accepted).toBe(false);
  }, 40_000);

  test("writtenPartShown: trailing spaces count only when the cursor proves they were drawn", () => {
    // biome-ignore lint/suspicious/noExplicitAny: read by name, so the file loads without it
    const writtenPartShown = (paneSession as any).writtenPartShown as (
      p: string,
      b: unknown
    ) => boolean;
    expect(typeof writtenPartShown).toBe("function");
    const part = `${"b".repeat(63)} `;
    // the box row shows the text; the cursor one cell after it proves the one space
    expect(writtenPartShown(part, { text: "b".repeat(63), match: "prefix", cursorGap: 1 })).toBe(
      true
    );
    expect(writtenPartShown(part, { text: "b".repeat(63), match: "prefix", cursorGap: 0 })).toBe(
      false
    );
    expect(writtenPartShown(part, { text: "b".repeat(63), match: "prefix", cursorGap: null })).toBe(
      false
    );
    const gapped = `${"x".repeat(32)}${" ".repeat(96)}`;
    expect(writtenPartShown(gapped, { text: "x".repeat(32), match: "prefix", cursorGap: 0 })).toBe(
      false
    );
    expect(
      writtenPartShown(gapped, { text: "x".repeat(16), match: "prefix", cursorGap: 112 })
    ).toBe(false);
    expect(
      writtenPartShown("x".repeat(64), { text: "x".repeat(64), match: "prefix", cursorGap: 0 })
    ).toBe(true);
  });

  test("a caller scroll while a copy may be unread is refused, and nothing is sent", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    const any = s as any;
    any.phase = "IDLE";
    any.screen = { ...any.screen, seq: 5 };
    any.rememberCopy(LINE, { kind: "text", text: LINE }, 0);
    const before = sc.sends.length;
    await expect(s.scroll({ by: -3 })).rejects.toThrow(/unread/);
    expect(sc.sends.length).toBe(before);
    any.forgetCopy();
    await s.scroll({ by: -3 });
    expect(sc.sends.length).toBe(before + 1);
  }, 30_000);

  test("a scrolled follow-up waiting on an unread copy sends no ctrl-End before that copy is resolved", async () => {
    const s = session();
    const sc = wire(s, [ACCEPTED]);
    const any = s as any;
    any.rememberCopy(LINE, { kind: "text", text: LINE }, 0);
    any.scrollPos = { atBottom: false, lastDirection: "up" };
    any.phase = "ADMITTING";
    const adm = admit(s, 30_000, NEXT_LINE);
    adm.initial = false;
    adm.index = 2;
    const done = any.runAdmission(adm) as Promise<void>;
    // the earlier copy drawn and settled: it is cleared, then the new line typed
    sc.box = LINE;
    await done;
    const sent = messagesOf(sc);
    const firstClear = sent.findIndex(isClear);
    const firstEnd = sent.findIndex((m) => m.text === "\x1b[1;5F");
    expect(firstClear).toBeGreaterThanOrEqual(0);
    if (firstEnd >= 0) expect(firstEnd).toBeGreaterThan(firstClear);
    expect(
      sent
        .filter(isTyped)
        .filter((m) => m.noGate !== true)
        .map((m) => m.text)
    ).toEqual([NEXT_LINE]);
    expect(sc.accepted).toBe(true);
  }, 60_000);
});
