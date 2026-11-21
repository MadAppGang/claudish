/**
 * The FAILED detail of a boot that reaches its deadline. A child that never drew a frame
 * (screen seq 0) has no screen tail to show, so the detail says so, with the elapsed time,
 * ahead of the gate line. A child whose screen kept changing keeps its screen tail.
 *
 * The session is never started: a fake client stands in for magmux, the gate reading and
 * the screen are set directly, and the start time is moved back past the boot deadline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";
import { emptyScreen } from "./screen-model.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const BOOT_TIMEOUT_MS = 90_000;

function session(): PaneSessionImpl {
  const root = mkdtempSync("/tmp/pbd-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "boot-detail-test",
    callerFlags: [],
    spawnModel: "boot-detail-test",
    cwd: root,
    sessionUuid: crypto.randomUUID(),
    transcriptPath: join(root, "transcript.jsonl"),
    slotEnv: {},
    shape: "interactive",
    readAvailable: true,
    parentEnv: { HOME: root, CLAUDE_CONFIG_DIR: configDir },
    decide: () => "continue",
    onBlocked: () => "wait",
    bootTimeoutMs: BOOT_TIMEOUT_MS,
  };
  const s = new PaneSessionImpl(opts, {
    paneId: "boot-detail",
    sockPath: join(root, "m.sock"),
    root,
    ctlDir,
    turnDir,
  });
  (s as any).client = { request: async () => ({ ok: false }) };
  (s as any).gateTrusted = true;
  (s as any).gate = {
    ready: false,
    reason: "starting",
    dialog: null,
    detail: "no input box yet",
    receivedAt: Date.now(),
  };
  (s as any).startedAtMs = Date.now() - BOOT_TIMEOUT_MS;
  cleanups.push(async () => {
    (s as any).client = null;
    (s as any).reapPromise = Promise.resolve();
    await s.shutdownReap("boot detail test cleanup");
  });
  return s;
}

describe("boot_timeout detail", () => {
  test("a child that drew nothing says so, with the elapsed seconds, then the gate line", async () => {
    const s = session();
    expect((s as any).screen.seq).toBe(0);
    (s as any).evalBoot();
    const snap = await s.terminal;
    expect(snap.state).toBe("FAILED");
    expect(snap.reason).toBe("boot_timeout");
    expect(snap.detail).toBe("Claude Code drew nothing in 90 s\ngate: starting (no input box yet)");
  });

  test("a drawn, changing screen keeps its screen tail ahead of the gate line", async () => {
    const s = session();
    (s as any).screen = {
      ...emptyScreen(160, 50),
      seq: 7,
      lines: ["", "Claude Code v2.1.290", "", "  Connecting to MCP servers…", ""],
      changedAt: Date.now(),
    };
    (s as any).evalBoot();
    const snap = await s.terminal;
    expect(snap.state).toBe("FAILED");
    expect(snap.reason).toBe("boot_timeout");
    expect(snap.detail).toBe(
      "Claude Code v2.1.290\n  Connecting to MCP servers…\ngate: starting (no input box yet)"
    );
  });
});
