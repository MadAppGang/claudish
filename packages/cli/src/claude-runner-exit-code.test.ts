import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "claudish-exit-code-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Run {
  proc: ChildProcess;
  exit: Promise<number | null>;
  dir: string;
  home: string;
}

/** Runs claudish over a stand-in `claude` whose whole behaviour is `body`. */
function runOver(body: string): Run {
  const dir = mkdtempSync(join(root, "case-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const standIn = join(dir, "claude");
  writeFileSync(standIn, `#!/bin/sh\n${body}\n`);
  chmodSync(standIn, 0o755);
  const proc = spawn(
    process.execPath,
    ["run", join(import.meta.dir, "index.ts"), "--monitor", "-y", "hi"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: dir,
        CLAUDE_PATH: standIn,
        // makePaneTestEnv's hermetic keys, which an environment built from scratch
        // lacks: no catalog fetch, keychain, 1Password or bundled endpoint
        // reaches past the test.
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
      },
      stdio: "ignore",
    }
  );
  const exit = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  return { proc, exit, dir, home };
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

describe.skipIf(process.platform === "win32")("claudish's exit code for Claude Code's exit", () => {
  test("is Claude Code's own code when it exits", async () => {
    expect(await runOver("exit 3").exit).toBe(3);
  }, 30_000);

  test("is 128 + signum when a signal kills it, for a signal like SIGKILL too", async () => {
    expect(await runOver("kill -KILL $$").exit).toBe(137);
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("claudish sent SIGTERM on its own", () => {
  test("stops Claude Code, removes its settings file, and exits 143", async () => {
    const run = runOver(
      [
        "trap 'echo TERM >> \"$TMPDIR/claude.log\"; exit 0' TERM",
        'echo "$$" > "$TMPDIR/claude.pid"',
        "while :; do sleep 1; done",
      ].join("\n")
    );
    const pidFile = join(run.dir, "claude.pid");
    const log = join(run.dir, "claude.log");
    await waitFor("Claude Code to start", () => existsSync(pidFile));
    try {
      // To claudish's pid alone, as a container stop or a plain `kill` sends it.
      run.proc.kill("SIGTERM");
      expect(await run.exit).toBe(143);
      await waitFor("Claude Code to receive the SIGTERM", () => existsSync(log));
      expect(readFileSync(log, "utf8")).toBe("TERM\n");
      const settings = readdirSync(join(run.home, ".claudish")).filter((name) =>
        name.startsWith("settings-")
      );
      expect(settings).toEqual([]);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // Stopped, as it should have been.
      }
    }
  }, 30_000);
});

/** Whether `pid` names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killStandIn(pidFile: string): void {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  } catch {
    // Stopped, as it should have been.
  }
}

describe.skipIf(process.platform === "win32")("claudish's shutdown on a signal", () => {
  // A stand-in whose TERM trap takes a second to finish, then marks that it did.
  const slowTrap = [
    'trap \'echo TERM >> "$TMPDIR/claude.log"; sleep 1; touch "$TMPDIR/claude.finished"; exit 0\' TERM',
    'echo "$$" > "$TMPDIR/claude.pid"',
    "while :; do sleep 1; done",
  ].join("\n");

  test("exits only after Claude Code has finished exiting, with 143", async () => {
    const run = runOver(slowTrap);
    const pidFile = join(run.dir, "claude.pid");
    const finished = join(run.dir, "claude.finished");
    const atExit: { finished?: boolean } = {};
    run.proc.on("exit", () => {
      atExit.finished = existsSync(finished);
    });
    await waitFor("Claude Code to start", () => existsSync(pidFile));
    try {
      run.proc.kill("SIGTERM");
      expect(await run.exit).toBe(143);
      expect(atExit.finished).toBe(true);
    } finally {
      killStandIn(pidFile);
    }
  }, 30_000);

  test("SIGKILLs a Claude Code that ignores SIGTERM after the bound, and still exits 143", async () => {
    const { SIGNAL_CHILD_EXIT_GRACE_MS } = await import("./claude-runner.js");
    const run = runOver(
      ["trap '' TERM", 'echo "$$" > "$TMPDIR/claude.pid"', "while :; do sleep 1; done"].join("\n")
    );
    const pidFile = join(run.dir, "claude.pid");
    await waitFor("Claude Code to start", () => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      const sentAt = Date.now();
      run.proc.kill("SIGTERM");
      expect(await run.exit).toBe(143);
      const elapsed = Date.now() - sentAt;
      expect(elapsed).toBeGreaterThanOrEqual(SIGNAL_CHILD_EXIT_GRACE_MS - 100);
      expect(elapsed).toBeLessThan(SIGNAL_CHILD_EXIT_GRACE_MS + 1_500);
      expect(alive(pid)).toBe(false);
    } finally {
      killStandIn(pidFile);
    }
  }, 30_000);

  test("a second signal during shutdown neither signals Claude Code again nor exits early", async () => {
    const run = runOver(slowTrap);
    const pidFile = join(run.dir, "claude.pid");
    const log = join(run.dir, "claude.log");
    const finished = join(run.dir, "claude.finished");
    const atExit: { finished?: boolean } = {};
    run.proc.on("exit", () => {
      atExit.finished = existsSync(finished);
    });
    await waitFor("Claude Code to start", () => existsSync(pidFile));
    try {
      run.proc.kill("SIGTERM");
      await waitFor("Claude Code to receive the SIGTERM", () => existsSync(log));
      run.proc.kill("SIGINT");
      expect(await run.exit).toBe(143);
      expect(atExit.finished).toBe(true);
      expect(readFileSync(log, "utf8")).toBe("TERM\n");
      const settings = readdirSync(join(run.home, ".claudish")).filter((name) =>
        name.startsWith("settings-")
      );
      expect(settings).toEqual([]);
    } finally {
      killStandIn(pidFile);
    }
  }, 30_000);
});
