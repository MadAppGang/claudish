import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PsSpawn, readProcessTableAsync, setPsSpawnForTest } from "./pane/process-identity.js";
import {
  KILL_PROCESS_GROUP,
  descendantsOf,
  signalProcessTree,
  snapshotDescendants,
  terminateChildTree,
  waitForExit,
} from "./process-tree.js";

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnChild(body: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", body], {
    env: { ...process.env },
    detached: KILL_PROCESS_GROUP,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

function waitForOutput(child: ChildProcess, expected: string, timeoutMs = 1_000): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) return Promise.reject(new Error("Child stdout is not piped"));

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(expected)) finish();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Child exited before writing ${expected}: code=${code} signal=${signal}`));
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for child output: ${expected}`)),
      timeoutMs
    );

    stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  const trackedChildren = [...children];

  for (const child of trackedChildren) {
    signalProcessTree(child, "SIGKILL");
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  await Promise.all(trackedChildren.map((child) => waitForExit(child, 400)));

  for (const child of trackedChildren) {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  children.clear();

  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("descendantsOf", () => {
  const entry = (pid: number, ppid: number) => ({ pid, ppid, lstart: `started ${pid}` });
  const pidsOf = (members: { pid: number }[]) => members.map((m) => m.pid);

  test("walks every level below the root and nothing beside it", () => {
    const table = [entry(200, 100), entry(300, 200), entry(201, 100), entry(900, 800)];
    expect(pidsOf(descendantsOf(table, 100))).toEqual([200, 201, 300]);
  });

  test("keeps each descendant's start time", () => {
    expect(descendantsOf([entry(200, 100)], 100)).toEqual([{ pid: 200, lstart: "started 200" }]);
  });

  test("never lists the root, init or this process", () => {
    const table = [entry(100, 100), entry(1, 100), entry(process.pid, 100), entry(200, 100)];
    expect(pidsOf(descendantsOf(table, 100))).toEqual([200]);
  });

  test("ends on a parent cycle in a table read mid-change", () => {
    const table = [entry(200, 300), entry(300, 200), entry(201, 200)];
    expect(pidsOf(descendantsOf(table, 200)).sort()).toEqual([201, 300]);
  });
});

describe("snapshotDescendants", () => {
  const row = (pid: number, ppid: number) =>
    `${pid} ${ppid} ${ppid} 00:01 Mon Oct  6 12:34:56 2026 cmd`;

  async function withPs<T>(execFile: PsSpawn["execFile"], run: () => Promise<T>): Promise<T> {
    const previous = setPsSpawnForTest({
      execFile,
      execFileSync: () => {
        throw new Error("not used");
      },
    });
    try {
      return await run();
    } finally {
      setPsSpawnForTest(previous);
    }
  }

  test("reads the tree from the process table", async () => {
    const table = [row(process.pid, 1), row(200, 100), row(300, 200), row(900, 800)].join("\n");
    const pids = await withPs(
      (_file, _args, _opts, cb) => cb(null, table),
      () => snapshotDescendants(100, 1_000)
    );
    expect(pids.map((m) => m.pid)).toEqual([200, 300]);
  });

  test("a plain table read, as the other callers make it, sets no cancel", async () => {
    let seen: { timeout?: number; killSignal?: string } | undefined;
    await withPs(
      (_file, _args, opts, cb) => {
        seen = opts;
        cb(null, row(process.pid, 1));
      },
      () => readProcessTableAsync()
    );
    expect(seen?.timeout).toBeUndefined();
    expect(seen?.killSignal).toBeUndefined();
  });

  test("is empty when ps cannot start", async () => {
    const pids = await withPs(
      () => {
        throw new Error("EPERM");
      },
      () => snapshotDescendants(100, 1_000)
    );
    expect(pids).toEqual([]);
  });

  test("is empty when ps fails", async () => {
    const pids = await withPs(
      (_file, _args, _opts, cb) => cb(new Error("exit 1"), ""),
      () => snapshotDescendants(100, 1_000)
    );
    expect(pids).toEqual([]);
  });

  test("cancels a ps that never answers, so it cannot outlive the read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-ps-cancel-"));
    tempDirs.add(dir);
    const pidFile = join(dir, "pid");
    const neverAnswers: PsSpawn["execFile"] = (_file, _args, opts, cb) =>
      execFile(
        "/bin/sh",
        ["-c", `echo $$ > "${pidFile}"; exec sleep 30`],
        { ...opts, env: opts.env },
        (err, stdout) => cb(err, String(stdout))
      );
    let pid = 0;
    try {
      await withPs(neverAnswers, () => snapshotDescendants(100, 200));
      expect(existsSync(pidFile)).toBe(true);
      pid = Number(readFileSync(pidFile, "utf8"));
      const deadline = Date.now() + 2_000;
      while (isRunning(pid) && Date.now() < deadline) await Bun.sleep(25);
      expect(isRunning(pid)).toBe(false);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Cancelled, as it should have been.
        }
      }
    }
  });

  test("gives up on a ps that never answers, at its budget", async () => {
    const startedAt = Date.now();
    const pids = await withPs(
      () => undefined,
      () => snapshotDescendants(100, 100)
    );
    expect(pids).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(600);
  });
});

describe("process tree termination", () => {
  test("waitForExit resolves true for a child that exits promptly", async () => {
    const child = spawnChild("process.exit(0);");

    expect(await waitForExit(child, 400)).toBe(true);
  });

  test("waitForExit resolves false when the child outlives the timeout", async () => {
    const child = spawnChild("setInterval(() => {}, 1000);");

    expect(await waitForExit(child, 200)).toBe(false);
    expect(await terminateChildTree(child, 200)).toBe(true);
  });

  test("terminateChildTree returns true for a child that exits on SIGTERM", async () => {
    const child = spawnChild('process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
    await waitForOutput(child, "ready");

    expect(await terminateChildTree(child, 200)).toBe(true);
  });

  test("terminateChildTree returns true after escalating past an ignored SIGTERM", async () => {
    const child = spawnChild(
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready\\n");'
    );
    await waitForOutput(child, "ready");

    expect(await terminateChildTree(child, 300)).toBe(true);
  });

  test("terminateChildTree sends SIGKILL to a non-detached child that ignores SIGTERM", async () => {
    if (process.platform === "win32") return;

    const child = spawn("sh", ["-c", "trap '' TERM; echo ready; while :; do sleep 0.1; done"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    await waitForOutput(child, "ready");

    expect(await terminateChildTree(child, 300)).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("signalProcessTree does not throw for an already-exited child", async () => {
    const child = spawnChild("process.exit(0);");
    expect(await waitForExit(child, 400)).toBe(true);

    expect(() => signalProcessTree(child, "SIGTERM")).not.toThrow();
  });

  test("terminateChildTree kills a grandchild when process groups are enabled", async () => {
    if (!KILL_PROCESS_GROUP) return;

    const dir = mkdtempSync(join(tmpdir(), "claudish-process-tree-"));
    tempDirs.add(dir);
    const marker = join(dir, "grandchild-survived");
    const grandchildBody = [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "survived"), 1500);`,
      'process.stdout.write("grandchild-ready\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentBody = [
      'const { spawn } = require("node:child_process");',
      // Keep the held parent alive through the grace period so termination escalates for the group.
      'process.on("SIGTERM", () => {});',
      `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildBody)}], { stdio: "inherit" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawnChild(parentBody);
    await waitForOutput(parent, "grandchild-ready");

    expect(await terminateChildTree(parent, 200)).toBe(true);
    await delay(2_500);

    expect(existsSync(marker)).toBe(false);
  });
});
