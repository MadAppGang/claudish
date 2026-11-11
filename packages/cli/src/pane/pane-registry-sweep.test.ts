import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endpointNameOf, endpointPathOf, endpointsDirOf } from "../view/endpoints.js";
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

/** Counts `ps` runs by kind while `fn` runs; the real `ps` still answers. */
async function countPs(fn: () => Promise<unknown>): Promise<{ sync: number; async: number }> {
  const n = { sync: 0, async: 0 };
  const prev: PsSpawn = setPsSpawnForTest({
    execFileSync(file, args, opts) {
      n.sync += 1;
      return prev.execFileSync(file, args, opts);
    },
    execFile(file, args, opts, cb) {
      n.async += 1;
      return prev.execFile(file, args, opts, cb);
    },
  });
  try {
    await fn();
  } finally {
    setPsSpawnForTest(prev);
  }
  return n;
}

describe("startup sweep: the process table and the endpoint folder", () => {
  // a synchronous `ps` blocks the event loop; on a loaded runner a 5 s probe timer then fires
  // before the child's exit is read, and a magmux that answered is refused
  test("a root with no records, endpoints, view sockets or feed reads no process table", async () => {
    const t = env();
    const n = await countPs(() => sweepOrphanPanes(t.sockRoot));
    expect(n).toEqual({ sync: 0, async: 0 });
  });

  test("a dead owner's endpoint is removed, reading the table without blocking", async () => {
    const t = env();
    const dir = endpointsDirOf(t.sockRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stale = endpointPathOf(t.sockRoot, endpointNameOf(deadPid(), "zz"));
    writeFileSync(stale, "");
    const n = await countPs(() => sweepOrphanPanes(t.sockRoot));
    expect(existsSync(stale)).toBe(false);
    expect(n.sync).toBe(0);
    expect(n.async).toBeGreaterThan(0);
  });
});

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
    // a dead relay's feed is what the sweep reads first; the new relay replaces it mid-sweep
    let path = writeFeed(t.sockRoot, deadPid(), "zz");
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
