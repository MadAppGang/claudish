/**
 * A gated send answered `still_in_box`: magmux pressed Enter and the line stayed in the input
 * box. Claude Code may simply not have read the Enter yet (a stalled process: the Enter byte is
 * queued behind the line, and it submits the line once it reads again). Any key or text sent now
 * queues behind that Enter and is read after it, so a ctrl-u clears nothing and a second copy is
 * submitted as well. So nothing is sent: only the line's own transcript record accepts it,
 * within the admission's deadline, and the copy stays remembered as unread after it.
 *
 * The session is never started: a scripted client answers each send, the screen and the gate
 * reading are set from a box the test controls, and a ticker runs the session's evaluation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
const NEW_DETAIL =
  "magmux not_accepted still_in_box: Enter was pressed and Claude Code had not read it";

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
  };
}

interface Pane {
  sends: Array<{ message: Record<string, unknown>; at: number }>;
  /** what the input box shows */
  box: string;
  /** rows drawn above the box */
  above: string[];
}

/**
 * Wires a scripted magmux: a gated send that types `LINE` answers `still_in_box` and leaves the
 * line in the box; one that types any other line is accepted; a ctrl-u empties the box. The
 * screen and the gate reading follow the box every 100 ms, and the session is evaluated every
 * 250 ms, as its own ticker does.
 */
function wire(s: PaneSessionImpl): Pane {
  const pane: Pane = { sends: [], box: "", above: [] };
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
        pane.box = LINE;
        return STILL_IN_BOX;
      }
      return ACCEPTED;
    },
  };
  any.gateTrusted = true;
  const refresh = () => {
    any.screen = screenWith(pane.box, pane.above);
    any.gate =
      pane.box === ""
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

  test("no record by the deadline: prompt_not_accepted at the deadline, saying Enter was not read, nothing sent after the reply", async () => {
    const { s, transitions } = session({ initialPrompt: LINE, admitTimeoutMs: 20_000 });
    const pane = wire(s);
    const at = await stillInBoxAt(pane);
    const snap = await s.terminal;
    expect(snap.state).toBe("FAILED");
    expect(snap.reason).toBe("prompt_not_accepted");
    expect(snap.detail?.split("\n")[0]).toStartWith(NEW_DETAIL);
    const failedAt = transitions.find(({ to }) => to === "FAILED")?.at ?? 0;
    const started = (s as any).startedAtMs as number;
    // the admission's own bound, not extended
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
    const { s } = session({ timings: { admitTimeoutMs: 30_000 } });
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
    const { s } = session({ timings: { admitTimeoutMs: 30_000 } });
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
