import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type SpawnPlan, prehydrateCredentialsForSpawn } from "./auth/credentials/prehydrate.js";
import { ENV } from "./config.js";
import { UPSTREAM_ERROR_LOG_ENV } from "./handlers/shared/upstream-error-capture.js";
import {
  type Accounting,
  type CaptureResult,
  type CaptureUnchanged,
  ContractErrorException,
  type FailureReason,
  type FinalVerdict,
  MAX_LIVE_PANES,
  type PaneBlock,
  type PaneSession,
  type PaneSessionOptions,
  type PaneSnapshot,
  SLOT_STATES,
  type SettledTurn,
  type SlotRow,
  type SlotState,
  TERMINAL_STATES,
  type TeamCancelResult,
  type TeamListResult,
  type TeamRunRow,
  assertMagmuxAvailable,
  checkChildFlags,
  contractMeta,
  deliveryRefusal,
  flagsRemoveRead,
  isTerminalState,
  livePaneCount,
  mergeAccounting,
  readTokenFileCached,
  releasePaneReservations,
  reservePanes,
  resolveProvider,
  sockRootFor,
  startPaneSession,
  toSlotRow,
} from "./pane/index.js";
import { redactSecrets } from "./redact.js";
import { projectsDir, transcriptPathFor } from "./session/session-discovery.js";
import { renderTeamStatsCompact, statsDir, tokenFileFor, writeStatusFile } from "./team-stats.js";

/*
 * Every team slot is an INTERACTIVE Claude Code session launched through claudish, in its
 * own headless magmux pane, driven by `PaneSession` (pane/). The transcript decides when a
 * turn settled and what its answer is; this file owns the TEAM policy on top of it:
 * `require_pattern` / `min_output_bytes` (`classifyRunOutput`), a slot that stops on a
 * question it cannot answer is FAILED `blocked` (D19), and the run registry the polling
 * verbs read. Rationale: ai-docs/architecture/team-lifecycle.md and team-capture.md.
 *
 * No claudish timer ends a slot after its prompt was accepted (D10). The only bounds are
 * the pane's boot (90 s) and the admission of the prompt (30 s), before any work exists.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamManifest {
  created: string;
  models: Record<string, { model: string; assignedAt: string }>;
  shuffleOrder: string[];
}

export interface ModelError {
  /** Model ID that failed (anonymized id used in the report). */
  model: string;
  /** The command the slot ran (the pane child's claudish argv, for the reader). */
  command: string;
  /** Failure classification (the contract's closed set, pane/contract.ts). */
  reason: FailureReason;
  /** One-line human-readable explanation of `reason`. */
  detail: string;
  /** Redacted head and tail of the pane's final screen. */
  screenSnippet?: string;
  /** Redacted head and tail of the answer the slot produced. */
  answerSnippet?: string;
  /** Path to the full error log file. */
  errorLogPath: string;
  /**
   * Path to this slot's upstream-error records, when the child wrote any.
   *
   * The raw provider response body for every failed request — which is what
   * separates a retryable rate limit from a hard quota wall. Omitted when the
   * file does not exist, so this is never a dangling reference: an unwritten
   * file means the child never had an upstream failure to record.
   */
  upstreamErrorLogPath?: string;
  /** The team session directory. */
  workDir: string;
}

/**
 * One slot in `status.json`. `state` is the contract's closed nine-value set. The fields
 * after `error` are written by every pane run; they are optional in the TYPE because a
 * `status.json` written by a pre-contract claudish lacks them, and `getStatus` returns
 * whatever is on disk.
 */
export interface ModelStatus {
  state: SlotState;
  /** From the pane's exit event; null when claudish ended the pane (verdict, cancel). */
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  /** FINAL answer bytes, written once, when the slot turns terminal (team-lifecycle.md). */
  outputSize: number;
  /** Populated on FAILED / EMPTY / CANCELLED with details for the failure report. */
  error?: ModelError;
  model?: string;
  spawnModel?: string | null;
  provider?: string | null;
  sessionUuid?: string;
  transcriptPath?: string;
  pane?: string | null;
  captureSource?: "transcript" | "screen" | "none" | null;
  turnSource?: "transcript" | "screen";
  stopReason?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  toolCalls?: number;
  turnsCompleted?: number;
  lastActivityAt?: string | null;
  /** The child's Claude Code version from its boot banner (R3-M4). */
  claudeCodeVersion?: string | null;
  /** Facts worth a reader's attention that are not failures (R3-M5, truncation). */
  anomalies?: string[];
}

export interface TeamStatus {
  startedAt: string;
  /** The run that wrote this file (CA-13); absent in a pre-contract file. */
  runId?: string;
  kind?: "run" | "judge";
  models: Record<string, ModelStatus>;
}

export interface TeamRunOptions {
  claudeFlags?: string[]; // extra flags passed to child claudish (checked by checkChildFlags)
  onStatusChange?: (id: string, status: ModelStatus) => void;
  /**
   * Opt-in stub threshold: below this many answer bytes a settled slot is recorded
   * EMPTY. Default 0 (off) — see DEFAULT_MIN_OUTPUT_BYTES for why. Whitespace-only
   * output is caught regardless of this setting.
   */
  minOutputBytes?: number;
  /**
   * Opt-in SHAPE contract: a JS regex source string the answer must match, or the slot
   * is recorded EMPTY with reason `shape_mismatch`.
   *
   * Byte counts cannot separate a broken answer from a legitimately short one (a
   * measured 96 B reply is valid — see DEFAULT_MIN_OUTPUT_BYTES). A caller that
   * mandated an output shape, however, KNOWS what a complete answer looks like:
   * `team`'s prompts require a fenced ```vote block, so "```vote" is a precise oracle
   * where length is a guess.
   *
   * Matched with `new RegExp(pattern)` (no flags) against the FULL answer: every
   * assistant text block of the turn, joined with "\n\n", exactly as written to
   * `response-<id>.md`. For a prompt delivered as a file the answer starts with the
   * first text block AFTER the task file was fully read, so `^VERDICT:` matches an
   * answer that begins with its verdict even when the model narrated before reading.
   */
  requirePattern?: string;
  /**
   * Called on a timer with a rendered, colourless progress block, and once more
   * when the run settles. Used to push live status somewhere a human can see it
   * (MCP channel notification, terminal, log).
   *
   * `phase` MUST be honoured by consumers that model session lifecycle: without
   * a terminal `"settled"` frame, a watcher sees only "running" forever and
   * never observes the run close.
   */
  onProgress?: (update: {
    rendered: string;
    phase: "running" | "settled";
    /** True when no model produced usable output. */
    allFailed: boolean;
  }) => void;
  /**
   * Max seconds between `onProgress` calls when NOTHING has changed. Default 60.
   *
   * This is a heartbeat, not a poll rate. Each frame renders as its own new line
   * in the client, so a fixed 5s tick on a 15-minute run would print ~180 lines of
   * near-identical text. Frames are emitted when a model's STATE changes (finishes,
   * fails, produces output); this interval only bounds how long a quiet run can go
   * without proving it is still alive.
   *
   * `status.txt` is rewritten on every internal poll regardless — it is a file, so
   * frequency costs nothing there.
   */
  heartbeatSeconds?: number;
  /** Spawn-plan factory seam for hermetic call-site tests. */
  spawnPlanner?: (models: (string | undefined)[]) => Promise<SpawnPlan>;
  /**
   * Called exactly once, when the run SETTLES: after the last slot turned terminal
   * and the settled `status.txt` render, from inside `done`'s `finally`. Receives
   * the final status.
   *
   * Read inside `startModels`, so the hook exists before the first pane is
   * spawned and does not depend on anything the caller does after
   * `startModels` returns — a run that settles at once takes the same path as a
   * slow one. A throwing consumer cannot fail the run. NOT called when
   * `startModels` itself throws: no run started, and the caller settles that.
   */
  onSettled?: (status: TeamStatus) => void;
  /**
   * The environment every pane of this run is built from (X-M9). Default
   * `process.env`. The transcript path is derived with `projectsDir(parentEnv)`.
   */
  parentEnv?: Record<string, string | undefined>;
  /** "judge" for the judging/ sub-run of `judgeResponses`; default "run". */
  kind?: "run" | "judge";
  /** @internal test-only pane timing seams (X-M7); production never passes them */
  paneTimings?: PaneSessionOptions["timings"];
  /** @internal test-only boot bound; production uses the pane's 90 s */
  bootTimeoutMs?: number;
}

/**
 * A running team, handed back once every slot has LEFT STARTING (D9): its prompt was
 * accepted, or it failed to boot or to take the prompt.
 *
 * This is what makes a team run addressable without blocking on it. The caller
 * gets the ids it needs to ask questions later, and asks them through the polling
 * verbs (`teamRunRow`, `listTeamRuns`, `captureTeamSlot`, `getStatus`) rather than by
 * holding a tool call open for the length of the run.
 */
export interface TeamHandle {
  /**
   * Unique per start (CA-13): `<team_session_id>-<base36 start ms>-<6 hex>`. Distinct
   * even when a later run reuses `sessionPath`.
   */
  runId: string;
  /**
   * The session directory's basename. Already the id used for this run's channel
   * frames, so a caller correlating frames to a run needs no second identifier.
   */
  teamSessionId: string;
  /** Absolute session directory. `getStatus` and `judgeResponses` both take it. */
  sessionPath: string;
  /**
   * Display model → anonymised slot id, e.g. `{"grok-4.6": "02"}`.
   *
   * The slot id addresses everything on disk for that model: `response-<id>.md`,
   * `stats/<id>.json`, `errors/<id>.log`, and the per-model entry in
   * `getStatus().models`.
   */
  slots: Record<string, string>;
  /**
   * Settles when every slot is terminal. Nothing needs to await it — the run
   * completes and writes its files either way — and a caller that only polls
   * can ignore it entirely.
   */
  done: Promise<TeamStatus>;
}

export interface TeamJudgeOptions {
  judges?: string[]; // models to use as judges (default: same models as runners)
  claudeFlags?: string[];
  /** The environment the judge panes are built from; default `process.env`. */
  parentEnv?: Record<string, string | undefined>;
  /** @internal test-only pane timing seams */
  paneTimings?: PaneSessionOptions["timings"];
}

export interface VoteResult {
  judgeId: string;
  responseId: string;
  verdict: "APPROVE" | "REJECT" | "ABSTAIN";
  confidence: number;
  summary: string;
  keyIssues: string[];
}

export interface TeamVerdict {
  responses: Record<
    string,
    {
      approvals: number;
      rejections: number;
      abstentions: number;
      score: number; // approvals / (approvals + rejections)
    }
  >;
  ranking: string[]; // response IDs sorted by score descending
  votes: VoteResult[];
}

// ─── Run registry (architecture §3.2) ─────────────────────────────────────────

interface SlotEntry {
  id: string;
  model: string;
  spawnModel: string | null;
  tokenFile: string;
  /** null = the pane never spawned (its row is FAILED `pane_lost`, `pane: null`) */
  session: PaneSession | null;
  /** refreshed on the 2 s tick and on every read */
  acct: Accounting;
  /** what `response-<id>.md` holds once it was written (decide, onBlocked or terminal) */
  answer: string | null;
  stopReason: string | null;
}

interface LiveTeamRun {
  runId: string;
  /** resolved absolute session dir (was the basename: "judging" collided, F6) */
  path: string;
  kind: "run" | "judge";
  startedAt: string;
  finishedAt: string | null;
  /** the in-memory object `updateModelStatus` serialises to status.json */
  status: TeamStatus;
  slots: Map<string, SlotEntry>;
  /** resolves once `done` has ended the run's record (`onSettled`), whatever ended it */
  settled: Promise<void>;
}

/** A `startModels` still before its registry entry (credentials, the staggered spawn loop). */
interface StartFlight {
  /** set by shutdown: the loop starts no further pane and unwinds through its `catch` */
  aborted: boolean;
}

/** Every `startModels` in progress, to the promise it returns (§20.3 item 8). */
const startsInFlight = new Map<StartFlight, Promise<unknown>>();

/**
 * Runs this process started, keyed by run_id (CA-13). An ACTIVE run stays until it
 * settles; a SETTLED run stays listable and capturable for SETTLED_RUN_RETENTION_MS,
 * at most MAX_SETTLED_RUNS of them (oldest evicted first). After eviction `status` still
 * answers from `status.json` (newest run at a path only).
 */
const teamRuns = new Map<string, LiveTeamRun>();
/** resolved path → run_id of the newest run started there */
const newestRunByPath = new Map<string, string>();
export const SETTLED_RUN_RETENTION_MS = 30 * 60_000; // same as channel TERMINAL_RETENTION_MS
export const MAX_SETTLED_RUNS = 20;
/** Slots of one run spawn this far apart, so N REPLs do not write ~/.claude.json at once (X-L8). */
export const BOOT_STAGGER_MS = 300;

function slotTerminal(e: SlotEntry): boolean {
  if (!e.session) return true;
  return isTerminalState(e.session.snapshot().state);
}

function runSettled(run: LiveTeamRun): boolean {
  return [...run.slots.values()].every((e) => slotTerminal(e));
}

/** Set `finishedAt` the moment the last slot turned terminal. */
function markIfSettled(run: LiveTeamRun): void {
  if (run.finishedAt === null && runSettled(run)) run.finishedAt = new Date().toISOString();
}

function evictRun(run: LiveTeamRun): void {
  teamRuns.delete(run.runId);
  if (newestRunByPath.get(run.path) === run.runId) newestRunByPath.delete(run.path);
}

/** Apply the retention policy. Called on every registry read and on every new run. */
function pruneRuns(now: number = Date.now()): void {
  const settled = [...teamRuns.values()]
    .filter((r) => {
      markIfSettled(r);
      return r.finishedAt !== null;
    })
    .sort((a, b) => Date.parse(a.finishedAt as string) - Date.parse(b.finishedAt as string));
  const keep: LiveTeamRun[] = [];
  for (const r of settled) {
    if (now - Date.parse(r.finishedAt as string) > SETTLED_RUN_RETENTION_MS) evictRun(r);
    else keep.push(r);
  }
  while (keep.length > MAX_SETTLED_RUNS) evictRun(keep.shift() as LiveTeamRun);
}

/** The run a verb addresses: `run_id` while retained, else the newest run at `path`. */
function addressRun(path: string | undefined, runId?: string): LiveTeamRun | null {
  pruneRuns();
  if (runId) {
    const run = teamRuns.get(runId) ?? null;
    if (run && path !== undefined && resolve(path) !== run.path) return null;
    return run;
  }
  if (path === undefined) return null;
  const id = newestRunByPath.get(resolve(path));
  return id ? (teamRuns.get(id) ?? null) : null;
}

/** The newest run at `path` when it is still ACTIVE. */
export function activeRunAt(path: string): { runId: string } | null {
  const run = addressRun(path);
  return run && !runSettled(run) ? { runId: run.runId } : null;
}

/**
 * At most one ACTIVE run per path (§3.2). Thrown as `run`'s usual text error, never as
 * a ContractError: `run` is not a verb of the mod contract.
 */
function assertNoActiveRun(path: string): void {
  const active = activeRunAt(path);
  if (active)
    throw new Error(
      `invalid_args: a team run is already ACTIVE at ${path} (run_id ${active.runId}); cancel it or wait for it`
    );
}

function emptyAccounting(provider: string | null): Accounting {
  return { tokensIn: null, tokensOut: null, costUsd: null, toolCalls: 0, provider };
}

function refreshAccounting(e: SlotEntry, snap: PaneSnapshot): Accounting {
  e.acct = mergeAccounting(snap, readTokenFileCached(e.tokenFile), {
    model: e.model,
    spawnModel: e.spawnModel,
  });
  return e.acct;
}

/** The R3-M4 / R3-M5 anomalies a team reader must see beside the state. */
function notableAnomalies(snap: PaneSnapshot): string[] {
  return snap.anomalies.filter(
    (a) =>
      a.startsWith("background_shell_open") ||
      a.startsWith("turn_end_record_missing") ||
      a.startsWith("prompt_not_read")
  );
}

function neverSpawnedRow(e: SlotEntry, m: ModelStatus | undefined): SlotRow {
  return {
    slot: e.id,
    model: e.model,
    provider: e.acct.provider,
    state: m?.state ?? "FAILED",
    reason: m?.error?.reason ?? "pane_lost",
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    tool_calls: 0,
    turns_completed: 0,
    last_activity_at: null,
    idle_seconds: null,
    activity: null,
    pane: null,
  };
}

function liveSlotRow(run: LiveTeamRun, e: SlotEntry): SlotRow {
  if (!e.session) return neverSpawnedRow(e, run.status.models[e.id]);
  const snap = e.session.snapshot();
  return toSlotRow(
    { slot: e.id, model: e.model, spawnModel: e.spawnModel },
    snap,
    refreshAccounting(e, snap)
  );
}

/** "ok" | "partial" | "all-failed" — the result card's words; CANCELLED counts as failed. */
function outcomeOf(states: SlotState[]): "ok" | "partial" | "all-failed" {
  const ok = states.filter((s) => s === "COMPLETED").length;
  if (ok === states.length) return "ok";
  return ok === 0 ? "all-failed" : "partial";
}

function runRow(run: LiveTeamRun): TeamRunRow {
  markIfSettled(run);
  const slots = [...run.slots.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => liveSlotRow(run, e));
  const settled = slots.every((s) => isTerminalState(s.state));
  return {
    run_id: run.runId,
    path: run.path,
    kind: run.kind,
    started_at: run.startedAt,
    finished_at: settled ? run.finishedAt : null,
    state: settled ? "SETTLED" : "ACTIVE",
    outcome: settled ? outcomeOf(slots.map((s) => s.state)) : null,
    slots,
  };
}

/** `run` from memory: the addressed run while retained, else null. */
export function teamRunRow(path: string | undefined, runId?: string): TeamRunRow | null {
  const run = addressRun(path, runId);
  return run ? runRow(run) : null;
}

/** True when `runId` is retained but a newer run now owns its path's status.json. */
export function isSupersededRun(runId: string): boolean {
  const run = teamRuns.get(runId);
  return !!run && newestRunByPath.get(run.path) !== runId;
}

/** A persisted state outside the closed set (e.g. `PENDING`) reads FAILED with reason null. */
function closedState(s: unknown): { state: SlotState; known: boolean } {
  return (SLOT_STATES as readonly unknown[]).includes(s)
    ? { state: s as SlotState, known: true }
    : { state: "FAILED", known: false };
}

/**
 * `run` built from `status.json`, for a run this server does not hold (§8 B): rows have
 * `idle_seconds:null` and `activity:null`, and `state` is whatever was last written.
 */
export function teamRunRowFromDisk(path: string, status: TeamStatus): TeamRunRow {
  const manifest = readManifestOrNull(path);
  const slots: SlotRow[] = Object.entries(status.models ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, m]) => {
      const { state, known } = closedState(m?.state);
      const terminal = isTerminalState(state);
      return {
        slot: id,
        model: m?.model ?? manifest?.models[id]?.model ?? "unknown",
        provider: m?.provider ?? null,
        state,
        reason: !known || !terminal || state === "COMPLETED" ? null : (m?.error?.reason ?? null),
        tokens_in: m?.tokensIn ?? null,
        tokens_out: m?.tokensOut ?? null,
        cost_usd: m?.costUsd ?? null,
        tool_calls: m?.toolCalls ?? 0,
        turns_completed: m?.turnsCompleted ?? 0,
        last_activity_at: m?.lastActivityAt ?? null,
        idle_seconds: null,
        activity: null,
        pane: m?.pane ?? null,
      };
    });
  const settled = slots.length > 0 && slots.every((s) => isTerminalState(s.state));
  const completions = Object.values(status.models ?? {})
    .map((m) => (m?.completedAt ? Date.parse(m.completedAt) : Number.NaN))
    .filter(Number.isFinite);
  return {
    run_id: status.runId ?? basename(path),
    path,
    kind: status.kind ?? (basename(path) === "judging" ? "judge" : "run"),
    started_at: status.startedAt,
    finished_at:
      settled && completions.length ? new Date(Math.max(...completions)).toISOString() : null,
    state: settled ? "SETTLED" : "ACTIVE",
    outcome: settled ? outcomeOf(slots.map((s) => s.state)) : null,
    slots,
  };
}

function readManifestOrNull(path: string): TeamManifest | null {
  try {
    return JSON.parse(readFileSync(join(path, "manifest.json"), "utf-8")) as TeamManifest;
  } catch {
    return null;
  }
}

/** Contract A: every retained run, ACTIVE first, then SETTLED by `finished_at` desc. */
export function listTeamRuns(): TeamListResult {
  pruneRuns();
  const rows = [...teamRuns.values()].map(runRow);
  const active = rows
    .filter((r) => r.state === "ACTIVE")
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  const settled = rows
    .filter((r) => r.state === "SETTLED")
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
  return { ...contractMeta(), runs: [...active, ...settled] };
}

function unknownRun(path: string | undefined, runId?: string): ContractErrorException {
  return new ContractErrorException(
    "unknown_run",
    runId
      ? `no team run with run_id ${runId} is retained by this server`
      : `no team run at ${path} is held by this server`
  );
}

/**
 * Stop one slot, or every slot in a run, on the caller's instruction (contract C).
 *
 * The ONLY thing that ends a working team slot. The orchestrator used to do it on a
 * timer and got it wrong — three productive slots died in session team-20260827-0015
 * because silence during a long tool call was read as death. The decision belongs to
 * whoever set the task and can tell a slow build from a hang.
 *
 * Synchronous transition, asynchronous reap: the state is CANCELLED when this returns;
 * the pane close and the process-group reap finish in the background.
 */
export async function cancelTeamRun(
  path: string | undefined,
  slot?: string,
  runId?: string
): Promise<TeamCancelResult> {
  const run = addressRun(path, runId);
  if (!run) throw unknownRun(path, runId);
  const entries = [...run.slots.values()].sort((a, b) => a.id.localeCompare(b.id));
  const targets = slot === undefined ? entries : entries.filter((e) => e.id === slot);
  if (slot !== undefined && targets.length === 0)
    throw new ContractErrorException(
      "unknown_slot",
      `run ${run.runId} has no slot ${JSON.stringify(slot)}`
    );
  const results = targets.map((e) => {
    if (!e.session)
      return { slot: e.id, state: run.status.models[e.id]?.state ?? "FAILED", changed: false };
    const r = e.session.cancel();
    return { slot: e.id, state: r.state, changed: r.changed };
  });
  return { run_id: run.runId, path: run.path, results };
}

/** The screen of a slot whose pane never spawned (§8 D, amended r2). */
function neverSpawnedCapture(): CaptureResult {
  return {
    seq: 0,
    cols: 160,
    rows: 50,
    cursor: { x: 0, y: 0 },
    lines: Array.from({ length: 50 }, () => ""),
    final: true,
  };
}

/** Contract D, memory only. Throws `ContractErrorException`. */
export function captureTeamSlot(
  path: string | undefined,
  slot: string,
  sinceSeq?: number,
  spans?: boolean,
  runId?: string
): CaptureResult | CaptureUnchanged {
  const run = addressRun(path, runId);
  if (!run) throw unknownRun(path, runId);
  const e = run.slots.get(slot);
  if (!e)
    throw new ContractErrorException(
      "unknown_slot",
      `run ${run.runId} has no slot ${JSON.stringify(slot)}`
    );
  if (!e.session) {
    const c = neverSpawnedCapture();
    return sinceSeq === 0 ? { unchanged: true, seq: 0, final: true } : c;
  }
  return e.session.capture(sinceSeq, { spans: spans === true });
}

/**
 * Per-slot maps the legacy `status` payload carries beside `run` (§4.1), derived from
 * the live rows: idle seconds and activity of every non-terminal slot, and the answer
 * bytes each has produced so far. Null for a run this server does not hold.
 */
export function teamLiveMaps(
  path: string | undefined,
  runId?: string
): {
  idle: Record<string, number>;
  activity: Record<string, string>;
  liveBytes: Record<string, number>;
  endRecordMissing: string[];
} | null {
  const run = addressRun(path, runId);
  if (!run) return null;
  const idle: Record<string, number> = {};
  const activity: Record<string, string> = {};
  const liveBytes: Record<string, number> = {};
  const endRecordMissing: string[] = [];
  for (const e of run.slots.values()) {
    if (!e.session) continue;
    const snap = e.session.snapshot();
    if (isTerminalState(snap.state)) continue;
    const row = toSlotRow({ slot: e.id, model: e.model, spawnModel: e.spawnModel }, snap, e.acct);
    if (row.idle_seconds !== null) idle[e.id] = row.idle_seconds;
    liveBytes[e.id] = snap.liveAnswerBytes;
    // the live condition, never the anomaly history: a slot that resumed work is not wedged
    if (snap.turnEndRecordMissing) endRecordMissing.push(e.id);
    if (row.activity !== null) activity[e.id] = row.activity;
  }
  return { idle, activity, liveBytes, endRecordMissing };
}

function cancelEverySlot(): void {
  for (const run of teamRuns.values()) for (const e of run.slots.values()) e.session?.cancel();
}

/**
 * Settle every team run CANCELLED and wait until each one's record has ENDED (§20.3
 * item 8). Process shutdown only; the pane registry's `reapAllPanes` does the killing.
 *
 * A run still in its spawn loop is not in `teamRuns` yet: it is told to stop spawning,
 * unwinds through its own `catch` (its handler writes `start-failed`), and is awaited. A
 * run whose loop finished meanwhile registers, so the cancel pass repeats until no start
 * is in flight. Then every run's `settled` — the end of `done`, after `onSettled` — is
 * awaited, so no record is left without its end on a clean shutdown.
 */
export async function shutdownAllTeamRuns(): Promise<void> {
  for (const f of startsInFlight.keys()) f.aborted = true;
  for (;;) {
    cancelEverySlot();
    if (startsInFlight.size === 0) break;
    await Promise.allSettled([...startsInFlight.values()]);
  }
  cancelEverySlot();
  await Promise.allSettled([...teamRuns.values()].map((r) => r.settled));
}

/** @internal tests: forget every retained run. */
export function resetTeamRegistryForTests(): void {
  teamRuns.clear();
  newestRunByPath.clear();
}

/** @internal tests: apply the retention policy as of `now` (the 30-minute rule). */
export function pruneTeamRunsForTests(now: number): void {
  pruneRuns(now);
}

// ─── Output Classification ────────────────────────────────────────────────────

/** How many trailing answer bytes a failed slot's error log keeps. */
export const STDOUT_TAIL_LIMIT = 4000;

/** Budget for the answer / screen snippets recorded in `status.json`. */
const SNIPPET_LIMIT = 2000;

/** Bytes of the snippet budget spent on the START of the text. */
const SNIPPET_HEAD = 600;

/**
 * Keep the snippet within budget WITHOUT discarding the beginning.
 *
 * A plain `.slice(-2000)` threw away the first half of a 4000-byte tail that was
 * already in hand, and the beginning is where a shape mismatch is usually
 * legible: a `require_pattern` near-miss like `**Verdict**: **FAIL**` against
 * `/\*\*Verdict\*\*: (PASS|CONDITIONAL|FAIL)/` is diagnosed the moment the
 * reader sees the model's actual wording. Ending a report at the tail can show
 * the reader the last 2000 bytes of prose and none of the line that explains it.
 *
 * Short text is returned whole, so the elision marker only ever appears when
 * something really was dropped.
 */
export function snippetHeadAndTail(text: string): string {
  if (text.length <= SNIPPET_LIMIT) return text;
  const head = text.slice(0, SNIPPET_HEAD);
  const tail = text.slice(-(SNIPPET_LIMIT - SNIPPET_HEAD));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n… [${omitted} bytes omitted] …\n\n${tail}`;
}

/**
 * Stub threshold, OFF by default.
 *
 * An earlier default of 200 produced a 2/2 false-positive rate the first time it
 * met real short answers: two correct one-sentence replies (141 B and 96 B) were
 * both recorded EMPTY. Re-checking the three real failures that motivated the
 * threshold, none of them actually needs it — the 1-byte "\n" is whitespace-only,
 * and the 98-byte API error and 195-byte preamble are both caught by their
 * markers. So the byte threshold earned no unique detections while rejecting
 * valid output.
 *
 * Callers who KNOW their answers should be long (a multi-KB review) can opt in
 * via `minOutputBytes`. Whitespace-only output is always caught regardless.
 */
export const DEFAULT_MIN_OUTPUT_BYTES = 0;

/** Added to `detail` (or the COMPLETED slot's anomalies) when the turn ended on max_tokens. */
export const TRUNCATION_NOTE =
  "the turn ended on stop_reason max_tokens, so the answer may be truncated";

/**
 * Decide whether a settled turn produced a usable answer. Returns null when it did.
 *
 * Precedence: `api_error` (FAILED) → `prompt_not_read` (FAILED) → `refused` (EMPTY) →
 * whitespace-only `empty_output` → `min_output_bytes` → `shape_mismatch` LAST (all
 * EMPTY). The structural failures come first because they give better detail, and a
 * turn that hit one of them would fail the shape contract too — reporting "no ```vote
 * block" for what is really an API error would send the caller after the wrong problem.
 */
export function classifyRunOutput(input: {
  /** The full answer: text blocks joined with "\n\n", as written to response-<id>.md. */
  answer: string;
  apiError: { status: number | null; text: string } | null;
  stopReason?: string | null;
  /** `complete === false` → prompt_not_read */
  promptRead?: SettledTurn["delivery"];
  minOutputBytes?: number;
  /** Caller's shape contract (regex source). See TeamRunOptions.requirePattern. */
  requirePattern?: string;
}): { state: "FAILED" | "EMPTY"; reason: FailureReason; detail: string } | null {
  const v = classifyAnswer(input);
  if (v && input.stopReason === "max_tokens") v.detail = `${v.detail} (${TRUNCATION_NOTE})`;
  return v;
}

type Verdict = { state: "FAILED" | "EMPTY"; reason: FailureReason; detail: string };

/** The turn's own failure signals: an API error, an unread task file, a refusal. */
function classifyTurnSignals(input: Parameters<typeof classifyRunOutput>[0]): Verdict | null {
  const { apiError, stopReason, promptRead } = input;
  if (apiError) {
    const status = apiError.status === null ? "" : ` (status ${apiError.status})`;
    return {
      state: "FAILED",
      reason: "api_error",
      detail: `The turn ended in an API error${status}: ${apiError.text.slice(0, 300) || "unknown"}`,
    };
  }
  if (promptRead?.complete === false) {
    const read = promptRead.linesRead ?? 0;
    return {
      state: "FAILED",
      reason: "prompt_not_read",
      detail:
        read === 0
          ? "the task file was never read, so the answer cannot be about the task"
          : `the child's Read calls returned ${read} of ${promptRead.linesTotal ?? "?"} lines of the task file`,
    };
  }
  if (stopReason === "refusal") {
    return {
      state: "EMPTY",
      reason: "refused",
      detail: "The model refused (stop_reason refusal).",
    };
  }
  return null;
}

/** The caller's shape contract, matched against the full answer (no flags). */
function classifyShape(answer: string, requirePattern: string | undefined): Verdict | null {
  if (!requirePattern) return null;
  let re: RegExp | null = null;
  try {
    re = new RegExp(requirePattern);
  } catch {
    // An unusable pattern must never fail a run that may be perfectly good.
    // startModels validates up front so the caller hears about it before any
    // model is spawned; this branch only guards a direct call.
    return null;
  }
  if (re.test(answer)) return null;
  return {
    state: "EMPTY",
    reason: "shape_mismatch",
    detail:
      `The answer (${Buffer.byteLength(answer, "utf8")} B of assistant text after the task was ` +
      `read) does not match the required pattern /${requirePattern}/. Every assistant message ` +
      "of the turn was read from the transcript, so nothing was lost: the model did not " +
      "produce the shape. Re-prompt it, or relax the contract.",
  };
}

function classifyAnswer(input: Parameters<typeof classifyRunOutput>[0]): Verdict | null {
  const signal = classifyTurnSignals(input);
  if (signal) return signal;
  const { answer } = input;
  const minOutputBytes = input.minOutputBytes ?? DEFAULT_MIN_OUTPUT_BYTES;
  const outputSize = Buffer.byteLength(answer, "utf8");

  // Nothing but whitespace is never a real answer, at any threshold.
  if (answer.trim().length === 0) {
    return {
      state: "EMPTY",
      reason: "empty_output",
      detail: `The turn settled with no non-whitespace answer (${outputSize} B).`,
    };
  }

  // Opt-in stub threshold. Off by default — see DEFAULT_MIN_OUTPUT_BYTES.
  if (minOutputBytes > 0 && outputSize < minOutputBytes) {
    return {
      state: "EMPTY",
      reason: "empty_output",
      detail: `The answer is only ${outputSize} B (caller required at least ${minOutputBytes} B).`,
    };
  }

  return classifyShape(answer, input.requirePattern);
}

/**
 * Write the full diagnostic log for a slot that did not complete.
 *
 * Always called on failure, so `errorLogPath` in the status report is never a
 * dangling reference.
 *
 * Credentials are stripped BEFORE the bytes hit disk. A screen or an answer can echo
 * key material, and the team result card names this path for the agent to read — so an
 * unredacted log is a credential handed straight into an agent's context. Redacting at
 * write time is the only point that covers every reader (the agent, a human,
 * `report_error`, a future consumer).
 */
function persistErrorLog(
  errorLogPath: string,
  header: string,
  sections: Array<[title: string, body: string]>
): void {
  const parts = [`=== ${redactSecrets(header)} ===`, ""];
  for (const [title, body] of sections) {
    parts.push(`--- ${title} ---`, body.trim() ? redactSecrets(body) : "(empty)", "");
  }
  try {
    writeFileSync(errorLogPath, parts.join("\n"), "utf-8");
  } catch {
    // Diagnostics are best-effort — never let logging failure mask the real error.
  }
}

// ─── Path Validation ──────────────────────────────────────────────────────────

/**
 * Validate that sessionPath is within cwd (prevents path traversal in MCP tools).
 * Returns the resolved absolute path.
 */
export function validateSessionPath(sessionPath: string): string {
  const resolved = resolve(sessionPath);
  const cwd = process.cwd();
  if (!resolved.startsWith(`${cwd}/`) && resolved !== cwd) {
    throw new Error(`Session path must be within current directory: ${sessionPath}`);
  }
  return resolved;
}

/**
 * Read a task prompt from a file on disk.
 *
 * Exists because a `team` prompt is typically hundreds of lines — a full review
 * brief with a required output shape. Passing that inline puts the entire text
 * into the tool-call record, where it is rendered verbatim in the caller's
 * terminal and buries every other argument. The prompt is already a file in
 * practice; this lets the caller say so.
 *
 * Contained to the working directory on the same terms as the session path.
 * `team` is reachable over MCP, so an unbounded path here would turn "run a
 * team" into "read any file on this machine and put it in a prompt".
 */
export function readTeamInputFile(inputPath: string): string {
  const resolved = resolve(inputPath);
  const cwd = process.cwd();
  if (!resolved.startsWith(`${cwd}/`) && resolved !== cwd) {
    throw new Error(`Input file must be within current directory: ${inputPath}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`Input file not found: ${resolved}`);
  }
  const text = readFileSync(resolved, "utf-8");
  // A silently-empty prompt would spawn N children to answer nothing, and every
  // one of them would bill for the attempt.
  if (text.trim().length === 0) {
    throw new Error(`Input file is empty: ${resolved}`);
  }
  return text;
}

// ─── Native Model Slots ──────────────────────────────────────────────────────

/*
 * A native-Anthropic name (`internal`, `default`, `opus`, `sonnet`, `haiku`,
 * `claude-*`) IS a runnable team slot. It spawns like any other child; the
 * proxy answers it through `nativeHandler` (proxy-server.ts, the `isNative`
 * branch) with no translation, because Claude Code already speaks the Anthropic
 * wire format, and it authenticates with the user's own subscription rather
 * than an API key (claude-runner.ts deletes ANTHROPIC_API_KEY for these).
 *
 * These names used to be REJECTED here. That guard (91ee9a8) was written
 * because they "failed with cryptic model not found errors" — but the cause was
 * `internal`/`default` reaching Claude Code as literal model names, which it
 * does not recognise. That is fixed at the source now: the `--model` boundary
 * normalizes a selector to its tier (normalizeNativeModelSpec), and the child
 * runs. Rejecting here as well would block a slot that demonstrably works, and
 * would keep the internal reviewer outside `requirePattern` — the one guard
 * that catches a voter which never voted.
 *
 * Pinning is already safe: `isRoutablyPinnable` (prehydrate.ts) excludes
 * native-anthropic specs, so the name stays BARE and the proxy's `isNative`
 * test (no "/" and no "@") still matches it.
 */

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Setup a new team session.
 * Creates directory structure, writes input.md, generates a shuffled manifest.
 */
export function setupSession(sessionPath: string, models: string[], input?: string): TeamManifest {
  if (models.length === 0) {
    throw new Error("At least one model is required");
  }

  // Reject re-use of existing session directory to prevent overwriting results
  if (existsSync(join(sessionPath, "manifest.json"))) {
    throw new Error(
      `Session already exists at ${sessionPath}. Use a new directory path or delete the existing session first.`
    );
  }

  // Create directories
  mkdirSync(join(sessionPath, "work"), { recursive: true });
  mkdirSync(join(sessionPath, "errors"), { recursive: true });

  // Write input.md if provided, otherwise require it to already exist
  if (input !== undefined) {
    writeFileSync(join(sessionPath, "input.md"), input, "utf-8");
  } else if (!existsSync(join(sessionPath, "input.md"))) {
    throw new Error(`No input.md found at ${sessionPath} and no input provided`);
  }

  // Generate zero-padded numeric IDs to support >26 models: 01, 02, ..., 99
  const ids = models.map((_, i) => String(i + 1).padStart(2, "0"));
  const shuffled = fisherYatesShuffle([...ids]);

  // Build manifest — shuffled[i] is the anonymous ID for models[i]
  const now = new Date().toISOString();
  const manifest: TeamManifest = {
    created: now,
    models: {},
    shuffleOrder: shuffled,
  };

  for (let i = 0; i < models.length; i++) {
    const anonId = shuffled[i];
    manifest.models[anonId] = {
      model: models[i],
      assignedAt: now,
    };
    mkdirSync(join(sessionPath, "work", anonId), { recursive: true });
  }

  writeFileSync(join(sessionPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  // Initialize status.json with every model STARTING: the closed set has no "not yet
  // started" state, and a slot leaves STARTING within the boot + admission bounds.
  const status: TeamStatus = {
    startedAt: now,
    models: Object.fromEntries(
      Object.keys(manifest.models).map((id) => [
        id,
        {
          state: "STARTING" as const,
          exitCode: null,
          startedAt: null,
          completedAt: null,
          outputSize: 0,
          model: manifest.models[id]?.model,
        },
      ])
    ),
  };
  writeFileSync(join(sessionPath, "status.json"), JSON.stringify(status, null, 2), "utf-8");

  return manifest;
}

/**
 * Fail fast on an unusable shape contract. Deliberately called BEFORE the
 * manifest read and the spawn loop: a bad regex discovered after N children
 * have run would either waste the whole run or, worse, be swallowed and
 * silently enforce nothing — which is the exact class of quiet failure this
 * option exists to remove.
 */
function assertValidRequirePattern(pattern: string | undefined): void {
  if (pattern === undefined) return;
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `Invalid requirePattern /${pattern}/: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * The pre-spawn refusals of a team run, in the order the MCP `run` handler applies them
 * BEFORE `setupSession` writes anything (§4.1): the caller's flags (D18), a prompt that
 * cannot be delivered with those flags (§2.3 rule 4), magmux present (≥ 0.14.0), no
 * ACTIVE run at the path, and room under the per-user pane limit. Each throws an Error
 * whose message starts with its code (`invalid_args:`, `magmux_unavailable:`,
 * `pane_limit:`). `startModels` repeats them, so the CLI gets the same checks.
 */
export async function preflightTeamRun(opts: {
  path: string;
  slots: number;
  claudeFlags?: string[];
  input?: string;
  requirePattern?: string;
  parentEnv?: Record<string, string | undefined>;
}): Promise<void> {
  // before setupSession and the run record, so a refused run leaves no record (§4.1)
  try {
    assertValidRequirePattern(opts.requirePattern);
  } catch (err) {
    throw new Error(`invalid_args: ${err instanceof Error ? err.message : String(err)}`);
  }
  const flags = opts.claudeFlags ?? [];
  const check = checkChildFlags(flags);
  if (!check.ok) throw new Error(`invalid_args: ${check.message}`);
  if (opts.input !== undefined) {
    const refusal = deliveryRefusal(opts.input, !flagsRemoveRead(flags));
    if (refusal) throw new Error(`invalid_args: ${refusal}`);
  }
  await assertMagmuxAvailable();
  assertNoActiveRun(resolve(opts.path));
  const root = sockRootFor(opts.parentEnv ?? process.env);
  const live = livePaneCount(root);
  if (live + opts.slots > MAX_LIVE_PANES)
    throw new Error(
      `pane_limit: ${live} live panes for this user, ${opts.slots} more would exceed ${MAX_LIVE_PANES}`
    );
}

function mintRunId(path: string, startMs: number): string {
  return `${basename(path)}-${startMs.toString(36)}-${randomBytes(3).toString("hex")}`;
}

const CANCELLED_DETAIL =
  'Stopped on the caller\'s instruction via team(mode:"cancel"). ' +
  "Whatever the child had written up to that point is in its response file.";

/**
 * Start every model as an interactive pane and RETURN once each has left STARTING
 * (D9): its prompt was accepted, or it failed to boot or to take the prompt. Bounded
 * by the boot (90 s) and admission (30 s) limits, about 12–20 s typical.
 *
 * Why this is the primitive rather than a blocking call. A team slot is a full
 * Claude Code session and can legitimately work for a very long time; the
 * previous blocking shape forced a deadline on it, and enforcing that deadline
 * killed three productive slots in session team-20260827-0015. Nothing here
 * imposes a deadline after a prompt is accepted. The caller polls, reads how long
 * each slot has been quiet and what it is doing, and decides for itself whether to
 * keep waiting.
 *
 * Each slot receives input.md (typed when it is one plain line, else as a task file it
 * is told to Read) and its answer is written to response-{ID}.md.
 */
export function startModels(sessionPath: string, opts: TeamRunOptions = {}): Promise<TeamHandle> {
  const flight: StartFlight = { aborted: false };
  const p = startModelsIn(flight, sessionPath, opts);
  startsInFlight.set(flight, p);
  const forget = () => {
    startsInFlight.delete(flight);
  };
  p.then(forget, forget);
  return p;
}

/** The stagger before slot `i` (X-L8), then the shutdown check: no pane starts after it. */
async function beforeSpawn(i: number, flight: StartFlight): Promise<void> {
  if (i > 0) await new Promise((r) => setTimeout(r, BOOT_STAGGER_MS));
  if (flight.aborted) throw new Error("cancelled: the server is shutting down");
}

async function startModelsIn(
  flight: StartFlight,
  sessionPath: string,
  opts: TeamRunOptions
): Promise<TeamHandle> {
  assertValidRequirePattern(opts.requirePattern);
  const claudeFlags = opts.claudeFlags ?? [];
  const flagCheck = checkChildFlags(claudeFlags);
  if (!flagCheck.ok) throw new Error(`invalid_args: ${flagCheck.message}`);

  const path = resolve(sessionPath);
  const manifest: TeamManifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf-8"));
  const statusPath = join(path, "status.json");
  const inputContent = readFileSync(join(path, "input.md"), "utf-8");
  const readAvailable = !flagsRemoveRead(claudeFlags);
  const refusal = deliveryRefusal(inputContent, readAvailable);
  if (refusal) throw new Error(`invalid_args: ${refusal}`);
  assertNoActiveRun(path);
  const parentEnv = opts.parentEnv ?? process.env;
  const kind = opts.kind ?? "run";

  // Resolve every model's credential AND its route HERE, before the spawn loop
  // below starts N children. Each child would otherwise open its own 1Password SDK
  // client, and the desktop app authorizes exactly one of them and denies the rest
  // ("Denied authorization for SDK client") — silently losing whichever models
  // depend on 1Password rather than a shell env var. Resolving in the parent
  // write-throughs the keys into process.env, which the pane snapshot carries to the
  // children, and the returned plan pins each bare name to an explicit
  // "provider@model" spec so the child never re-walks the chain. See
  // auth/credentials/prehydrate.ts for the measured repro.
  const spawnPlan = await (opts.spawnPlanner ?? prehydrateCredentialsForSpawn)(
    Object.values(manifest.models).map((m) => m.model)
  );
  await assertMagmuxAvailable();

  // In-memory status cache to eliminate read-modify-write races
  const statusCache: TeamStatus = JSON.parse(readFileSync(statusPath, "utf-8"));
  const startMs = Date.now();
  const runId = mintRunId(path, startMs);
  statusCache.runId = runId;
  statusCache.kind = kind;

  /**
   * Set while the spawn loop is being unwound (§6.1 step 7): the cancels it issues are
   * not the caller's, so nothing they do reaches status.json — the started slots stay
   * STARTING there and `summarise` counts them as failed.
   */
  let aborting = false;

  function patchModelStatus(id: string, update: Partial<ModelStatus>): void {
    statusCache.models[id] = { ...statusCache.models[id], ...update } as ModelStatus;
  }
  function flushStatus(): void {
    writeFileSync(statusPath, JSON.stringify(statusCache, null, 2), "utf-8");
  }
  function updateModelStatus(id: string, update: Partial<ModelStatus>): void {
    if (aborting) return;
    patchModelStatus(id, update);
    flushStatus();
  }
  function notifyStatus(id: string): void {
    try {
      opts.onStatusChange?.(id, statusCache.models[id] as ModelStatus);
    } catch {
      // A status consumer must never be able to fail the run.
    }
  }

  const minOutputBytes = opts.minOutputBytes ?? DEFAULT_MIN_OUTPUT_BYTES;
  const requirePattern = opts.requirePattern;

  // Each child writes its token/cost stats here (one file per model).
  mkdirSync(statsDir(path), { recursive: true });

  const entries = new Map<string, SlotEntry>();
  let run: LiveTeamRun | null = null;
  const errorLogPathOf = (id: string) => join(path, "errors", `${id}.log`);
  const upstreamLogOf = (id: string) => join(path, "errors", `${id}-upstream.jsonl`);
  const commandOf = (e: SlotEntry) =>
    ["claudish", "-i", "--model", e.spawnModel ?? e.model, "-y", "--quiet", ...claudeFlags].join(
      " "
    );

  /** `response-<id>.md` in one write, byte-exact; remembered so it is written once. */
  /**
   * The slot's response file. A failed write (disk full, the directory removed mid-run)
   * must not throw out of the verdict or the terminal patch: the slot's terminal row is
   * still written, and the failure goes to the slot's error log instead.
   */
  function writeResponse(e: SlotEntry, text: string): string {
    e.answer = text;
    try {
      writeFileSync(join(path, `response-${e.id}.md`), text, "utf-8");
    } catch (err) {
      persistErrorLog(errorLogPathOf(e.id), `response file not written: ${String(err)}`, []);
    }
    return text;
  }

  /** Team policy for a settled turn (D8): the verdict, after the response file exists. */
  function teamDecide(e: SlotEntry, turn: SettledTurn): FinalVerdict {
    e.stopReason = turn.stopReason;
    writeResponse(e, turn.answer);
    const v = classifyRunOutput({
      answer: turn.answer,
      apiError: turn.apiError,
      stopReason: turn.stopReason,
      promptRead: turn.delivery,
      minOutputBytes,
      requirePattern,
    });
    // R3-M5: an open background shell goes into the slot's detail, not only the anomalies.
    const shells = (e.session?.snapshot().anomalies ?? []).filter((a) =>
      a.startsWith("background_shell_open")
    );
    if (!v) {
      const notes = [...shells, ...(turn.stopReason === "max_tokens" ? [TRUNCATION_NOTE] : [])];
      return notes.length
        ? { state: "COMPLETED", detail: notes.join(" · ") }
        : { state: "COMPLETED" };
    }
    return { state: v.state, reason: v.reason, detail: [v.detail, ...shells].join(" · ") };
  }

  /** D19: team has no answering verb, so a slot blocked on a question can never finish. */
  function teamOnBlocked(e: SlotEntry, b: PaneBlock): FinalVerdict {
    const index = (e.session?.snapshot().turnsCompleted ?? 0) + 1;
    writeResponse(e, e.session?.turnAnswer(index) ?? "");
    return { state: "FAILED", reason: "blocked", detail: b.text };
  }

  function accountingFields(a: Accounting): Partial<ModelStatus> {
    return {
      provider: a.provider,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      costUsd: a.costUsd,
      toolCalls: a.toolCalls,
    };
  }

  function liveFields(e: SlotEntry, snap: PaneSnapshot): Partial<ModelStatus> {
    return {
      state: snap.state,
      pane: snap.paneId || null,
      captureSource: snap.captureSource,
      turnSource: snap.turnSource,
      lastActivityAt: snap.lastActivityAt,
      turnsCompleted: snap.turnsCompleted,
      claudeCodeVersion: snap.claudeCodeVersion,
      anomalies: notableAnomalies(snap),
      ...accountingFields(refreshAccounting(e, snap)),
    };
  }

  /** The fields a slot gets once, when it turns terminal (and its error log on failure). */
  function terminalFields(e: SlotEntry, snap: PaneSnapshot): Partial<ModelStatus> {
    const index = Math.max(1, snap.turnsCompleted);
    const answer = e.answer ?? writeResponse(e, e.session?.turnAnswer(index) ?? "");
    const anomalies = [
      ...notableAnomalies(snap),
      ...(snap.state === "COMPLETED" && e.stopReason === "max_tokens" ? [TRUNCATION_NOTE] : []),
    ];
    const base: Partial<ModelStatus> = {
      completedAt: snap.endedAt ?? new Date().toISOString(),
      exitCode: snap.exitCode,
      outputSize: Buffer.byteLength(answer, "utf8"),
      stopReason: e.stopReason,
      anomalies,
    };
    if (snap.state === "COMPLETED") return { ...base, error: undefined };
    return { ...base, error: slotError(e, snap, answer) };
  }

  /** The `ModelError` of a slot that did not complete; writes its error log first. */
  function slotError(e: SlotEntry, snap: PaneSnapshot, answer: string): ModelError {
    const reason: FailureReason =
      snap.reason ?? (snap.state === "CANCELLED" ? "cancelled" : "child_exited");
    const detail = reason === "cancelled" ? CANCELLED_DETAIL : (snap.detail ?? reason);
    const errorLogPath = errorLogPathOf(e.id);
    persistErrorLog(errorLogPath, `${snap.state}: ${reason}: ${detail}`, [
      ["final screen", snap.screenTail],
      [
        "exit code",
        snap.exitCode === null ? "(none: claudish ended the pane)" : String(snap.exitCode),
      ],
      ["anomalies", snap.anomalies.join("\n")],
      ["answer (tail)", answer.slice(-STDOUT_TAIL_LIMIT)],
    ]);
    const upstream = upstreamLogOf(e.id);
    return {
      model: e.id,
      command: commandOf(e),
      reason,
      detail,
      screenSnippet: snap.screenTail
        ? snippetHeadAndTail(redactSecrets(snap.screenTail))
        : undefined,
      answerSnippet: answer ? snippetHeadAndTail(redactSecrets(answer)) : undefined,
      errorLogPath,
      // Only when the child actually wrote one. Naming a file that does not exist
      // sends a reader after evidence that was never captured.
      upstreamErrorLogPath: existsSync(upstream) ? upstream : undefined,
      workDir: path,
    };
  }

  /** `onTransition`: every wire-state change, synchronously, before any frame. */
  function onSlotTransition(e: SlotEntry, snap: PaneSnapshot): void {
    if (aborting) return;
    const update = liveFields(e, snap);
    if (isTerminalState(snap.state)) Object.assign(update, terminalFields(e, snap));
    updateModelStatus(e.id, update);
    notifyStatus(e.id);
    if (run) markIfSettled(run);
  }

  /** A slot whose pane never spawned: FAILED `pane_lost` with the message; siblings continue. */
  function failNeverSpawned(e: SlotEntry, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const errorLogPath = errorLogPathOf(e.id);
    writeResponse(e, "");
    persistErrorLog(errorLogPath, `FAILED: pane_lost: ${msg}`, [["start", msg]]);
    updateModelStatus(e.id, {
      state: "FAILED",
      completedAt: new Date().toISOString(),
      outputSize: 0,
      pane: null,
      error: {
        model: e.id,
        command: commandOf(e),
        reason: "pane_lost",
        detail: `the pane never started: ${msg}`,
        errorLogPath,
        workDir: path,
      },
    });
    notifyStatus(e.id);
  }

  const cwd = process.cwd();
  const projects = projectsDir(parentEnv);

  async function startSlot(e: SlotEntry, uuid: string, transcriptPath: string): Promise<void> {
    let session: PaneSession;
    try {
      session = await startPaneSession({
        kind: "t",
        label: e.id,
        callerFlags: claudeFlags,
        spawnModel: e.spawnModel ?? e.model,
        cwd,
        sessionUuid: uuid,
        transcriptPath,
        slotEnv: {
          // Point this child's token tracker at a path WE choose, so its tokens/cost
          // can be attributed back to this model.
          [ENV.CLAUDISH_TOKEN_FILE]: e.tokenFile,
          // Per SLOT, unconditionally: the records carry no slot id, so one shared
          // path would interleave every model in the run into an unattributable file.
          [UPSTREAM_ERROR_LOG_ENV]: upstreamLogOf(e.id),
        },
        shape: "one-shot",
        initialPrompt: inputContent,
        readAvailable,
        decide: (turn) => teamDecide(e, turn),
        onBlocked: (b) => teamOnBlocked(e, b),
        onTransition: (t) => onSlotTransition(e, t.snap),
        parentEnv,
        ...(opts.bootTimeoutMs !== undefined ? { bootTimeoutMs: opts.bootTimeoutMs } : {}),
        ...(opts.paneTimings ? { timings: opts.paneTimings } : {}),
      });
    } catch (err) {
      failNeverSpawned(e, err);
      return;
    }
    e.session = session;
    updateModelStatus(e.id, { pane: session.paneId });
  }

  const slotIds = Object.keys(manifest.models);
  reservePanes(slotIds.length, sockRootFor(parentEnv));
  // Each startSlot call consumes exactly one reservation, whether its pane starts or not.
  let reservationsLeft = slotIds.length;
  const starts: Promise<void>[] = [];

  // The spawn loop has its own catch because NOTHING after it exists yet when it
  // throws: the ticker, the registry entry and `done` are all built below. A failed
  // status.json write for slot N would otherwise leave slots 1..N-1 running and billing
  // with no `done` and no registry entry to cancel them through. A slot's own
  // startPaneSession throw is NOT such a throw: it is that slot's FAILED pane_lost.
  try {
    let i = 0;
    for (const [id, entry] of Object.entries(manifest.models)) {
      await beforeSpawn(i++, flight);
      // Spawn with the parent-resolved explicit spec when there is one, so the child
      // skips routing entirely and finds its key in the inherited env. ABSENT from the
      // map means "spawn it bare". The manifest keeps `entry.model` (the user's string)
      // as the run's identity; only argv changes.
      const spawnModel = spawnPlan.pinned.get(entry.model) ?? entry.model;
      const tokenFile = tokenFileFor(path, id);
      const provider = resolveProvider({ model: entry.model, spawnModel, tokenFile: null });
      const e: SlotEntry = {
        id,
        model: entry.model,
        spawnModel,
        tokenFile,
        session: null,
        acct: emptyAccounting(provider),
        answer: null,
        stopReason: null,
      };
      entries.set(id, e);
      const uuid = randomUUID();
      // Team children run in the server's cwd, as before; the launcher `cd`s there.
      const transcriptPath = transcriptPathFor(cwd, uuid, projects);
      updateModelStatus(id, {
        state: "STARTING",
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
        outputSize: 0,
        model: entry.model,
        spawnModel,
        provider,
        sessionUuid: uuid,
        transcriptPath,
        pane: null,
        captureSource: null,
        turnSource: "transcript",
        stopReason: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        toolCalls: 0,
        turnsCompleted: 0,
        lastActivityAt: null,
      });
      const start = startSlot(e, uuid, transcriptPath);
      // Observed by the Promise.all below; until then a rejection must not count as
      // unhandled while the loop is still staggering.
      start.catch(() => undefined);
      starts.push(start);
      reservationsLeft--;
    }
    await Promise.all(starts);
  } catch (err) {
    // Nothing reported as failed to start may keep running or billing: stop every pane
    // already started (§2.10: close_pane, magmux, then SIGTERM and SIGKILL on the
    // verified group) and only then let the ORIGINAL error out, so the caller's
    // `start-failed` record is true when it is written. `onSettled` is NOT called — no
    // run started; the caller records the failure.
    aborting = true;
    await Promise.allSettled(starts);
    const started = [...entries.values()]
      .map((e) => e.session)
      .filter((s): s is PaneSession => s !== null);
    for (const s of started) s.cancel();
    await Promise.all(started.map((s) => s.reaped().catch(() => undefined)));
    releasePaneReservations(reservationsLeft);
    throw err;
  }

  // ── Live progress ─────────────────────────────────────────────────────────
  // Two different cadences, deliberately:
  //   · status.json / status.txt — rewritten every poll. Files; frequency is free.
  //   · onProgress — only when the run's state actually CHANGES, plus a slow
  //                  heartbeat. Each frame renders as its own new line in the
  //                  client, so a fixed short tick would bury the transcript in
  //                  near-identical rows (a 15-min run at 5s = ~180 lines).
  const POLL_MS = 2000;
  const heartbeatMs = (opts.heartbeatSeconds ?? 60) * 1000;

  let lastSignature = "";
  let lastEmitMs = 0;

  /**
   * What "changed" means for emission purposes. EXCLUDES elapsed time and raw token
   * counts: both tick continuously, and keying on them re-creates the spam this dedupe
   * exists to stop. Token totals still ride along on whatever frame does get emitted.
   */
  const stateSignature = (): string =>
    Object.entries(statusCache.models)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, m]) => `${id}:${m.state}:${m.outputSize}`)
      .join("|");

  const emitProgress = (phase: "running" | "settled" = "running"): void => {
    const elapsedSeconds = (Date.now() - startMs) / 1000;
    writeStatusFile(path, manifest, statusCache, { elapsedSeconds });
    if (!opts.onProgress) return;

    const signature = stateSignature();
    const changed = signature !== lastSignature;
    const heartbeatDue = Date.now() - lastEmitMs >= heartbeatMs;
    // A settled run must always emit — it is the terminal frame.
    if (phase !== "settled" && !changed && !heartbeatDue) return;

    lastSignature = signature;
    lastEmitMs = Date.now();

    try {
      const models = Object.values(statusCache.models);
      opts.onProgress({
        rendered: renderTeamStatsCompact(path, manifest, statusCache, { elapsedSeconds }),
        phase,
        allFailed: models.length > 0 && models.every((m) => m.state !== "COMPLETED"),
      });
    } catch {
      // A progress consumer must never be able to fail the run.
    }
  };

  /** Fresh accounting for disk readers (§3.1): every non-terminal slot, one write. */
  const refreshLiveSlots = (): void => {
    let dirty = false;
    for (const e of entries.values()) {
      if (!e.session) continue;
      const snap = e.session.snapshot();
      if (isTerminalState(snap.state)) continue;
      patchModelStatus(e.id, liveFields(e, snap));
      dirty = true;
    }
    if (dirty) {
      try {
        flushStatus();
      } catch {
        // the next tick retries; a state change writes on its own
      }
    }
  };

  // The registry entry exists from here, before the D9 `ready` await, so a run is
  // listable and cancellable once all of its panes exist (§3.2, §20.3).
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((r) => {
    resolveSettled = r;
  });
  run = {
    runId,
    path,
    kind,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: null,
    status: statusCache,
    slots: entries,
    settled,
  };
  teamRuns.set(runId, run);
  newestRunByPath.set(path, runId);
  pruneRuns();
  markIfSettled(run);

  emitProgress(); // one immediately, so status.txt exists from the start
  const progressHandle = setInterval(() => {
    refreshLiveSlots();
    emitProgress("running");
  }, POLL_MS);
  // Don't hold the event loop open on the ticker alone.
  progressHandle.unref?.();

  // D9: return once every slot has left STARTING. `ready` never rejects: it resolves on
  // any exit from STARTING, terminal included.
  await Promise.all([...entries.values()].map((e) => e.session?.ready ?? Promise.resolve()));

  const liveRun = run;
  // Built last, immediately before the return, and nothing after it can throw: the
  // record's one end (`onSettled`) can therefore never race the handler's start-failed
  // `catch` (§20.3 item 1).
  const done = (async (): Promise<TeamStatus> => {
    // The caller resumes from `await startModels(...)` before this body runs on, even
    // for a run whose every slot already ended.
    await new Promise((r) => setImmediate(r));
    try {
      await Promise.all([...entries.values()].map((e) => e.session?.terminal ?? Promise.resolve()));
    } finally {
      clearInterval(progressHandle);
      markIfSettled(liveRun);
      if (liveRun.finishedAt === null) liveRun.finishedAt = new Date().toISOString();
      // Terminal frame. Without this a status-tracking consumer never sees the run
      // close — every frame would read "running", including the last one.
      emitProgress("settled");
      // The caller's settle hook, exactly once, after the settled render. Its own try,
      // the `onProgress` convention: a consumer can never fail the run.
      try {
        opts.onSettled?.(statusCache);
      } catch {
        // A settle consumer must never be able to fail the run.
      }
      resolveSettled();
    }
    return statusCache;
  })();
  // A caller that only polls never touches `done`. Without this an unobserved rejection
  // would take down the MCP server, which hosts every other session too.
  done.catch(() => {});

  return {
    runId,
    teamSessionId: basename(path),
    sessionPath: path,
    // Display model → anonymised slot. The manifest is shuffled for blind JUDGING,
    // which protects the judge children reading response-<id>.md without a manifest.
    // It was never hidden from the orchestrating caller.
    slots: Object.fromEntries(
      Object.entries(manifest.models).map(([anonId, entry]) => [entry.model, anonId])
    ),
    done,
  };
}

/**
 * Start every model and wait for all of them.
 *
 * The blocking form of `startModels`, kept for the pipeline modes that are
 * inherently sequential: `run-and-judge` cannot judge answers that do not exist
 * yet. Prefer `startModels` anywhere the caller can poll instead, because this
 * form makes the run's duration the CALLER's problem — and an MCP client aborts
 * a tool call that stays silent too long.
 */
export async function runModels(
  sessionPath: string,
  opts: TeamRunOptions = {}
): Promise<TeamStatus> {
  const handle = await startModels(sessionPath, opts);
  return handle.done;
}

/**
 * Judge existing responses blindly.
 * Reads response-*.md files, sends to judge models, collects votes, aggregates verdict.
 */
export async function judgeResponses(
  sessionPath: string,
  opts: TeamJudgeOptions = {}
): Promise<TeamVerdict> {
  // Response files are written only at a slot's terminal transition: judging a run that
  // is still ACTIVE would silently vote on the subset that happens to have finished.
  const active = activeRunAt(resolve(sessionPath));
  if (active)
    throw new Error(
      `invalid_args: the team run at ${resolve(sessionPath)} is still ACTIVE (run_id ${active.runId}); judge it once it has settled`
    );
  // Collect all response files in sorted order
  const responseFiles = readdirSync(sessionPath)
    .filter((f) => f.startsWith("response-") && f.endsWith(".md"))
    .sort();

  if (responseFiles.length < 2) {
    throw new Error(`Need at least 2 responses to judge, found ${responseFiles.length}`);
  }

  const responses: Record<string, string> = {};
  for (const file of responseFiles) {
    const id = file.replace(/^response-/, "").replace(/\.md$/, "");
    responses[id] = readFileSync(join(sessionPath, file), "utf-8");
  }

  // Build and save judge prompt
  const input = readFileSync(join(sessionPath, "input.md"), "utf-8");
  const judgePrompt = buildJudgePrompt(input, responses);
  writeFileSync(join(sessionPath, "judge-prompt.md"), judgePrompt, "utf-8");

  // Determine judge models (default: same models that produced responses)
  const judgeModels = opts.judges ?? getDefaultJudgeModels(sessionPath);

  // Run judges in a sub-session under sessionPath/judging/
  const judgePath = join(sessionPath, "judging");
  mkdirSync(judgePath, { recursive: true });

  setupSession(judgePath, judgeModels, judgePrompt);
  // The judge prompt (rubric + every response) is not a plain line, so it reaches each
  // judge as a task file it Reads; an incomplete read is FAILED prompt_not_read, never a
  // verdict on part of the input.
  await runModels(judgePath, {
    claudeFlags: opts.claudeFlags,
    kind: "judge",
    ...(opts.parentEnv ? { parentEnv: opts.parentEnv } : {}),
    ...(opts.paneTimings ? { paneTimings: opts.paneTimings } : {}),
  });

  // Parse votes from judge outputs
  const votes = parseJudgeVotes(judgePath, Object.keys(responses));

  // Aggregate votes into a verdict
  const verdict = aggregateVerdict(votes, Object.keys(responses));

  // Write verdict.md (reveals model names since judging is complete)
  writeFileSync(join(sessionPath, "verdict.md"), formatVerdict(verdict, sessionPath), "utf-8");

  return verdict;
}

/**
 * Get current status of a team session.
 */
export function getStatus(sessionPath: string): TeamStatus {
  return JSON.parse(readFileSync(join(sessionPath, "status.json"), "utf-8"));
}

/**
 * `<sessionPath>/status.json`, or a status with an EMPTY `models` map when it
 * cannot be read. Never throws: it feeds the start-failure record, which must
 * be written whatever state the run's directory is in.
 */
export function readTeamStatus(sessionPath: string): TeamStatus {
  try {
    const parsed = getStatus(sessionPath);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.models &&
      typeof parsed.models === "object"
    ) {
      return parsed;
    }
  } catch {
    // Unreadable or partial — `status.json` writes are not atomic.
  }
  return { startedAt: new Date().toISOString(), models: {} };
}

/**
 * How one `team(mode:"run")` ended, as its session-directory record states it
 * (`<sessionsDir>/team-<8 hex>/meta.json`, written by `finishTeamRun`).
 */
export interface TeamRunOutcome {
  status: "completed" | "failed" | "cancelled";
  slots: number;
  ok: number;
  failed: number;
  cancelled: number;
  /** Present only when the run never started: `startModels` threw. */
  reason?: "start-failed";
}

/**
 * Counts and verdict for ANY `TeamStatus`, settled or not, so a run that failed
 * partway still yields counts.
 *
 * - `COMPLETED` → ok.
 * - a terminal row whose `error.reason` is `cancelled` → cancelled (a CANCELLED row
 *   always carries it); with any other reason → failed.
 * - every non-terminal row (STARTING, RUNNING, AWAITING_*) → failed. A settled run has
 *   none; in a run that failed to start they are the slots never started and the slots
 *   just stopped. The magus monitor's heartbeat applies the same rule.
 *
 * `slots` is the number of entries. `status` is `completed` when at least one
 * slot is ok (the channel frame's rule), `cancelled` when every slot was
 * cancelled, otherwise `failed`.
 */
export function summarise(status: TeamStatus): TeamRunOutcome {
  const models = Object.values(status?.models ?? {});
  let ok = 0;
  let failed = 0;
  let cancelled = 0;
  for (const model of models) {
    if (model?.state === "COMPLETED") ok++;
    else if (model?.error?.reason === "cancelled" && TERMINAL_STATES.includes(model.state)) {
      cancelled++;
    } else failed++;
  }
  const slots = models.length;
  const verdict: TeamRunOutcome["status"] =
    ok >= 1 ? "completed" : slots > 0 && cancelled === slots ? "cancelled" : "failed";
  return { status: verdict, slots, ok, failed, cancelled };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

export function fisherYatesShuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getDefaultJudgeModels(sessionPath: string): string[] {
  const manifest: TeamManifest = JSON.parse(
    readFileSync(join(sessionPath, "manifest.json"), "utf-8")
  );
  return Object.values(manifest.models).map((e) => e.model);
}

export function buildJudgePrompt(input: string, responses: Record<string, string>): string {
  const ids = Object.keys(responses).sort();
  let prompt = "## Blind Evaluation Task\n\n";
  prompt += "### Original Task\n\n";
  prompt += `${input}\n\n`;
  prompt += "---\n\n";
  prompt += "### Responses to Evaluate\n\n";
  prompt +=
    "Evaluate each response independently. You do not know which model produced which response.\n\n";

  for (const id of ids) {
    prompt += `#### Response ${id}\n\n`;
    prompt += `${responses[id]}\n\n`;
    prompt += "---\n\n";
  }

  prompt += "### Your Assignment\n\n";
  prompt += `For EACH of the ${ids.length} responses above, provide a vote block in this exact format:\n\n`;
  prompt += "```vote\n";
  prompt += "RESPONSE: [ID]\n";
  prompt += "VERDICT: [APPROVE|REJECT|ABSTAIN]\n";
  prompt += "CONFIDENCE: [1-10]\n";
  prompt += "SUMMARY: [One sentence]\n";
  prompt += "KEY_ISSUES: [Comma-separated issues, or None]\n";
  prompt += "```\n\n";
  prompt += `Provide exactly ${ids.length} vote blocks, one per response. Be decisive and analytical.\n`;

  return prompt;
}

export function parseJudgeVotes(judgePath: string, responseIds: string[]): VoteResult[] {
  const votes: VoteResult[] = [];
  const responseFiles = readdirSync(judgePath)
    .filter((f) => f.startsWith("response-") && f.endsWith(".md"))
    .sort();

  for (const file of responseFiles) {
    const judgeId = file.replace(/^response-/, "").replace(/\.md$/, "");
    let content: string;
    try {
      content = readFileSync(join(judgePath, file), "utf-8");
    } catch {
      continue;
    }

    // Parse ```vote ... ``` blocks
    const votePattern = /```vote\s*\n([\s\S]*?)\n\s*```/g;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical RegExp.exec() iteration idiom
    while ((match = votePattern.exec(content)) !== null) {
      const block = match[1];
      const responseMatch = block.match(/RESPONSE:\s*(\S+)/);
      const verdictMatch = block.match(/VERDICT:\s*(APPROVE|REJECT|ABSTAIN)/);
      const confidenceMatch = block.match(/CONFIDENCE:\s*(\d+)/);
      const summaryMatch = block.match(/SUMMARY:\s*(.+)/);
      const keyIssuesMatch = block.match(/KEY_ISSUES:\s*(.+)/);

      const responseId = responseMatch?.[1];
      const verdict = verdictMatch?.[1];

      if (!responseId || !verdict) continue;
      // Only record votes for IDs we expect
      if (!responseIds.includes(responseId)) continue;

      votes.push({
        judgeId,
        responseId,
        verdict: verdict as "APPROVE" | "REJECT" | "ABSTAIN",
        confidence: Number.parseInt(confidenceMatch?.[1] ?? "5", 10),
        summary: summaryMatch?.[1]?.trim() ?? "",
        keyIssues:
          keyIssuesMatch?.[1]
            ?.split(",")
            .map((s) => s.trim())
            .filter((s) => s.toLowerCase() !== "none" && s.length > 0) ?? [],
      });
    }
  }

  return votes;
}

export function aggregateVerdict(votes: VoteResult[], responseIds: string[]): TeamVerdict {
  const responses: TeamVerdict["responses"] = {};

  for (const id of responseIds) {
    const votesForResponse = votes.filter((v) => v.responseId === id);
    const approvals = votesForResponse.filter((v) => v.verdict === "APPROVE").length;
    const rejections = votesForResponse.filter((v) => v.verdict === "REJECT").length;
    const abstentions = votesForResponse.filter((v) => v.verdict === "ABSTAIN").length;
    const total = approvals + rejections;

    responses[id] = {
      approvals,
      rejections,
      abstentions,
      score: total > 0 ? approvals / total : 0,
    };
  }

  const ranking = Object.entries(responses)
    .sort(([, a], [, b]) => b.score - a.score)
    .map(([id]) => id);

  return { responses, ranking, votes };
}

function formatVerdict(verdict: TeamVerdict, sessionPath: string): string {
  let manifest: TeamManifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(join(sessionPath, "manifest.json"), "utf-8"));
  } catch {
    // If manifest is missing we just won't show model names
  }

  let output = "# Team Verdict\n\n";
  output += "## Ranking\n\n";
  output += "| Rank | Response | Model | Score | Approvals | Rejections | Abstentions |\n";
  output += "|------|----------|-------|-------|-----------|------------|-------------|\n";

  for (let i = 0; i < verdict.ranking.length; i++) {
    const id = verdict.ranking[i];
    const r = verdict.responses[id];
    const modelName = manifest?.models[id]?.model ?? "unknown";
    const scoreStr = `${(r.score * 100).toFixed(0)}%`;
    output += `| ${i + 1} | ${id} | ${modelName} | ${scoreStr} | ${r.approvals} | ${r.rejections} | ${r.abstentions} |\n`;
  }

  output += "\n## Individual Votes\n\n";
  for (const vote of verdict.votes) {
    const issueStr = vote.keyIssues.length > 0 ? ` Issues: ${vote.keyIssues.join(", ")}.` : "";
    output += `- **Judge ${vote.judgeId}** -> Response ${vote.responseId}: **${vote.verdict}** (${vote.confidence}/10) — ${vote.summary}${issueStr}\n`;
  }

  return output;
}
