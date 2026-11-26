/**
 * An admission whose turn file cannot be written types nothing: the pointer line would name a
 * file that is not there, so the admission fails at once with `turn_file_failed`, as the
 * interactive driver drops such an injection.
 *
 * The session is never started: the admission is started directly, with its send and its
 * phase events captured.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function session(): { s: PaneSessionImpl; turnDir: string } {
  const root = mkdtempSync("/tmp/ptf-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "turn-file-write-test",
    callerFlags: [],
    spawnModel: "turn-file-write-test",
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
    paneId: "turn-file-write",
    sockPath: join(root, "m.sock"),
    root,
    ctlDir,
    turnDir,
  });
  cleanups.push(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test seam
    (s as any).reapPromise = Promise.resolve();
    await s.shutdownReap("turn file write test cleanup");
  });
  return { s, turnDir };
}

for (const initial of [true, false]) {
  test(`the turn directory is gone: the ${initial ? "first" : "later"} admission types nothing and fails with turn_file_failed`, () => {
    const { s, turnDir } = session();
    // biome-ignore lint/suspicious/noExplicitAny: test seam
    const any = s as any;
    const sent: unknown[] = [];
    const fired: Array<[string, unknown]> = [];
    any.runAdmission = (adm: unknown) => {
      sent.push(adm);
      return Promise.resolve();
    };
    any.fire = (event: string, o: unknown) => {
      fired.push([event, o]);
    };
    rmSync(turnDir, { recursive: true, force: true });
    any.startAdmission({ kind: "caller", text: "Reply with exactly PEAR." }, initial);
    expect(sent).toEqual([]);
    expect(any.admission).toBeNull();
    expect(fired).toEqual([
      [initial ? "admit_deadline" : "admit_abandoned", { detail: "turn_file_failed" }],
    ]);
    const anomalies = [...(any.anomalies as Map<string, number>).keys()];
    expect(anomalies.some((a) => a.startsWith("turn_file_failed:"))).toBe(true);
  });
}
