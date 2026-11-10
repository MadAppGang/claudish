import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryAcquire } from "../view/kernel-lock.js";
import { OWNER_START36, ensureSockRoot } from "./pane-launch.js";
import { sweepOrphanPanes } from "./pane-registry.js";
import { type PaneTestEnv, makePaneTestEnv } from "./test-helpers/hermetic-env.js";

const envs: PaneTestEnv[] = [];
afterAll(() => {
  for (const t of envs) t.cleanup();
});

function env(): PaneTestEnv {
  const t = makePaneTestEnv();
  envs.push(t);
  ensureSockRoot(t.sockRoot);
  return t;
}

function deadPid(): number {
  return Bun.spawnSync(["/usr/bin/true"], { env: { ...process.env } }).pid;
}

function writeFeed(root: string, pid: number, start36: string): string {
  mkdirSync(join(root, "feed"), { recursive: true, mode: 0o700 });
  const path = join(root, "feed", "feed.json");
  const stamp = { pid, start36, started_at: new Date().toISOString() };
  writeFileSync(
    path,
    JSON.stringify({ relay: stamp, written_at: stamp.started_at, servers: [], items: [] }),
    { mode: 0o600 }
  );
  return path;
}

describe("startup sweep: the herdr placement locks and the relay's feed file", () => {
  test("a feed file stamped by a dead relay is removed; a live relay's stays", async () => {
    const dead = env();
    const stale = writeFeed(dead.sockRoot, deadPid(), "zz");
    await sweepOrphanPanes(dead.sockRoot);
    expect(existsSync(stale)).toBe(false);

    const live = env();
    const kept = writeFeed(live.sockRoot, process.pid, OWNER_START36);
    await sweepOrphanPanes(live.sockRoot);
    expect(existsSync(kept)).toBe(true);
  });

  test("a free workspace lock is removed; a held one stays", async () => {
    const t = env();
    const dir = join(t.sockRoot, "herdr");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const free = join(dir, "freefree.lock");
    tryAcquire(free)?.close();
    const heldPath = join(dir, "heldheld.lock");
    const held = tryAcquire(heldPath);
    try {
      await sweepOrphanPanes(t.sockRoot);
      expect(existsSync(free)).toBe(false);
      expect(existsSync(heldPath)).toBe(true);
    } finally {
      held?.close();
    }
  });
});
