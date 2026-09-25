import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CLAUDISH_PLACEHOLDER_API_KEY } from "./claude-runner.js";
import {
  type ReinstallWait,
  SUPERVISOR_UPGRADE_EXIT,
  type SupervisorOptions,
  isRunnableClaudeBinary,
  npmReinstallInProgress,
  parseDaemonArgs,
  superviseClaudeDaemon,
  supervisorArgv,
  supervisorEnv,
} from "./daemon-command.js";

// Process groups, POSIX signals and executable bits: the cases below that need
// them do not run on Windows.
const onWindows = process.platform === "win32";
const root = mkdtempSync(join(tmpdir(), "claudish-daemon-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseDaemonArgs", () => {
  test("takes the port and leaves everything after -- to claude daemon run", () => {
    expect(parseDaemonArgs(["--port", "8787", "--", "--log-file", "/x", "--port", "1"])).toEqual({
      port: 8787,
      supervisorArgs: ["--log-file", "/x", "--port", "1"],
    });
    expect(parseDaemonArgs(["-p", "8787"])).toEqual({ port: 8787, supervisorArgs: [] });
  });

  test("leaves the port unset when none is given", () => {
    expect(parseDaemonArgs([])).toEqual({ supervisorArgs: [] });
  });

  test.each([["0"], ["65536"], ["abc"], ["1.5"]])("rejects the port %s", (value) => {
    expect(() => parseDaemonArgs(["--port", value])).toThrow("--port must be an integer 1-65535");
  });

  test("rejects a port flag with no value", () => {
    expect(() => parseDaemonArgs(["--port"])).toThrow("(got nothing)");
  });

  test("rejects an option of claude daemon run given before --", () => {
    expect(() => parseDaemonArgs(["--port", "1", "--json-path", "x"])).toThrow(
      "unknown argument --json-path; options for claude daemon run go after --"
    );
  });
});

describe("supervisorArgv", () => {
  test("puts the service origin after the caller's options, where the CLI's last-wins parse keeps it", () => {
    expect(supervisorArgv(["--log-file", "/x", "--origin", "foreground"])).toEqual([
      "daemon",
      "run",
      "--log-file",
      "/x",
      "--origin",
      "foreground",
      "--origin",
      "service",
    ]);
  });
});

describe("supervisorEnv", () => {
  test("points the supervisor at the proxy and carries the launcher's trust as it arrived", () => {
    const parent = {
      ANTHROPIC_BASE_URL: "https://elsewhere.example",
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      PATH: "/bin",
    };
    const env = supervisorEnv(parent, "http://127.0.0.1:8787");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
    expect(env.PATH).toBe("/bin");
    expect(parent.ANTHROPIC_BASE_URL).toBe("https://elsewhere.example");
  });

  test("removes claudish's inherited placeholder key and keeps a real one", () => {
    expect(
      supervisorEnv({ ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY }, "http://x")
        .ANTHROPIC_API_KEY
    ).toBeUndefined();
    expect(supervisorEnv({ ANTHROPIC_API_KEY: "sk-real" }, "http://x").ANTHROPIC_API_KEY).toBe(
      "sk-real"
    );
  });
});

describe.skipIf(onWindows)("isRunnableClaudeBinary", () => {
  const dir = join(root, "runnable");
  mkdirSync(join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin"), { recursive: true });
  const write = (path: string, bytes: number, mode: number) => {
    writeFileSync(path, "x".repeat(bytes));
    chmodSync(path, mode);
    return path;
  };

  test("holds for an executable file and not for a plain one, a directory or a missing path", async () => {
    expect(await isRunnableClaudeBinary(write(join(dir, "exec"), 4, 0o755), 1024)).toBe(true);
    expect(await isRunnableClaudeBinary(write(join(dir, "plain"), 4, 0o644), 1024)).toBe(false);
    expect(await isRunnableClaudeBinary(dir, 1024)).toBe(false);
    expect(await isRunnableClaudeBinary(join(dir, "missing"), 1024)).toBe(false);
  });

  test("takes a small file inside the npm package for npm's stub", async () => {
    const bin = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin");
    expect(await isRunnableClaudeBinary(write(join(bin, "stub"), 4, 0o755), 1024)).toBe(false);
    expect(await isRunnableClaudeBinary(write(join(bin, "native"), 2048, 0o755), 1024)).toBe(true);
  });
});

describe.skipIf(onWindows)("npmReinstallInProgress", () => {
  const scope = join(root, "npm", "node_modules", "@anthropic-ai");
  const binary = join(scope, "claude-code", "bin", "claude");
  mkdirSync(join(scope, "claude-code", "bin"), { recursive: true });
  mkdirSync(join(scope, ".claude-code-Ab3dE9"), { recursive: true });
  mkdirSync(join(scope, ".other-package-Zz1"), { recursive: true });

  test("holds while npm's staging directory for the package is fresh", async () => {
    expect(await npmReinstallInProgress(binary, 60_000)).toBe(true);
  });

  test("does not hold once the staging directory is older than the window", async () => {
    await Bun.sleep(150);
    expect(await npmReinstallInProgress(binary, 100)).toBe(false);
  });

  test("does not hold outside an npm package", async () => {
    expect(await npmReinstallInProgress(join(root, "elsewhere", "claude"), 60_000)).toBe(false);
  });
});

/**
 * A stand-in for `claude`. Each start records itself to starts.jsonl and then
 * follows the next step of plan.json: exit with a code, move its own file away
 * first (an upgrade that has not landed), kill itself, or wait and record the
 * signals it receives. Waiting ends 300 ms after the first signal, so a second
 * signal close behind it is recorded too; with `healthOnStop` it first asks the
 * proxy for /health, as a supervisor still shutting down may still need it.
 */
const STAND_IN = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.DAEMON_TEST_DIR;
const startsPath = join(dir, "starts.jsonl");
let n = 0;
try { n = readFileSync(startsPath, "utf8").split("\\n").filter(Boolean).length; } catch {}
const step = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"))[n] ?? {};
const record = {
  pid: process.pid,
  argv: process.argv.slice(2),
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  firstParty: process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL ?? null,
  health: null,
};
if (step.health) {
  const res = await fetch(record.baseUrl + "/health");
  record.health = { status: res.status, body: await res.json() };
}
appendFileSync(startsPath, JSON.stringify(record) + "\\n");
if (step.vanish) renameSync(process.argv[1], process.argv[1] + ".away");
if (step.kill) process.kill(process.pid, "SIGKILL");
if (typeof step.exit === "number") process.exit(step.exit);
let exiting = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, async () => {
    appendFileSync(join(dir, "signals.log"), sig + "\\n");
    if (exiting) return;
    exiting = true;
    if (step.healthOnStop) {
      let status = 0;
      try { status = (await fetch(record.baseUrl + "/health")).status; } catch {}
      appendFileSync(join(dir, "stop-health.log"), status + "\\n");
    }
    setTimeout(() => process.exit(0), 300);
  });
}
setInterval(() => {}, 1000);
`;

interface Start {
  pid: number;
  argv: string[];
  baseUrl: string | null;
  firstParty: string | null;
  health: { status: number; body: unknown } | null;
}

let caseDir = "";
let standIn = "";
let caseNumber = 0;

function starts(): Start[] {
  const path = join(caseDir, "starts.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Start);
}

function signals(): string[] {
  const path = join(caseDir, "signals.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

function standInEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    DAEMON_TEST_DIR: caseDir,
    ...extra,
  };
}

function setUpCase(plan: object[]): void {
  caseNumber += 1;
  caseDir = join(root, `case-${caseNumber}`);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "plan.json"), JSON.stringify(plan));
  standIn = join(caseDir, "claude.mjs");
  writeFileSync(standIn, STAND_IN);
  chmodSync(standIn, 0o755);
}

function killLeftovers(): void {
  for (const { pid } of starts()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

const quickWait: ReinstallWait = {
  fastMs: 300,
  fastPollMs: 50,
  slowMs: 600,
  slowPollMs: 50,
  stagingFreshMs: 600_000,
  stubMaxBytes: 64 * 1024,
};

describe.skipIf(onWindows)("superviseClaudeDaemon", () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
  });
  afterEach(killLeftovers);

  function supervise(plan: object[], extra: Partial<SupervisorOptions> = {}) {
    setUpCase(plan);
    return superviseClaudeDaemon({
      resolveBinary: async () => standIn,
      argv: supervisorArgv([]),
      env: standInEnv(),
      log: (line) => logs.push(line),
      reinstallWait: quickWait,
      ...extra,
    });
  }

  test("starts the supervisor again after an upgrade exit and ends with its next code", async () => {
    const supervision = supervise([{ exit: SUPERVISOR_UPGRADE_EXIT }, { exit: 3 }]);
    expect(await supervision.exitCode).toBe(3);
    expect(starts().map((s) => s.argv)).toEqual([
      ["daemon", "run", "--origin", "service"],
      ["daemon", "run", "--origin", "service"],
    ]);
    expect(logs).toContain("supervisor exited to upgrade; starting it again");
  });

  test("ends with any other exit code at once", async () => {
    expect(await supervise([{ exit: 0 }]).exitCode).toBe(0);
    expect(starts()).toHaveLength(1);
    expect(await supervise([{ exit: 5 }]).exitCode).toBe(5);
    expect(starts()).toHaveLength(1);
    expect(logs).toContain("claude daemon run exited with code 5; `claude daemon logs` shows why");
  });

  test("reports a supervisor killed by a signal as 128 + signum", async () => {
    expect(await supervise([{ kill: true }]).exitCode).toBe(137);
    expect(logs).toContain(
      "claude daemon run was killed by SIGKILL; `claude daemon logs` shows why"
    );
  });

  test("stop sends one SIGTERM and ends with the stop signal's code", async () => {
    const supervision = supervise([{}]);
    await waitFor("the supervisor to start", () => starts().length === 1);
    supervision.stop("SIGINT");
    expect(await supervision.exitCode).toBe(130);
    expect(signals()).toEqual(["SIGTERM"]);
    expect(logs).toContain("claude daemon run exited with code 0");
  });

  test("a restart waits for an upgraded binary that is not in place yet", async () => {
    const supervision = supervise([{ exit: SUPERVISOR_UPGRADE_EXIT, vanish: true }, { exit: 0 }], {
      reinstallWait: { ...quickWait, fastMs: 5000 },
    });
    await waitFor("the first start", () => starts().length === 1);
    await Bun.sleep(300);
    expect(starts()).toHaveLength(1);
    renameSync(`${standIn}.away`, standIn);
    expect(await supervision.exitCode).toBe(0);
    expect(starts()).toHaveLength(2);
  });

  test("a restart gives up once the binary stays missing past the wait", async () => {
    const supervision = supervise([{ exit: SUPERVISOR_UPGRADE_EXIT, vanish: true }]);
    expect(await supervision.exitCode).toBe(1);
    expect(starts()).toHaveLength(1);
    expect(logs).toContain(`${standIn} is not runnable after the upgrade; giving up`);
  });

  test("a stop during the wait ends without another start", async () => {
    const supervision = supervise([{ exit: SUPERVISOR_UPGRADE_EXIT, vanish: true }], {
      reinstallWait: { ...quickWait, fastMs: 5000 },
    });
    await waitFor("the first start", () => starts().length === 1);
    supervision.stop("SIGTERM");
    expect(await supervision.exitCode).toBe(143);
    expect(starts()).toHaveLength(1);
  });

  test("a missing binary on the first start ends with 1", async () => {
    const supervision = supervise([], { resolveBinary: async () => null });
    expect(await supervision.exitCode).toBe(1);
    expect(logs).toContain("Claude Code CLI not found; set CLAUDE_PATH to its binary");
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function runClaudish(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ["run", join(import.meta.dir, "index.ts"), ...args], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    // Its own group, like a job a shell started, so the test can signal the
    // group as a terminal would.
    detached: true,
  });
}

async function exitOf(proc: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
  return { code, stderr };
}

describe.skipIf(onWindows)("claudish daemon", () => {
  afterEach(killLeftovers);

  function cliEnv(): NodeJS.ProcessEnv {
    const home = join(caseDir, "home");
    mkdirSync(home, { recursive: true });
    return standInEnv({
      HOME: home,
      TMPDIR: caseDir,
      CLAUDE_PATH: standIn,
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    });
  }

  test("runs the supervisor behind the proxy, restarts it on upgrade, and stops it with one signal", async () => {
    setUpCase([
      { health: true, exit: SUPERVISOR_UPGRADE_EXIT },
      { health: true, healthOnStop: true },
    ]);
    const port = await freePort();
    const proc = runClaudish(
      ["daemon", "--port", String(port), "--", "--log-file", "/x"],
      cliEnv()
    );
    const exit = exitOf(proc);

    await waitFor("the restarted supervisor", () => starts().length === 2, 15_000);
    for (const start of starts()) {
      expect(start.argv).toEqual(["daemon", "run", "--log-file", "/x", "--origin", "service"]);
      expect(start.baseUrl).toBe(`http://127.0.0.1:${port}`);
      expect(start.firstParty).toBe("1");
      expect(start.health).toEqual({ status: 200, body: { status: "ok" } });
    }

    // What a terminal's Ctrl-C does: the signal goes to claudish's group.
    process.kill(-(proc.pid as number), "SIGINT");
    const { code } = await exit;
    expect(code).toBe(130);
    expect(signals()).toEqual(["SIGTERM"]);
    // The proxy outlived the supervisor's shutdown, and went once it was over.
    expect(readFileSync(join(caseDir, "stop-health.log"), "utf8")).toBe("200\n");
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  }, 30_000);

  test.each([
    [[], "--port <n> is required"],
    [["--port", "1", "--json-path", "x"], "unknown argument --json-path"],
  ])(
    "refuses %j with exit 1",
    async (args, message) => {
      setUpCase([]);
      const { code, stderr } = await exitOf(runClaudish(["daemon", ...args], cliEnv()));
      expect(code).toBe(1);
      expect(stderr).toContain(message);
      expect(starts()).toHaveLength(0);
    },
    30_000
  );
});
