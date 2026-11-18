/**
 * `waitNoOrphans` and `killLeftovers` read the process table, and `ps` can fail to start for a
 * moment on a loaded machine. A failed read is read again; a table still unavailable at the end
 * still throws, because reading it as "no process" would pass with every orphan running.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PsSpawn, setPsSpawnForTest } from "../process-identity.js";
import { SANDBOX_REFUSED_PS, killLeftovers, waitNoOrphans } from "./hermetic-env.js";

const dirs: string[] = [];
let restore: PsSpawn | undefined;

afterEach(() => {
  if (restore) setPsSpawnForTest(restore);
  restore = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptySockRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudish-wait-orphans-"));
  dirs.push(dir);
  return dir;
}

/** `ps` refused for the first `failures` synchronous reads, then the real one. */
function refusedFor(failures: number): PsSpawn {
  const real = setPsSpawnForTest(SANDBOX_REFUSED_PS);
  setPsSpawnForTest(real);
  let left = failures;
  return {
    execFileSync: (file, args, opts) => {
      if (left-- > 0) return SANDBOX_REFUSED_PS.execFileSync(file, args, opts);
      return real.execFileSync(file, args, opts);
    },
    execFile: real.execFile,
  };
}

describe("waitNoOrphans", () => {
  test("retries a process table that ps could not read inside the wait", async () => {
    const sockRoot = emptySockRoot();
    restore = setPsSpawnForTest(refusedFor(2));
    expect(await waitNoOrphans({ sockRoot }, 5000)).toEqual({ processes: [], files: [] });
  });

  test("still throws when the table is unavailable at the end of the wait", async () => {
    const sockRoot = emptySockRoot();
    restore = setPsSpawnForTest(SANDBOX_REFUSED_PS);
    await expect(waitNoOrphans({ sockRoot }, 500)).rejects.toThrow(
      "process table unavailable: ps could not run"
    );
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killLeftovers", () => {
  test("reads a process table that ps could not read again, and kills the leftover", async () => {
    const sockRoot = emptySockRoot();
    // One process with the sock root in its own arguments, so the kill leaves no untagged child.
    const leftover = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", "setTimeout(() => {}, 30_000)", sockRoot],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }
    );
    try {
      restore = setPsSpawnForTest(refusedFor(2));
      killLeftovers({ sockRoot });
      await leftover.exited;
      expect(alive(leftover.pid)).toBe(false);
    } finally {
      leftover.kill("SIGKILL");
    }
  });

  test("kills the leftovers of several sock roots with one process table read", async () => {
    const roots = [emptySockRoot(), emptySockRoot()];
    const leftovers = roots.map((root) =>
      Bun.spawn([process.execPath, "--no-env-file", "-e", "setTimeout(() => {}, 30_000)", root], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      })
    );
    const real = setPsSpawnForTest(SANDBOX_REFUSED_PS);
    setPsSpawnForTest(real);
    let reads = 0;
    try {
      restore = setPsSpawnForTest({
        execFileSync: (file, args, opts) => {
          reads++;
          return real.execFileSync(file, args, opts);
        },
        execFile: real.execFile,
      });
      killLeftovers({ sockRoot: roots });
      await Promise.all(leftovers.map((p) => p.exited));
      expect(leftovers.map((p) => alive(p.pid))).toEqual([false, false]);
      expect(reads).toBe(1);
    } finally {
      for (const p of leftovers) p.kill("SIGKILL");
    }
  });

  test("still throws when ps can never read the table", () => {
    const sockRoot = emptySockRoot();
    restore = setPsSpawnForTest(SANDBOX_REFUSED_PS);
    expect(() => killLeftovers({ sockRoot })).toThrow(
      "process table unavailable: ps could not run"
    );
  });
});
