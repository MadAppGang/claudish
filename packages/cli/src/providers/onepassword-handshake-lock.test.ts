/**
 * Tests for onepassword-handshake-lock.ts — the dependency-light cross-process
 * mutex around the 1Password DesktopAuth handshake.
 *
 * Every test redirects the exported path seam into a fresh temp directory and
 * compresses the shipped 120s stale / 45s timeout timings to milliseconds. The
 * real ~/.claudish directory, 1Password SDK, `op` binary, and network are never
 * touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetHandshakeContextForTests,
  peerHoldsHandshakeLock,
  resetHandshakeLockTestSeams,
  setHandshakeLockTestSeams,
  withHandshakeLock,
} from "./onepassword-handshake-lock.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let lockPath: string;
let savedBypass: string | undefined;

function writeLiveForeignLock(at: number): void {
  expect(process.ppid).not.toBe(process.pid);
  expect(() => process.kill(process.ppid, 0)).not.toThrow();
  writeFileSync(lockPath, `${process.ppid} ${at}`);
}

beforeEach(() => {
  __resetHandshakeContextForTests();
  dir = mkdtempSync(join(tmpdir(), "claudish-op-handshake-lock-"));
  lockPath = join(dir, "op-handshake.lock");
  savedBypass = process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK;
  delete process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK;
  setHandshakeLockTestSeams({
    path: lockPath,
    timing: { staleMs: 500, timeoutMs: 100, pollMs: 1 },
  });
});

afterEach(() => {
  __resetHandshakeContextForTests();
  resetHandshakeLockTestSeams();
  if (savedBypass === undefined) delete process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK;
  else process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK = savedBypass;
  rmSync(dir, { recursive: true, force: true });
});

describe("peerHoldsHandshakeLock", () => {
  test("returns false when no lock file exists", () => {
    expect(existsSync(lockPath)).toBe(false);
    expect(peerHoldsHandshakeLock()).toBe(false);
  });

  test("returns false when this process owns the lock", () => {
    writeFileSync(lockPath, `${process.pid} ${Date.now()}`);

    expect(peerHoldsHandshakeLock()).toBe(false);
  });

  test("returns false when the lock owner has exited", () => {
    const deadProcess = spawnSync(process.execPath, ["-e", ""], { env: { ...process.env } });
    expect(deadProcess.status).toBe(0);
    expect(deadProcess.pid).toBeGreaterThan(0);
    expect(() => process.kill(deadProcess.pid!, 0)).toThrow();
    writeFileSync(lockPath, `${deadProcess.pid} ${Date.now()}`);

    expect(peerHoldsHandshakeLock()).toBe(false);
  });

  test("returns true for a recent lock held by a live foreign process", () => {
    writeLiveForeignLock(Date.now());

    expect(peerHoldsHandshakeLock()).toBe(true);
  });

  test("returns false for a stale lock held by a live foreign process", () => {
    writeLiveForeignLock(Date.now() - 501);

    expect(peerHoldsHandshakeLock()).toBe(false);
  });

  test.each(["", "not-a-pid not-a-timestamp"])(
    "returns false without throwing for an unreadable lock fixture %p",
    (contents) => {
      writeFileSync(lockPath, contents);

      expect(() => peerHoldsHandshakeLock()).not.toThrow();
      expect(peerHoldsHandshakeLock()).toBe(false);
    }
  );

  test("does not blame a later holder after our own locked handshake is denied", async () => {
    await expect(
      withHandshakeLock(async () => {
        expect(readFileSync(lockPath, "utf-8").startsWith(`${process.pid} `)).toBe(true);
        throw new Error("authorization denied");
      })
    ).rejects.toThrow("authorization denied");

    writeLiveForeignLock(Date.now());
    expect(peerHoldsHandshakeLock()).toBe(false);
  });

  test("never blames a peer when we held the lock, even if the holder predates our handshake (fact 1, otherwise unreachable)", async () => {
    setHandshakeLockTestSeams({ timing: { staleMs: 10_000 } });
    const beforeHandshake = Date.now();

    await expect(
      withHandshakeLock(async () => {
        expect(readFileSync(lockPath, "utf-8").startsWith(`${process.pid} `)).toBe(true);
        throw new Error("authorization denied");
      })
    ).rejects.toThrow("authorization denied");

    // Synthetic state: O_EXCL makes an older foreign holder unreachable after we held the lock.
    // This pins Fact 1 so its direct ownership guarantee is not deleted as dead code.
    const foreignHolderAt = beforeHandshake - 5;
    writeLiveForeignLock(foreignHolderAt);
    expect(Date.now() - foreignHolderAt).toBeLessThan(10_000);
    expect(peerHoldsHandshakeLock()).toBe(false);
  });

  test("does not blame a foreign holder that arrived after an unlocked handshake began", async () => {
    process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK = "1";

    await expect(
      withHandshakeLock(async () => {
        const callbackStartedAt = Date.now();
        while (Date.now() <= callbackStartedAt) await sleep(1);
        writeLiveForeignLock(Date.now());
        throw new Error("authorization denied");
      })
    ).rejects.toThrow("authorization denied");

    expect(peerHoldsHandshakeLock()).toBe(false);
  });

  test("recognizes a foreign holder that predates an unlocked handshake", async () => {
    process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK = "1";
    const holderStartedAt = Date.now();
    writeLiveForeignLock(holderStartedAt);
    while (Date.now() <= holderStartedAt) await sleep(1);

    await expect(
      withHandshakeLock(async () => {
        throw new Error("authorization denied");
      })
    ).rejects.toThrow("authorization denied");

    expect(peerHoldsHandshakeLock()).toBe(true);
  });
});

describe("withHandshakeLock", () => {
  test("mutually excludes concurrent handshakes", async () => {
    type Event = { name: "first" | "second"; phase: "enter" | "exit"; at: number };
    const events: Event[] = [];
    let active = 0;
    let maxActive = 0;

    const run = (name: Event["name"], holdMs: number) =>
      withHandshakeLock(async () => {
        events.push({ name, phase: "enter", at: Date.now() });
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(holdMs);
        active--;
        events.push({ name, phase: "exit", at: Date.now() });
      });

    await Promise.all([run("first", 15), run("second", 5)]);

    const firstEnter = events.find((event) => event.name === "first" && event.phase === "enter");
    const firstExit = events.find((event) => event.name === "first" && event.phase === "exit");
    const secondEnter = events.find((event) => event.name === "second" && event.phase === "enter");
    const secondExit = events.find((event) => event.name === "second" && event.phase === "exit");

    expect(events).toHaveLength(4);
    expect(maxActive).toBe(1);
    expect(firstEnter).toBeDefined();
    expect(firstExit).toBeDefined();
    expect(secondEnter).toBeDefined();
    expect(secondExit).toBeDefined();
    expect(
      (firstExit?.at ?? 0) <= (secondEnter?.at ?? 0) ||
        (secondExit?.at ?? 0) <= (firstEnter?.at ?? 0)
    ).toBe(true);
  });

  test("removes the lock after success and after a propagated callback error", async () => {
    const result = await withHandshakeLock(async () => {
      expect(existsSync(lockPath)).toBe(true);
      return "done";
    });

    expect(result).toBe("done");
    expect(existsSync(lockPath)).toBe(false);

    await expect(
      withHandshakeLock(async () => {
        expect(existsSync(lockPath)).toBe(true);
        throw new Error("handshake failed");
      })
    ).rejects.toThrow("handshake failed");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("bypasses locking when CLAUDISH_NO_OP_HANDSHAKE_LOCK=1", async () => {
    process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK = "1";

    const result = await withHandshakeLock(async () => {
      expect(existsSync(lockPath)).toBe(false);
      return "unlocked";
    });

    expect(result).toBe("unlocked");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("steals a fresh lock whose owner process has exited", async () => {
    const deadProcess = spawnSync(process.execPath, ["-e", ""], { env: { ...process.env } });
    expect(deadProcess.status).toBe(0);
    expect(deadProcess.pid).toBeGreaterThan(0);
    writeFileSync(lockPath, `${deadProcess.pid} ${Date.now()}`);

    const startedAt = Date.now();
    const holder = await withHandshakeLock(async () => readFileSync(lockPath, "utf-8"));

    expect(holder.startsWith(`${process.pid} `)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("degrades to an unlocked callback after acquire timeout", async () => {
    setHandshakeLockTestSeams({ timing: { timeoutMs: 10, pollMs: 1 } });
    const originalHolder = `${process.pid} ${Date.now()}`;
    writeFileSync(lockPath, originalHolder);

    const startedAt = Date.now();
    let callbackRan = false;
    await withHandshakeLock(async () => {
      callbackRan = true;
    });

    expect(callbackRan).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(readFileSync(lockPath, "utf-8")).toBe(originalHolder);
  });

  test("degrades to an unlocked callback when the lock path is unwritable", async () => {
    const parentFile = join(dir, "not-a-directory");
    writeFileSync(parentFile, "blocking file");
    setHandshakeLockTestSeams({ path: join(parentFile, "op-handshake.lock") });

    let callbackRan = false;
    await expect(
      withHandshakeLock(async () => {
        callbackRan = true;
        return "unlocked";
      })
    ).resolves.toBe("unlocked");

    expect(callbackRan).toBe(true);
    expect(readFileSync(parentFile, "utf-8")).toBe("blocking file");
  });
});
