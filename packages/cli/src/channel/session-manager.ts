// ─── SessionManager ──────────────────────────────────────────────────────────
//
// Lifecycle owner for channel sessions. Each session is one INTERACTIVE Claude Code,
// launched through claudish (`claudish -i --model X -y --quiet --session-id <uuid>
// --add-dir <turnDir> [caller flags]`) inside its own headless magmux pane and driven
// over the pane's socket (packages/cli/src/pane/, architecture §2). There is no `-p`,
// no `--stdin` and no stream-json: the child's own transcript is the turn oracle, and
// the pane session's phase table is the clock of every state record this file writes.
//
// The policy stays here (D8): a one-shot session's verdict is `classifyRunOutput` with
// no byte floor and no pattern; an interactive session continues after each turn and
// fails only on an API-error turn (D20); a question or a permission dialog waits for
// `send_input` (D19 is team's rule, not ours). `send_input` is accepted in every
// non-terminal state and queued (D17). `timeout_seconds` is the caller's own deadline
// and the only post-acceptance timer (D10).
//
// The 10.4.0 session records are kept, byte for byte where the magus monitor reads
// them (§20.1): `spawn.json` before any pane, `waits.jsonl` from the pane's transition
// hook, `meta.json` through `toMetaRecord` with every 10.4.0 key, `events.jsonl` with
// one `assistant` line per main-chain message id.

import { randomUUID } from "node:crypto";
import {
  type WriteStream,
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

import { ENV } from "../config.js";
import { UPSTREAM_ERROR_LOG_ENV } from "../handlers/shared/upstream-error-capture.js";
import {
  type Accounting,
  type CaptureResult,
  type CaptureUnchanged,
  ContractErrorException,
  FAILURE_REASONS,
  type FailureReason,
  type FinalVerdict,
  type PaneBlock,
  type PaneSession,
  type PaneSessionOptions,
  type PaneSnapshot,
  SLOT_STATES,
  type SessionCancelResult,
  type SessionRow,
  type SettledTurn,
  type SlotState,
  assertMagmuxAvailable,
  checkChildFlags,
  deliveryRefusal,
  flagsRemoveRead,
  isTerminalState,
  mergeAccounting,
  readTokenFileCached,
  releasePaneReservations,
  reservePanes,
  resolveProvider,
  sockRootFor,
  startPaneSession,
} from "../pane/index.js";
import { redactSecrets } from "../redact.js";
import { projectsDir, transcriptPathFor } from "../session/session-discovery.js";
import { TRUNCATION_NOTE, type TeamRunOutcome, classifyRunOutput } from "../team-orchestrator.js";
import { readTokenStatsAt } from "../team-stats.js";
import { sessionsDirFrom } from "./home-dir.js";
import { hostPidFrom } from "./parent-proof.js";
import { ScrollbackBuffer } from "./scrollback-buffer.js";
import type {
  ChannelEvent,
  ChannelEventType,
  SessionCreateOptions,
  SessionInfo,
  SessionManagerOptions,
} from "./types.js";

/** One record of the session's own event log, as `get_diagnostics` returns it. */
export interface DiagnosticEvent {
  /**
   * When the record was written, ISO-8601 — or `""` for a record recovered from
   * `events.jsonl` after the session left memory whose line carries no `at`.
   * Empty rather than back-filled from the file's mtime: a fabricated timestamp is
   * indistinguishable from a measured one.
   */
  at: string;
  /** The record's `type` (`state`, `tool`, `anomaly`, `assistant`), or null. */
  label: string | null;
  /** The record, redacted and truncated to `EVENT_PREVIEW_CHARS`. */
  preview: string;
  /** True when `preview` is a prefix rather than the whole record. */
  truncated: boolean;
}

/** What `get_diagnostics` returns. Every field is reachable without a filesystem read. */
export interface SessionDiagnostics {
  sessionId: string;
  state: SlotState;
  /** The current channel event (10.4.0's `status` key, RB7). */
  event: ChannelEventType;
  reason: FailureReason | null;
  detail: string | null;
  /** The model as the caller asked for it. */
  model: string;
  /** The pinned `provider@model` the child was spawned with, or null. */
  spawnModel: string | null;
  provider: string | null;
  shape: "one-shot" | "interactive";
  /** The pane's internal phase; null when the session is not live. */
  phase: string | null;
  exitCode: number | null;
  /** Seconds since the last screen change or transcript append; null when not live. */
  idleSeconds: number | null;
  elapsedSeconds: number;
  /** The session's own timeout, for reading `elapsedSeconds` against (0 when unknown). */
  timeoutSeconds: number;
  /** Bytes of answer prose in `get_output`. Zero on a session that produced no answer. */
  outputBytes: number;
  turnsCompleted: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  toolCalls: number;
  pendingInputs: number;
  /** Whether claudish holds a live socket to the pane's magmux right now. */
  connected: boolean;
  /** The last non-empty rows of the child's screen, redacted (a PTY has no separate stderr). */
  screenTail: string;
  pane: string | null;
  sockPath: string | null;
  /** The head of magmux's own stderr, redacted. */
  magmuxStderr: string;
  captureSource: SessionInfo["captureSource"];
  turnSource: SessionInfo["turnSource"];
  /** Bytes of assistant text before a file-delivered turn's task file was read. */
  preambleBytes: number;
  readCoverage: {
    linesTotal: number;
    linesReturned: number;
    complete: boolean;
    reads: number;
  } | null;
  claudeCodeVersion: string | null;
  /** Deduplicated anomaly keys with counts (`illegal_transition:…`, `socket_reconnected ×2`, …). */
  anomalies: readonly string[];
  /** The tail of the session's own event records, oldest → newest. */
  recentEvents: readonly DiagnosticEvent[];
  /** How many records the ring holds (it caps at `EVENT_RING_SIZE`). */
  eventsTotal: number;
  /** Raw JSONL records from the child proxy's upstream-error capture, newest last. */
  upstreamErrors: readonly string[];
  claudeSessionId: string | null;
  transcriptPath: string | null;
  sessionDir: string;
  eventLogPath: string;
  upstreamErrorLogPath: string;
}

/** What `get_output` returns. */
export interface SessionOutput {
  sessionId: string;
  state: SlotState;
  output: string;
  totalLines: number;
  turnsCompleted: number;
  tokensIn: number | null;
  tokensOut: number | null;
  elapsedSeconds: number;
  /** Seconds since the last activity. Null when not live. */
  idleSeconds: number | null;
}

/** What `send_input` returns (§4.2). */
export type SendInputResult =
  | { success: true; queued: number }
  | {
      success: false;
      reason: "terminal" | "unknown_session" | "delivery_unavailable" | "unsupported_command";
      state: SlotState | null;
    };

interface SessionEntry {
  info: SessionInfo;
  /** null before the pane started, and for a session whose pane never started */
  session: PaneSession | null;
  /** Answer prose, one line per entry. What `get_output` returns. */
  scrollback: ScrollbackBuffer;
  outputLogStream: WriteStream | null;
  sessionDir: string;
  cwd: string;
  tokenFile: string;
  eventLogPath: string;
  /** Bytes already written to `events.jsonl`; the log stops at EVENT_LOG_LIMIT. */
  eventLogBytes: number;
  upstreamErrorLogPath: string;
  /** The last `EVENT_RING_SIZE` event records, redacted and truncated. */
  eventRing: DiagnosticEvent[];
  /** Bytes of answer prose appended (the `outputBytes` metric). */
  proseBytes: number;
  /** Turn indexes whose answer reached the scrollback. */
  answeredTurns: Set<number>;
  waitLogPath: string;
  waitLogBytes: number;
  /** The `since` of the wait that is open now, or null. */
  waitSince: string | null;
  /** The terminal transition was handled (records written). */
  ended: boolean;
  evictHandle: ReturnType<typeof setTimeout> | null;
  /** The last channel event emitted; STARTING is the initial state, never a frame. */
  lastEvent: ChannelEventType;
  lastFrameTool: string | null;
  lastFrameToolCount: number;
  lastToolFrameAt: number;
  lastLoggedTool: string | null;
  assistantIdsLogged: number;
  anomaliesLogged: Set<string>;
  sendRejectedSeen: number;
  /** Optional frame meta for the next frame (`prompt_not_read`, `send_rejected`). */
  pendingMeta: Record<string, string>;
  /** The question or permission text of the current block, for the frame content. */
  blockText: string | null;
}

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_SCROLLBACK = 2000;
const DEFAULT_TIMEOUT = 600;
const MAX_TIMEOUT = 3600;

/**
 * The caller's `timeout_seconds` as a whole number of seconds in
 * 1..MAX_TIMEOUT: rounded, then clamped. Anything that is not a finite number
 * (absent, null, NaN, Infinity, garbage from a client that ignored the schema)
 * is DEFAULT_TIMEOUT; a numeric string is read as its number.
 *
 * `spawn.json` is a contract with the magus plugin monitor, which drops any
 * record whose `timeoutSeconds` is not an integer in 1..3600 — so a raw 90.5,
 * 0 or -5 made the whole run invisible, and 0 or less also timed the session
 * out at once.
 */
export function normaliseTimeoutSeconds(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(1, Math.round(n)));
}

/**
 * How long a terminal session stays readable before it is dropped from the map.
 * Long enough that an agent which polls, sees `completed`, and then calls
 * `get_output`/`get_diagnostics`/`capture_session` always finds the session; the
 * artifacts on disk outlive it either way.
 */
const TERMINAL_RETENTION_MS = 30 * 60_000;

/** Hard ceiling on retained terminal sessions, whatever the retention window says. */
const MAX_TERMINAL_SESSIONS = 50;

/** Cap on `events.jsonl`. */
const EVENT_LOG_LIMIT = 4 * 1024 * 1024;

/**
 * Cap on `waits.jsonl`. One line is under 200 bytes, so this is about 6 000
 * waits — far beyond any real interactive session. Past it, later waits are
 * not recorded.
 */
const WAIT_LOG_LIMIT = 1024 * 1024;

/** How many event records `get_diagnostics` can hand back, and how much of each. */
const EVENT_RING_SIZE = 200;
const EVENT_PREVIEW_CHARS = 800;

/** Default number of ring events returned when the caller names no limit. */
const DEFAULT_EVENT_LIMIT = 40;

/** Bytes of `upstream-errors.jsonl` read back for diagnostics. */
const UPSTREAM_ERROR_TAIL_BYTES = 64 * 1024;

/**
 * `spawn.json`'s `schema`. Bumped only on a breaking change to `spawn.json`; it
 * versions that file alone, not `waits.jsonl` or a team record's `meta.json`.
 */
const SPAWN_RECORD_SCHEMA = 1;

/** RUNNING activities that are not a tool name (§8 B). */
const NON_TOOL_ACTIVITY = new Set(["thinking", "background", "finishing"]);

/** `meta.json` `status` for each terminal state (§20.1): EMPTY is a failure to the monitor. */
const META_STATUS: Record<SlotState, string> = {
  STARTING: "starting",
  RUNNING: "running",
  AWAITING_INPUT: "waiting_for_input",
  AWAITING_PERMISSION: "awaiting_permission",
  COMPLETED: "completed",
  FAILED: "failed",
  EMPTY: "failed",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
};

/** A 10.4.0 `meta.json` `status` read back as a `SlotState` (the first-generation reader). */
const STATE_OF_10_4_STATUS: Record<string, SlotState> = {
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  timeout: "TIMEOUT",
};

/**
 * The channel event for a session state (architecture §3.4). Pure; the wire, the
 * wait log's `to` and `get_diagnostics.event` all read it.
 */
export function channelEventFor(snap: { state: SlotState; activity: string | null }): {
  event: ChannelEventType;
  tool: string | null;
} {
  switch (snap.state) {
    case "STARTING":
      return { event: "starting", tool: null };
    case "RUNNING": {
      const a = snap.activity;
      return a && !NON_TOOL_ACTIVITY.has(a)
        ? { event: "tool_executing", tool: a }
        : { event: "running", tool: null };
    }
    case "AWAITING_INPUT":
      return { event: "waiting_for_input", tool: null };
    case "AWAITING_PERMISSION":
      return { event: "awaiting_permission", tool: null };
    case "COMPLETED":
      return { event: "completed", tool: null };
    case "CANCELLED":
      return { event: "cancelled", tool: null };
    case "TIMEOUT":
      return { event: "timeout", tool: null };
    default:
      return { event: "failed", tool: null };
  }
}

/** One `list_sessions` row (§8 B): exactly the SlotRow keys plus the four session keys. */
export function sessionRowOf(info: SessionInfo): SessionRow {
  const terminal = isTerminalState(info.state);
  return {
    slot: info.sessionId,
    model: info.model,
    provider: info.provider,
    state: info.state,
    reason: info.state === "COMPLETED" || !terminal ? null : info.reason,
    tokens_in: info.tokensIn,
    tokens_out: info.tokensOut,
    cost_usd: info.costUsd,
    tool_calls: info.toolCalls,
    turns_completed: info.turnsCompleted,
    last_activity_at: info.lastActivityAt,
    idle_seconds: terminal ? null : info.idleSeconds,
    activity: terminal ? null : info.activity,
    pane: info.pane,
    session_id: info.sessionId,
    started_at: info.startedAt,
    completed_at: info.completedAt,
    elapsed_seconds: info.elapsedSeconds,
  };
}

/**
 * The `meta.json` record (§20.1). Every 10.4.0 key under its 10.4.0 name and meaning —
 * the magus monitor reads `status` (an unknown value reads as `failed`),
 * `terminalReason`, `elapsedSeconds`, `turnsCompleted`, `toolCallCount`, `costUsd` and
 * `exitCode` — plus additive keys. A `SessionInfo` key that would repeat a pinned key
 * (`toolCalls`, `reason`, `panePid`) is written only under the pinned name.
 */
export function toMetaRecord(info: SessionInfo, cwd: string): Record<string, unknown> {
  return {
    sessionId: info.sessionId,
    model: info.model,
    spawnModel: info.spawnModel,
    status: META_STATUS[info.state],
    pid: info.panePid,
    startedAt: info.startedAt,
    completedAt: info.completedAt,
    exitCode: info.exitCode,
    turnsCompleted: info.turnsCompleted,
    tokensUsed: (info.tokensIn ?? 0) + (info.tokensOut ?? 0),
    elapsedSeconds: info.elapsedSeconds,
    idleSeconds: info.idleSeconds,
    costUsd: info.costUsd,
    toolCallCount: info.toolCalls,
    terminalReason: info.reason,
    claudeSessionId: info.claudeSessionId,
    ...(info.parentClaudeSessionId ? { parentClaudeSessionId: info.parentClaudeSessionId } : {}),
    transcriptPath: info.transcriptPath,
    // additive (pane generation)
    state: info.state,
    detail: info.detail,
    tokensIn: info.tokensIn,
    tokensOut: info.tokensOut,
    lastActivityAt: info.lastActivityAt,
    shape: info.shape,
    pane: info.pane,
    provider: info.provider,
    captureSource: info.captureSource,
    turnSource: info.turnSource,
    timeoutSeconds: info.timeoutSeconds,
    cwd,
  };
}

/**
 * Write JSON so a reader never sees half of it: `<path>.tmp`, then rename over
 * `<path>`. Throws on failure; callers that must not throw catch it themselves.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, path);
}

/** The count of one anomaly key in a snapshot's `anomalies` (`key` or `key ×n`). */
function anomalyCount(anomalies: readonly string[], key: string): number {
  for (const a of anomalies) {
    if (a === key) return 1;
    if (a.startsWith(`${key} ×`)) return Number(a.slice(key.length + 2)) || 1;
  }
  return 0;
}

/** An anomaly entry without its `×n` count suffix. */
function anomalyKey(a: string): string {
  const at = a.lastIndexOf(" ×");
  return at > 0 ? a.slice(0, at) : a;
}

// ─── Disk fallback ───────────────────────────────────────────────────────────
//
// Sessions live in a Map, and two things legitimately remove them from it: the
// 30-minute / 50-session retention policy, and the MCP server restarting. The three
// READERS (`getSession`, `getOutput`, `getDiagnostics`) fall back to the session's
// directory; the MUTATORS never do (`liveEntry`). The reader reads both generations of
// `meta.json`: 10.4.0's (`status`, no `state`) and the pane one (`state` beside it).

/**
 * What a session id may contain, given that it is about to become a path segment.
 * No `/`, no `\`, no NUL and no leading dot, which makes `..`, `../../etc/passwd` and an
 * absolute path unrepresentable rather than merely unlikely.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Refuse to parse a `meta.json` larger than this; it is not the file we wrote. */
const META_READ_LIMIT = 1024 * 1024;

/** Bytes of `output.log` read back, before the same scrollback bound the live path applies. */
const OUTPUT_TAIL_BYTES = 256 * 1024;

/** Bytes of `events.jsonl` read back: a bounded TAIL, never the whole file. */
const EVENT_TAIL_BYTES = 512 * 1024;

/** Bytes of `screen.txt` read back. */
const SCREEN_READ_BYTES = 64 * 1024;

/**
 * The detail of a session whose directory exists but whose `meta.json` does not, or
 * will not parse: the process died before reaching a verdict (SIGKILL, a panic, a full
 * disk). Distinctive enough to grep.
 */
const NO_TERMINAL_RECORD = "claudish_no_terminal_record";

/** How every annotation of OUR OWN in `output.log` begins (kept out of `outputBytes`). */
const CLAUDISH_NOTE_PREFIX = "[claudish] ";

/** A session reconstructed from `<sessionsDir>/<id>/`. There is no process behind it. */
interface DiskRecord {
  info: SessionInfo;
  sessionDir: string;
  /** True when `meta.json` was missing or unusable and `info` was reconstructed. */
  partial: boolean;
}

/**
 * The last `maxBytes` of a file, as text, plus whether the read began mid-file. A
 * positioned tail read, never a whole-file read. Null for an absent file. Never throws.
 */
function readTailText(path: string, maxBytes: number): { text: string; truncated: boolean } | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return { text: "", truncated: false };
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, length, start);
    return { text: buf.toString("utf-8"), truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** The last `maxBytes` of a JSONL file, split into whole lines; a first partial line is dropped. */
function readTailLines(path: string, maxBytes: number): string[] {
  const tail = readTailText(path, maxBytes);
  if (!tail) return [];
  const lines = tail.text.split("\n");
  if (tail.truncated) lines.shift();
  return lines.filter((line) => line.trim().length > 0);
}

/** Byte size of a file, or 0 when it is absent or unreadable. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Parse a small JSON object off disk, or null for every failure mode of the file. */
function readJsonObject(path: string, maxBytes: number): Record<string, unknown> | null {
  try {
    if (fileSize(path) > maxBytes) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A field of a `meta.json` that must be a string, or null. Never a coercion. */
const metaString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** `{ parentClaudeSessionId }` when there is one, else nothing — never the key with no value. */
const optionalParent = (id: string | null | undefined): { parentClaudeSessionId?: string } =>
  id ? { parentClaudeSessionId: id } : {};

/** A field of a `meta.json` that must be a finite number, or null. */
const metaNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const metaReason = (v: unknown): FailureReason | null =>
  typeof v === "string" && (FAILURE_REASONS as readonly string[]).includes(v)
    ? (v as FailureReason)
    : null;

/** The record's `type`, or null — the label of one `events.jsonl` line. */
function labelForLine(line: string): string | null {
  try {
    const v = JSON.parse(line) as { type?: unknown; subtype?: unknown };
    if (typeof v?.type !== "string") return null;
    return typeof v.subtype === "string" ? `${v.type}:${v.subtype}` : v.type;
  } catch {
    return null;
  }
}

/** A tail window with its first, partial line removed (unless it is one enormous line). */
function dropLeadingFragment(tail: { text: string; truncated: boolean }): string {
  if (!tail.truncated) return tail.text;
  const firstBreak = tail.text.indexOf("\n");
  return firstBreak === -1 ? tail.text : tail.text.slice(firstBreak + 1);
}

/** Tokens, cost and tool calls from a recovered session's `tokens.json` (the proxy's own file). */
function diskAccounting(sessionDir: string): {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  toolCalls: number;
} {
  const stats = readTokenStatsAt(join(sessionDir, "tokens.json"));
  return {
    tokensIn: stats?.billed_input_tokens ?? null,
    tokensOut: stats?.output_tokens ?? null,
    costUsd: typeof stats?.total_cost === "number" ? stats.total_cost : null,
    toolCalls: Array.isArray(stats?.tool_calls)
      ? stats.tool_calls.reduce((sum, t) => sum + (typeof t.count === "number" ? t.count : 0), 0)
      : 0,
  };
}

/** Whole seconds between an ISO start and an epoch-ms end, never negative and never NaN. */
function elapsedSecondsBetween(startedAt: string, endedAtMs: number): number {
  const seconds = Math.round((endedAtMs - Date.parse(startedAt)) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/** `outputBytes` for a recovered session: prose only, without our own `[claudish] …` notes. */
function diskProseBytes(
  tail: { text: string; truncated: boolean } | null,
  fileBytes: number
): number {
  if (!tail || tail.truncated) return fileBytes;
  const prose = tail.text
    .split("\n")
    .filter((line) => !line.startsWith(CLAUDISH_NOTE_PREFIX))
    .join("\n");
  return Buffer.byteLength(prose, "utf-8");
}

/** The screen of a session whose pane never spawned (§8 D, amended r2). */
function blankFinalCapture(): CaptureResult {
  return {
    seq: 0,
    cols: 160,
    rows: 50,
    cursor: { x: 0, y: 0 },
    lines: Array.from({ length: 50 }, () => ""),
    final: true,
  };
}

function unknownSession(sessionId: string): ContractErrorException {
  return new ContractErrorException(
    "unknown_session",
    `no session ${JSON.stringify(sessionId)} is held by this server`
  );
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private maxSessions: number;
  private scrollbackCapacity: number;
  private sessionsDir: string;
  private terminalRetentionMs: number;
  private onStateChange?: (sessionId: string, event: ChannelEvent) => void;
  private readonly parentEnv: Record<string, string | undefined>;
  private readonly paneTimings: SessionManagerOptions["paneTimings"];
  /** createSession calls past their checks whose entry is not in the map yet. */
  private starting = 0;
  /** Pane starts in flight; `shutdownAll` waits for them so no pane starts unsettled. */
  private readonly pendingStarts = new Set<Promise<void>>();
  private readonly _hostPid: number;
  private readonly _launcherPid: number | undefined;
  /** Team run record id → its `startedAt`, until `finishTeamRun` writes its end. */
  private readonly teamRunStarts = new Map<string, string>();
  /** Team run records whose end is on disk. The first `finishTeamRun` write to succeed wins. */
  private readonly settledTeamRuns = new Set<string>();

  constructor(options?: SessionManagerOptions) {
    // Computed once: the Claude Code process that launched this MCP server
    // does not change for the life of the process. See parent-proof.ts.
    const host =
      options?.hostPid !== undefined
        ? { hostPid: options.hostPid }
        : hostPidFrom(process.env, process.ppid);
    this._hostPid = host.hostPid;
    this._launcherPid = host.launcherPid;
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.scrollbackCapacity = options?.scrollbackCapacity ?? DEFAULT_SCROLLBACK;
    this.terminalRetentionMs = options?.terminalRetentionMs ?? TERMINAL_RETENTION_MS;
    // `$HOME` before `os.homedir()`, by the rule the plugin monitor shares —
    // see home-dir.ts. Diverging here makes every run invisible to it.
    this.sessionsDir = options?.sessionsDir ?? sessionsDirFrom(process.env);
    this.onStateChange = options?.onStateChange;
    this.parentEnv = options?.parentEnv ?? process.env;
    this.paneTimings = options?.paneTimings;
  }

  /** The Claude Code process that launched this MCP server (`spawn.json` `hostPid`). */
  get hostPid(): number {
    return this._hostPid;
  }

  /** The npm `node` launcher between Claude Code and this process, when there is one. */
  get launcherPid(): number | undefined {
    return this._launcherPid;
  }

  /**
   * Start the record of one `team(mode:"run")`: create
   * `<sessionsDir>/team-<8 hex>/` and write its `spawn.json` (`kind: "team"`).
   * Returns the record id.
   *
   * Called BEFORE `startModels`, so a run never starts unrecorded, and it
   * throws — failing the tool call before any child exists — when the record
   * cannot be written. The directory holds only `spawn.json` and, once the run
   * ends, `meta.json` (`finishTeamRun`). It is invisible to `list_sessions`
   * (in-memory only), and `loadDiskRecord` refuses its id, so no session tool
   * mistakes it for a session.
   */
  recordTeamRun(opts: { teamPath: string; slots: number; parentClaudeSessionId?: string }): string {
    mkdirSync(this.sessionsDir, { recursive: true });
    let id = "";
    let dir = "";
    // Non-recursive mkdir fails on an existing directory, so a collision of
    // two random 8-hex ids can never adopt someone else's record.
    for (let attempt = 0; ; attempt++) {
      id = `team-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      dir = join(this.sessionsDir, id);
      try {
        mkdirSync(dir);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST" || attempt >= 4) throw err;
      }
    }
    const startedAt = new Date().toISOString();
    this.writeSpawnRecord(dir, {
      kind: "team",
      sessionId: id,
      parentClaudeSessionId: opts.parentClaudeSessionId,
      startedAt,
      teamPath: resolve(opts.teamPath),
      slots: opts.slots,
    });
    this.teamRunStarts.set(id, startedAt);
    return id;
  }

  /**
   * End a team run's record: write `<record dir>/meta.json` atomically, at most
   * once.
   *
   * The first call whose write SUCCEEDS wins; a later call writes nothing and
   * reports one stderr line. A failed write does not count, so a retry can
   * still end the record. It NEVER throws: a write failure is reported on
   * stderr, so a caller's `catch` always rethrows its ORIGINAL error rather
   * than a disk error that masked it. A lost write leaves a record with no
   * end, which an observer reports from the writer's liveness — never a false
   * verdict.
   */
  finishTeamRun(record: string, outcome: TeamRunOutcome): void {
    if (this.settledTeamRuns.has(record)) {
      process.stderr.write(`[claudish] team run record ${record} already ended; ignoring\n`);
      return;
    }
    try {
      const dir = this.diskSessionDir(record);
      if (dir === null) throw new Error("not a record id");
      const completedAt = new Date().toISOString();
      const startedAt =
        this.teamRunStarts.get(record) ??
        metaString(readJsonObject(join(dir, "spawn.json"), META_READ_LIMIT)?.startedAt) ??
        completedAt;
      const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
      writeJsonAtomic(join(dir, "meta.json"), {
        kind: "team",
        status: outcome.status,
        startedAt,
        completedAt,
        elapsedSeconds: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs / 1000)) : 0,
        slots: outcome.slots,
        ok: outcome.ok,
        failed: outcome.failed,
        cancelled: outcome.cancelled,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      });
      // Only now: the end is on disk. `startedAt` stays for a retry until then.
      this.settledTeamRuns.add(record);
      this.teamRunStarts.delete(record);
    } catch (err) {
      process.stderr.write(
        `[claudish] could not write the end of team run record ${record}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  /**
   * Write `<dir>/spawn.json`, the start-time record, atomically (tmp + rename),
   * one key per line.
   *
   * Deliberately NOT wrapped in a `try`: a run that cannot be recorded must not
   * run unrecorded, so a failure here fails the tool call before any pane
   * exists. `hostPid`, `launcherPid` (only when the launcher branch produced
   * `hostPid`) and `mcpPid` — this process, the one that writes `meta.json` —
   * are filled in here; the caller supplies the rest.
   */
  private writeSpawnRecord(
    dir: string,
    record: {
      kind: "session" | "team";
      sessionId: string;
      parentClaudeSessionId?: string;
      startedAt: string;
      model?: string;
      timeoutSeconds?: number;
      claudeSessionId?: string;
      teamPath?: string;
      slots?: number;
    }
  ): void {
    const { kind, sessionId, parentClaudeSessionId, startedAt, ...rest } = record;
    const body = {
      schema: SPAWN_RECORD_SCHEMA,
      kind,
      sessionId,
      ...(parentClaudeSessionId ? { parentClaudeSessionId } : {}),
      hostPid: this._hostPid,
      ...(this._launcherPid !== undefined ? { launcherPid: this._launcherPid } : {}),
      mcpPid: process.pid,
      startedAt,
      ...rest,
    };
    writeJsonAtomic(join(dir, "spawn.json"), body);
  }

  /**
   * Create a session and start its pane. Resolves with the session id once the pane
   * exists (no boot wait): the session is STARTING then.
   *
   * Order (§4.2, §20.1): the checks; the magmux check; the pane reservation (a refused
   * session leaves no record); `prompt.md`; `spawn.json` (a failure releases the
   * reservation and fails the call); then the pane. A pane that fails to start leaves a
   * FAILED `pane_lost` session with a `meta.json`, and the call throws.
   */
  async createSession(opts: SessionCreateOptions): Promise<string> {
    if (this.activeSessions + this.starting >= this.maxSessions) {
      throw new Error(`Max sessions (${this.maxSessions}) reached`);
    }
    // A caller-supplied id must not be able to adopt or overwrite a live session.
    if (opts.sessionId !== undefined && this.sessions.has(opts.sessionId)) {
      throw new Error(`Session id already in use: ${opts.sessionId}`);
    }
    const flags = opts.claudishFlags ?? [];
    const flagCheck = checkChildFlags(flags);
    if (!flagCheck.ok) throw new Error(`invalid_args: ${flagCheck.message}`);
    const readAvailable = !flagsRemoveRead(flags);
    if (opts.prompt) {
      const refusal = deliveryRefusal(opts.prompt, readAvailable);
      if (refusal) throw new Error(`invalid_args: ${refusal}`);
    }
    const parentEnv = opts.parentEnv ?? this.parentEnv;

    // Counted from here, so concurrent creates cannot overshoot maxSessions while they
    // await the magmux check; from `sessions.set` on, the entry itself counts.
    this.starting++;
    let counted = true;
    const uncount = () => {
      if (counted) this.starting--;
      counted = false;
    };
    try {
      await assertMagmuxAvailable();
      reservePanes(1, sockRootFor(parentEnv));
      let entry: SessionEntry;
      try {
        entry = this.recordSession(opts);
      } catch (err) {
        releasePaneReservations(1);
        throw err;
      }
      this.sessions.set(entry.info.sessionId, entry);
      uncount();
      const started = this.startPane(entry, opts, { flags, readAvailable, parentEnv });
      const tracked = started.catch(() => undefined);
      this.pendingStarts.add(tracked);
      try {
        await started;
      } finally {
        this.pendingStarts.delete(tracked);
      }
      return entry.info.sessionId;
    } finally {
      uncount();
    }
  }

  /** `prompt.md`, `spawn.json` and the in-memory entry (STARTING). Throws before any pane. */
  private recordSession(opts: SessionCreateOptions): SessionEntry {
    const sessionId = opts.sessionId ?? randomUUID().slice(0, 8);
    // Minted here: it is the child's transcript basename, known BEFORE the pane starts.
    const claudeSessionId = randomUUID();
    // Normalised once, here, so `spawn.json`, `SessionInfo` and the pane's timer agree
    // on one value the plugin monitor accepts (an integer in 1..MAX_TIMEOUT).
    const timeout = normaliseTimeoutSeconds(opts.timeoutSeconds);
    const startedAt = new Date().toISOString();
    const sessionDir = opts.sessionDir ?? join(this.sessionsDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    if (opts.prompt) writeFileSync(join(sessionDir, "prompt.md"), opts.prompt, "utf-8");

    // The start-time record, BEFORE the pane and before every runtime file, so a
    // session never runs unrecorded. Throws rather than continue.
    this.writeSpawnRecord(sessionDir, {
      kind: "session",
      sessionId,
      parentClaudeSessionId: opts.parentClaudeSessionId,
      startedAt,
      model: opts.model,
      timeoutSeconds: timeout,
      claudeSessionId,
    });

    const cwd = opts.cwd ?? process.cwd();
    const parentEnv = opts.parentEnv ?? this.parentEnv;
    const spawnModel = opts.spawnModel ?? null;
    const tokenFile = opts.tokenFile ?? join(sessionDir, "tokens.json");
    return {
      info: {
        sessionId,
        model: opts.model,
        spawnModel,
        provider: resolveProvider({ model: opts.model, spawnModel, tokenFile: null }),
        state: "STARTING",
        shape: opts.prompt ? "one-shot" : "interactive",
        pane: null,
        panePid: null,
        startedAt,
        completedAt: null,
        exitCode: null,
        turnsCompleted: 0,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        toolCalls: 0,
        lastActivityAt: null,
        elapsedSeconds: 0,
        idleSeconds: null,
        activity: null,
        reason: null,
        detail: null,
        pendingInputs: opts.prompt ? 1 : 0,
        claudeSessionId,
        transcriptPath: transcriptPathFor(cwd, claudeSessionId, projectsDir(parentEnv)),
        // Present only when proven, so `meta.json` carries the key exactly when
        // `spawn.json` does, with the same value.
        ...optionalParent(opts.parentClaudeSessionId),
        captureSource: null,
        turnSource: "transcript",
        timeoutSeconds: timeout,
      },
      session: null,
      scrollback: new ScrollbackBuffer(this.scrollbackCapacity),
      outputLogStream: createWriteStream(join(sessionDir, "output.log")),
      sessionDir,
      cwd,
      tokenFile,
      eventLogPath: join(sessionDir, "events.jsonl"),
      eventLogBytes: 0,
      upstreamErrorLogPath: join(sessionDir, "upstream-errors.jsonl"),
      eventRing: [],
      proseBytes: 0,
      answeredTurns: new Set(),
      waitLogPath: join(sessionDir, "waits.jsonl"),
      waitLogBytes: 0,
      waitSince: null,
      ended: false,
      evictHandle: null,
      lastEvent: "starting",
      lastFrameTool: null,
      lastFrameToolCount: 0,
      lastToolFrameAt: 0,
      lastLoggedTool: null,
      assistantIdsLogged: 0,
      anomaliesLogged: new Set(),
      sendRejectedSeen: 0,
      pendingMeta: {},
      blockText: null,
    };
  }

  /** Start the entry's pane. A throw ends the record FAILED `pane_lost` and is rethrown. */
  private async startPane(
    entry: SessionEntry,
    opts: SessionCreateOptions,
    p: { flags: string[]; readAvailable: boolean; parentEnv: Record<string, string | undefined> }
  ): Promise<void> {
    const info = entry.info;
    const paneOpts: PaneSessionOptions = {
      kind: "s",
      label: info.sessionId,
      callerFlags: p.flags,
      spawnModel: info.spawnModel ?? info.model,
      cwd: entry.cwd,
      sessionUuid: info.claudeSessionId,
      transcriptPath: info.transcriptPath,
      slotEnv: {
        // The child's token tracker writes to a path WE own: tokens, cost and tool
        // counts come from the proxy, never from anything the child prints.
        [ENV.CLAUDISH_TOKEN_FILE]: entry.tokenFile,
        // Per session, unconditionally: the records carry no session id, so a shared
        // path would interleave concurrent sessions into one unattributable file.
        [UPSTREAM_ERROR_LOG_ENV]: entry.upstreamErrorLogPath,
      },
      shape: info.shape,
      ...(opts.prompt ? { initialPrompt: opts.prompt } : {}),
      readAvailable: p.readAvailable,
      decide: (turn) => this.decide(entry, turn),
      onBlocked: (b) => this.onBlocked(entry, b),
      timeoutMs: info.timeoutSeconds * 1000,
      onChange: (snap) => this.onPaneChange(entry, snap),
      onTransition: (t) => this.onPaneTransition(entry, t),
      parentEnv: p.parentEnv,
      ...(this.paneTimings ? { timings: this.paneTimings } : {}),
    };
    try {
      entry.session = await startPaneSession(paneOpts);
    } catch (err) {
      this.failNeverSpawned(entry, err);
      throw err;
    }
    if (!entry.ended) this.applySnapshot(entry, entry.session.snapshot());
  }

  /** A session whose pane never started: FAILED `pane_lost`, its records ended. */
  private failNeverSpawned(entry: SessionEntry, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const at = new Date().toISOString();
    const info = entry.info;
    info.state = "FAILED";
    info.reason = "pane_lost";
    info.detail = `the pane never started: ${msg}`;
    info.completedAt = at;
    info.pendingInputs = 0;
    info.elapsedSeconds = elapsedSecondsBetween(info.startedAt, Date.parse(at));
    this.appendEvent(entry, { type: "state", from: "STARTING", to: "FAILED", at });
    this.endRecords(entry, null);
    this.emitFrame(entry, { state: "FAILED", activity: null, toolCalls: 0 });
  }

  // ─── Pane policy (D8) ──────────────────────────────────────────────────

  /** The verdict of a settled turn: one-shot → classified; interactive → continue (D20). */
  private decide(entry: SessionEntry, turn: SettledTurn): FinalVerdict | "continue" {
    this.appendAnswer(entry, turn.index, turn.answer);
    // The pane's shape at the settle, not entry.info's copy: a send_input whose own step
    // settles the turn has converted the session before sendInput could update the copy.
    if (turn.shape === "one-shot") {
      const v = classifyRunOutput({
        answer: turn.answer,
        apiError: turn.apiError,
        stopReason: turn.stopReason,
        promptRead: turn.delivery,
        minOutputBytes: 0,
      });
      if (v) return { state: v.state, reason: v.reason, detail: v.detail };
      return turn.stopReason === "max_tokens"
        ? { state: "COMPLETED", detail: TRUNCATION_NOTE }
        : { state: "COMPLETED" };
    }
    if (turn.apiError) {
      const v = classifyRunOutput({ answer: turn.answer, apiError: turn.apiError });
      return { state: "FAILED", reason: "api_error", detail: v?.detail ?? "API error" };
    }
    // An interactive turn whose task file was not fully read continues; the caller is
    // told on the next frame (r2, X-M4).
    if (turn.delivery.complete === false) {
      entry.pendingMeta.prompt_not_read = "true";
      this.appendEvent(entry, {
        type: "anomaly",
        key: "prompt_not_read",
        turn: turn.index,
        linesRead: turn.delivery.linesRead,
        linesTotal: turn.delivery.linesTotal,
        at: new Date().toISOString(),
      });
    }
    return "continue";
  }

  /** A question or a permission dialog waits for `send_input` (the channel can answer). */
  private onBlocked(entry: SessionEntry, b: PaneBlock): "wait" {
    entry.blockText = b.text;
    return "wait";
  }

  // ─── Pane callbacks ────────────────────────────────────────────────────

  /** `onTransition`: every wire-state change, synchronously, before any frame. */
  private onPaneTransition(
    entry: SessionEntry,
    t: { from: SlotState; to: SlotState; at: string; snap: PaneSnapshot }
  ): void {
    if (entry.ended) return;
    const { snap } = t;
    this.applySnapshot(entry, snap);
    // Before the frame, so the wait line is on disk by the time anyone hears of it.
    this.recordWaitTransition(entry, t.from, t.to, t.at, snap);
    this.appendEvent(entry, { type: "state", from: t.from, to: t.to, at: t.at });
    this.logPaneFacts(entry, snap);
    if (!isWaiting(t.to)) entry.blockText = null;
    if (isTerminalState(t.to)) this.onTerminal(entry, snap);
    this.emitFrame(entry, snap);
  }

  /** `onChange` (coalesced): activity and accounting changes within a state. */
  private onPaneChange(entry: SessionEntry, snap: PaneSnapshot): void {
    if (entry.ended) return;
    this.applySnapshot(entry, snap);
    this.logPaneFacts(entry, snap);
    this.emitFrame(entry, snap);
  }

  /** The terminal transition: answer, records and eviction, before the reap starts. */
  private onTerminal(entry: SessionEntry, snap: PaneSnapshot): void {
    const session = entry.session;
    // A turn that ended without a settle (cancel, timeout, child exit) still shows the
    // answer it had produced.
    const index = snap.turnsCompleted + 1;
    if (session && !entry.answeredTurns.has(index)) {
      const partial = session.turnAnswer(index);
      if (partial) this.appendAnswer(entry, index, partial);
    }
    if (snap.state !== "COMPLETED") {
      const why = snap.reason ?? snap.state.toLowerCase();
      this.recordNote(
        entry,
        `\n[claudish] ${snap.state} ${why}${snap.detail ? `: ${snap.detail}` : ""}\n`
      );
    }
    const screen = session ? (session.capture() as CaptureResult).lines : null;
    this.endRecords(entry, screen);
  }

  /** Close `output.log`, write `screen.txt` and `meta.json`, schedule eviction. Once. */
  private endRecords(entry: SessionEntry, screenLines: string[] | null): void {
    if (entry.ended) return;
    entry.ended = true;
    entry.outputLogStream?.end();
    entry.outputLogStream = null;
    if (screenLines) {
      try {
        const text = screenLines.join("\n").replace(/\s+$/, "");
        writeFileSync(join(entry.sessionDir, "screen.txt"), `${redactSecrets(text)}\n`, "utf-8");
      } catch {
        /* diagnostics are never load-bearing */
      }
    }
    // A wait can only be open here when the session ended in a step that also left the
    // waiting state; recordWaitTransition closed it. Belt and braces for the never-
    // spawned path, which has no transition.
    if (entry.waitSince !== null) {
      this.appendWait(entry, {
        wait: "closed",
        since: entry.waitSince,
        at: entry.info.completedAt ?? new Date().toISOString(),
        to: channelEventFor(entry.info).event,
      });
      entry.waitSince = null;
    }
    try {
      writeFileSync(
        join(entry.sessionDir, "meta.json"),
        JSON.stringify(toMetaRecord(entry.info, entry.cwd), null, 2),
        "utf-8"
      );
    } catch (err) {
      process.stderr.write(
        `[claudish] session ${entry.info.sessionId}: could not write meta.json: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    this.scheduleEviction(entry);
  }

  /** Copy a pane snapshot (and the proxy's token file) into the session's info. */
  private applySnapshot(entry: SessionEntry, snap: PaneSnapshot): void {
    const info = entry.info;
    const acct: Accounting = mergeAccounting(snap, readTokenFileCached(entry.tokenFile), {
      model: info.model,
      spawnModel: info.spawnModel,
    });
    info.state = snap.state;
    info.shape = snap.shape;
    info.pane = snap.paneId || null;
    info.panePid = snap.panePid;
    info.completedAt = snap.endedAt;
    info.exitCode = snap.exitCode;
    info.turnsCompleted = snap.turnsCompleted;
    info.tokensIn = acct.tokensIn;
    info.tokensOut = acct.tokensOut;
    info.costUsd = acct.costUsd;
    info.toolCalls = acct.toolCalls;
    info.provider = acct.provider ?? info.provider;
    info.lastActivityAt = snap.lastActivityAt;
    info.idleSeconds = snap.idleSeconds;
    info.activity = snap.activity;
    info.reason = snap.reason;
    info.detail = snap.detail;
    info.pendingInputs = snap.pendingInputs;
    info.captureSource = snap.captureSource;
    info.turnSource = snap.turnSource;
    info.elapsedSeconds = elapsedSecondsBetween(
      info.startedAt,
      snap.endedAt ? Date.parse(snap.endedAt) : Date.now()
    );
  }

  /** `events.jsonl`: new assistant message ids, tool changes, new anomalies. */
  private logPaneFacts(entry: SessionEntry, snap: PaneSnapshot): void {
    const at = new Date().toISOString();
    const ids = entry.session?.assistantMessageIds() ?? [];
    for (; entry.assistantIdsLogged < ids.length; entry.assistantIdsLogged++) {
      this.appendEvent(entry, {
        type: "assistant",
        message: { id: ids[entry.assistantIdsLogged] },
        at,
      });
    }
    const { tool } = channelEventFor(snap);
    if (tool && tool !== entry.lastLoggedTool)
      this.appendEvent(entry, { type: "tool", name: tool, at });
    entry.lastLoggedTool = tool;
    for (const a of snap.anomalies) {
      const key = anomalyKey(a);
      if (entry.anomaliesLogged.has(key)) continue;
      entry.anomaliesLogged.add(key);
      this.appendEvent(entry, { type: "anomaly", key, at });
    }
    const rejected = anomalyCount(snap.anomalies, "send_not_accepted");
    if (rejected > entry.sendRejectedSeen) {
      entry.sendRejectedSeen = rejected;
      entry.pendingMeta.send_rejected = "true";
    }
  }

  /**
   * One channel frame when the derived event changes, plus a coalesced `tool_executing`
   * repeat (≤ 1 frame/s) when the tool or the tool count changes.
   */
  private emitFrame(
    entry: SessionEntry,
    snap: Pick<PaneSnapshot, "state" | "activity" | "toolCalls">
  ): void {
    const { event, tool } = channelEventFor(snap);
    const now = Date.now();
    const changed = event !== entry.lastEvent;
    const toolRepeat =
      !changed &&
      event === "tool_executing" &&
      (tool !== entry.lastFrameTool || snap.toolCalls !== entry.lastFrameToolCount) &&
      now - entry.lastToolFrameAt >= 1000;
    if (!changed && !toolRepeat) return;
    entry.lastEvent = event;
    if (event === "tool_executing") {
      entry.lastFrameTool = tool;
      entry.lastFrameToolCount = snap.toolCalls;
      entry.lastToolFrameAt = now;
    }
    const extraMeta: Record<string, string> = {
      ...(tool ? { tool, tool_count: String(snap.toolCalls) } : {}),
      ...(snap.activity ? { activity: snap.activity } : {}),
      ...entry.pendingMeta,
    };
    entry.pendingMeta = {};
    try {
      this.onStateChange?.(entry.info.sessionId, {
        type: event,
        model: entry.info.model,
        content: this.frameContent(entry, event, tool),
        elapsedSeconds: entry.info.elapsedSeconds,
        createdAt: entry.info.startedAt,
        extraMeta,
      });
    } catch {
      // a notification consumer must never break the session
    }
  }

  private frameContent(entry: SessionEntry, event: ChannelEventType, tool: string | null): string {
    const info = entry.info;
    switch (event) {
      case "running":
        return "The turn is running.";
      case "tool_executing":
        return `Using ${tool}.`;
      case "waiting_for_input":
        return entry.blockText
          ? `The model asked a question; send_input declines it and becomes the next prompt.\n${entry.blockText}`
          : "The turn finished; waiting for send_input.";
      case "awaiting_permission":
        return `A permission dialog is open for ${info.activity ?? "a tool"}; send_input declines it and becomes the next prompt.${entry.blockText ? `\n${entry.blockText}` : ""}`;
      case "completed":
        return `Session completed (${info.turnsCompleted} turn(s)). Call get_output for the answer.`;
      case "cancelled":
        return "Session cancelled.";
      case "timeout":
        return `Timeout after ${info.timeoutSeconds}s; the pane was closed.`;
      case "failed":
        return `${info.state} ${info.reason ?? ""}${info.detail ? `: ${info.detail}` : ""}`.trim();
      default:
        return "";
    }
  }

  // ─── Public verbs ──────────────────────────────────────────────────────

  /**
   * Send a turn (D17): accepted in every non-terminal state and queued until the session
   * is idle; during a question or a permission dialog the dialog is declined with Esc and
   * the text becomes the next prompt. Any accepted send converts a one-shot session to
   * interactive. A disk-recovered or unknown session answers `unknown_session`.
   */
  sendInput(sessionId: string, text: string): SendInputResult {
    const entry = this.liveEntry(sessionId);
    if (!entry) return { success: false, reason: "unknown_session", state: null };
    if (!entry.session) return { success: false, reason: "terminal", state: entry.info.state };
    const r = entry.session.send(text);
    if (!r.ok) return { success: false, reason: r.reason, state: entry.session.snapshot().state };
    entry.info.shape = "interactive";
    this.applySnapshot(entry, entry.session.snapshot());
    return { success: true, queued: r.queued };
  }

  /** Answer prose. Falls back to `<sessionsDir>/<id>/output.log` for a session not in memory. */
  getOutput(sessionId: string, tailLines?: number): SessionOutput {
    const entry = this.sessions.get(sessionId);
    if (!entry) return this.diskOutput(this.requireDiskRecord(sessionId), tailLines);
    this.refresh(entry);
    const info = entry.info;
    return {
      sessionId,
      state: info.state,
      output: entry.scrollback.getLines(tailLines).join("\n"),
      totalLines: entry.scrollback.totalLines,
      turnsCompleted: info.turnsCompleted,
      tokensIn: info.tokensIn,
      tokensOut: info.tokensOut,
      elapsedSeconds: info.elapsedSeconds,
      idleSeconds: isTerminalState(info.state) ? null : info.idleSeconds,
    };
  }

  /**
   * Everything a post-mortem needs, from the API rather than the filesystem. Falls back
   * to the session directory for a session not in memory — the restart case is the one
   * this exists for.
   */
  getDiagnostics(sessionId: string, eventLimit = DEFAULT_EVENT_LIMIT): SessionDiagnostics {
    const limit = Math.max(0, Math.min(Math.trunc(eventLimit) || 0, EVENT_RING_SIZE));
    const entry = this.sessions.get(sessionId);
    if (!entry) return this.diskDiagnostics(this.requireDiskRecord(sessionId), limit);
    this.refresh(entry);
    const info = entry.info;
    return {
      sessionId,
      state: info.state,
      event: channelEventFor(info).event,
      reason: isTerminalState(info.state) && info.state !== "COMPLETED" ? info.reason : null,
      detail: info.detail,
      // The resolved chain, both halves: what the caller asked for, and the pinned
      // `provider@model` the child was actually spawned with.
      model: info.model,
      spawnModel: info.spawnModel,
      provider: info.provider,
      shape: info.shape,
      exitCode: info.exitCode,
      // Silence, reported not judged.
      idleSeconds: isTerminalState(info.state) ? null : info.idleSeconds,
      elapsedSeconds: info.elapsedSeconds,
      timeoutSeconds: info.timeoutSeconds,
      outputBytes: entry.proseBytes,
      turnsCompleted: info.turnsCompleted,
      tokensIn: info.tokensIn,
      tokensOut: info.tokensOut,
      costUsd: info.costUsd,
      toolCalls: info.toolCalls,
      pendingInputs: info.pendingInputs,
      pane: info.pane,
      captureSource: info.captureSource,
      turnSource: info.turnSource,
      ...this.paneFacts(entry),
      recentEvents: limit === 0 ? [] : entry.eventRing.slice(-limit),
      eventsTotal: entry.eventRing.length,
      upstreamErrors: readTailLines(entry.upstreamErrorLogPath, UPSTREAM_ERROR_TAIL_BYTES),
      claudeSessionId: info.claudeSessionId,
      transcriptPath: info.transcriptPath,
      sessionDir: entry.sessionDir,
      eventLogPath: entry.eventLogPath,
      upstreamErrorLogPath: entry.upstreamErrorLogPath,
    };
  }

  /** The `get_diagnostics` fields only a pane can answer; their "no pane" values otherwise. */
  private paneFacts(
    entry: SessionEntry
  ): Pick<
    SessionDiagnostics,
    | "phase"
    | "connected"
    | "screenTail"
    | "sockPath"
    | "magmuxStderr"
    | "preambleBytes"
    | "readCoverage"
    | "claudeCodeVersion"
    | "anomalies"
  > {
    const session = entry.session;
    if (!session)
      return {
        phase: null,
        connected: false,
        screenTail: "",
        sockPath: null,
        magmuxStderr: "",
        preambleBytes: 0,
        readCoverage: null,
        claudeCodeVersion: null,
        anomalies: entry.info.detail ? [entry.info.detail] : [],
      };
    const snap = session.snapshot();
    const pane = session.diagnostics();
    return {
      phase: snap.phase,
      connected: snap.connected,
      screenTail: redactSecrets(snap.screenTail),
      sockPath: session.sockPath,
      magmuxStderr: redactSecrets(pane.magmuxStderr),
      preambleBytes: pane.preambleBytes,
      readCoverage: pane.readCoverage,
      claudeCodeVersion: snap.claudeCodeVersion,
      anomalies: snap.anomalies,
    };
  }

  /**
   * Stop a session (§8 C): synchronous transition, asynchronous reap. Idempotent: a
   * second call returns the same state with `changed:false`. Throws
   * `ContractErrorException("unknown_session")` for a session this server does not hold.
   */
  cancelSession(sessionId: string): SessionCancelResult {
    const entry = this.liveEntry(sessionId);
    if (!entry) throw unknownSession(sessionId);
    if (!entry.session) return { session_id: sessionId, state: entry.info.state, changed: false };
    const r = entry.session.cancel();
    return { session_id: sessionId, state: r.state, changed: r.changed };
  }

  /**
   * The session's screen (§8 D): a memory read. `CaptureUnchanged` when `sinceSeq`
   * equals the current seq. A session whose pane never started answers a blank final
   * screen. Throws `ContractErrorException("unknown_session")` once it is not retained.
   */
  captureSession(
    sessionId: string,
    sinceSeq?: number,
    spans?: boolean
  ): CaptureResult | CaptureUnchanged {
    const entry = this.liveEntry(sessionId);
    if (!entry) throw unknownSession(sessionId);
    if (!entry.session)
      return sinceSeq === 0 ? { unchanged: true, seq: 0, final: true } : blankFinalCapture();
    return entry.session.capture(sinceSeq, { spans: spans === true });
  }

  /**
   * Sessions this process holds. IN-MEMORY ONLY, deliberately: session ids carry no
   * ordering, and the sessions directory only grows (≈ 10 000 entries measured), so a
   * directory scan is either slow or a sample. Recovery is id-addressed and O(1).
   */
  listSessions(includeCompleted = false): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    for (const entry of this.sessions.values()) {
      this.refresh(entry);
      if (!includeCompleted && isTerminalState(entry.info.state)) continue;
      sessions.push({ ...entry.info });
    }
    return sessions;
  }

  /** `list_sessions` rows (§8 B). */
  listSessionRows(includeCompleted = false): SessionRow[] {
    return this.listSessions(includeCompleted).map(sessionRowOf);
  }

  /** A single session's info; falls back to `<sessionsDir>/<id>/meta.json`. */
  getSession(sessionId: string): SessionInfo {
    const entry = this.sessions.get(sessionId);
    if (!entry) return this.requireDiskRecord(sessionId).info;
    this.refresh(entry);
    return { ...entry.info };
  }

  /**
   * Settle every live session CANCELLED (process shutdown): each closes its open wait
   * (`to:"cancelled"`) and writes its `meta.json` on that transition, before this
   * resolves. The pane registry's `reapAllPanes` does the killing; a test that wants the
   * panes gone awaits its own no-orphan check.
   */
  async shutdownAll(): Promise<void> {
    // A pane still starting would otherwise be skipped here and run on unsettled.
    await Promise.all([...this.pendingStarts]);
    const pending: Promise<unknown>[] = [];
    for (const entry of this.sessions.values()) {
      const session = entry.session;
      if (!session) continue;
      if (!isTerminalState(session.snapshot().state)) session.cancel();
      pending.push(session.terminal.catch(() => undefined));
    }
    await Promise.all(pending);
  }

  // ─── Internal: the read-only disk fallback ───────────────────────────────

  /**
   * The LIVE entry for a session, or undefined. Never consults the disk: a recovered
   * record describes a process that is GONE, so `sendInput`, `cancelSession` and
   * `captureSession` go through here and the three readers do not.
   */
  private liveEntry(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /** A disk record for `sessionId`, or the same `not found` an unknown id always got. */
  private requireDiskRecord(sessionId: string): DiskRecord {
    const record = this.loadDiskRecord(sessionId);
    if (!record) throw new Error(`Session ${sessionId} not found`);
    return record;
  }

  /**
   * `<sessionsDir>/<id>`, or null when the id is not something we will join onto a
   * path: the allowlist, then a containment check.
   */
  private diskSessionDir(sessionId: string): string | null {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    const root = resolve(this.sessionsDir);
    const dir = resolve(root, sessionId);
    if (dir !== join(root, sessionId)) return null;
    if (!dir.startsWith(root + sep)) return null;
    return dir;
  }

  /**
   * Rebuild a `SessionInfo` from `<sessionsDir>/<id>/`, reading both `meta.json`
   * generations. Every field is validated, never coerced; nothing here throws.
   */
  private loadDiskRecord(sessionId: string): DiskRecord | null {
    const sessionDir = this.diskSessionDir(sessionId);
    if (sessionDir === null) return null;

    let dirMtimeMs: number;
    try {
      const stat = statSync(sessionDir);
      if (!stat.isDirectory()) return null;
      dirMtimeMs = stat.mtimeMs;
    } catch {
      return null;
    }

    // A team run's record lives in the same directory (`team-<8 hex>/`) and its id
    // passes SESSION_ID_RE, but it is not a session; an id-addressed tool answers a
    // team id exactly like an unknown id.
    const spawnRecord = readJsonObject(join(sessionDir, "spawn.json"), META_READ_LIMIT);
    if (spawnRecord?.kind === "team") return null;
    const meta = readJsonObject(join(sessionDir, "meta.json"), META_READ_LIMIT);
    if (meta?.kind === "team") return null;
    const partial = meta === null;
    const measured = diskAccounting(sessionDir);

    const transcriptPath = this.diskTranscriptPath(
      meta,
      metaString(meta?.claudeSessionId) ?? metaString(spawnRecord?.claudeSessionId) ?? ""
    );
    return {
      sessionDir,
      partial,
      info: diskInfo({ sessionId, meta, spawnRecord, measured, dirMtimeMs, transcriptPath }),
    };
  }

  /**
   * The recorded transcript path, re-derived from `claudeSessionId` + the recorded cwd
   * when the stored one does not exist (F1 window, §3.3). A 10.4.0 record carries no
   * cwd, so its stored path is returned as is.
   */
  private diskTranscriptPath(meta: Record<string, unknown> | null, uuid: string): string {
    const stored = metaString(meta?.transcriptPath) ?? "";
    const cwd = metaString(meta?.cwd);
    if (stored && existsSync(stored)) return stored;
    if (cwd && uuid) return transcriptPathFor(cwd, uuid, projectsDir(this.parentEnv));
    return stored;
  }

  /** `getOutput` for a recovered session, replayed through a real `ScrollbackBuffer`. */
  private diskOutput(record: DiskRecord, tailLines?: number): SessionOutput {
    const tail = readTailText(join(record.sessionDir, "output.log"), OUTPUT_TAIL_BYTES);
    const buffer = new ScrollbackBuffer(this.scrollbackCapacity);
    if (tail?.text) buffer.append(dropLeadingFragment(tail));
    const info = record.info;
    return {
      sessionId: info.sessionId,
      state: info.state,
      output: buffer.getLines(tailLines).join("\n"),
      totalLines: buffer.totalLines,
      turnsCompleted: info.turnsCompleted,
      tokensIn: info.tokensIn,
      tokensOut: info.tokensOut,
      elapsedSeconds: info.elapsedSeconds,
      idleSeconds: null,
    };
  }

  /**
   * `getDiagnostics` for a recovered session. What died with the process says so rather
   * than guessing: no phase, no live connection, `at:""` on an event line without one,
   * and the one anomaly that CAN be observed from disk — a record with no `meta.json`.
   */
  private diskDiagnostics(record: DiskRecord, limit: number): SessionDiagnostics {
    const { sessionDir, info } = record;
    const eventLogPath = join(sessionDir, "events.jsonl");
    const upstreamErrorLogPath = join(sessionDir, "upstream-errors.jsonl");
    const outputLogPath = join(sessionDir, "output.log");
    const events = readTailLines(eventLogPath, EVENT_TAIL_BYTES);
    const outputTail = readTailText(outputLogPath, OUTPUT_TAIL_BYTES);
    const screen = readTailText(join(sessionDir, "screen.txt"), SCREEN_READ_BYTES);
    return {
      sessionId: info.sessionId,
      state: info.state,
      event: channelEventFor(info).event,
      reason: info.reason,
      detail: info.detail,
      model: info.model,
      spawnModel: info.spawnModel,
      provider: info.provider,
      shape: info.shape,
      phase: null,
      exitCode: info.exitCode,
      idleSeconds: null,
      elapsedSeconds: info.elapsedSeconds,
      timeoutSeconds: info.timeoutSeconds,
      outputBytes: diskProseBytes(outputTail, fileSize(outputLogPath)),
      turnsCompleted: info.turnsCompleted,
      tokensIn: info.tokensIn,
      tokensOut: info.tokensOut,
      costUsd: info.costUsd,
      toolCalls: info.toolCalls,
      pendingInputs: 0,
      connected: false,
      screenTail: redactSecrets(screen?.text ?? "").trimEnd(),
      pane: info.pane,
      sockPath: null,
      magmuxStderr: "",
      captureSource: info.captureSource,
      turnSource: info.turnSource,
      preambleBytes: 0,
      readCoverage: null,
      claudeCodeVersion: null,
      anomalies: record.partial
        ? [
            `no readable meta.json in ${sessionDir} — this record was reconstructed from ` +
              "the remaining artifacts, so state, exit code and timings are unknown. The " +
              "session's process died before it could write a verdict.",
          ]
        : [],
      recentEvents:
        limit === 0
          ? []
          : events.slice(-limit).map((line) => {
              // Redacted on the READ path too: a log from an older build was not.
              const redacted = redactSecrets(line);
              const truncated = redacted.length > EVENT_PREVIEW_CHARS;
              let at = "";
              try {
                const parsed = JSON.parse(line) as { at?: unknown };
                if (typeof parsed?.at === "string") at = parsed.at;
              } catch {
                /* not ours */
              }
              return {
                at,
                label: labelForLine(line),
                preview: truncated ? redacted.slice(0, EVENT_PREVIEW_CHARS) : redacted,
                truncated,
              };
            }),
      eventsTotal: events.length,
      upstreamErrors: readTailLines(upstreamErrorLogPath, UPSTREAM_ERROR_TAIL_BYTES),
      claudeSessionId: info.claudeSessionId || null,
      transcriptPath: info.transcriptPath || null,
      sessionDir,
      eventLogPath,
      upstreamErrorLogPath,
    };
  }

  // ─── Internal ────────────────────────────────────────────────────────

  /** Refresh a live entry's info from its pane (a memory read plus a cached token file). */
  private refresh(entry: SessionEntry): void {
    if (entry.session && !entry.ended) this.applySnapshot(entry, entry.session.snapshot());
    else if (!isTerminalState(entry.info.state))
      entry.info.elapsedSeconds = elapsedSecondsBetween(entry.info.startedAt, Date.now());
  }

  /** A settled turn's answer → scrollback, `output.log` and `outputBytes`. Once per turn. */
  private appendAnswer(entry: SessionEntry, index: number, answer: string): void {
    if (entry.answeredTurns.has(index)) return;
    entry.answeredTurns.add(index);
    if (!answer) return;
    const text = answer.endsWith("\n") ? answer : `${answer}\n`;
    entry.proseBytes += Buffer.byteLength(answer, "utf-8");
    this.appendToOutput(entry, text);
  }

  /**
   * Append a `[claudish] …` annotation of OUR OWN to the output. Not counted in
   * `outputBytes`: that metric is what the CHILD produced.
   */
  private recordNote(entry: SessionEntry, note: string): void {
    this.appendToOutput(entry, note);
  }

  private appendToOutput(entry: SessionEntry, text: string): void {
    entry.scrollback.append(text);
    entry.outputLogStream?.write(text);
  }

  /** One event record: into the in-memory ring AND onto `events.jsonl`, redacted once. */
  private appendEvent(entry: SessionEntry, record: Record<string, unknown>): void {
    const line = JSON.stringify(record);
    const redacted = redactSecrets(line);
    const truncated = redacted.length > EVENT_PREVIEW_CHARS;
    entry.eventRing.push({
      at: typeof record.at === "string" ? record.at : new Date().toISOString(),
      label: typeof record.type === "string" ? record.type : null,
      preview: truncated ? redacted.slice(0, EVENT_PREVIEW_CHARS) : redacted,
      truncated,
    });
    if (entry.eventRing.length > EVENT_RING_SIZE) entry.eventRing.shift();
    if (entry.eventLogBytes >= EVENT_LOG_LIMIT) return;
    const payload = `${redacted}\n`;
    entry.eventLogBytes += Buffer.byteLength(payload, "utf-8");
    const capped = entry.eventLogBytes >= EVENT_LOG_LIMIT;
    try {
      appendFileSync(
        entry.eventLogPath,
        capped
          ? `${payload}{"type":"claudish_truncated","limit_bytes":${EVENT_LOG_LIMIT}}\n`
          : payload
      );
    } catch {
      /* diagnostics are never load-bearing */
    }
  }

  /**
   * The wait log's two hooks (§20.1): one `open` line when the wire state enters
   * AWAITING_INPUT or AWAITING_PERMISSION, one `closed` line when it leaves both. Driven
   * by the pane's `onTransition`, which reports the NET change of one step, so a turn
   * that settles with a send queued (RUNNING → IDLE → ADMITTING) opens no wait. The
   * phase table has no wait-to-wait edge, so `to` is never `waiting_for_input`.
   */
  private recordWaitTransition(
    entry: SessionEntry,
    from: SlotState,
    to: SlotState,
    at: string,
    snap: PaneSnapshot
  ): void {
    const was = isWaiting(from);
    const is = isWaiting(to);
    if (!was && is) {
      entry.waitSince = at;
      this.appendWait(entry, { wait: "open", since: at, turns: snap.turnsCompleted });
      return;
    }
    if (was && !is) {
      this.appendWait(entry, {
        wait: "closed",
        since: entry.waitSince ?? at,
        at,
        to: channelEventFor(snap).event,
      });
      entry.waitSince = null;
    }
  }

  /**
   * Append one line to `waits.jsonl`. Durable on purpose: a wait can open and close
   * between two reads of any observer. One `appendFileSync` of under 200 bytes per line;
   * a write failure loses only that line. The log stops at WAIT_LOG_LIMIT.
   */
  private appendWait(
    entry: SessionEntry,
    line:
      | { wait: "open"; since: string; turns: number }
      | { wait: "closed"; since: string; at: string; to: ChannelEventType }
  ): void {
    if (entry.waitLogBytes >= WAIT_LOG_LIMIT) return;
    const payload = `${JSON.stringify(line)}\n`;
    entry.waitLogBytes += Buffer.byteLength(payload, "utf-8");
    try {
      appendFileSync(entry.waitLogPath, payload);
    } catch (err) {
      process.stderr.write(
        `[claudish] session ${entry.info.sessionId}: could not append to waits.jsonl: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  /** Drop a terminal session from the map after its retention window (memory only). */
  private scheduleEviction(entry: SessionEntry): void {
    if (entry.evictHandle) return;
    entry.evictHandle = setTimeout(() => {
      this.sessions.delete(entry.info.sessionId);
    }, this.terminalRetentionMs);
    // Never a reason for the MCP server to stay alive.
    entry.evictHandle.unref?.();
    this.evictOldestTerminal();
  }

  /** Enforce the hard ceiling, oldest terminal session first. */
  private evictOldestTerminal(): void {
    const terminal = [...this.sessions.values()].filter((c) => c.ended);
    if (terminal.length <= MAX_TERMINAL_SESSIONS) return;
    terminal.sort((a, b) => (a.info.completedAt ?? "").localeCompare(b.info.completedAt ?? ""));
    for (const victim of terminal.slice(0, terminal.length - MAX_TERMINAL_SESSIONS)) {
      if (victim.evictHandle) clearTimeout(victim.evictHandle);
      this.sessions.delete(victim.info.sessionId);
    }
  }

  private get activeSessions(): number {
    let count = 0;
    for (const entry of this.sessions.values()) if (!entry.ended) count++;
    return count;
  }
}

function isWaiting(s: SlotState): boolean {
  return s === "AWAITING_INPUT" || s === "AWAITING_PERMISSION";
}

/**
 * The state and reason of a disk record, from either `meta.json` generation: the pane
 * generation's `state` (a closed-set value) and `terminalReason` (a `FailureReason`), or
 * 10.4.0's `status`. A non-terminal or unknown value — and a missing record — reads
 * FAILED with reason null (§8 B).
 */
function diskState(meta: Record<string, unknown> | null): {
  state: SlotState;
  reason: FailureReason | null;
} {
  const raw = meta?.state;
  if (typeof raw === "string" && (SLOT_STATES as readonly string[]).includes(raw)) {
    const state = raw as SlotState;
    if (!isTerminalState(state)) return { state: "FAILED", reason: null };
    return { state, reason: state === "COMPLETED" ? null : metaReason(meta?.terminalReason) };
  }
  // 10.4.0: its terminalReason was Claude Code's text, not a FailureReason, so only the
  // two reasons a state implies are known.
  const status = typeof meta?.status === "string" ? STATE_OF_10_4_STATUS[meta.status] : undefined;
  const state = status ?? "FAILED";
  if (state === "CANCELLED") return { state, reason: "cancelled" };
  if (state === "TIMEOUT") return { state, reason: "timeout" };
  return { state, reason: null };
}

/**
 * A `SessionInfo` from a session directory's files. Every field is validated, never
 * coerced: a `meta.json` truncated mid-write by a SIGKILL is the case this is FOR.
 */
function diskInfo(d: {
  sessionId: string;
  meta: Record<string, unknown> | null;
  spawnRecord: Record<string, unknown> | null;
  measured: ReturnType<typeof diskAccounting>;
  dirMtimeMs: number;
  transcriptPath: string;
}): SessionInfo {
  const { meta, spawnRecord, measured } = d;
  const startedAt =
    metaString(meta?.startedAt) ??
    metaString(spawnRecord?.startedAt) ??
    new Date(d.dirMtimeMs).toISOString();
  const completedAt = metaString(meta?.completedAt);
  const { state, reason } = diskState(meta);
  return {
    // The id we were ASKED for, never the one in the file.
    sessionId: d.sessionId,
    model: metaString(meta?.model) ?? metaString(spawnRecord?.model) ?? "unknown",
    spawnModel: metaString(meta?.spawnModel),
    provider: metaString(meta?.provider),
    state,
    shape: meta?.shape === "interactive" ? "interactive" : "one-shot",
    pane: metaString(meta?.pane),
    // NEVER the pid from the file: it belonged to a process that is gone, and pids are
    // reused.
    panePid: null,
    startedAt,
    completedAt,
    exitCode: metaNumber(meta?.exitCode),
    turnsCompleted: metaNumber(meta?.turnsCompleted) ?? 0,
    tokensIn: metaNumber(meta?.tokensIn) ?? measured.tokensIn,
    tokensOut: metaNumber(meta?.tokensOut) ?? measured.tokensOut,
    costUsd: metaNumber(meta?.costUsd) ?? measured.costUsd,
    toolCalls: metaNumber(meta?.toolCallCount) ?? measured.toolCalls,
    lastActivityAt: metaString(meta?.lastActivityAt),
    // Wall time as it ENDED, not as it looks now.
    elapsedSeconds: elapsedSecondsBetween(
      startedAt,
      completedAt ? Date.parse(completedAt) : d.dirMtimeMs
    ),
    // Read from disk: no live process to be idle. Null, never 0.
    idleSeconds: null,
    activity: null,
    reason,
    detail: meta === null ? NO_TERMINAL_RECORD : metaString(meta.detail),
    pendingInputs: 0,
    claudeSessionId:
      metaString(meta?.claudeSessionId) ?? metaString(spawnRecord?.claudeSessionId) ?? "",
    ...optionalParent(metaString(meta?.parentClaudeSessionId)),
    transcriptPath: d.transcriptPath,
    captureSource: diskCaptureSource(meta?.captureSource),
    turnSource: meta?.turnSource === "screen" ? "screen" : "transcript",
    timeoutSeconds:
      metaNumber(meta?.timeoutSeconds) ?? metaNumber(spawnRecord?.timeoutSeconds) ?? 0,
  };
}

function diskCaptureSource(v: unknown): SessionInfo["captureSource"] {
  return v === "transcript" || v === "screen" || v === "none" ? v : null;
}
