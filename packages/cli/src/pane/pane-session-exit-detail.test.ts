/**
 * The FAILED detail of a pane child that exits at startup names the child's own error line,
 * read from the exit capture, ahead of magmux's single last line.
 *
 * The session is never started: a fake client answers the exit capture, and the exit is
 * driven through `onPaneExit` with an empty screen, which is what a child that dies before
 * its first frame leaves behind.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function session(captureText: string, captureAlt = false): PaneSessionImpl {
  const root = mkdtempSync("/tmp/pxd-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "exit-detail-test",
    callerFlags: [],
    spawnModel: "exit-detail-test",
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
    paneId: "exit-detail",
    sockPath: join(root, "m.sock"),
    root,
    ctlDir,
    turnDir,
  });
  (s as any).client = {
    request: async (msg: { type: string }) =>
      msg.type === "capture"
        ? { ok: true, result: { text: captureText, alt: captureAlt } }
        : { ok: false },
  };
  cleanups.push(async () => {
    (s as any).client = null;
    (s as any).reapPromise = Promise.resolve();
    await s.shutdownReap("exit detail test cleanup");
  });
  return s;
}

async function exitWith(s: PaneSessionImpl, exitCode: number, lastLine: string) {
  await (s as any).onPaneExit({ exitCode, lastLine });
  return s.terminal;
}

const MISSING_CLAUDE = [
  "Error: Claude Code CLI not found",
  "Install it from: https://claude.com/claude-code",
  "",
  "Or if you have a local installation, set CLAUDE_PATH:",
  "  export CLAUDE_PATH=~/.claude/local/claude",
].join("\n");

describe("child_exited detail", () => {
  test("puts the child's Error: line from the exit capture before the last line", async () => {
    const s = session(`${MISSING_CLAUDE}\n\n\n`);
    const snap = await exitWith(s, 1, "  export CLAUDE_PATH=~/.claude/local/claude");
    expect(snap.state).toBe("FAILED");
    expect(snap.reason).toBe("child_exited");
    const detail = snap.detail ?? "";
    expect(
      detail.startsWith("pane child exited with code 1: Error: Claude Code CLI not found")
    ).toBe(true);
    expect(detail.split("\n")[0]).toContain("Error: Claude Code CLI not found");
    expect(detail.indexOf("Error: Claude Code CLI not found")).toBeLessThan(
      detail.indexOf("last line:")
    );
    expect(detail).toContain("last line:   export CLAUDE_PATH=~/.claude/local/claude");
  });

  test("with no Error: line, carries the last non-empty lines of the exit capture", async () => {
    const lines = ["boot", "step one", "step two", "step three", "step four", "gave up here"];
    const s = session(`${lines.join("\n")}\n\n`);
    const snap = await exitWith(s, 2, "gave up here");
    expect(snap.reason).toBe("child_exited");
    const detail = snap.detail ?? "";
    const head = detail.slice(0, detail.indexOf("last line:"));
    for (const l of lines.slice(-5)) expect(head).toContain(l);
    expect(head).not.toContain("boot");
  });

  test("an unknown --agent in the exit capture is still agent_rejected", async () => {
    const s = session("Error: --agent 'zzz-not-real' not found. Available agents: a, b\n");
    const snap = await exitWith(s, 1, "…not found. Avail…");
    expect(snap.reason).toBe("agent_rejected");
    expect(snap.detail).toBe("--agent 'zzz-not-real' not found. Available agents: a, b");
  });
});

const RULE = "─".repeat(160);
const TUI_FRAME = [
  "⏺ Bash(bun test)",
  "  ⎿  1 fail",
  "    Error: expected 200 to be 401",
  RULE,
  "❯ ",
  RULE,
  "  ? for shortcuts",
];

describe("child_exited detail on the alternate screen", () => {
  test("an alternate-screen capture adds no evidence before the last line", async () => {
    const s = session(TUI_FRAME.join("\n"), true);
    const snap = await exitWith(s, 1, "Segmentation fault");
    expect(snap.reason).toBe("child_exited");
    expect((snap.detail ?? "").split("\n")[0]).toBe(
      "pane child exited with code 1; last line: Segmentation fault"
    );
  });

  test("an alternate screen adds no evidence before the last line", async () => {
    const s = session(TUI_FRAME.join("\n"));
    const screen = (s as any).screen;
    (s as any).screen = { ...screen, alt: true, lines: [...TUI_FRAME] };
    const snap = await exitWith(s, 1, "Segmentation fault");
    expect(snap.reason).toBe("child_exited");
    expect((snap.detail ?? "").split("\n")[0]).toBe(
      "pane child exited with code 1; last line: Segmentation fault"
    );
  });
});
