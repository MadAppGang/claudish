import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileLockUnavailableError,
  acquireFileLock,
  readHolder,
  withFileLock,
} from "./file-lock.js";
import { withRefreshGate } from "./refresh-lock.js";
import { withStateLock } from "./state-lock.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "claudish-file-lock-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for child-process barrier");
    await sleep(5);
  }
}

function holder(pid: number, host: string, nonce: string, at: number): string {
  return `${JSON.stringify({ pid, host, nonce, at })}\n`;
}

describe("file lock cross-process exclusion", () => {
  test("serializes four independently spawned OS processes", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "refresh.lock");
      const goPath = join(dir, "go");
      const modulePath = join(import.meta.dir, "file-lock.ts");
      const children = Array.from({ length: 4 }, (_, index) => {
        const readyPath = join(dir, `ready-${index}`);
        const resultPath = join(dir, `result-${index}.json`);
        const source = `
            import { existsSync, writeFileSync } from "node:fs";
            import { acquireFileLock } from ${JSON.stringify(modulePath)};
            const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
            writeFileSync(${JSON.stringify(readyPath)}, "ready");
            while (!existsSync(${JSON.stringify(goPath)})) await sleep(2);
            const handle = await acquireFileLock(${JSON.stringify(lockPath)}, {
              timeoutMs: 5_000,
              pollMs: 2,
              staleMs: 5_000,
              heartbeatMs: 25,
            });
            const enteredAt = Date.now();
            await sleep(150);
            const exitedAt = Date.now();
            handle.release();
            writeFileSync(
              ${JSON.stringify(resultPath)},
              JSON.stringify({ index: ${index}, enteredAt, exitedAt })
            );
          `;
        return {
          readyPath,
          resultPath,
          process: Bun.spawn([process.execPath, "-e", source], {
            cwd: import.meta.dir,
            env: {
              ...process.env,
              CLAUDISH_DISABLE_KEYCHAIN: "1",
              CLAUDISH_DISABLE_OP: "1",
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          }),
        };
      });

      await waitFor(() => children.every((child) => existsSync(child.readyPath)));
      writeFileSync(goPath, "go");

      const exits = await Promise.all(
        children.map(async (child) => {
          const stderrPromise = new Response(child.process.stderr).text();
          const exitCode = await child.process.exited;
          return { exitCode, stderr: await stderrPromise };
        })
      );
      expect(exits).toEqual([
        { exitCode: 0, stderr: "" },
        { exitCode: 0, stderr: "" },
        { exitCode: 0, stderr: "" },
        { exitCode: 0, stderr: "" },
      ]);

      const intervals = children
        .map(
          (child) =>
            JSON.parse(readFileSync(child.resultPath, "utf8")) as {
              index: number;
              enteredAt: number;
              exitedAt: number;
            }
        )
        .sort((a, b) => a.enteredAt - b.enteredAt);

      expect(intervals).toHaveLength(4);
      for (let index = 1; index < intervals.length; index++) {
        expect(intervals[index].enteredAt).toBeGreaterThanOrEqual(intervals[index - 1].exitedAt);
      }
      expect(existsSync(lockPath)).toBe(false);

      // Mutation caught: make acquire succeed without open(..., "wx") / O_EXCL.
      // The barrier releases four already-loaded processes together; without
      // exclusion their 150 ms critical sections overlap.
    });
  }, 15_000);

  test("two OS waiters cannot both hold after racing to steal one stale lock", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "stale.lock");
      const goPath = join(dir, "go");
      const stalePid = 777_777;
      writeFileSync(lockPath, holder(stalePid, "race-host", "stale-nonce", 1));
      const modulePath = join(import.meta.dir, "file-lock.ts");

      const children = Array.from({ length: 2 }, (_, index) => {
        const judgedPath = join(dir, `judged-${index}`);
        const acquiredPath = join(dir, `acquired-${index}`);
        const releasePath = join(dir, `release-${index}`);
        const source = `
          import { existsSync, writeFileSync } from "node:fs";
          import { acquireFileLock } from ${JSON.stringify(modulePath)};
          const pause = (ms = 2) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
          while (!existsSync(${JSON.stringify(goPath)})) await Bun.sleep(2);
          const handle = await acquireFileLock(${JSON.stringify(lockPath)}, {
            timeoutMs: 5_000,
            pollMs: 2,
            staleMs: 60_000,
            heartbeatMs: 0,
            deps: {
              now: () => 100_000,
              hostname: () => "race-host",
              isProcessAlive: (pid) => {
                if (pid === ${stalePid}) {
                  writeFileSync(${JSON.stringify(judgedPath)}, "judged");
                  while (![${JSON.stringify(join(dir, "judged-0"))}, ${JSON.stringify(join(dir, "judged-1"))}].every(existsSync)) pause();
                  if (${index} === 1) pause(75);
                  return false;
                }
                return true;
              },
              sleep: async (ms) => Bun.sleep(ms),
            },
          });
          writeFileSync(${JSON.stringify(acquiredPath)}, handle.nonce);
          while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(2);
          handle.release();
        `;
        return {
          index,
          acquiredPath,
          releasePath,
          process: Bun.spawn([process.execPath, "-e", source], {
            cwd: import.meta.dir,
            env: {
              ...process.env,
              CLAUDISH_DISABLE_KEYCHAIN: "1",
              CLAUDISH_DISABLE_OP: "1",
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          }),
        };
      });

      writeFileSync(goPath, "go");
      await waitFor(() => children.some((child) => existsSync(child.acquiredPath)));
      await sleep(100);
      const firstWave = children.filter((child) => existsSync(child.acquiredPath));
      expect(firstWave).toHaveLength(1);
      const winner = firstWave[0] as (typeof children)[number];
      const waiter = children.find((child) => child !== winner) as (typeof children)[number];
      expect(readHolder(lockPath)?.nonce).toBe(readFileSync(winner.acquiredPath, "utf8"));

      writeFileSync(winner.releasePath, "release");
      await waitFor(() => existsSync(waiter.acquiredPath));
      expect(readHolder(lockPath)?.nonce).toBe(readFileSync(waiter.acquiredPath, "utf8"));
      writeFileSync(waiter.releasePath, "release");

      const exits = await Promise.all(
        children.map(async (child) => ({
          exitCode: await child.process.exited,
          stderr: await new Response(child.process.stderr).text(),
        }))
      );
      expect(exits).toEqual([
        { exitCode: 0, stderr: "" },
        { exitCode: 0, stderr: "" },
      ]);
      expect(existsSync(lockPath)).toBe(false);

      // Mutation caught: steal by read-then-rm. Both waiters judge the stale
      // record behind the explicit barrier; the delayed rm deletes the winner's
      // new lock and both acquired markers appear in the first wave.
    });
  }, 15_000);
});

describe("file lock holder lifecycle", () => {
  test("steals a fresh same-host lock when its process is provably dead", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "dead.lock");
      let now = 10_000;
      writeFileSync(path, holder(777_777, "test-host", "dead-nonce", now));

      const handle = await acquireFileLock(path, {
        timeoutMs: 20,
        pollMs: 2,
        staleMs: 60_000,
        deps: {
          now: () => now,
          hostname: () => "test-host",
          isProcessAlive: () => false,
          sleep: async (ms) => {
            now += ms;
          },
        },
      });

      expect(handle.holdsLock()).toBe(true);
      expect(handle.nonce).not.toBe("dead-nonce");
      handle.release();

      // Mutation caught: remove dead-holder detection. The fresh holder is not
      // stale, so the mutant times out instead of acquiring.
    });
  });

  test("steals a stale same-host holder even when its pid is reported alive", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "stale.lock");
      writeFileSync(path, holder(process.pid, "test-host", "stale-nonce", 1_000));

      const handle = await acquireFileLock(path, {
        timeoutMs: 20,
        pollMs: 2,
        staleMs: 500,
        deps: {
          now: () => 2_000,
          hostname: () => "test-host",
          isProcessAlive: () => true,
          sleep: async () => {},
        },
      });

      expect(handle.holdsLock()).toBe(true);
      handle.release();

      // Mutation caught: remove same-host stale-TTL stealing.
    });
  });

  test("steals an old zero-byte lock left by a crash before the holder write", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "empty.lock");
      writeFileSync(path, "");
      utimesSync(path, new Date(1_000), new Date(1_000));

      const handle = await acquireFileLock(path, {
        timeoutMs: 20,
        pollMs: 2,
        staleMs: 500,
        deps: {
          now: () => 2_000,
          hostname: () => "test-host",
          isProcessAlive: () => true,
          sleep: async () => {},
        },
      });

      expect(handle.holdsLock()).toBe(true);
      expect(readHolder(path)?.nonce).toBe(handle.nonce);
      handle.release();

      // Mutation caught: treat readHolder(path) === null as permanently live.
      // The zero-byte lock reaches the acquire timeout instead of being stolen by
      // its mtime identity.
    });
  });

  test("removes the file it created when the initial holder write fails", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "write-fails.lock");
      const modulePath = join(import.meta.dir, "file-lock.ts");
      const source = `
        import { existsSync } from "node:fs";
        import { acquireFileLock } from ${JSON.stringify(modulePath)};
        process.on("SIGXFSZ", () => {});
        try {
          const handle = await acquireFileLock(${JSON.stringify(path)}, {
            timeoutMs: 20,
            staleMs: 100,
          });
          handle.release();
          process.stdout.write(JSON.stringify({ acquired: true, exists: existsSync(${JSON.stringify(path)}) }));
        } catch (error) {
          process.stdout.write(JSON.stringify({
            acquired: false,
            name: error?.name,
            reason: error?.reason,
            exists: existsSync(${JSON.stringify(path)}),
          }));
        }
      `;
      const child = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          'ulimit -f 0; exec "$1" -e "$2"',
          "claudish-lock-write-failure",
          process.execPath,
          source,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } }
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        acquired: false,
        name: "FileLockUnavailableError",
        reason: "unwritable",
        exists: false,
      });
      expect(existsSync(path)).toBe(false);

      // Mutation caught: omit the inode-checked unlink in tryCreate's write
      // failure branch. The child reports exists:true for the zero-byte file.
    });
  });

  test("never steals a foreign-host holder", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "foreign.lock");
      writeFileSync(path, holder(42, "other-host", "remote-nonce", 0));
      let sleepCalls = 0;

      await expect(
        acquireFileLock(path, {
          timeoutMs: 20,
          pollMs: 2,
          staleMs: 1,
          deps: {
            now: () => 100_000,
            hostname: () => "this-host",
            isProcessAlive: () => false,
            sleep: async () => {
              sleepCalls++;
            },
          },
        })
      ).rejects.toMatchObject({ reason: "foreign-host" });
      expect(sleepCalls).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(holder(42, "other-host", "remote-nonce", 0));

      // Mutation caught: apply dead-pid or stale stealing across hosts.
    });
  });

  test("fence and release compare host, pid, and nonce", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "fenced.lock");
      const handle = await acquireFileLock(path, {
        timeoutMs: 20,
        staleMs: 1_000,
        deps: { hostname: () => "test-host" },
      });
      writeFileSync(path, holder(handle.pid, handle.host, "successor-nonce", Date.now()));

      expect(handle.holdsLock()).toBe(false);
      handle.release();
      expect(readHolder(path)?.nonce).toBe("successor-nonce");

      // Mutation caught: fence/release on pid alone. The stolen-from holder would
      // report ownership and delete its successor's lock.
    });
  });

  test("heartbeat renews the holder for the entire hold", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "heartbeat.lock");
      let tick = 1_000;
      const handle = await acquireFileLock(path, {
        timeoutMs: 20,
        staleMs: 1_000,
        heartbeatMs: 5,
        deps: {
          now: () => ++tick,
          hostname: () => "test-host",
        },
      });
      const initialAt = readHolder(path)?.at ?? 0;
      await sleep(25);
      const renewedAt = readHolder(path)?.at ?? 0;

      expect(renewedAt).toBeGreaterThan(initialAt);
      expect(handle.holdsLock()).toBe(true);
      handle.release();

      // Mutation caught: start no heartbeat, or stop it before callback work ends.
    });
  });
});

describe("caller-chosen unavailable semantics", () => {
  test("withFileLock fails closed or proceeds unlocked only when explicitly requested", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "foreign.lock");
      writeFileSync(path, holder(9, "remote-host", "remote", 0));
      const deps = { now: () => 1_000, hostname: () => "local-host" };
      let failWorkRan = false;

      await expect(
        withFileLock(path, { timeoutMs: 1, staleMs: 1, deps, onUnavailable: "fail" }, async () => {
          failWorkRan = true;
        })
      ).rejects.toBeInstanceOf(FileLockUnavailableError);
      expect(failWorkRan).toBe(false);

      let proceededHandle: unknown = "not-called";
      const result = await withFileLock(
        path,
        { timeoutMs: 1, staleMs: 1, deps, onUnavailable: "proceed" },
        async (handle) => {
          proceededHandle = handle;
          return "unlocked";
        }
      );
      expect(result).toBe("unlocked");
      expect(proceededHandle).toBeNull();

      // Mutation caught: give onUnavailable an implicit shared default or make
      // both callers inherit the same fail-open/fail-closed behavior.
    });
  });

  test("refresh gate fails closed while state lock returns null", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "foreign.lock");
      writeFileSync(path, holder(9, "remote-host", "remote", 0));
      const deps = { now: () => 1_000, hostname: () => "local-host" };
      let refreshWorkRan = false;

      await expect(
        withRefreshGate(
          "openai-codex",
          "account-a",
          async () => {
            refreshWorkRan = true;
          },
          { path, deps }
        )
      ).rejects.toMatchObject({ reason: "foreign-host" });
      expect(refreshWorkRan).toBe(false);

      let stateWorkRan = false;
      const stateResult = await withStateLock(
        async () => {
          stateWorkRan = true;
          return "persisted";
        },
        { path, deps }
      );
      expect(stateResult).toBeNull();
      expect(stateWorkRan).toBe(false);

      // Mutations caught: make refresh-lock proceed without ownership, or make
      // state-lock propagate acquire failure instead of returning its drop signal.
    });
  });
});
