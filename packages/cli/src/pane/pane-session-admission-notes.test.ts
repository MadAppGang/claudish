/**
 * What one admission records about a send, driven without a pane.
 *
 * A `busy` reply means Enter was NOT pressed. When it also reports `typed: true`, the text
 * may be in the box, also when the reply names a turn's own dialog that covers the box: the
 * next send must clear the box first, or it types onto that leftover. The clear itself waits
 * for the dialog to close (`clearOwnLeftover` sends no key while a dialog shows).
 *
 * A text witness matched by a record holding the launch line k > 1 times is counted as
 * `witness_copies:<k>`, once per turn, however often the view is read.
 *
 * The session is never started: the admission and the follower's view are set directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function session(): PaneSessionImpl {
  const root = mkdtempSync("/tmp/pan-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "admission-notes-test",
    callerFlags: [],
    spawnModel: "admission-notes-test",
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
    paneId: "admission-notes",
    sockPath: join(root, "m.sock"),
    root,
    ctlDir,
    turnDir,
  });
  cleanups.push(async () => {
    (s as any).reapPromise = Promise.resolve();
    await s.shutdownReap("admission notes test cleanup");
  });
  return s;
}

/** The admission fields `onBusy` reads and writes. */
function admission() {
  return { clearFirst: false, clearAfter: 0, noted: new Set<string>(), stopped: false };
}

function anomalies(s: PaneSessionImpl): Map<string, number> {
  return (s as any).anomalies as Map<string, number>;
}

async function busy(
  s: PaneSessionImpl,
  adm: ReturnType<typeof admission>,
  out: { reason: string; dialog: string | null; typed: boolean }
): Promise<void> {
  await (s as any).onBusy(adm, { kind: "busy", ...out }, "submit");
}

describe("a busy reply that names a turn's dialog", () => {
  test("with typed: true, the next send clears the box first and the dialog is noted", async () => {
    const s = session();
    const adm = admission();
    const before = Date.now();
    await busy(s, adm, { reason: "dialog:permission", dialog: "permission", typed: true });
    expect(adm.clearFirst).toBe(true);
    expect(adm.clearAfter).toBeGreaterThanOrEqual(before);
    expect(adm.noted.has("gate_dialog_at_admission:permission")).toBe(true);
    expect(anomalies(s).get("gate_dialog_at_admission:permission")).toBe(1);
  });

  test("with typed: false, nothing was typed and no clear is marked", async () => {
    const s = session();
    const adm = admission();
    await busy(s, adm, { reason: "dialog:question", dialog: "question", typed: false });
    expect(adm.clearFirst).toBe(false);
    expect(adm.noted.has("gate_dialog_at_admission:question")).toBe(true);
  });

  test("with no dialog and typed: true, the clear is marked as before", async () => {
    const s = session();
    const adm = admission();
    await busy(s, adm, { reason: "typing_in_progress", dialog: null, typed: true });
    expect(adm.clearFirst).toBe(true);
    expect(anomalies(s).get("gate_typed_withheld")).toBe(1);
  });
});

/** A view whose current turn is `index`, accepted, with `witnessCopies` copies. */
function viewOf(index: number, witnessCopies: number | null) {
  return {
    availability: "ok",
    current: {
      index,
      acceptedAt: witnessCopies === null ? null : "2026-11-19T15:23:21.574Z",
      lastChatOffset: null,
      witnessCopies,
    },
  };
}

/** One forced read of the follower, answered with `view`; the real follower is put back. */
function feed(s: PaneSessionImpl, view: unknown): void {
  const real = (s as any).follower;
  (s as any).follower = { poll() {}, view: () => view };
  try {
    (s as any).pollFollower(true);
  } finally {
    (s as any).follower = real;
  }
}

describe("a text witness matched by more than one whole copy of the line", () => {
  test("two copies are recorded as witness_copies:2 once per turn", () => {
    const s = session();
    (s as any).turnIndex = 1;
    feed(s, viewOf(1, null));
    expect([...anomalies(s).keys()].some((k) => k.startsWith("witness_copies"))).toBe(false);
    feed(s, viewOf(1, 2));
    feed(s, viewOf(1, 2));
    expect(anomalies(s).get("witness_copies:2")).toBe(1);
  });

  test("a later turn witnessed by two copies counts again", () => {
    const s = session();
    (s as any).turnIndex = 1;
    feed(s, viewOf(1, 2));
    (s as any).turnIndex = 2;
    feed(s, viewOf(2, 2));
    expect(anomalies(s).get("witness_copies:2")).toBe(2);
  });

  test("one copy records nothing", () => {
    const s = session();
    (s as any).turnIndex = 1;
    feed(s, viewOf(1, 1));
    expect([...anomalies(s).keys()].some((k) => k.startsWith("witness_copies"))).toBe(false);
  });

  test("a view of an earlier turn records nothing", () => {
    const s = session();
    (s as any).turnIndex = 2;
    feed(s, viewOf(1, 3));
    expect([...anomalies(s).keys()].some((k) => k.startsWith("witness_copies"))).toBe(false);
  });
});
