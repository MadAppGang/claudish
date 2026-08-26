/**
 * SessionEventRegistry — the harness session-event layer's public surface.
 *
 * Keyed by Claude Code session_id (extracted from body.metadata.user_id).
 * Each session gets a TranscriptTailer over its transcript file
 * (<claudeHome>/projects/<slug>/<sid>.jsonl); translated events fold into
 * per-session state via the pure reducer and fan out to subscribers.
 *
 * Failure posture: no public method ever throws. Unknown session state is
 * `undefined` — callers must treat that as "no injection". Zero filesystem
 * cost unless a caller opts in (proOnUltracode gates every call site).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { translateLine } from "./event-translator.js";
import { initialState, reduceEvent } from "./session-state.js";
import { TranscriptTailer } from "./transcript-tailer.js";
import type { HarnessEvent, SessionEventState } from "./types.js";

export type SessionEventSubscriber = (sessionId: string, event: HarnessEvent) => void;

export interface SessionEventRegistryOptions {
  /** Claude Code home dir (default ~/.claude). Test seam — homedir() can't be re-pointed in Bun. */
  claudeHome?: string;
  /** Tailer poll interval in ms (default 250). Test seam. */
  pollIntervalMs?: number;
}

/** How long a transcript-not-found result is cached before retrying. */
const MISS_TTL_MS = 5_000;
/** After this many misses, stop looking for the session's transcript. */
const MAX_MISSES = 5;
/** Sessions idle longer than this are swept (lossless — re-ensure re-backfills). */
const IDLE_SWEEP_MS = 30 * 60 * 1000;

interface SessionEntry {
  state: SessionEventState;
  tailer: TranscriptTailer;
  lastActivity: number;
}

/**
 * Extract the Claude Code session_id from request metadata. Claude Code embeds
 * it in `metadata.user_id` (e.g. "user_<hash>_account_<uuid>_session_<uuid>").
 * Returns undefined for any unrecognized shape — which callers must treat as
 * "unknown session" (no injection).
 */
export function extractSessionId(metadata: unknown): string | undefined {
  const userId = (metadata as { user_id?: unknown } | null | undefined)?.user_id;
  if (typeof userId !== "string") return undefined;
  // Real captured shape (RequestMeta trace, 2026-07-13): user_id is a
  // JSON-ENCODED STRING — {"device_id":"…","account_uuid":"","session_id":"<uuid>"}.
  // The suffix-regex below does NOT match it ("session_" is followed by `id":"`),
  // so JSON parsing must come first.
  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown };
    if (typeof parsed?.session_id === "string" && parsed.session_id) {
      return parsed.session_id;
    }
  } catch {
    // not JSON — fall through to the plain user_…_session_<uuid> suffix format
  }
  const match = userId.match(
    /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return match?.[1];
}

/** Claude Code's project-dir slug: every non-alphanumeric char becomes "-". */
export function slugFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export class SessionEventRegistry {
  private sessions = new Map<string, SessionEntry>();
  private misses = new Map<string, { lastTry: number; count: number }>();
  private subscribers: SessionEventSubscriber[] = [];
  private claudeHome: string;
  private pollIntervalMs?: number;

  constructor(opts: SessionEventRegistryOptions = {}) {
    this.claudeHome = opts.claudeHome ?? join(homedir(), ".claude");
    this.pollIntervalMs = opts.pollIntervalMs;
  }

  /** Locate the session transcript and start tailing it. Safe to call per request. */
  ensureSession(sessionId: string): void {
    try {
      this.sweepIdle();
      const existing = this.sessions.get(sessionId);
      if (existing) {
        existing.lastActivity = Date.now();
        return;
      }

      const miss = this.misses.get(sessionId);
      if (miss) {
        if (miss.count >= MAX_MISSES) return; // gave up (logged once below)
        if (Date.now() - miss.lastTry < MISS_TTL_MS) return;
      }

      const filePath = this.locateTranscript(sessionId);
      if (!filePath) {
        const count = (miss?.count ?? 0) + 1;
        this.misses.set(sessionId, { lastTry: Date.now(), count });
        if (count === MAX_MISSES) {
          log(
            `[SessionEvents] transcript for session ${sessionId} not found after ${MAX_MISSES} attempts — giving up`
          );
        }
        return;
      }
      this.misses.delete(sessionId);

      const entry: SessionEntry = {
        state: initialState({ defaultEffort: this.readSettingsEffortLevel() }),
        tailer: new TranscriptTailer(filePath, (line) => this.onLine(sessionId, line), {
          pollIntervalMs: this.pollIntervalMs,
          onError: (err) => log(`[SessionEvents] tailer for ${sessionId} stopped: ${err}`),
        }),
        lastActivity: Date.now(),
      };
      this.sessions.set(sessionId, entry);
      entry.tailer.start(); // backfills from byte 0 → full state even on late attach
      log(`[SessionEvents] tailing ${filePath}`);
    } catch (err) {
      // The event layer must never break request handling.
      log(`[SessionEvents] ensureSession(${sessionId}) failed: ${err}`);
    }
  }

  /** Synchronous drain — closes the enter-event→request timing window. */
  sync(sessionId: string): void {
    try {
      const entry = this.sessions.get(sessionId);
      if (entry) {
        entry.lastActivity = Date.now();
        entry.tailer.syncNow();
      }
    } catch (err) {
      log(`[SessionEvents] sync(${sessionId}) failed: ${err}`);
    }
  }

  /** Current folded state. `undefined` = unknown session = no injection. */
  getState(sessionId: string): SessionEventState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** Subscribe to translated events (the bus). Returns an unsubscribe fn. */
  subscribe(fn: SessionEventSubscriber): () => void {
    this.subscribers.push(fn);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== fn);
    };
  }

  /** Dispose every tailer (proxy shutdown). */
  disposeAll(): void {
    for (const entry of this.sessions.values()) {
      entry.tailer.dispose();
    }
    this.sessions.clear();
    this.misses.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private onLine(sessionId: string, line: string): void {
    const event = translateLine(line);
    if (!event) return;
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.state = reduceEvent(entry.state, event);
    log(
      `[SessionEvents] ${sessionId}: ${event.kind}${event.kind === "effort_changed" ? ` level=${event.level} scope=${event.scope}` : ""} → ultracodeActive=${entry.state.ultracodeActive}`
    );
    for (const fn of this.subscribers) {
      try {
        fn(sessionId, event);
      } catch {
        // Subscriber errors must not poison the fold loop.
      }
    }
  }

  /**
   * <claudeHome>/projects/<slugFromCwd(cwd)>/<sid>.jsonl, with a glob fallback
   * across projects/* — the filename is unique per session, only the directory
   * lookup can mismatch (e.g. Claude Code launched from a different cwd).
   */
  private locateTranscript(sessionId: string): string | undefined {
    const projectsDir = join(this.claudeHome, "projects");
    const primary = join(projectsDir, slugFromCwd(process.cwd()), `${sessionId}.jsonl`);
    if (existsSync(primary)) return primary;
    try {
      for (const dir of readdirSync(projectsDir)) {
        const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // projects dir missing/unreadable → treated as not found
    }
    return undefined;
  }

  /** Seed for new sessions: persisted default from <claudeHome>/settings.json. */
  private readSettingsEffortLevel(): string | undefined {
    try {
      const settings = JSON.parse(readFileSync(join(this.claudeHome, "settings.json"), "utf-8"));
      return typeof settings.effortLevel === "string" ? settings.effortLevel : undefined;
    } catch {
      return undefined;
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [sid, entry] of this.sessions) {
      if (now - entry.lastActivity > IDLE_SWEEP_MS) {
        entry.tailer.dispose();
        this.sessions.delete(sid);
      }
    }
  }
}

/** Process-wide singleton — constructed lazily-cheap (no fs work until ensureSession). */
export const sessionEvents = new SessionEventRegistry();
