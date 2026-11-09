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
import { waitForExit } from "./process-tree.js";

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
 * by default) and captures them. `sessionEndMs` installs a `sessionEnd` hook that
 * takes that long, touching `hook.started` and `hook.finished` in the run's directory.
 * Monitor mode runs no hooks, so that launch goes through a custom endpoint instead;
 * the stand-in never calls it. `holdProxyStop` makes the proxy's `server.stop`, the
 * first step of `proxy.shutdown()`, touch `proxy-stop.held` and wait for `proxy-stop.release`
 * in the run's directory, with the event loop free to run a signal handler meanwhile.
 * `endpointUrl` launches through a custom endpoint at that URL. `extraArgs` go on claudish's
 * command line before the prompt.
 */
function runOver(
  body: string,
  opts: {
    verbose?: boolean;
    sessionEndMs?: number;
    holdProxyStop?: boolean;
    endpointUrl?: string;
    extraArgs?: string[];
  } = {}
): Run {
  const dir = mkdtempSync(join(root, "case-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const preload = join(dir, "hold-proxy-stop.ts");
  if (opts.holdProxyStop) {
    writeFileSync(
      preload,
      `import { existsSync, writeFileSync } from "node:fs";
const serve = Bun.serve.bind(Bun);
Bun.serve = ((options: never) => {
  const server = serve(options);
  const stop = async (force?: boolean) => {
    writeFileSync(${JSON.stringify(join(dir, "proxy-stop.held"))}, "");
    while (!existsSync(${JSON.stringify(join(dir, "proxy-stop.release"))})) await Bun.sleep(10);
    return server.stop(force);
  };
  return new Proxy(server, {
    get(target, key) {
      if (key === "stop") return stop;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}) as typeof Bun.serve;
`
    );
  }
  const usesEndpoint = opts.sessionEndMs !== undefined || opts.endpointUrl !== undefined;
  const hook = join(dir, "slow-session-end.ts");
  if (opts.sessionEndMs !== undefined) {
    writeFileSync(
      hook,
      `import { writeFileSync } from "node:fs";
export default {
  apiVersion: 1,
  id: "slow-session-end",
  on: {
    async sessionEnd() {
      writeFileSync(${JSON.stringify(join(dir, "hook.started"))}, "");
      await Bun.sleep(${opts.sessionEndMs});
      writeFileSync(${JSON.stringify(join(dir, "hook.finished"))}, "");
    },
  },
};
`
    );
  }
  if (usesEndpoint) {
    const claudishDir = join(home, ".claudish");
    mkdirSync(claudishDir);
    writeFileSync(
      join(claudishDir, "config.json"),
      JSON.stringify({
        customEndpoints: {
          stub: {
            kind: "simple",
            url: `${opts.endpointUrl ?? "http://127.0.0.1:9"}/v1`,
            format: "openai",
            authScheme: "none",
          },
        },
        ...(opts.sessionEndMs !== undefined ? { hooks: { modules: [hook] } } : {}),
      })
    );
  }
  const standIn = join(dir, "claude");
  writeFileSync(standIn, `#!/bin/sh\n${body}\n`);
  chmodSync(standIn, 0o755);
  const proc = spawn(
    process.execPath,
    [
      "run",
      ...(opts.holdProxyStop ? ["--preload", preload] : []),
      join(import.meta.dir, "index.ts"),
      ...(usesEndpoint ? ["--model", "stub@fake-model"] : ["--monitor"]),
      "-y",
      ...(opts.verbose ? ["--verbose"] : []),
      ...(opts.extraArgs ?? []),
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
  // The shell runs a trap only once its foreground `sleep` returns, so the loop's
  // sleep is short: the trap has to start promptly to finish inside the grace.
  const slowTrap = [
    'trap \'echo TERM >> "$TMPDIR/claude.log"; sleep 1; touch "$TMPDIR/claude.finished"; exit 0\' TERM',
    'echo "$$" > "$TMPDIR/claude.pid"',
    "while :; do sleep 0.05; done",
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
function runHandlersOverStuckChild(opts: {
  keepAlive: boolean;
  ps?:
    | "fails"
    | "hangs"
    | "childExitsDuringRead"
    | "descendantKept"
    | "descendantPidReused"
    | "secondReadFails";
  /** A real process the injected table lists as Claude Code's child. */
  descendant?: number;
  /** Leaves the handlers with no Claude Code attached, as before the spawn. */
  noChild?: boolean;
}) {
  const dir = mkdtempSync(join(root, "stuck-"));
  const settings = join(dir, "settings.json");
  const cleanupLog = join(dir, "cleanup.log");
  const killLog = join(dir, "kill.log");
  const ready = join(dir, "ready");
  const script = join(dir, "handlers.ts");
  writeFileSync(settings, "{}");
  const logRead = `appendFileSync(${JSON.stringify(killLog)}, "PS " + Date.now() + "\\n");`;
  const started = "Mon Oct  6 12:34:56 2026";
  const startedLater = "Mon Oct  6 12:35:57 2026";
  const tableRow = (pid: string, ppid: string, lstart: string) =>
    `\`\${${pid}} ${ppid} ${ppid} 00:01 ${lstart} cmd\``;
  /** A first read listing the descendant under Claude Code, then `second`. */
  const scriptedReads = (second: string) => `${logRead}
  reads += 1;
  const own = ${tableRow("process.pid", "1", started)};
  if (reads === 1) {
    cb(null as never, own + "\\n" + ${tableRow(String(opts.descendant), "99999999", started)});
    return;
  }
  ${second}`;
  /** The descendant reparented to init, with start time `lstart`. */
  const reparented = (lstart: string) =>
    `cb(null as never, own + "\\n" + ${tableRow(String(opts.descendant), "1", lstart)});`;
  const psBody = {
    fails: 'throw new Error("EPERM");',
    hangs: "",
    childExitsDuringRead: `${logRead}
  stuck.exitCode = 0;
  cb(new Error("exit 1"), "");`,
    descendantKept: scriptedReads(reparented(started)),
    descendantPidReused: scriptedReads(reparented(startedLater)),
    secondReadFails: scriptedReads('cb(new Error("exit 1"), "");'),
  };
  const replacePs = opts.ps
    ? `import { setPsSpawnForTest } from ${JSON.stringify(join(import.meta.dir, "pane/process-identity.ts"))};
let reads = 0;
setPsSpawnForTest({ execFileSync: () => "", execFile: (_f: string, _a: string[], _o: unknown, cb: (e: Error, s: string) => void) => {
  ${psBody[opts.ps]}
} } as never);
`
    : "";
  writeFileSync(
    script,
    `import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { setupSignalHandlers } from ${JSON.stringify(join(import.meta.dir, "claude-runner.ts"))};
${replacePs}const stuck = Object.assign(new EventEmitter(), {
  pid: 99999999,
  exitCode: null,
  signalCode: null,
  kill: (signal: string) => {
    appendFileSync(${JSON.stringify(killLog)}, signal + " " + Date.now() + "\\n");
    return true;
  },
});
const shutdown = setupSignalHandlers(${JSON.stringify(settings)}, true, () => appendFileSync(${JSON.stringify(cleanupLog)}, "cleanup\\n"));
${opts.noChild ? "" : "shutdown.attachClaudeCode(stuck as never);"}
writeFileSync(${JSON.stringify(ready)}, "");
${opts.keepAlive ? "setInterval(() => {}, 1000);" : "await Bun.sleep(1500);"}
`
  );
  const proc = spawn(process.execPath, ["run", script], {
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
    stdio: "ignore",
  });
  const exit = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)));
  return { proc, exit, settings, cleanupLog, killLog, ready };
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

  test("ends a stalled launch with no Claude Code attached yet, cleaning up once", async () => {
    const { SIGNAL_SHUTDOWN_BUDGET_MS } = await import("./claude-runner.js");
    const run = runHandlersOverStuckChild({ keepAlive: true, noChild: true });
    await waitFor("the handlers to install", () => existsSync(run.ready));
    const sentAt = Date.now();
    run.proc.kill("SIGTERM");
    expect(await run.exit).toBe(143);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(SIGNAL_SHUTDOWN_BUDGET_MS - 100);
    expect(readFileSync(run.cleanupLog, "utf8")).toBe("cleanup\n");
    expect(existsSync(run.settings)).toBe(false);
    expect(existsSync(run.killLog)).toBe(false);
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

describe.skipIf(process.platform === "win32")("Claude Code's descendants on a signal", () => {
  /** SIGKILLs whatever the run recorded and did not stop, so no stand-in outlives the test. */
  function killRecorded(dir: string, names: string[]): void {
    for (const name of names) {
      const file = join(dir, name);
      if (existsSync(file)) killStandIn(file);
    }
  }

  /** Waits for `file` to hold a pid and returns it. */
  async function recordedPid(file: string): Promise<number> {
    await waitFor(`${file} to hold a pid`, () => {
      return existsSync(file) && readFileSync(file, "utf8").trim() !== "";
    });
    return Number(readFileSync(file, "utf8"));
  }

  test("SIGKILLs the whole tree when Claude Code has to be SIGKILLed", async () => {
    const run = runOver(
      [
        "trap '' TERM",
        'case "$ROLE" in',
        '  "") echo "$$" > "$TMPDIR/claude.pid"; ROLE=child "$0" & ;;',
        '  child) echo "$$" > "$TMPDIR/child.pid"; ROLE=grandchild "$0" & ;;',
        '  grandchild) echo "$$" > "$TMPDIR/grandchild.pid" ;;',
        "esac",
        "while :; do sleep 0.05; done",
      ].join("\n")
    );
    const names = ["claude.pid", "child.pid", "grandchild.pid"];
    try {
      const child = await recordedPid(join(run.dir, "child.pid"));
      const grandchild = await recordedPid(join(run.dir, "grandchild.pid"));
      expect(alive(child)).toBe(true);
      expect(alive(grandchild)).toBe(true);
      run.proc.kill("SIGTERM");
      expect(await run.exit).toBe(143);
      // A killed orphan stays listed until init reaps it, a moment later.
      const deadline = Date.now() + 2_000;
      while ((alive(child) || alive(grandchild)) && Date.now() < deadline) await Bun.sleep(25);
      expect({ child: alive(child), grandchild: alive(grandchild) }).toEqual({
        child: false,
        grandchild: false,
      });
    } finally {
      killRecorded(run.dir, names);
    }
  }, 30_000);

  for (const ps of ["fails", "hangs"] as const) {
    test(`still SIGKILLs Claude Code in time when ps ${ps}`, async () => {
      const { SIGNAL_CHILD_EXIT_GRACE_MS, SIGNAL_DESCENDANT_READ_MS } = await import(
        "./claude-runner.js"
      );
      const run = runHandlersOverStuckChild({ keepAlive: true, ps });
      try {
        await waitFor("the handlers to install", () => existsSync(run.ready));
        run.proc.kill("SIGTERM");
        await waitFor("the SIGKILL", () => {
          return existsSync(run.killLog) && readFileSync(run.killLog, "utf8").includes("SIGKILL");
        });
        const sent = readFileSync(run.killLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(" "));
        expect(sent.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
        const gap = Number(sent[1]?.[1]) - Number(sent[0]?.[1]);
        expect(gap).toBeGreaterThanOrEqual(SIGNAL_CHILD_EXIT_GRACE_MS - 100);
        expect(gap).toBeLessThan(SIGNAL_CHILD_EXIT_GRACE_MS + SIGNAL_DESCENDANT_READ_MS + 300);
      } finally {
        run.proc.kill("SIGKILL");
        await run.exit;
      }
    }, 30_000);
  }

  /** Runs a shutdown over a real sacrificial process that a scripted table lists as a child. */
  async function shutdownOverDescendant(
    ps: "descendantKept" | "descendantPidReused" | "secondReadFails",
    check: (sacrificial: ChildProcess, signals: () => (string | undefined)[]) => Promise<void>
  ): Promise<void> {
    const sacrificial = spawn("/bin/sleep", ["30"], {
      env: { PATH: process.env.PATH },
      stdio: "ignore",
    });
    const run = runHandlersOverStuckChild({ keepAlive: true, ps, descendant: sacrificial.pid });
    try {
      await waitFor("the handlers to install", () => existsSync(run.ready));
      run.proc.kill("SIGTERM");
      await waitFor("the SIGKILL", () => {
        return existsSync(run.killLog) && readFileSync(run.killLog, "utf8").includes("SIGKILL");
      });
      await check(sacrificial, () =>
        readFileSync(run.killLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(" ")[0])
      );
    } finally {
      run.proc.kill("SIGKILL");
      await run.exit;
      sacrificial.kill("SIGKILL");
    }
  }

  test("SIGKILLs a descendant whose start time still matches, after it was reparented", async () => {
    await shutdownOverDescendant("descendantKept", async (sacrificial, signals) => {
      expect(await waitForExit(sacrificial, 2_000)).toBe(true);
      expect(sacrificial.signalCode).toBe("SIGKILL");
      expect(signals()).toEqual(["SIGTERM", "PS", "SIGKILL", "PS"]);
    });
  }, 30_000);

  test("does not signal a pid whose start time changed: it is another process now", async () => {
    await shutdownOverDescendant("descendantPidReused", async (sacrificial, signals) => {
      await Bun.sleep(300);
      expect(sacrificial.signalCode).toBeNull();
      expect(sacrificial.exitCode).toBeNull();
      expect(signals()).toEqual(["SIGTERM", "PS", "SIGKILL", "PS"]);
    });
  }, 30_000);

  test("a failed second read signals no descendant, and Claude Code is still killed", async () => {
    await shutdownOverDescendant("secondReadFails", async (sacrificial, signals) => {
      await Bun.sleep(300);
      expect(sacrificial.signalCode).toBeNull();
      expect(sacrificial.exitCode).toBeNull();
      expect(signals()).toEqual(["SIGTERM", "PS", "SIGKILL", "PS"]);
    });
  }, 30_000);

  test("sends no SIGKILL when Claude Code exits while the table is read", async () => {
    const run = runHandlersOverStuckChild({ keepAlive: true, ps: "childExitsDuringRead" });
    try {
      await waitFor("the handlers to install", () => existsSync(run.ready));
      run.proc.kill("SIGTERM");
      await waitFor("the table read", () => {
        return existsSync(run.killLog) && readFileSync(run.killLog, "utf8").includes("PS");
      });
      await Bun.sleep(150);
      const sent = readFileSync(run.killLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(" ")[0]);
      expect(sent).toEqual(["SIGTERM", "PS"]);
    } finally {
      run.proc.kill("SIGKILL");
      await run.exit;
    }
  }, 30_000);

  test("sends no SIGKILL to anything when Claude Code exits inside the grace", async () => {
    const run = runOver(
      [
        'if [ "$ROLE" = child ]; then',
        "  trap '' TERM",
        '  echo "$$" > "$TMPDIR/child.pid"',
        "  while :; do sleep 0.05; done",
        "fi",
        // Slower than a process-table read, so the tree is still whole during one.
        "trap 'sleep 0.5; touch \"$TMPDIR/claude.finished\"; exit 0' TERM",
        'echo "$$" > "$TMPDIR/claude.pid"',
        'ROLE=child "$0" &',
        "while :; do sleep 0.05; done",
      ].join("\n")
    );
    const names = ["claude.pid", "child.pid"];
    try {
      const child = await recordedPid(join(run.dir, "child.pid"));
      await recordedPid(join(run.dir, "claude.pid"));
      run.proc.kill("SIGTERM");
      expect(await run.exit).toBe(143);
      expect(existsSync(join(run.dir, "claude.finished"))).toBe(true);
      await Bun.sleep(300);
      expect(alive(child)).toBe(true);
    } finally {
      killRecorded(run.dir, names);
    }
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("a signal before Claude Code is spawned", () => {
  /**
   * Sends `signal` while the launch waits up to LIVE_DISCOVERY_BOUND_MS on a stalled model
   * list, with the settings file already written and Claude Code not spawned yet, and
   * asserts the whole teardown ran. Returns the milliseconds from the signal to the exit.
   */
  async function expectStoppedBeforeSpawn(
    signal: "SIGTERM" | "SIGHUP",
    code: number,
    extraArgs: string[] = []
  ): Promise<number> {
    let modelsRequested = false;
    const stalledEndpoint = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith("/models")) modelsRequested = true;
        return new Promise<Response>(() => {});
      },
    });
    const run = runOver('touch "$TMPDIR/claude.spawned"', {
      verbose: true,
      endpointUrl: `http://127.0.0.1:${stalledEndpoint.port}`,
      extraArgs,
    });
    const settingsFiles = () =>
      readdirSync(join(run.home, ".claudish")).filter((name) => name.startsWith("settings-"));
    const received = `[claudish] Received ${signal}`;
    const shuttingDown = "[claudish] Shutting down proxy server...";
    try {
      await waitFor(
        "the launch to hold with its settings file written",
        () => modelsRequested && settingsFiles().length > 0,
        15_000,
        5
      );
      const signalledAt = Date.now();
      run.proc.kill(signal);
      expect(await run.exit).toBe(code);
      const elapsedMs = Date.now() - signalledAt;
      expect(existsSync(join(run.dir, "claude.spawned"))).toBe(false);
      expect(settingsFiles()).toEqual([]);
      const output = run.output();
      expect(output).toContain(received);
      expect(output).toContain(shuttingDown);
      expect(output).toContain("[claudish] Done");
      expect(output.indexOf(received)).toBeLessThan(output.indexOf(shuttingDown));
      expect(output.indexOf(shuttingDown)).toBeLessThan(output.indexOf("[claudish] Done"));
      return elapsedMs;
    } finally {
      run.proc.kill("SIGKILL");
      await run.exit;
      stalledEndpoint.stop(true);
    }
  }

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(`${signal} runs the teardown, exits ${code} and never spawns Claude Code`, async () => {
      await expectStoppedBeforeSpawn(signal, code);
    }, 30_000);
  }

  test("SIGTERM during the first of three model lookups ends well inside the deadline", async () => {
    const elapsedMs = await expectStoppedBeforeSpawn("SIGTERM", 143, [
      "--model-opus",
      "stub@fake-opus",
      "--model-sonnet",
      "stub@fake-sonnet",
    ]);
    // One 2 s lookup plus the teardown. Two lookups take about 4 s, the deadline 4.5 s.
    expect(elapsedMs).toBeLessThan(3_500);
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("sessionEnd during a signal shutdown", () => {
  const hookMs = 1_400;

  /** SIGTERMs claudish over `body` and asserts the hook finished before claudish exited. */
  async function expectSessionEndFinishes(body: string): Promise<void> {
    const run = runOver(body, { verbose: true, sessionEndMs: hookMs });
    const pidFile = join(run.dir, "claude.pid");
    const hookFinished = join(run.dir, "hook.finished");
    const atExit: { finished?: boolean } = {};
    run.proc.on("exit", () => {
      atExit.finished = existsSync(hookFinished);
    });
    await waitFor("Claude Code to start", () => existsSync(pidFile));
    try {
      run.proc.kill("SIGTERM");
      expect(await run.exit).toBe(143);
      expect(existsSync(join(run.dir, "hook.started"))).toBe(true);
      expect(atExit.finished).toBe(true);
      // Printed by the caller's teardown, which the deadline would have cut short.
      expect(run.output()).toContain("[claudish] Done");
    } finally {
      killStandIn(pidFile);
    }
  }

  test("finishes when Claude Code exits about 1.9 s after SIGTERM", async () => {
    await expectSessionEndFinishes(
      [
        "trap 'sleep 1.9; exit 0' TERM",
        'echo "$$" > "$TMPDIR/claude.pid"',
        "while :; do sleep 0.05; done",
      ].join("\n")
    );
  }, 30_000);

  test("finishes when Claude Code ignores SIGTERM and has to be SIGKILLed", async () => {
    await expectSessionEndFinishes(
      ["trap '' TERM", 'echo "$$" > "$TMPDIR/claude.pid"', "while :; do sleep 0.05; done"].join(
        "\n"
      )
    );
  }, 30_000);

  test("the deadline covers every part and stays below the supervisor's SIGKILL", async () => {
    const {
      SIGNAL_CHILD_EXIT_GRACE_MS,
      SIGNAL_CHILD_KILL_WAIT_MS,
      SIGNAL_DESCENDANT_READ_MS,
      SIGNAL_SHUTDOWN_BUDGET_MS,
    } = await import("./claude-runner.js");
    const { TERMINATE_GRACE_MS } = await import("./process-tree.js");
    const { EVENT_BUDGETS } = await import("./hooks/engine.js");
    const sessionEndBudget = EVENT_BUDGETS.sessionEnd as number;
    expect(SIGNAL_CHILD_EXIT_GRACE_MS + SIGNAL_CHILD_KILL_WAIT_MS + sessionEndBudget).toBeLessThan(
      SIGNAL_SHUTDOWN_BUDGET_MS
    );
    expect(SIGNAL_SHUTDOWN_BUDGET_MS).toBeLessThan(TERMINATE_GRACE_MS);
    // Both descendant reads come out of the SIGKILL step, and leave it time to wait.
    expect(2 * SIGNAL_DESCENDANT_READ_MS).toBeLessThan(SIGNAL_CHILD_KILL_WAIT_MS);
  });
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
        "trap 'exit 0' TERM",
        'echo "$$" > "$TMPDIR/claude.pid"',
        'echo "$ANTHROPIC_BASE_URL" > "$TMPDIR/claude.url"',
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
    const run = runOver("exit 0", { verbose: true, holdProxyStop: true });
    const shuttingDown = "[claudish] Shutting down proxy server...";
    const received = "[claudish] Received SIGINT";
    const release = join(run.dir, "proxy-stop.release");
    try {
      // The launcher has returned Claude Code's 0 by now: the caller prints this line
      // after it, then holds in `proxy.shutdown()` until the test releases it.
      await waitFor("proxy.shutdown to be held", () => {
        return existsSync(join(run.dir, "proxy-stop.held"));
      });
      await waitFor("the teardown line", () => run.output().includes(shuttingDown));
      run.proc.kill("SIGINT");
      await waitFor("the handler to report the signal", () => run.output().includes(received));
      writeFileSync(release, "");
      expect(await run.exit).toBe(130);
      const output = run.output();
      expect(output).toContain("[claudish] Done");
      expect(output.indexOf(shuttingDown)).toBeLessThan(output.indexOf(received));
      expect(output.indexOf(received)).toBeLessThan(output.indexOf("[claudish] Done"));
    } finally {
      writeFileSync(release, "");
      run.proc.kill("SIGKILL");
      await run.exit;
    }
  }, 30_000);
});
