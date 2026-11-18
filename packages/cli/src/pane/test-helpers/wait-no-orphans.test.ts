/**
 * `waitNoOrphans` polls the process table, and `ps` can fail to start for a moment on a loaded
 * machine. One failed read inside the wait is retried; an unavailable table at the end of the
 * wait still throws, because reading it as "no process" would pass with every orphan running.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PsSpawn, setPsSpawnForTest } from "../process-identity.js";
import { SANDBOX_REFUSED_PS, waitNoOrphans } from "./hermetic-env.js";

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
