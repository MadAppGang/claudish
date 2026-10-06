// ─── Host pid and the parent proof ───────────────────────────────────────────
//
// Two facts a session or team record carries so an observer outside this
// process — the magus `claudish` plugin monitor — can tell which Claude Code
// window started a run:
//
//   * `hostPid`: the Claude Code process that launched this MCP server. A
//     structural fact, read once at startup from the process tree we were given
//     (our parent, or our launcher's parent). Never searched for.
//   * `parentClaudeSessionId`: the Claude Code CONVERSATION that issued the
//     tool call. Recorded only when PROVEN per call: the calling tool-use id is
//     found in that conversation's transcript. Otherwise absent — never the id
//     the server happened to start with, which goes stale on /clear, on a
//     resume, and whenever two windows share one conversation.
//
// Why a hit is proof: a tool-use id is unique and is written only into the
// transcript of the conversation (or of a subagent of it) that issued the call.
// Every source below is used to CONFIRM, and every failure — no `_meta`, an
// unreadable record, a transcript layout a future Claude Code changed —
// degrades to "absent", never to a wrong answer.

import * as fsPromises from "node:fs/promises";
import { join } from "node:path";

import { userHomeFrom } from "./home-dir.js";

/** What a Claude Code session id or tool-use id may look like. Also the path-safety gate. */
export const CLAUDE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** `_meta` key Claude Code puts the calling tool-use id under. */
export const TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

/** Bytes of a main transcript searched for the tool-use id, from its end. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** Subagent transcripts are searched only when modified this recently. */
export const SUBAGENT_WINDOW_MS = 10 * 60_000;

/** At most this many subagent transcripts are searched, newest first. */
export const MAX_SUBAGENT_FILES = 32;

/**
 * Wait between looks while the transcript append may still be in flight.
 * Claude Code writes the tool_use record asynchronously: in a live 2.1.290
 * session it reached disk 377 ms after its own timestamp.
 */
export const PROOF_POLL_INTERVAL_MS = 100;

/** Total time the proof keeps looking before it answers "not proven". */
export const PROOF_DEADLINE_MS = 2000;

// ─── hostPid ─────────────────────────────────────────────────────────────────

export interface HostPids {
  /** The Claude Code process that launched this MCP server. */
  hostPid: number;
  /**
   * The npm `node` launcher (`bin/claudish.cjs`) between Claude Code and this
   * process, when there is one. Present exactly when `hostPid` came from the
   * launcher branch, so every record says which branch produced it.
   */
  launcherPid?: number;
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The host pid, from the environment and our own parent pid. Pure.
 *
 * - npm / bun global install: Claude Code → `node` launcher → `bun` (us). The
 *   launcher sets `CLAUDISH_LAUNCHER_PID` (itself) and `CLAUDISH_LAUNCHER_PPID`
 *   (its parent). When `CLAUDISH_LAUNCHER_PID` is OUR parent, the host is the
 *   launcher's parent.
 * - compiled binary, or `bun src/index.ts`: our parent is the host.
 *
 * The pair check makes a leaked pair inert: a nested claudish that inherits an
 * outer launcher's variables sees `CLAUDISH_LAUNCHER_PID` ≠ its own parent and
 * ignores them. No `ps`, no walk.
 */
export function hostPidFrom(env: Record<string, string | undefined>, ppid: number): HostPids {
  const launcherPpid = positiveInt(env.CLAUDISH_LAUNCHER_PPID);
  if (
    env.CLAUDISH_LAUNCHER_PID === String(ppid) &&
    launcherPpid !== undefined &&
    launcherPpid !== ppid
  ) {
    return { hostPid: launcherPpid, launcherPid: ppid };
  }
  return { hostPid: ppid };
}

// ─── Candidates ──────────────────────────────────────────────────────────────

/**
 * The conversation id this server was started with, when it can be a
 * candidate at all.
 *
 * `CLAUDE_CODE_SESSION_ID` when it is well formed and `CLAUDE_CODE_CHILD_SESSION`
 * is empty. Claude Code sets the latter for Bash-tool children and monitors and
 * strips it from the stdio MCP servers it launches, so its presence means this
 * server was not started by Claude Code directly. A candidate only: it is
 * believed when the proof finds the tool-use id in its transcript.
 */
export function parentSessionIdFrom(env: Record<string, string | undefined>): string | undefined {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (id === undefined || !CLAUDE_ID_RE.test(id)) return undefined;
  if (env.CLAUDE_CODE_CHILD_SESSION) return undefined;
  return id;
}

/**
 * `CLAUDE_CONFIG_DIR`, else `<home>/.claude`, with `<home>` resolved by the
 * same `$HOME`-first rule as the sessions directory (home-dir.ts): Claude Code
 * follows `$HOME`, and Bun's `os.homedir()` does not.
 */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(userHomeFrom(env), ".claude");
}

/** The subset of `node:fs/promises` the proof uses. Injectable for tests. */
export interface ProofFs {
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
  stat: (
    path: string
  ) => Promise<{ mtimeMs: number; size: number; isDirectory(): boolean; isFile(): boolean }>;
  open: (
    path: string,
    flags: "r"
  ) => Promise<{
    read: (
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number
    ) => Promise<{ bytesRead: number }>;
    close: () => Promise<void>;
  }>;
}

const defaultFs: ProofFs = {
  readFile: (path, encoding) => fsPromises.readFile(path, encoding),
  readdir: (path) => fsPromises.readdir(path),
  stat: (path) => fsPromises.stat(path),
  open: (path, flags) => fsPromises.open(path, flags),
};

/** The host's live session record, as far as the proof trusts it. */
export interface HostSessionRecord {
  sessionId: string;
  /** The host's working directory, when the record names one. Feeds the fast path. */
  cwd?: string;
}

/**
 * `<configDir>/sessions/<hostPid>.json`, the record Claude Code writes at
 * startup and rewrites on every session switch (so it is current after
 * `/clear`). Used only when it parses, its `pid === hostPid`, and its
 * `sessionId` is well formed; anything else is `undefined`. Never throws.
 */
export async function readHostSessionRecord(opts: {
  configDir: string;
  hostPid: number;
  fs?: ProofFs;
}): Promise<HostSessionRecord | undefined> {
  const fs = opts.fs ?? defaultFs;
  try {
    const raw = await fs.readFile(
      join(opts.configDir, "sessions", `${opts.hostPid}.json`),
      "utf-8"
    );
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const rec = parsed as { pid?: unknown; sessionId?: unknown; cwd?: unknown };
    if (rec.pid !== opts.hostPid) return undefined;
    if (typeof rec.sessionId !== "string" || !CLAUDE_ID_RE.test(rec.sessionId)) return undefined;
    return {
      sessionId: rec.sessionId,
      ...(typeof rec.cwd === "string" && rec.cwd.length > 0 ? { cwd: rec.cwd } : {}),
    };
  } catch {
    return undefined;
  }
}

/** One conversation the proof may confirm. */
export interface ProofCandidate {
  sessionId: string;
  /** Working directory whose project directory is tried first (the fast path). */
  cwd?: string;
}

/**
 * The candidates for one call, deduplicated, at most two: the environment's
 * session id, then the host session record's. The host record's `cwd` is
 * attached to both, since it names the project the host runs in.
 */
export async function gatherProofCandidates(opts: {
  env: Record<string, string | undefined>;
  hostPid: number;
  configDir: string;
  fs?: ProofFs;
}): Promise<ProofCandidate[]> {
  const record = await readHostSessionRecord({
    configDir: opts.configDir,
    hostPid: opts.hostPid,
    fs: opts.fs,
  });
  const cwd = record?.cwd;
  const ids = [parentSessionIdFrom(opts.env), record?.sessionId].filter(
    (id): id is string => id !== undefined
  );
  return [...new Set(ids)].map((sessionId) => ({ sessionId, ...(cwd ? { cwd } : {}) }));
}

// ─── The proof ───────────────────────────────────────────────────────────────

/** Claude Code keeps a project directory name to this many slug characters. */
export const PROJECT_DIR_SLUG_MAX = 200;

/** Claude Code's 32-bit string hash (`(h << 5) - h + charCode`, per UTF-16 unit). */
function claudeCodeStringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Claude Code's project directory name for a cwd: every character outside
 * `[A-Za-z0-9]` becomes `-` (so `/.claude/` becomes `--claude-`). A slug longer than
 * 200 characters is cut to 200 and suffixed `-<base36 |hash(cwd)|>`, the hash taken
 * over the WHOLE path, not the slug. Read from Claude Code 2.1.291's own bundle
 * (`k(e)=e.replace(/[^a-zA-Z0-9]/g,"-")`, `eI(e)` truncates at `Rle=200` and appends
 * `Le(e)=Math.abs(hash(e)).toString(36)`) and MEASURED: a live 2.1.291 run in a
 * 259-character cwd wrote `<200 slug chars>-g32rlu`, which this function reproduces.
 * Used as the fast path of the proof (a future rule change degrades to the directory
 * listing) and, through `slugForPath`, for every transcript path claudish derives.
 */
export function projectDirNameFor(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= PROJECT_DIR_SLUG_MAX) return slug;
  return `${slug.slice(0, PROJECT_DIR_SLUG_MAX)}-${Math.abs(claudeCodeStringHash(cwd)).toString(36)}`;
}

/**
 * `<configDir>\0<candidate>` → the project directory the LISTING found holding
 * `<candidate>.jsonl`, so the listing runs about once per candidate per server
 * life. The fast path is never cached (it is one `stat`), and an entry whose
 * transcript is gone is dropped and resolved again: a wrong entry would
 * otherwise answer every later call for the server's whole life.
 */
export type ProjectDirCache = Map<string, string>;

const serverProjectDirCache: ProjectDirCache = new Map();

/** A regular file at `path`. A directory that happens to carry the name is not a transcript. */
async function isTranscriptFile(fs: ProofFs, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findProjectDir(
  fs: ProofFs,
  configDir: string,
  candidate: ProofCandidate,
  cache: ProjectDirCache
): Promise<string | undefined> {
  const cacheKey = `${configDir}\0${candidate.sessionId}`;
  const projectsDir = join(configDir, "projects");
  const fileName = `${candidate.sessionId}.jsonl`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    if (await isTranscriptFile(fs, join(cached, fileName))) return cached;
    cache.delete(cacheKey);
  }

  if (candidate.cwd) {
    const fast = join(projectsDir, projectDirNameFor(candidate.cwd));
    if (await isTranscriptFile(fs, join(fast, fileName))) return fast;
  }

  let names: string[];
  try {
    names = await fs.readdir(projectsDir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const dir = join(projectsDir, name);
    if (await isTranscriptFile(fs, join(dir, fileName))) {
      cache.set(cacheKey, dir);
      return dir;
    }
  }
  return undefined;
}

/** Whether the last `TRANSCRIPT_TAIL_BYTES` of `path` contain `needle`. */
async function tailContains(fs: ProofFs, path: string, needle: Buffer): Promise<boolean> {
  let handle: Awaited<ReturnType<ProofFs["open"]>> | undefined;
  try {
    const { size } = await fs.stat(path);
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    if (length < needle.length) return false;
    const buffer = Buffer.alloc(length);
    handle = await fs.open(path, "r");
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).includes(needle);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** `<project>/<candidate>/subagents/*.jsonl` modified in the window, newest first, capped. */
async function recentSubagentTranscripts(
  fs: ProofFs,
  projectDir: string,
  candidateId: string,
  nowMs: number
): Promise<string[]> {
  const dir = join(projectDir, candidateId, "subagents");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const recent: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const { mtimeMs } = await fs.stat(path);
      if (nowMs - mtimeMs <= SUBAGENT_WINDOW_MS) recent.push({ path, mtimeMs });
    } catch {
      /* gone between readdir and stat */
    }
  }
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return recent.slice(0, MAX_SUBAGENT_FILES).map((f) => f.path);
}

async function candidateHolds(
  fs: ProofFs,
  configDir: string,
  candidate: ProofCandidate,
  needle: Buffer,
  nowMs: number,
  cache: ProjectDirCache
): Promise<boolean> {
  const projectDir = await findProjectDir(fs, configDir, candidate, cache);
  if (projectDir === undefined) return false;
  if (await tailContains(fs, join(projectDir, `${candidate.sessionId}.jsonl`), needle)) {
    return true;
  }
  for (const path of await recentSubagentTranscripts(fs, projectDir, candidate.sessionId, nowMs)) {
    if (await tailContains(fs, path, needle)) return true;
  }
  return false;
}

export interface ProveCallingConversationOptions {
  /** The calling tool-use id, from the request `_meta`. Anything malformed → `undefined`, no read. */
  toolUseId: unknown;
  /** At most two are used, after deduplication. A bare string is a candidate with no `cwd`. */
  candidates: readonly (ProofCandidate | string)[];
  /** Claude Code's config directory (`claudeConfigDir(env)`). */
  configDir: string;
  /** Clock for the subagent recency window and the deadline. Default `Date.now`. */
  now?: () => number;
  /** Injected filesystem. Default `node:fs/promises`. */
  fs?: ProofFs;
  /** The wait between looks. Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Project directories the listing found. Default: one cache for the server's life. */
  cache?: ProjectDirCache;
}

/**
 * The conversation whose transcript holds the calling tool-use id, or
 * `undefined`. Asynchronous throughout, so the MCP process keeps pumping every
 * live session while one call proves. Never throws.
 *
 * For each candidate: find its project directory (fast path from `cwd`, else
 * one listing), then search the last 256 KB of `<C>.jsonl`, then up to 32
 * subagent transcripts modified in the last 10 minutes, newest first, for the
 * exact quoted substring `"<toolUseId>"`. The first hit decides and returns at
 * once, so a call whose record is already on disk waits for nothing. With no
 * hit, look again every `PROOF_POLL_INTERVAL_MS` until `PROOF_DEADLINE_MS`
 * has passed, then `undefined`. Elapsed time is the larger of the clock's
 * advance and the total slept, so the loop ends even under a clock that never
 * moves.
 */
export async function proveCallingConversation(
  opts: ProveCallingConversationOptions
): Promise<string | undefined> {
  const { toolUseId } = opts;
  if (typeof toolUseId !== "string" || !CLAUDE_ID_RE.test(toolUseId)) return undefined;
  const candidates = normaliseCandidates(opts.candidates);
  if (candidates.length === 0) return undefined;

  const fs = opts.fs ?? defaultFs;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = opts.cache ?? serverProjectDirCache;
  const needle = Buffer.from(`"${toolUseId}"`, "utf-8");

  const look = async (): Promise<string | undefined> => {
    for (const candidate of candidates) {
      if (await candidateHolds(fs, opts.configDir, candidate, needle, now(), cache)) {
        return candidate.sessionId;
      }
    }
    return undefined;
  };

  try {
    const startedAt = now();
    let slept = 0;
    for (;;) {
      const found = await look();
      if (found !== undefined) return found;
      const remaining = PROOF_DEADLINE_MS - Math.max(now() - startedAt, slept);
      if (remaining <= 0) return undefined;
      const wait = Math.min(PROOF_POLL_INTERVAL_MS, remaining);
      await sleep(wait);
      slept += wait;
    }
  } catch {
    // Every failure is "not proven".
    return undefined;
  }
}

/**
 * Well-formed, deduplicated, at most two. The id becomes a path segment, and
 * the pattern is what keeps it one.
 */
function normaliseCandidates(raw: readonly (ProofCandidate | string)[]): ProofCandidate[] {
  const out: ProofCandidate[] = [];
  for (const entry of raw) {
    const candidate = typeof entry === "string" ? { sessionId: entry } : entry;
    if (!CLAUDE_ID_RE.test(candidate.sessionId)) continue;
    if (out.some((c) => c.sessionId === candidate.sessionId)) continue;
    out.push(candidate);
    if (out.length === 2) break;
  }
  return out;
}

/**
 * The whole per-call proof as the MCP handlers run it: gather the candidates
 * for this host, then prove. `undefined` whenever nothing is proven.
 */
export async function proveParentForCall(opts: {
  toolUseId: unknown;
  hostPid: number;
  env?: Record<string, string | undefined>;
  fs?: ProofFs;
}): Promise<string | undefined> {
  if (typeof opts.toolUseId !== "string" || !CLAUDE_ID_RE.test(opts.toolUseId)) return undefined;
  const env = opts.env ?? process.env;
  const configDir = claudeConfigDir(env);
  try {
    const candidates = await gatherProofCandidates({
      env,
      hostPid: opts.hostPid,
      configDir,
      fs: opts.fs,
    });
    return await proveCallingConversation({
      toolUseId: opts.toolUseId,
      candidates,
      configDir,
      fs: opts.fs,
    });
  } catch {
    return undefined;
  }
}
