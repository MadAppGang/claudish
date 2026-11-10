/**
 * `<root>/replays/`: one entry per replay of a Claude session, shared by every MCP server under
 * the root. An entry is a directory of whom to dial and excludes nothing: the exclusion is the
 * kernel lock on `<uuid>.lock`, which the replay's magmux holds for as long as it lives. A free
 * lock with an entry on disk means the entry is stale, whatever it says.
 *
 * Entries are written by atomic rename while holding `registry.lock` for one synchronous
 * read-modify-write. A write that cannot get that lock within its bound is skipped by the caller
 * (one log line): the lock state is the truth, so an out-of-date entry costs a joiner one dial.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateSubdir, ensureSockRoot } from "../pane/pane-launch.js";
import { isUuid } from "../pane/transcript-page.js";
import { type KernelLock, removeIfFree, tryAcquire, waitAcquire } from "./kernel-lock.js";

export const REPLAYS_DIR = "replays";
/** How long an editor waits for `registry.lock`: its holder only does file operations. */
export const REGISTRY_LOCK_WAIT_MS = 5_000;

export interface ReplayRegistryEntry {
  v: 1;
  /** "open" from before the boot; "closing" from the moment its owner starts to end it */
  state: "open" | "closing";
  replay_id: string;
  /** the endpoint file name `c<pid>-<start36>.sock`; null when its owner cannot be joined */
  owner_endpoint: string | null;
  /** keys the pane record `<root>/panes/<pane_id>.json` */
  pane_id: string;
  since: string;
}

const REPLAY_ID_RE = /^replay-[0-9a-f]{16}$/;
const ENDPOINT_RE = /^c\d+-[0-9a-z]+\.sock$/;
const PANE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseEntry(raw: string): ReplayRegistryEntry | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (e.v !== 1 || (e.state !== "open" && e.state !== "closing")) return null;
  if (typeof e.replay_id !== "string" || !REPLAY_ID_RE.test(e.replay_id)) return null;
  if (
    e.owner_endpoint !== null &&
    (typeof e.owner_endpoint !== "string" || !ENDPOINT_RE.test(e.owner_endpoint))
  )
    return null;
  if (typeof e.pane_id !== "string" || !PANE_ID_RE.test(e.pane_id)) return null;
  if (typeof e.since !== "string" || Number.isNaN(Date.parse(e.since))) return null;
  return {
    v: 1,
    state: e.state,
    replay_id: e.replay_id,
    owner_endpoint: e.owner_endpoint as string | null,
    pane_id: e.pane_id,
    since: e.since,
  };
}

export class ReplayRegistry {
  readonly dir: string;

  constructor(
    readonly root: string,
    private readonly log: (line: string) => void = () => {}
  ) {
    this.dir = join(root, REPLAYS_DIR);
  }

  /** Creates `<root>/replays/` (0700) under a verified root. */
  ensure(): string {
    ensureSockRoot(this.root);
    return ensurePrivateSubdir(this.root, REPLAYS_DIR);
  }

  lockPathOf(uuid: string): string {
    return join(this.dir, `${this.key(uuid)}.lock`);
  }

  /** The replay lock: held by someone means a replay process of this session exists. */
  tryLock(uuid: string): KernelLock | null {
    this.ensure();
    return tryAcquire(this.lockPathOf(uuid));
  }

  /** No lock: entries are renamed into place, so a read sees a whole one or none. */
  read(uuid: string): ReplayRegistryEntry | null {
    try {
      return parseEntry(readFileSync(this.entryPathOf(uuid), "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Runs `fn` holding `registry.lock`. Null when the lock stayed held for the whole bound (its
   * holder is stopped); `fn` did not run then.
   */
  async withLock<T>(fn: () => T, waitMs = REGISTRY_LOCK_WAIT_MS): Promise<{ value: T } | null> {
    this.ensure();
    const lock = await waitAcquire(join(this.dir, "registry.lock"), waitMs);
    if (!lock) return null;
    try {
      return { value: fn() };
    } finally {
      lock.close();
    }
  }

  /** Call only inside `withLock`. */
  writeLocked(uuid: string, entry: ReplayRegistryEntry): void {
    const path = this.entryPathOf(uuid);
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: "wx" });
    try {
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Marks the entry closing when it is still this replay's. False when skipped or not ours. */
  async markClosing(uuid: string, replayId: string): Promise<boolean> {
    const done = await this.withLock(() => {
      const e = this.read(uuid);
      if (!e || e.replay_id !== replayId || e.state === "closing") return false;
      this.writeLocked(uuid, { ...e, state: "closing" });
      return true;
    });
    if (!done) this.log(`[replay] registry.lock held; ${uuid} not marked closing`);
    return done?.value ?? false;
  }

  /** Compare-and-delete: removes the entry only while it is still this replay's. */
  async removeIf(uuid: string, replayId: string): Promise<boolean> {
    const done = await this.withLock(() => {
      const e = this.read(uuid);
      if (!e || e.replay_id !== replayId) return false;
      rmSync(this.entryPathOf(uuid), { force: true });
      return true;
    });
    if (!done) this.log(`[replay] registry.lock held; entry of ${uuid} left for the sweep`);
    return done?.value ?? false;
  }

  /**
   * Removes every lock file nobody holds, and the entry that went with it. A held lock and its
   * entry are left alone. Returns the uuids swept.
   */
  async sweep(): Promise<string[]> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const swept: string[] = [];
    for (const name of names) {
      const m = /^([0-9a-f-]{36})\.lock$/.exec(name);
      if (!m?.[1] || !isUuid(m[1])) continue;
      const uuid = m[1];
      // the entry first: a free lock proves it stale, and removing the lock last keeps one inode
      const held = tryAcquire(this.lockPathOf(uuid));
      if (!held) continue;
      try {
        await this.withLock(() => rmSync(this.entryPathOf(uuid), { force: true }));
      } finally {
        held.close();
      }
      if (removeIfFree(this.lockPathOf(uuid))) swept.push(uuid);
    }
    // a writer killed between its write and its rename; listed and removed under the lock, so no
    // live write is cut and none that died while the loop above waited is missed
    await this.withLock(() => {
      let now: string[];
      try {
        now = readdirSync(this.dir);
      } catch {
        return;
      }
      for (const name of now)
        if (name.endsWith(".tmp")) rmSync(join(this.dir, name), { force: true });
    });
    return swept;
  }

  private entryPathOf(uuid: string): string {
    return join(this.dir, `${this.key(uuid)}.json`);
  }

  private key(uuid: string): string {
    const k = uuid.toLowerCase();
    if (!isUuid(k)) throw new Error(`not a session uuid: ${JSON.stringify(uuid)}`);
    return k;
  }
}
