import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KILL_PROCESS_GROUP,
  signalProcessTree,
  terminateChildTree,
  waitForExit,
} from "./process-tree.js";

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

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
