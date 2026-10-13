/**
 * The pane child's own state from Claude Code's session registry (research
 * dev-research-cc-slot-signals, report §"What claudish reads from the screen").
 *
 * Every interactive Claude Code writes `<configDir>/sessions/<pid>.json` and rewrites it
 * on each state change: `status` is `idle`, `busy`, `waiting` (with `waitingFor`) or
 * `shell` (a background Bash still running after the turn), and the first record has no
 * `status` at all for 100–440 ms of boot. The record's `sessionId` is the `--session-id`
 * claudish mints, so a pane finds its record by that uuid (11/11 measured) and never by
 * a bare pid.
 *
 * The file is undocumented (`claude agents --json` is the documented reader, but a user's
 * `disableAgentView` makes it refuse, and it omits fields we read), so everything here is
 * defensive: a missing, unparseable, foreign or dead record is `null`, and callers fall
 * back to the screen. #96438: a torn write can leave a stray trailing `}`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface RegistryRecord {
  pid: number;
  sessionId: string;
  /** null while the record has no status yet (boot) */
  status: string | null;
  /** Claude Code's wall clock, ms; null when absent */
  statusUpdatedAt: number | null;
  waitingFor: string | null;
  version: string | null;
}

/** Statuses whose meaning claudish relies on. Anything else is reported, never acted on. */
export const KNOWN_STATUSES: ReadonlySet<string> = new Set(["idle", "busy", "waiting", "shell"]);

/** Rescan the directory at most this often while the record is not found. */
const SCAN_INTERVAL_MS = 1_000;

/** Parse one record; tolerates the trailing-brace torn write of #96438. */
export function parseRegistryRecord(raw: string): RegistryRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const trimmed = raw.trimEnd().replace(/\}+$/, "}");
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.pid !== "number" || typeof r.sessionId !== "string") return null;
  return {
    pid: r.pid,
    sessionId: r.sessionId,
    status: typeof r.status === "string" ? r.status : null,
    statusUpdatedAt: typeof r.statusUpdatedAt === "number" ? r.statusUpdatedAt : null,
    waitingFor: typeof r.waitingFor === "string" ? r.waitingFor : null,
    version: typeof r.version === "string" ? r.version : null,
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: alive, owned by someone else — not our child, but not dead either
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SessionRegistryOptions {
  /** `claudeConfigDir(env)` of the child's environment */
  configDir: string;
  sessionUuid: string;
  /** @internal test seams */
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

/**
 * One pane's view of its record. `read()` is cheap once the record is found (one file
 * read); until then it scans `sessions/` at most once a second. Never throws.
 */
export class SessionRegistry {
  private pid: number | null = null;
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(private readonly o: SessionRegistryOptions) {
    this.dir = join(o.configDir, "sessions");
    this.now = o.now ?? Date.now;
    this.isAlive = o.isAlive ?? pidAlive;
  }

  read(): RegistryRecord | null {
    if (this.pid !== null) {
      const rec = this.readPid(this.pid);
      if (rec) return rec;
      this.pid = null;
    }
    const now = this.now();
    if (now - this.lastScanAt < SCAN_INTERVAL_MS) return null;
    this.lastScanAt = now;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return null;
    }
    for (const name of names) {
      const m = /^(\d+)\.json$/.exec(name);
      if (!m) continue;
      const rec = this.readPid(Number(m[1]));
      if (rec) {
        this.pid = rec.pid;
        return rec;
      }
    }
    return null;
  }

  private readPid(pid: number): RegistryRecord | null {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, `${pid}.json`), "utf8");
    } catch {
      return null;
    }
    const rec = parseRegistryRecord(raw);
    if (!rec || rec.pid !== pid || rec.sessionId !== this.o.sessionUuid) return null;
    return this.isAlive(pid) ? rec : null;
  }
}
