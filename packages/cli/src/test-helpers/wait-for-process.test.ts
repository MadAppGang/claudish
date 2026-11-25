/**
 * `waitForProcess` polls the process table while the code under test is still running on
 * the same event loop (a team run starting its panes, a reap). A synchronous `ps` blocks
 * that loop for the whole read, and on a loaded machine each read takes hundreds of ms, so
 * a poll every 25 ms leaves the work it waits for almost no time to run. The wait must read
 * the table without blocking: timers keep firing between and during its reads.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type PsSpawn, setPsSpawnForTest } from "../pane/process-identity.js";
import { waitForProcess } from "./team-pane.js";

/** How long one stubbed `ps` read takes, sync or async. */
const PS_READ_MS = 200;

/** A table `processTableTrusted` accepts: it lists this process. */
const TABLE = `${process.pid} 1 ${process.pid} 00:05 Wed Nov 25 10:00:00 2026 bun test\n`;

/** `ps` that takes `PS_READ_MS` either way: a busy wait when sync, a timer when async. */
const SLOW_PS: PsSpawn = {
  execFileSync() {
    const end = performance.now() + PS_READ_MS;
    while (performance.now() < end) {}
    return TABLE;
  },
  execFile(_file, _args, _opts, cb) {
    setTimeout(() => cb(null, TABLE), PS_READ_MS);
    return undefined;
  },
};

let restore: PsSpawn | undefined;

afterEach(() => {
  if (restore) setPsSpawnForTest(restore);
  restore = undefined;
});

describe("waitForProcess", () => {
  test("keeps the event loop serving timers while it waits", async () => {
    restore = setPsSpawnForTest(SLOW_PS);
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks++;
    }, 10);
    try {
      await expect(
        waitForProcess(() => false, "a process that never starts", 1_000)
      ).rejects.toThrow("timed out waiting for a process that never starts");
    } finally {
      clearInterval(ticker);
    }
    // About 100 ticks of 10 ms fit in the 1 s wait when the reads do not block; a blocking
    // read leaves room for a handful between its 200 ms stalls.
    expect(ticks).toBeGreaterThanOrEqual(50);
  });

  test("returns the row of the process it waits for", async () => {
    restore = setPsSpawnForTest(SLOW_PS);
    const row = await waitForProcess((r) => r.pid === process.pid, "this process", 1_000);
    expect(row.command).toBe("bun test");
  });
});
