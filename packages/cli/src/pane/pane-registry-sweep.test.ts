import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryAcquire } from "../view/kernel-lock.js";
import { OWNER_START36, ensureSockRoot } from "./pane-launch.js";
import { sweepOrphanPanes } from "./pane-registry.js";
import { type PsSpawn, setPsSpawnForTest } from "./process-identity.js";
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

  test("a relay that starts and publishes while the sweep reads the process table keeps its feed", async () => {
    const t = env();
    let relay: ReturnType<typeof Bun.spawn> | null = null;
    let path = "";
    const prev: PsSpawn = setPsSpawnForTest({
      execFileSync(file, args, opts) {
        const out = prev.execFileSync(file, args, opts);
        if (!relay) {
          // the relay starts right after this snapshot, so the snapshot cannot list it
          relay = Bun.spawn(["/bin/sleep", "30"], { env: { ...process.env } });
          path = writeFeed(t.sockRoot, relay.pid, Date.now().toString(36));
        }
        return out;
      },
      execFile: (file, args, opts, cb) => prev.execFile(file, args, opts, cb),
    });
    try {
      const out = await sweepOrphanPanes(t.sockRoot);
      expect(relay).not.toBeNull();
      expect(out.cleaned).not.toContain("feed/feed.json");
      expect(existsSync(path)).toBe(true);
    } finally {
      setPsSpawnForTest(prev);
      (relay as ReturnType<typeof Bun.spawn> | null)?.kill();
    }
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
