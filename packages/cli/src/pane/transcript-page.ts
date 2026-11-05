/**
 * One page of a session's transcript as plain text lines (`transcript_session` and
 * `team(mode="transcript")`, MTL-373; architecture § 2.3, § 2.4).
 *
 * Stateless: every answer is computed from the child's Claude Code transcript JSONL and
 * an opaque cursor `v1.<offset>.<k>.<id8>` — the byte offset of an entry's line start,
 * the index of the next line within that entry, and the first 8 hex of the session uuid.
 * The cursor is a file fact, so it survives a server restart, the disk fallback and a
 * read through another claudish server.
 *
 * READ ONLY: `openSync` with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstatSync`, `statSync`,
 * `lstatSync`, `readSync`, `closeSync`, `realpathSync`, `readdirSync`, `readlinkSync` (the
 * Linux fd table) and `process.kill(pid, 0)`. Nothing is written.
 */

import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { log } from "../logger.js";
import {
  ContractErrorException,
  MAX_TRANSCRIPT_LINES,
  TRANSCRIPT_ANSWER_MAX_BYTES,
  type TranscriptLine,
} from "./contract.js";
import { entryLines } from "./transcript-redaction.js";

// ─── Cursor ──────────────────────────────────────────────────────────────────

/** A position: the line start of an entry, the next line within it, the transcript's id8. */
export interface TranscriptCursor {
  offset: number;
  k: number;
  id8: string;
}

/** The id8 of a record that has no session uuid (no transcript to read). */
export const NO_UUID_ID8 = "00000000";

/**
 * The renderer revision. `v1` names this cursor format AND the line rules (renderEntry,
 * redaction before every cut, the cuts made on the lease-independent text, nextCut and
 * its two bounds; pane/transcript-redaction.ts). A change to how many lines
 * one entry yields mints `v2`, which must accept a `v1` cursor at its offset with k = 0.
 */
const CURSOR_PREFIX = "v1";

const CURSOR_RE = /^v1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9a-f]{8})$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID in its canonical 8-4-4-4-12 hex form. */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** The first 8 hex of a session uuid, lowercase. */
export function id8Of(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/** Syntax only (prefix `v1`, two non-negative safe integers, 8 lowercase hex); throws `invalid_args`. */
export function decodeCursor(s: string): TranscriptCursor {
  const m = typeof s === "string" ? CURSOR_RE.exec(s) : null;
  if (!m) throw new ContractErrorException("invalid_args", "'since' is not a transcript cursor");
  const offset = Number(m[1]);
  const k = Number(m[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(k))
    throw new ContractErrorException("invalid_args", "'since' is not a transcript cursor");
  return { offset, k, id8: m[3] as string };
}

export function encodeCursor(c: TranscriptCursor): string {
  return `${CURSOR_PREFIX}.${c.offset}.${c.k}.${c.id8}`;
}

/** The longest cursor string: `v1.` + two 16-digit fields + `.` + 8 hex (45 bytes). */
const WORST_CASE_CURSOR = `${CURSOR_PREFIX}.${"9".repeat(16)}.${"9".repeat(16)}.${"f".repeat(8)}`;

// ─── Page reader ─────────────────────────────────────────────────────────────

export interface PageLimits {
  /** lines per answer */
  maxLines: number;
  /** UTF-8 bytes of the compact JSON answer */
  maxAnswerBytes: number;
  /** bytes of the answer without its lines (address fields, worst-case cursor, booleans) */
  envelopeBytes: number;
  /** transcript bytes scanned per call; a line that STARTS within it is read whole */
  scanBytes: number;
  /** a complete line longer than this is skipped unparsed */
  maxEntryBytes: number;
}

export const DEFAULT_PAGE_LIMITS: PageLimits = {
  maxLines: MAX_TRANSCRIPT_LINES,
  maxAnswerBytes: TRANSCRIPT_ANSWER_MAX_BYTES,
  envelopeBytes: 0,
  scanBytes: 16 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
};

export interface TranscriptPage {
  lines: TranscriptLine[];
  /** the scan position after the page: the cursor to answer */
  next: TranscriptCursor;
  /** the page stopped at a cap before the end of the complete lines in the file */
  more: boolean;
  /** the position OF each returned line (for the byte guard to step back to) */
  at: TranscriptCursor[];
}

const READ_CHUNK = 1024 * 1024;

/**
 * Complete lines of an open file from a byte offset, read in 1 MiB chunks. A line is
 * returned only once its `\n` is in hand; bytes after the last `\n` before `size` are
 * never returned. A line longer than the collect bound is scanned to its `\n` and
 * returned with `data: null`.
 */
class LineScanner {
  private chunk: Buffer = Buffer.alloc(0);
  private chunkStart: number;
  private idx = 0;

  constructor(
    private readonly fd: number,
    private readonly size: number,
    start: number
  ) {
    this.chunkStart = start;
  }

  /** The file offset of the next unread line. */
  get position(): number {
    return this.chunkStart + this.idx;
  }

  next(
    collect: boolean,
    maxBytes: number
  ): { start: number; end: number; data: Buffer | null } | null {
    const start = this.position;
    const parts: Buffer[] = [];
    let len = 0;
    let keep = collect;
    for (;;) {
      if (this.idx >= this.chunk.length) {
        const at = this.chunkStart + this.chunk.length;
        if (at >= this.size) return null;
        const n = Math.min(READ_CHUNK, this.size - at);
        const b = Buffer.alloc(n);
        const got = readSync(this.fd, b, 0, n, at);
        if (got <= 0) return null;
        this.chunk = got < n ? b.subarray(0, got) : b;
        this.chunkStart = at;
        this.idx = 0;
      }
      const nl = this.chunk.indexOf(0x0a, this.idx);
      const stop = nl === -1 ? this.chunk.length : nl;
      if (keep) {
        const piece = this.chunk.subarray(this.idx, stop);
        len += piece.length;
        if (len > maxBytes) {
          keep = false;
          parts.length = 0;
        } else parts.push(piece);
      }
      if (nl === -1) {
        this.idx = this.chunk.length;
        continue;
      }
      this.idx = nl + 1;
      return { start, end: this.chunkStart + nl, data: keep ? Buffer.concat(parts) : null };
    }
  }
}

function lineCost(l: TranscriptLine): number {
  return Buffer.byteLength(JSON.stringify(l)) + 1; // the separating comma
}

function absentPage(from: TranscriptCursor): TranscriptPage {
  return { lines: [], next: from, more: false, at: [] };
}

/** Read-only, never following a symlink in the FINAL component, never blocking on a FIFO. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

/**
 * Read the page after `from` from `path`, opened with OPEN_FLAGS (a symlink there, or a
 * missing file, is an empty page with `next = from`). For a file claudish did not contain
 * itself; `transcriptAnswer` reads through `openContainedTranscript`.
 */
export function readTranscriptPage(
  path: string,
  from: TranscriptCursor,
  limits?: Partial<PageLimits>
): TranscriptPage {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch {
    return absentPage(from);
  }
  try {
    return readTranscriptPageFd(fd, from, limits);
  } finally {
    closeQuietly(fd);
  }
}

/**
 * Read the page after `from` from an open descriptor (the caller closes it). The only
 * function that reads a transcript's lines. Not a regular file: an empty page.
 * Throws `invalid_args` when `from.offset` is past the end of the file or not at a line
 * start. A `k` at or past the entry's line count moves on to the next entry.
 *
 * An entry's lines are produced lazily (`entryLines`): the chunks before `k` are cut but
 * never masked or sliced, and production stops as soon as the page is full.
 */
export function readTranscriptPageFd(
  fd: number,
  from: TranscriptCursor,
  limits?: Partial<PageLimits>
): TranscriptPage {
  const lim: PageLimits = { ...DEFAULT_PAGE_LIMITS, ...limits };
  const st = fstatSync(fd);
  if (!st.isFile()) return absentPage(from);
  const size = st.size;
  if (from.offset > size)
    throw new ContractErrorException("invalid_args", "'since' is past the end of the transcript");
  if (from.offset > 0) {
    const b = Buffer.alloc(1);
    const got = readSync(fd, b, 0, 1, from.offset - 1);
    if (got !== 1 || b[0] !== 0x0a)
      throw new ContractErrorException("invalid_args", "'since' is not at a line start");
  }
  const scanner = new LineScanner(fd, size, from.offset);
  const lines: TranscriptLine[] = [];
  const at: TranscriptCursor[] = [];
  let bytes = lim.envelopeBytes;
  let next: TranscriptCursor = { ...from };
  let more = false;
  for (;;) {
    if (scanner.position - from.offset >= lim.scanBytes) {
      // past the scan budget: only ask whether another complete line exists
      if (scanner.next(false, 0)) more = true;
      break;
    }
    const l = scanner.next(true, lim.maxEntryBytes);
    if (!l) break;
    const startK = l.start === from.offset ? from.k : 0;
    if (l.data) {
      let j = 0;
      for (const pending of entryLines(l.data.toString("utf-8"))) {
        if (j < startK) {
          j++;
          continue; // cut, never built
        }
        const stop = { lines, next: { offset: l.start, k: j, id8: from.id8 }, more: true, at };
        if (lines.length >= lim.maxLines) return stop;
        const line = pending.build();
        const cost = lineCost(line);
        if (lines.length > 0 && bytes + cost > lim.maxAnswerBytes) return stop;
        lines.push(line);
        at.push({ offset: l.start, k: j, id8: from.id8 });
        bytes += cost;
        j++;
      }
    }
    next = { offset: l.end + 1, k: 0, id8: from.id8 };
  }
  return { lines, next, more, at };
}

// ─── Locating and containing the file ────────────────────────────────────────

/**
 * One `readdir` of `projectsRoot`: exactly one `<dir>/<uuid>.jsonl` → its path, else
 * null (none, more than one, an unreadable root, or a uuid that is not UUID syntax).
 * For a record that carries the uuid but no cwd (`spawn.json` alone).
 */
export function locateTranscriptByUuid(projectsRoot: string, uuid: string): string | null {
  if (!isUuid(uuid)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(projectsRoot);
  } catch {
    return null;
  }
  let hit: string | null = null;
  for (const d of dirs) {
    const p = join(projectsRoot, d, `${uuid}.jsonl`);
    try {
      if (!statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    if (hit !== null) return null;
    hit = p;
  }
  return hit;
}

/**
 * Whether a process is alive, without signalling it: `process.kill(pid, 0)`. ESRCH →
 * "dead"; success or EPERM → "alive" (possibly a reused pid: the safe direction); a
 * missing or non-integer pid, or any other error → "unknown".
 */
export function writerLiveness(pid: unknown): "dead" | "alive" | "unknown" {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

/** Milliseconds since `path` was last modified, or null when it cannot be stat'ed. */
export function fileAgeMs(path: string, now: number = Date.now()): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * No write to the transcript within `graceMs` (§ 2.4, a record that says the session or slot
 * finished): its mtime is at least `graceMs` old. A path not known, or a file that cannot be
 * stat'ed (never written, or deleted), has had no write and counts as quiet; the record's
 * own finish time already carries the grace.
 */
export function transcriptQuiet(path: string | null, now: number, graceMs: number): boolean {
  if (path === null) return true;
  const age = fileAgeMs(path, now);
  return age === null || age >= graceMs;
}

/**
 * A writer read from DISK (a `meta.json`, `spawn.json` or `status.json` record) counts as
 * gone this long after its last sign of life: 2.5× the measured ≈ 12 s reap bound, the
 * disk-side stand-in for "reaped" when another server may still own the process.
 */
export const TRANSCRIPT_GRACE_MS = 30_000;

/** Paths whose containment failed and were logged; capped so a hostile poller cannot grow it. */
const loggedRejections = new Set<string>();
const MAX_LOGGED_REJECTIONS = 256;

function logRejection(path: string, why: string): void {
  if (loggedRejections.has(path) || loggedRejections.size >= MAX_LOGGED_REJECTIONS) return;
  loggedRejections.add(path);
  log(`[transcript] refused transcript path ${path}: ${why}`);
}

function isEnoent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * An open, read-only descriptor of a transcript claudish may read, or null (read as an
 * absent file); the caller closes it. Its basename must be `<uuid>.jsonl`, and the file
 * THE DESCRIPTOR NAMES must lie under `realpath(projectsRoot)`. ENOENT at any step is
 * silent (before the first prompt the file does not exist yet); a real failure is logged
 * once per path per process.
 *
 * Containment is checked against the descriptor, never against a pathname looked up twice
 * (a `stat` and an `open` that both follow a link agree with each other about the
 * replacement, which proves nothing):
 *   1. `realpath(path)` lies under `realpath(projectsRoot)`. A legitimately symlinked
 *      CLAUDE_CONFIG_DIR or projects directory is resolved here, as before.
 *   2. That real path is opened with O_NOFOLLOW, so a final component swapped for a
 *      symlink after step 1 fails to open (ELOOP) rather than being followed, and with
 *      O_NONBLOCK, so a FIFO swapped in cannot block the server.
 *   3. `fstat` of the descriptor is a regular file.
 *   4. AFTER the open, `lstat` of the real path names the descriptor's (dev, ino), and
 *      then the parent directory still realpaths to itself (no ancestor is a symlink
 *      now): the open file is the one at a symlink-free path under the root. An ancestor
 *      swapped for a symlink before the open, and still swapped at the parent check,
 *      is refused.
 *   5. On Linux, the kernel's own path of the descriptor (its fd-table link) must equal
 *      the real path, which closes the window below there.
 * Residual risk, accepted (ai-docs/architecture/mcp-sessions.md, review round 2): Bun
 * exposes neither `openat` nor `F_GETPATH` on macOS, so there an ancestor swapped for a
 * symlink to an outside directory before the open and restored before the parent
 * `realpath` passes: the descriptor and the `lstat` (calls in that order) both name the
 * outside inode, and the parent check sees the restored directory. Two swaps suffice.
 * The attacker must already write the user's own projects directory as the same uid, so
 * can read the outside file directly, and the answer goes only to that user's Claude Code.
 */
export function openContainedTranscript(
  path: string,
  uuid: string,
  projectsRoot: string
): number | null {
  if (basename(path) !== `${uuid}.jsonl`) {
    logRejection(path, "basename is not the session uuid");
    return null;
  }
  let real: string;
  let root: string;
  try {
    real = realpathSync(path);
    root = realpathSync(projectsRoot);
  } catch (e) {
    if (!isEnoent(e)) logRejection(path, errText(e));
    return null;
  }
  if (!real.startsWith(root + sep)) {
    logRejection(path, "outside the Claude Code projects directory");
    return null;
  }
  let fd: number;
  try {
    fd = openSync(real, OPEN_FLAGS);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ELOOP")
      logRejection(path, "the transcript became a symlink");
    else if (!isEnoent(e)) logRejection(path, errText(e));
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      logRejection(path, "not a regular file");
      closeQuietly(fd);
      return null;
    }
    const parent = dirname(real);
    const named = lstatSync(real);
    if (
      realpathSync(parent) !== parent ||
      !named.isFile() ||
      named.dev !== st.dev ||
      named.ino !== st.ino ||
      !kernelPathMatches(fd, real)
    ) {
      logRejection(path, "the opened file is not the one under the projects directory");
      closeQuietly(fd);
      return null;
    }
    return fd;
  } catch (e) {
    if (!isEnoent(e)) logRejection(path, errText(e));
    closeQuietly(fd);
    return null;
  }
}

/** Linux only: the kernel's path of `fd` is `real`. Elsewhere, or with no fd table: true. */
function kernelPathMatches(fd: number, real: string): boolean {
  if (process.platform !== "linux") return true;
  let kernel: string;
  try {
    kernel = readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return true; // no /proc mounted: steps 1–4 stand
  }
  return kernel === real;
}

// ─── The answer ──────────────────────────────────────────────────────────────

export interface TranscriptSource {
  /** null: not found (read as an absent file) */
  transcriptPath: string | null;
  /** null: the record has no session uuid (§ 2.3) */
  sessionUuid: string | null;
  /** observed BEFORE the read (§ 2.4); false whenever liveness is unknown */
  writerGone: boolean;
  /** the Claude Code projects directory the path must lie under */
  projectsRoot: string;
}

/** What a replay needs to know about a session or team slot, from the transcript verbs' lookup. */
export interface ReplayTarget {
  claudeSessionId: string | null;
  transcriptPath: string | null;
  /** the writer is provably gone: the transcript verbs' own rule */
  writerGone: boolean;
  /** the session's own working directory, when the record gives one */
  cwd: string | null;
  projectsRoot: string;
}

/** Claude Code writes `cwd` on each user and assistant record, so a first screenful holds one. */
const HEAD_CWD_MAX_BYTES = 256 * 1024;

/**
 * The working directory the transcript's first records name, or null: a file that cannot be
 * read under the projects directory, or no record with a `cwd` in its first 256 KiB. A line
 * the cap cuts in half does not parse and is skipped.
 */
export function transcriptHeadCwd(path: string, uuid: string, projectsRoot: string): string | null {
  const fd = openContainedTranscript(path, uuid.toLowerCase(), projectsRoot);
  if (fd === null) return null;
  let text: string;
  try {
    const buf = Buffer.alloc(HEAD_CWD_MAX_BYTES);
    const n = readSync(fd, buf, 0, HEAD_CWD_MAX_BYTES, 0);
    text = buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    closeQuietly(fd);
  }
  for (const line of text.split("\n")) {
    try {
      const rec: unknown = JSON.parse(line);
      const cwd = rec && typeof rec === "object" ? (rec as { cwd?: unknown }).cwd : undefined;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {
      // not a whole record
    }
  }
  return null;
}

export interface TranscriptAnswerFields {
  cursor: string;
  lines: TranscriptLine[];
  more: boolean;
  final: boolean;
}

/** UTF-8 bytes of an answer with these address fields and no lines, at its largest. */
function envelopeBytesOf(address: object): number {
  return Buffer.byteLength(
    JSON.stringify({ ...address, cursor: WORST_CASE_CURSOR, lines: [], more: false, final: false })
  );
}

/**
 * The whole answer for one call: `{...address, cursor, lines, more, final}`. Checks the
 * cursor's id8 against this transcript, contains the path, reads the page, and sets
 * `final = writerGone && !more`. Its compact JSON is at most `maxAnswerBytes` bytes:
 * the page is budgeted with the address's envelope, and a last guard drops trailing
 * lines (stepping the cursor back) should an estimate ever be wrong.
 * Throws `invalid_args` for a cursor from another transcript, past the end, or off a
 * line start.
 */
export function transcriptAnswer<A extends object>(
  src: TranscriptSource,
  since: TranscriptCursor | undefined,
  address: A,
  limits?: Partial<PageLimits>
): A & TranscriptAnswerFields {
  const uuid = isUuid(src.sessionUuid) ? src.sessionUuid.toLowerCase() : null;
  const id8 = uuid ? id8Of(uuid) : NO_UUID_ID8;
  if (since && since.id8 !== id8)
    throw new ContractErrorException("invalid_args", "the cursor belongs to another transcript");
  const from: TranscriptCursor = since ?? { offset: 0, k: 0, id8 };
  const lim: Partial<PageLimits> = { envelopeBytes: envelopeBytesOf(address), ...limits };
  const maxBytes = lim.maxAnswerBytes ?? DEFAULT_PAGE_LIMITS.maxAnswerBytes;

  let page: TranscriptPage;
  if (!uuid) {
    if (from.offset !== 0 || from.k !== 0)
      throw new ContractErrorException("invalid_args", "the cursor belongs to another transcript");
    page = absentPage(from);
  } else {
    const fd =
      src.transcriptPath === null
        ? null
        : openContainedTranscript(src.transcriptPath, uuid, src.projectsRoot);
    if (fd === null) page = absentPage(from);
    else {
      try {
        page = readTranscriptPageFd(fd, from, lim);
      } finally {
        closeQuietly(fd);
      }
    }
  }

  const build = (): A & TranscriptAnswerFields => ({
    ...address,
    cursor: encodeCursor(page.next),
    lines: page.lines,
    more: page.more,
    final: src.writerGone && !page.more,
  });
  let answer = build();
  // never expected: keeps the byte invariant if an estimate above is ever wrong
  while (page.lines.length > 1 && Buffer.byteLength(JSON.stringify(answer)) > maxBytes) {
    const last = page.at[page.lines.length - 1] as TranscriptCursor;
    page = {
      lines: page.lines.slice(0, -1),
      at: page.at.slice(0, -1),
      next: last,
      more: true,
    };
    answer = build();
  }
  return answer;
}
