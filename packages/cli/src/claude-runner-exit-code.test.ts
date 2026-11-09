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
  /** claudish's stdout and stderr so far, interleaved; empty unless `verbose`. */
  output: () => string;
}

/**
 * Runs claudish over a stand-in `claude` whose whole behaviour is `body`.
 * `verbose` turns claudish's own `[claudish]` lines on (single-shot mode is quiet
 * by default) and captures them.
 */
function runOver(body: string, opts: { verbose?: boolean } = {}): Run {
  const dir = mkdtempSync(join(root, "case-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const standIn = join(dir, "claude");
  writeFileSync(standIn, `#!/bin/sh\n${body}\n`);
  chmodSync(standIn, 0o755);
  const proc = spawn(
    process.execPath,
    [
      "run",
      join(import.meta.dir, "index.ts"),
      "--monitor",
      "-y",
      ...(opts.verbose ? ["--verbose"] : []),
      "hi",
    ],
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
      stdio: opts.verbose ? ["ignore", "pipe", "pipe"] : "ignore",
    }
  );
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString();
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  // `close`, not `exit`: the output streams have drained by then.
  const exit = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)));
  return { proc, exit, dir, home, output: () => output };
}

async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs = 15_000,
  pollMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(pollMs);
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

/**
 * Runs the real signal handlers in their own process, over a Claude Code that
 * never exits. `keepAlive` stands for whatever still holds the event loop open
 * when the shutdown stalls; without it nothing does.
 */
function runHandlersOverStuckChild(opts: { keepAlive: boolean }) {
  const dir = mkdtempSync(join(root, "stuck-"));
  const settings = join(dir, "settings.json");
  const cleanupLog = join(dir, "cleanup.log");
  const ready = join(dir, "ready");
  const script = join(dir, "handlers.ts");
  writeFileSync(settings, "{}");
  writeFileSync(
    script,
    `import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupSignalHandlers } from ${JSON.stringify(join(import.meta.dir, "claude-runner.ts"))};
const stuck = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => true });
setupSignalHandlers(stuck as never, ${JSON.stringify(settings)}, true, () => appendFileSync(${JSON.stringify(cleanupLog)}, "cleanup\\n"));
writeFileSync(${JSON.stringify(ready)}, "");
${opts.keepAlive ? "setInterval(() => {}, 1000);" : "await Bun.sleep(1500);"}
`
  );
  const proc = spawn(process.execPath, ["run", script], {
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
    stdio: "ignore",
  });
  const exit = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)));
  return { proc, exit, settings, cleanupLog, ready };
}

describe.skipIf(process.platform === "win32")("claudish's signal shutdown deadline", () => {
  test("exits 143 at the deadline when the shutdown stalls, cleaning up once", async () => {
    const { SIGNAL_SHUTDOWN_BUDGET_MS } = await import("./claude-runner.js");
    const run = runHandlersOverStuckChild({ keepAlive: true });
    await waitFor("the handlers to install", () => existsSync(run.ready));
    const sentAt = Date.now();
    run.proc.kill("SIGTERM");
    expect(await run.exit).toBe(143);
    const elapsed = Date.now() - sentAt;
    expect(elapsed).toBeGreaterThanOrEqual(SIGNAL_SHUTDOWN_BUDGET_MS - 100);
    expect(elapsed).toBeLessThan(SIGNAL_SHUTDOWN_BUDGET_MS + 1_500);
    expect(readFileSync(run.cleanupLog, "utf8")).toBe("cleanup\n");
    expect(existsSync(run.settings)).toBe(false);
  }, 30_000);

  test("does not hold a finished process open, which still exits 143", async () => {
    const { SIGNAL_SHUTDOWN_BUDGET_MS } = await import("./claude-runner.js");
    const run = runHandlersOverStuckChild({ keepAlive: false });
    await waitFor("the handlers to install", () => existsSync(run.ready));
    const sentAt = Date.now();
    run.proc.kill("SIGTERM");
    expect(await run.exit).toBe(143);
    expect(Date.now() - sentAt).toBeLessThan(SIGNAL_SHUTDOWN_BUDGET_MS - 1_000);
  }, 30_000);
});

/** Whether a TCP connection to `url`'s port is refused. */
async function portClosed(url: string): Promise<boolean> {
  const { port, hostname } = new URL(url);
  try {
    const socket = await Bun.connect({
      hostname,
      port: Number(port),
      socket: { data() {} },
    });
    socket.end();
    return false;
  } catch {
    return true;
  }
}

describe.skipIf(process.platform === "win32")("claudish's teardown after a signal", () => {
  test("shuts the proxy down and prints Done, then exits 143", async () => {
    const run = runOver(
      [
        'echo "$$" > "$TMPDIR/claude.pid"',
        'echo "$ANTHROPIC_BASE_URL" > "$TMPDIR/claude.url"',
        "trap 'exit 0' TERM",
        "while :; do sleep 1; done",
      ].join("\n"),
      { verbose: true }
    );
    const pidFile = join(run.dir, "claude.pid");
    const urlFile = join(run.dir, "claude.url");
    await waitFor("Claude Code to start", () => existsSync(pidFile) && existsSync(urlFile));
    await waitFor("the proxy URL", () => readFileSync(urlFile, "utf8").trim() !== "");
    const proxyUrl = readFileSync(urlFile, "utf8").trim();
    try {
      expect(await portClosed(proxyUrl)).toBe(false);
      run.proc.kill("SIGTERM");
      expect(await run.exit).toBe(143);
      const output = run.output();
      expect(output).toContain("[claudish] Shutting down proxy server...");
      // Printed only once `await proxy.shutdown()` has resolved.
      expect(output).toContain("[claudish] Done");
      expect(output.indexOf("[claudish] Shutting down proxy server...")).toBeLessThan(
        output.indexOf("[claudish] Done")
      );
      expect(await portClosed(proxyUrl)).toBe(true);
    } finally {
      killStandIn(pidFile);
    }
  }, 30_000);

  test("reports a SIGHUP as a quit: exits 129 with no failure notice", async () => {
    const run = runOver(
      ['echo "$$" > "$TMPDIR/claude.pid"', "trap 'exit 0' TERM", "while :; do sleep 1; done"].join(
        "\n"
      ),
      { verbose: true }
    );
    const pidFile = join(run.dir, "claude.pid");
    await waitFor("Claude Code to start", () => existsSync(pidFile));
    try {
      run.proc.kill("SIGHUP");
      expect(await run.exit).toBe(129);
      expect(run.output()).toContain("[claudish] Done");
      expect(run.output()).not.toContain("Session ended with errors");
    } finally {
      killStandIn(pidFile);
    }
  }, 30_000);

  test("a signal during the caller's teardown exits 128 + signum, not Claude Code's 0", async () => {
    const run = runOver("exit 0", { verbose: true });
    // The caller prints this after the launcher returned Claude Code's 0, just
    // before `proxy.shutdown()`.
    await waitFor(
      "the caller's teardown to start",
      () => run.output().includes("[claudish] Shutting down proxy server..."),
      15_000,
      1
    );
    run.proc.kill("SIGINT");
    const code = await run.exit;
    // A signal that lands after the process has exited is never handled, and that
    // run proves nothing. The handler's own line says which case this was.
    if (run.output().includes("[claudish] Received SIGINT")) expect(code).toBe(130);
    else expect(code).toBe(0);
  }, 30_000);
});
