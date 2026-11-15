/**
 * The compaction store: one folder per Claude Code session.
 *
 * ```
 * ~/.claudish/compaction/                     (0700)
 * ~/.claudish/compaction/<session_id>/        (0700)
 * ~/.claudish/compaction/<session_id>/<key>.json   (0600) the decided form of one tool_result
 * ~/.claudish/compaction/<session_id>/<key>.txt    (0600) the original output, for Read
 * ```
 *
 * History compaction keeps its records in the same folder and the same
 * `<key>.json` shape: a summary prepared for one boundary
 * (`historyRecordKey("history-summary", ...)`) and a swap applied at one
 * boundary (`historyRecordKey("history-swap", ...)`).
 *
 * A form is decided once and replayed on every later request. The cache and
 * the thinking signatures both match the history the model already saw, so a
 * record is never rewritten: `put` refuses to replace an existing key. The
 * records are written atomically (`atomicWriteFileSync`) and loaded from disk
 * on the first use of a session in this process, so a proxy restart or
 * `claude --resume` replays the same bytes.
 *
 * The session id comes from the request's `metadata.user_id`; only ids that
 * are safe as one path segment are accepted (`isSafeSessionId`), so no
 * request can name a folder outside the store.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../auth/accounts/atomic-write.js";
import { claudishHome } from "../auth/accounts/paths.js";

/** A session folder unused for this long is deleted at proxy startup. */
export const COMPACTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** `~/.claudish/compaction`, under the HOME of `env`. */
export function compactionRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudishHome(env), "compaction");
}

/**
 * True for an id usable as one path segment: letters, digits, `-` and `_`,
 * 1 to 128 characters. Claude Code's session ids are UUIDs.
 */
export function isSafeSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/**
 * The record key of one tool_result: sha256 over the session id, the
 * tool_use id and the original text, NUL-separated, as lowercase hex.
 */
export function toolOutputKey(sessionId: string, toolUseId: string, originalText: string): string {
  return createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(toolUseId)
    .update("\0")
    .update(originalText)
    .digest("hex");
}

/** The decided form of one tool_result. */
export type ToolOutputRecord =
  | {
      kind: "tool-output";
      form: "compressed";
      /** The exact text sent in place of the original: compressed text plus the footer. */
      text: string;
      /** Characters of the original output (N in the footer). */
      originalChars: number;
      /** Characters of the compressed text before the footer (M in the footer). */
      compressedChars: number;
      decidedAt: string;
    }
  | {
      kind: "tool-output";
      form: "original";
      /** Why the original is kept, for the debug log. */
      reason: string;
      decidedAt: string;
    };

/**
 * The record key of one history record: sha256 over the record kind, the
 * session id and the prefix hash, NUL-separated, as lowercase hex. A summary
 * and a swap of the same boundary therefore never share a key.
 */
export function historyRecordKey(
  kind: "history-summary" | "history-swap",
  sessionId: string,
  prefixHash: string
): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(prefixHash)
    .digest("hex");
}

/**
 * A summary of messages `[0, boundary)` of one conversation thread, decided
 * once. A `failed` record is final for its boundary: it is never retried.
 */
export type HistorySummaryRecord =
  | {
      kind: "history-summary";
      form: "ready";
      /** The thread: sha256 of the conversation's first message. */
      thread: string;
      /** sha256 of messages `[0, boundary)` (`messagesHash`). */
      prefixHash: string;
      boundary: number;
      /** The summary text, sent after the summary marker line. */
      summary: string;
      /** The prefix hash of the summary this one rolled forward from, if any. */
      basedOn?: string;
      decidedAt: string;
    }
  | {
      kind: "history-summary";
      form: "failed";
      thread: string;
      prefixHash: string;
      boundary: number;
      reason: string;
      decidedAt: string;
    };

/**
 * A history swap: messages `[0, boundary)` replaced by one summary message,
 * and thinking blocks removed from messages `[boundary, end)`. Replayed on
 * every later request whose `[0, boundary)` and `[boundary, end)` hash the same.
 */
export interface HistorySwapRecord {
  kind: "history-swap";
  thread: string;
  /** sha256 of messages `[0, boundary)`. */
  prefixHash: string;
  /** sha256 of messages `[boundary, end)`. */
  tailHash: string;
  boundary: number;
  /** One past the last message the swap saw (the message count at swap time). */
  end: number;
  /** The summary text the swap sends. */
  summary: string;
  decidedAt: string;
}

/** Every record kind the store holds. */
export type CompactionRecord = ToolOutputRecord | HistorySummaryRecord | HistorySwapRecord;

const KEY_PATTERN = /^[0-9a-f]{64}$/;

export class CompactionStore {
  private readonly sessions = new Map<string, Map<string, CompactionRecord>>();

  constructor(readonly root: string = compactionRoot()) {}

  /** The session's folder. Throws for an id `isSafeSessionId` refuses. */
  sessionDir(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) {
      throw new Error("Refusing to build a compaction path for an unsafe session id");
    }
    return join(this.root, sessionId);
  }

  /** The recovery file of one record: the original output. */
  recoveryPath(sessionId: string, key: string): string {
    return join(this.sessionDir(sessionId), `${key}.txt`);
  }

  /** Create the root and the session folder, both 0700. Returns the session folder. */
  ensureSessionDir(sessionId: string): string {
    return ensureSessionFolder(this.root, sessionId);
  }

  /** The record for `key`, loading the session from disk on its first use. */
  get(sessionId: string, key: string): CompactionRecord | undefined {
    return this.session(sessionId).get(key);
  }

  /**
   * Store a decision, on disk first and then in memory. The first decision for
   * a key wins: a second `put` of the same key returns the record already held
   * and writes nothing. When the disk write fails the error is rethrown and
   * nothing is held, so a caller can fall back to `remember` an `original`
   * form, which a later process reaches by itself (rule: a block with no record
   * outside the last message stays original).
   */
  put(sessionId: string, key: string, record: CompactionRecord): CompactionRecord {
    if (!KEY_PATTERN.test(key))
      throw new Error("Refusing a compaction record with a malformed key");
    const records = this.session(sessionId);
    const existing = records.get(key);
    if (existing) return existing;
    this.ensureSessionDir(sessionId);
    atomicWriteFileSync(join(this.sessionDir(sessionId), `${key}.json`), JSON.stringify(record), {
      mode: 0o600,
      dirMode: 0o700,
    });
    records.set(key, record);
    return record;
  }

  /** Hold a decision in memory only. The first decision for a key wins. */
  remember(sessionId: string, key: string, record: CompactionRecord): CompactionRecord {
    const records = this.session(sessionId);
    const existing = records.get(key);
    if (existing) return existing;
    records.set(key, record);
    return record;
  }

  /** Every record of a session, loading it from disk on its first use. */
  list(sessionId: string): Array<[string, CompactionRecord]> {
    return [...this.session(sessionId).entries()];
  }

  /** Write the original output for Read. Returns its absolute path. */
  writeRecovery(sessionId: string, key: string, original: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error("Refusing a recovery file with a malformed key");
    this.ensureSessionDir(sessionId);
    const path = this.recoveryPath(sessionId, key);
    atomicWriteFileSync(path, original, { mode: 0o600, dirMode: 0o700 });
    return path;
  }

  private session(sessionId: string): Map<string, CompactionRecord> {
    let records = this.sessions.get(sessionId);
    if (!records) {
      records = loadSession(this.sessionDir(sessionId));
      this.sessions.set(sessionId, records);
    }
    return records;
  }
}

/** Create `<root>/<sessionId>` and the root, both 0700. Returns the session folder. */
export function ensureSessionFolder(root: string, sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error("Refusing to build a compaction path for an unsafe session id");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function isRecord(value: unknown): value is CompactionRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.kind === "tool-output") {
    if (r.form === "compressed") return typeof r.text === "string";
    return r.form === "original";
  }
  if (r.kind === "history-summary") {
    if (typeof r.prefixHash !== "string" || typeof r.thread !== "string") return false;
    if (!Number.isInteger(r.boundary)) return false;
    if (r.form === "ready") return typeof r.summary === "string";
    return r.form === "failed";
  }
  if (r.kind === "history-swap") {
    return (
      typeof r.prefixHash === "string" &&
      typeof r.tailHash === "string" &&
      typeof r.thread === "string" &&
      typeof r.summary === "string" &&
      Number.isInteger(r.boundary) &&
      Number.isInteger(r.end)
    );
  }
  return false;
}

/** Every readable record in a session folder. An unreadable file is skipped. */
function loadSession(dir: string): Map<string, CompactionRecord> {
  const records = new Map<string, CompactionRecord>();
  if (!existsSync(dir)) return records;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return records;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const key = name.slice(0, -".json".length);
    if (!KEY_PATTERN.test(key)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf-8"));
      if (isRecord(parsed)) records.set(key, parsed);
    } catch {
      // A torn or foreign file states nothing.
    }
  }
  return records;
}

/**
 * Delete every session folder under `root` whose newest file is older than
 * `maxAgeMs` (an empty folder counts by its own mtime). Ids in `keep` are
 * never deleted. Returns the ids deleted. Never throws.
 */
export function purgeExpiredSessions(
  root: string = compactionRoot(),
  opts: { now?: number; maxAgeMs?: number; keep?: Iterable<string> } = {}
): string[] {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? COMPACTION_RETENTION_MS;
  const keep = new Set(opts.keep ?? []);
  const deleted: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return deleted;
  }
  for (const name of names) {
    if (!isSafeSessionId(name) || keep.has(name)) continue;
    const dir = join(root, name);
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      let newest = stat.mtimeMs;
      for (const file of readdirSync(dir)) {
        try {
          newest = Math.max(newest, statSync(join(dir, file)).mtimeMs);
        } catch {
          // a file removed between the listing and the stat
        }
      }
      if (now - newest > maxAge) {
        rmSync(dir, { recursive: true, force: true });
        deleted.push(name);
      }
    } catch {
      // one unreadable folder never stops the rest
    }
  }
  return deleted;
}
