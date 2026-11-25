/**
 * A gated send answered `still_in_box`: magmux pressed Enter and the line stayed in the input
 * box. Claude Code may simply not have read the Enter yet (a stalled process: the Enter byte is
 * queued behind the line, and it submits the line once it reads again). Any key or text sent now
 * queues behind that Enter and is read after it, so a ctrl-u clears nothing and a second copy is
 * submitted as well. So nothing is sent: only the line's own transcript record accepts it, up to
 * `UNPROVEN_RECORD_WAIT_MS` from the admission's start, and the copy stays remembered as unread
 * after it. An `unconfirmed` reply (Enter pressed, no evidence) waits the same way.
 *
 * The session is never started: a scripted client answers each send, the screen and the gate
 * reading are set from a box the test controls, and a ticker runs the session's evaluation.
 * `jump` moves the clock forward, so no test waits out a long bound.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { locateBox } from "./box-locate.js";
import type { SlotState } from "./contract.js";
import type { MagmuxReply } from "./magmux-client.js";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";
import type { ScreenState } from "./screen-model.js";

const LINE = "Reply with exactly PEAR.";
const NEXT_LINE = "Now reply with exactly PLUM.";
const COLS = 80;
const ROWS = 24;

const STILL_IN_BOX: MagmuxReply = {
  ok: false,
  code: "not_accepted",
  reason: "still_in_box",
  typed: true,
  error: "pane 0: the text is still in the input box after Enter",
};
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
const TYPED_NOTHING: MagmuxReply = {
  ok: false,
  code: "busy",
  reason: "no_input_box",
  typed: false,
  error: "pane 0: no input box",
};
const STILL_DETAIL =
  "magmux not_accepted still_in_box: Enter pressed, line then still in the box; last screen: ";
const UNCONFIRMED_DETAIL =
  "magmux not_accepted unconfirmed: Enter pressed, no evidence of a submit; last screen: ";
const REASON_DETAIL_MAX = 160;

const realNow = Date.now;
let clockAhead = 0;
beforeAll(() => {
  Date.now = () => realNow() + clockAhead;
});
afterAll(() => {
  Date.now = realNow;
});
/** Move the clock `ms` forward. */
function jump(ms: number): void {
  clockAhead += ms;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function session(extra: Partial<PaneSessionOptions> = {}): {
  s: PaneSessionImpl;
  transitions: Array<{ to: SlotState; at: number }>;
} {
  const root = mkdtempSync("/tmp/psib-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const transitions: Array<{ to: SlotState; at: number }> = [];
  const s = new PaneSessionImpl(
    {
      kind: "s",
      label: "still-in-box-test",
      callerFlags: [],
      spawnModel: "still-in-box-test",
      cwd: root,
      sessionUuid: crypto.randomUUID(),
      transcriptPath: join(root, "transcript.jsonl"),
      slotEnv: {},
      shape: "interactive",
      readAvailable: true,
      parentEnv: { HOME: root, CLAUDE_CONFIG_DIR: configDir },
      decide: () => "continue",
      onBlocked: () => "wait",
      onTransition: (t) => transitions.push({ to: t.to, at: Date.now() }),
      ...extra,
    },
    { paneId: "still-in-box", sockPath: join(root, "m.sock"), root, ctlDir, turnDir }
  );
  // start() was never called: there is no process, group or watcher to reap
  (s as any).reapPromise = Promise.resolve();
  cleanups.push(async () => {
    (s as any).client = null;
    await s.shutdownReap("still in box test cleanup");
  });
  return { s, transitions };
}

/** A Claude Code screen: `above` rows over the input box, which shows `box`. */
function screenWith(box: string, above: readonly string[]): ScreenState {
  const rule = "─".repeat(COLS);
  const lines = Array.from({ length: ROWS }, () => "");
  above.forEach((row, i) => {
    lines[2 + i] = row;
  });
  lines[14] = rule;
  lines[15] = box ? `❯ ${box}` : "❯";
  lines[16] = rule;
  lines[17] = "  ? for shortcuts";
  return {
    seq: 1,
    cols: COLS,
    rows: ROWS,
    cursor: { x: 2 + box.length, y: 15 },
    lines,
    spans: lines.map(() => []),
    alt: true,
    changedAt: Date.now(),
    aboveBoxChangedAt: 0,
    // a screen built fresh: its box counts as drawn just now, unless the refresh keeps the
    // held screen's box unchanged (`keepBoxChangedAt`)
    boxChangedAt: Date.now(),
  };
}

/**
 * `next`, keeping the held screen's `boxChangedAt` when its box reads the same (place, rows,
 * cursor, width), as the screen model keeps it for a frame that leaves the box alone.
 */
function keepBoxChangedAt(prev: ScreenState | undefined, next: ScreenState): ScreenState {
  const key = (s: ScreenState | undefined): string | null => {
    const box = s ? locateBox(s) : null;
    if (!s || !box) return null;
    return JSON.stringify([
      s.cols,
      box.top,
      box.bottom,
      s.cursor,
      s.lines.slice(box.top, box.bottom + 1),
    ]);
  };
  const k = key(next);
  return k !== null && prev && k === key(prev)
    ? { ...next, boxChangedAt: prev.boxChangedAt }
    : next;
}

interface Pane {
  sends: Array<{ message: Record<string, unknown>; at: number }>;
  /** what the input box shows */
  box: string;
  /** rows drawn above the box */
  above: string[];
  /** magmux's answer to a send that types `LINE`; `STILL_IN_BOX` leaves the line in the box */
  reply: MagmuxReply;
  /** the published gate reading's dialog, when `reason` is set */
  dialog: string | null;
  /** the published gate reading's reason, whatever the box holds */
  reason: string | null;
  /** no input box is drawn */
  noBox: boolean;
}

/**
 * Wires a scripted magmux: a gated send that types `LINE` answers `pane.reply` (`still_in_box`,
 * the default, leaves the line in the box); one that types any other line is accepted; a ctrl-u empties the box. The
 * screen and the gate reading follow the box every 100 ms, and the session is evaluated every
 * 250 ms, as its own ticker does.
 */
function wire(s: PaneSessionImpl): Pane {
  const pane: Pane = {
    sends: [],
    box: "",
    above: [],
    reply: STILL_IN_BOX,
    dialog: null,
    reason: null,
    noBox: false,
  };
  const any = s as any;
  any.client = {
    isClosed: false,
    close() {},
    on() {},
    async request(message: Record<string, unknown>): Promise<MagmuxReply> {
      if (message.type === "list" || message.type === "capture")
        return { ok: true, result: { panes: [] } };
      pane.sends.push({ message: { ...message }, at: Date.now() });
      if (message.noGate === true) {
        if (((message.keys as string[] | undefined) ?? []).includes("ctrl-u")) pane.box = "";
        return { ok: true, result: {} };
      }
      if (message.text === LINE) {
        if (pane.reply === STILL_IN_BOX) pane.box = LINE;
        return pane.reply;
      }
      return ACCEPTED;
    },
  };
  any.gateTrusted = true;
  const refresh = () => {
    any.screen = keepBoxChangedAt(any.screen, screenWith(pane.box, pane.above));
    if (pane.noBox) any.screen.lines[15] = "";
    any.gate =
      pane.box === "" && pane.reason === null
        ? { ready: true, reason: null, dialog: null, detail: null, receivedAt: Date.now() }
        : {
            ready: false,
            reason: pane.reason ?? "box_not_empty",
            dialog: pane.dialog,
            detail: "the input box already holds text",
            receivedAt: Date.now(),
          };
  };
  refresh();
  const screenTimer = setInterval(refresh, 100);
  const tick = setInterval(() => any.step(() => any.evaluate()), 250);
  cleanups.push(() => {
    clearInterval(screenTimer);
    clearInterval(tick);
  });
  return pane;
}

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

async function within(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(25);
  return pred();
}

/** The `still_in_box` reply's time: the send that typed `LINE` (its reply is immediate). */
async function stillInBoxAt(pane: Pane): Promise<number> {
  expect(await within(() => pane.sends.some(({ message }) => message.text === LINE), 5_000)).toBe(
    true
  );
  return pane.sends.find(({ message }) => message.text === LINE)?.at ?? 0;
}

/** Everything sent after the `still_in_box` reply. */
function sentAfter(pane: Pane, at: number) {
  const i = pane.sends.findIndex(({ at: t, message }) => t === at && message.text === LINE);
  return pane.sends.slice(i + 1).map(({ message }) => message);
}

const phaseOf = (s: PaneSessionImpl): string => (s as any).phase;

describe("still_in_box: Enter pressed, the line still in the box", () => {
  for (const pauseMs of [1_000, 10_000])
    test(`its record lands ${pauseMs / 1000} s later: accepted once, nothing sent after the reply`, async () => {
      const { s, transitions } = session({ initialPrompt: LINE, admitTimeoutMs: 30_000 });
      const pane = wire(s);
      const at = await stillInBoxAt(pane);
      await Bun.sleep(pauseMs);
      expect(phaseOf(s)).toBe("ADMITTING");
      pane.box = "";
      writeRecord(s, LINE);
      expect(await within(() => phaseOf(s) === "RUNNING", 3_000)).toBe(true);
      expect(transitions.filter(({ to }) => to === "RUNNING")).toHaveLength(1);
      expect(sentAfter(pane, at)).toEqual([]);
      expect(s.snapshot().anomalies).toContain("gate_still_in_box");
    }, 30_000);

  test("no record by the bound: prompt_not_accepted at the bound, saying what was seen, nothing sent after the reply", async () => {
    const { s, transitions } = session({
      initialPrompt: LINE,
      admitTimeoutMs: 16_000,
      timings: { unprovenRecordWaitMs: 20_000 },
    });
    const pane = wire(s);
    const at = await stillInBoxAt(pane);
    const snap = await s.terminal;
    expect(snap.state).toBe("FAILED");
    expect(snap.reason).toBe("prompt_not_accepted");
    expect(snap.detail?.split("\n")[0]).toMatch(
      new RegExp(
        `^${STILL_DETAIL}line still in the box; no transcript record of it in (19|20|21) s$`
      )
    );
    const failedAt = transitions.find(({ to }) => to === "FAILED")?.at ?? 0;
    const started = (s as any).startedAtMs as number;
    // the record wait's bound, not the admission's shorter deadline
    expect(failedAt - at).toBeGreaterThan(18_500);
    expect(failedAt - started).toBeLessThan(22_000);
    expect(sentAfter(pane, at)).toEqual([]);
  }, 40_000);

  test("the box then shows the entry submitted and empties, with no record: no key, still waiting, never accepted from the screen", async () => {
    const { s } = session({ initialPrompt: LINE, admitTimeoutMs: 30_000 });
    const pane = wire(s);
    const at = await stillInBoxAt(pane);
    await Bun.sleep(1_000);
    pane.above = [`❯ ${LINE}`, "", "✻ Thinking…"];
    pane.box = "";
    await Bun.sleep(8_000);
    expect(phaseOf(s)).toBe("ADMITTING");
    expect(s.snapshot().state).toBe("STARTING");
    expect(sentAfter(pane, at)).toEqual([]);
    writeRecord(s, LINE);
    expect(await within(() => phaseOf(s) === "RUNNING", 3_000)).toBe(true);
    expect(sentAfter(pane, at)).toEqual([]);
  }, 30_000);

  test("a later prompt after a still_in_box admission expired: nothing typed and no key while the line is in the box; typed once when it leaves", async () => {
    const { s } = session({ timings: { unprovenRecordWaitMs: 30_000 } });
    const pane = wire(s);
    const any = s as any;
    expect(await within(() => phaseOf(s) === "IDLE", 3_000)).toBe(true);
    expect(s.send(LINE)).toMatchObject({ ok: true });
    await stillInBoxAt(pane);
    expect(await within(() => phaseOf(s) === "IDLE", 35_000)).toBe(true);
    expect(s.snapshot().anomalies).toContain("send_not_accepted");
    expect(any.unreadCopy).toBe(LINE);
    expect(any.keysWithheld()).toBe(true);
    const secondAt = Date.now();
    expect(s.send(NEXT_LINE)).toMatchObject({ ok: true });
    // the stalled Claude Code: the line stays drawn and still, its Enter unread, three times as
    // long as a settled box needs
    await Bun.sleep(6_000);
    expect(pane.sends.filter(({ at }) => at >= secondAt)).toEqual([]);
    // it reads again: the Enter submits the line, and the box empties
    pane.box = "";
    expect(
      await within(() => pane.sends.some(({ message }) => message.text === NEXT_LINE), 8_000)
    ).toBe(true);
    const after = pane.sends.filter(({ at }) => at >= secondAt).map(({ message }) => message);
    expect(after.filter((m) => m.noGate === true)).toEqual([]);
    expect(after.filter((m) => typeof m.text === "string").map((m) => m.text)).toEqual([NEXT_LINE]);
  }, 80_000);

  test("a later prompt after a still_in_box admission expired, the box already empty: typed once, no key", async () => {
    const { s } = session({ timings: { unprovenRecordWaitMs: 30_000 } });
    const pane = wire(s);
    const any = s as any;
    expect(await within(() => phaseOf(s) === "IDLE", 3_000)).toBe(true);
    expect(s.send(LINE)).toMatchObject({ ok: true });
    await stillInBoxAt(pane);
    expect(await within(() => phaseOf(s) === "IDLE", 35_000)).toBe(true);
    expect(any.unreadCopy).toBe(LINE);
    // Claude Code read again before the next prompt: the line was submitted, its record late
    pane.box = "";
    await Bun.sleep(500);
    const secondAt = Date.now();
    expect(s.send(NEXT_LINE)).toMatchObject({ ok: true });
    expect(
      await within(() => pane.sends.some(({ message }) => message.text === NEXT_LINE), 10_000)
    ).toBe(true);
    const after = pane.sends.filter(({ at }) => at >= secondAt).map(({ message }) => message);
    expect(after.filter((m) => m.noGate === true)).toEqual([]);
    expect(after.filter((m) => typeof m.text === "string").map((m) => m.text)).toEqual([NEXT_LINE]);
  }, 60_000);
});

/** A created prompt sent and answered, its record awaited. */
async function unproven(reply: MagmuxReply = STILL_IN_BOX) {
  const run = session({ initialPrompt: LINE });
  const pane = wire(run.s);
  pane.reply = reply;
  const at = await stillInBoxAt(pane);
  expect(await within(() => (run.s as any).admission?.submittedUnproven != null, 2_000)).toBe(true);
  return { ...run, pane, at };
}

/** Several evaluations run at the moved clock. */
const settleTicks = () => Bun.sleep(800);

/** As if the session had started `ms` earlier. */
function ageSession(s: PaneSessionImpl, ms: number): void {
  (s as any).startedAtMs -= ms;
}

describe("Enter pressed with no proof: the record is waited for past the admission deadline", () => {
  for (const [name, reply] of [
    ["still_in_box", STILL_IN_BOX],
    ["unconfirmed", UNCONFIRMED],
  ] as const)
    for (const afterS of [45, 110])
      test(`${name}, the record ${afterS} s after the admission started: accepted once, nothing sent`, async () => {
        const { s, pane, at, transitions } = await unproven(reply);
        jump(afterS * 1000);
        await settleTicks();
        expect(phaseOf(s)).toBe("ADMITTING");
        expect(s.snapshot().state).toBe("STARTING");
        pane.box = "";
        writeRecord(s, LINE);
        expect(await within(() => phaseOf(s) === "RUNNING", 3_000)).toBe(true);
        await settleTicks();
        expect(transitions.filter(({ to }) => to === "RUNNING")).toHaveLength(1);
        expect(sentAfter(pane, at)).toEqual([]);
      }, 15_000);

  test("a submitted entry over an empty box accepts nothing, and no record by the bound fails", async () => {
    const { s, pane, at } = await unproven();
    pane.above = [`❯ ${LINE}`, "", "✽ Noodling… (running UserPromptSubmit hook · 2s)"];
    pane.box = "";
    jump(45_000);
    await settleTicks();
    expect(phaseOf(s)).toBe("ADMITTING");
    jump(60_000);
    await settleTicks();
    expect(phaseOf(s)).toBe("ADMITTING");
    jump(20_000);
    expect(await within(() => phaseOf(s) === "FAILED", 3_000)).toBe(true);
    expect(s.snapshot().reason).toBe("prompt_not_accepted");
    expect(sentAfter(pane, at)).toEqual([]);
  }, 15_000);

  test("a slow boot shortens the created prompt's wait: STARTING never outlasts boot and admission together", async () => {
    const { s } = await unproven();
    ageSession(s, 60_000);
    jump(50_000);
    await settleTicks();
    expect(phaseOf(s)).toBe("ADMITTING");
    jump(12_000);
    expect(await within(() => phaseOf(s) === "FAILED", 3_000)).toBe(true);
  }, 15_000);

  test("a boot that used its whole bound leaves the created prompt its 30 s", async () => {
    const { s } = await unproven();
    ageSession(s, 200_000);
    expect((s as any).gateWaitEnd() - Date.now()).toBeGreaterThan(4_000);
    jump(26_000);
    await settleTicks();
    expect(phaseOf(s)).toBe("ADMITTING");
    jump(5_000);
    expect(await within(() => phaseOf(s) === "FAILED", 3_000)).toBe(true);
  }, 15_000);

  test("a later prompt waits the whole bound however long the session has run, and no longer", async () => {
    const { s } = session();
    const pane = wire(s);
    expect(await within(() => phaseOf(s) === "IDLE", 3_000)).toBe(true);
    ageSession(s, 500_000);
    s.send(LINE);
    await stillInBoxAt(pane);
    jump(115_000);
    await settleTicks();
    expect(phaseOf(s)).toBe("ADMITTING");
    jump(6_000);
    expect(await within(() => phaseOf(s) === "IDLE", 3_000)).toBe(true);
    expect(s.snapshot().anomalies).toContain("send_not_accepted");
  }, 15_000);

  test("a prompt queued behind it is not sent during the wait", async () => {
    const { s } = session();
    const pane = wire(s);
    expect(await within(() => phaseOf(s) === "IDLE", 3_000)).toBe(true);
    s.send(LINE);
    const at = await stillInBoxAt(pane);
    s.send(NEXT_LINE);
    for (let i = 0; i < 3; i++) {
      jump(35_000);
      await settleTicks();
      expect(phaseOf(s)).toBe("ADMITTING");
      expect(sentAfter(pane, at)).toEqual([]);
    }
    pane.box = "";
    writeRecord(s, LINE);
    expect(await within(() => phaseOf(s) === "RUNNING", 3_000)).toBe(true);
    expect(sentAfter(pane, at)).toEqual([]);
  }, 15_000);

  test("a command's panel up past the deadline gets no Escape", async () => {
    const { s, pane, at } = await unproven(UNCONFIRMED);
    jump(45_000);
    await settleTicks();
    expect(phaseOf(s)).toBe("ADMITTING");
    (s as any).admission.panel = { showingSince: null, escaped: false, entered: true };
    pane.above = ["Esc to cancel"];
    pane.reason = "no_input_box";
    for (let i = 0; i < 3; i++) await settleTicks();
    expect(phaseOf(s)).toBe("ADMITTING");
    expect(sentAfter(pane, at)).toEqual([]);
  }, 15_000);

  test("the whole wait sends nothing, whatever the box shows", async () => {
    const { s, pane, at } = await unproven();
    for (const box of [LINE, "", "Reply with", "something else", ""]) {
      pane.box = box;
      jump(15_000);
      await settleTicks();
    }
    expect(phaseOf(s)).toBe("ADMITTING");
    expect(sentAfter(pane, at)).toEqual([]);
  }, 15_000);

  test("a reconnect during the wait still gives magmux its time to report the input view", async () => {
    const { s } = await unproven();
    jump(45_000);
    await settleTicks();
    expect(phaseOf(s)).toBe("ADMITTING");
    expect((s as any).gateWaitEnd() - Date.now()).toBeGreaterThan(4_000);
  }, 15_000);

  for (const [name, dialog, reason, expected] of [
    ["a first-run screen", "onboarding", "dialog:onboarding", "first_run_dialog"],
    ["a trust dialog", "trust", "dialog:trust", "first_run_dialog"],
    ["vim mode", null, "vim_mode", "prompt_not_accepted"],
  ] as const)
    test(`${name} during the wait fails the prompt at once`, async () => {
      const { s, pane, at } = await unproven();
      jump(45_000);
      await settleTicks();
      expect(phaseOf(s)).toBe("ADMITTING");
      pane.dialog = dialog;
      pane.reason = reason;
      expect(await within(() => phaseOf(s) === "FAILED", 2_000)).toBe(true);
      expect(s.snapshot().reason).toBe(expected);
      expect(sentAfter(pane, at)).toEqual([]);
    }, 15_000);

  const ends: Array<[string, (s: PaneSessionImpl) => void, string]> = [
    ["cancel", (s) => s.cancel(), "CANCELLED"],
    ["the session timeout", (s) => s.expire(), "TIMEOUT"],
    ["the pane's exit", (s) => void (s as any).onPaneExit({ exitCode: 1 }), "FAILED"],
    ["magmux's exit", (s) => (s as any).onMagmuxExit(1, null), "FAILED"],
    [
      "a lost pane",
      (s) => (s as any).step(() => (s as any).fire("pane_lost", { detail: "lost" })),
      "FAILED",
    ],
  ];
  for (const [name, end, state] of ends)
    test(`${name} during the wait ends it at once, with nothing left that acts later`, async () => {
      const { s, pane, at, transitions } = await unproven();
      jump(45_000);
      await settleTicks();
      expect(phaseOf(s)).toBe("ADMITTING");
      end(s);
      expect(await within(() => s.snapshot().state === state, 1_000)).toBe(true);
      expect((s as any).admission).toBeNull();
      expect((s as any).timeoutTimer ?? null).toBeNull();
      expect((s as any).endGatePause ?? null).toBeNull();
      const seen = transitions.length;
      jump(200_000);
      writeRecord(s, LINE);
      await settleTicks();
      expect(transitions).toHaveLength(seen);
      expect(s.snapshot().state).toBe(state as SlotState);
      expect(sentAfter(pane, at)).toEqual([]);
    }, 15_000);

  test("nothing typed: the 30 s deadline is unchanged", async () => {
    const { s } = session({ initialPrompt: LINE });
    const pane = wire(s);
    pane.reply = TYPED_NOTHING;
    await stillInBoxAt(pane);
    jump(26_000);
    await Bun.sleep(300);
    expect(phaseOf(s)).toBe("ADMITTING");
    jump(5_000);
    expect(await within(() => phaseOf(s) === "FAILED", 3_000)).toBe(true);
    expect(s.snapshot().reason).toBe("prompt_not_accepted");
  }, 15_000);

  test("a lost reply keeps the 30 s deadline", async () => {
    const { s } = await unproven({ ok: false, code: "client_lost", error: "connection closed" });
    jump(31_000);
    expect(await within(() => phaseOf(s) === "FAILED", 3_000)).toBe(true);
  }, 15_000);
});

describe("the failure's first line says only what was seen", () => {
  const screens: Array<[string, (pane: Pane) => void, string]> = [
    [
      "the line in the box",
      (p) => {
        p.box = LINE;
      },
      "line still in the box",
    ],
    [
      "an empty box",
      (p) => {
        p.box = "";
      },
      "box empty",
    ],
    [
      "a submitted entry over an empty box",
      (p) => {
        p.above = [`❯ ${LINE}`, "", "✽ Noodling…"];
        p.box = "";
      },
      "a submitted entry of the line",
    ],
    [
      "no located box",
      (p) => {
        p.noBox = true;
      },
      "box not located",
    ],
    [
      "other text in the box",
      (p) => {
        p.box = "something else";
      },
      "other text in the box",
    ],
  ];
  for (const [reason, reply, head] of [
    ["still_in_box", STILL_IN_BOX, STILL_DETAIL],
    ["unconfirmed", UNCONFIRMED, UNCONFIRMED_DETAIL],
  ] as const)
    for (const [name, draw, shown] of screens)
      test(`${reason}, the last screen showing ${name}`, async () => {
        const { s, pane } = await unproven(reply);
        draw(pane);
        await Bun.sleep(300);
        jump(125_000);
        expect(await within(() => phaseOf(s) === "FAILED", 3_000)).toBe(true);
        const line = s.snapshot().detail?.split("\n")[0] ?? "";
        expect(line).toMatch(new RegExp(`^${head}${shown}; no transcript record of it in \\d+ s$`));
        expect(line.length).toBeLessThanOrEqual(REASON_DETAIL_MAX);
      }, 15_000);

  test("magmux's ok on transcript evidence claudish did not find is not called not_accepted", async () => {
    const { s, pane } = await unproven({
      ok: true,
      result: { accept: "confirmed", evidence: "transcript", enter: true },
    });
    pane.box = "";
    await Bun.sleep(300);
    jump(125_000);
    expect(await within(() => phaseOf(s) === "FAILED", 3_000)).toBe(true);
    const line = s.snapshot().detail?.split("\n")[0] ?? "";
    expect(line).toMatch(
      /^magmux ok on transcript evidence claudish did not find; last screen: box empty; no transcript record of it in \d+ s$/
    );
    expect(line.length).toBeLessThanOrEqual(REASON_DETAIL_MAX);
  }, 15_000);
});
