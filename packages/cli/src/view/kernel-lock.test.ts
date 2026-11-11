import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flockAvailable, removeIfFree, tryAcquire, waitAcquire } from "./kernel-lock.js";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function lockPath(): string {
  dir = mkdtempSync(join(tmpdir(), "kernel-lock-"));
  return join(dir, "x.lock");
}

describe.if(flockAvailable())("kernel-lock", () => {
  test("free → acquired; a second descriptor in this process → null; close twice frees it", () => {
    const p = lockPath();
    const a = tryAcquire(p);
    expect(a).not.toBeNull();
    expect(tryAcquire(p)).toBeNull();
    a?.close();
    a?.close();
    const b = tryAcquire(p);
    expect(b).not.toBeNull();
    b?.close();
  });

  test("waitAcquire gives up after its bound while the lock is held, and wins once it is free", async () => {
    const p = lockPath();
    const a = tryAcquire(p);
    const t0 = Date.now();
    expect(await waitAcquire(p, 150)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    setTimeout(() => a?.close(), 50);
    const b = await waitAcquire(p, 2_000);
    expect(b).not.toBeNull();
    b?.close();
  });

  test("a lock file unlinked while held: a new acquirer gets a lock on the new file", () => {
    const p = lockPath();
    const a = tryAcquire(p);
    unlinkSync(p);
    const b = tryAcquire(p);
    expect(b).not.toBeNull();
    a?.close();
    b?.close();
  });

  test("removeIfFree leaves a held lock and removes a free one", () => {
    const p = lockPath();
    const a = tryAcquire(p);
    expect(removeIfFree(p)).toBe(false);
    expect(existsSync(p)).toBe(true);
    a?.close();
    expect(removeIfFree(p)).toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  test("the descriptor has close-on-exec: a child does not hold the lock", () => {
    const p = lockPath();
    const a = tryAcquire(p);
    const child = Bun.spawnSync(
      ["/bin/sh", "-c", `ls /dev/fd/${a?.fd} 2>/dev/null && echo leaked || echo closed`],
      { env: { ...process.env } }
    );
    expect(child.stdout.toString().trim()).toBe("closed");
    a?.close();
  });
});
