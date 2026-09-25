import { type ChildProcess, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { type SpawnPlan, prehydrateCredentialsForSpawn } from "./auth/credentials/prehydrate.js";
import { StreamJsonReducer } from "./channel/stream-json-reducer.js";
import { ENV } from "./config.js";
import { UPSTREAM_ERROR_LOG_ENV } from "./handlers/shared/upstream-error-capture.js";
import { KILL_PROCESS_GROUP, signalProcessTree, terminateChildTree } from "./process-tree.js";
import { redactSecrets } from "./redact.js";
import { resolveClaudishSpawn } from "./spawn-claudish.js";
import { decodeChunk, newStdioDecoder } from "./stdio-decode.js";
import { renderTeamStatsCompact, statsDir, tokenFileFor, writeStatusFile } from "./team-stats.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamManifest {
  created: string;
  models: Record<string, { model: string; assignedAt: string }>;
  shuffleOrder: string[];
}

/**
 * Why a run is being reported as unusable.
 *
 * Exit code alone is a bad success oracle here: `claude -p` exits 0 on API
 * errors and on background-task termination just as it does on real success.
 * Classifying the failure means the caller never has to infer it from byte counts.
 */
export type FailureReason =
  | "nonzero_exit"
  /**
   * The caller stopped this slot through `team(mode:"cancel")`. NOT a defect —
   * the only failure reason here that reflects a decision rather than a fault.
   */
  | "cancelled"
  /**
   * Only `team-grid.ts` produces this now, mapping magmux's pane states. The
   * orchestrator has no deadline and never terminates a slot itself — see
   * ai-docs/architecture/team-lifecycle.md.
   */
  | "timeout"
  | "api_error"
  | "background_task_ceiling"
  | "empty_output"
  | "shape_mismatch";

/**
 * How a child's answer is read off its stdout. See TeamRunOptions.captureMode.
 */
export type TeamCaptureMode = "stream-json" | "print";

/** Escape hatch, so `"print"` is reachable without editing a call site. */
export const TEAM_CAPTURE_ENV_VAR = "CLAUDISH_TEAM_CAPTURE";

/**
 * Resolve the capture mode: explicit option wins, then the env var, then
 * recovery-on by default.
 *
 * Only the exact string `"print"` opts out. Garbage resolves to the default
 * rather than throwing — a typo in an env var must not fail a whole team run,
 * and the safe direction is the one that keeps more of the answer.
 */
export function resolveCaptureMode(
  explicit: TeamCaptureMode | undefined,
  env: NodeJS.ProcessEnv = process.env
): TeamCaptureMode {
  if (explicit) return explicit;
  return env[TEAM_CAPTURE_ENV_VAR]?.trim().toLowerCase() === "print" ? "print" : "stream-json";
}

export interface ModelError {
  /** Model ID that failed (anonymized id used in the report). */
  model: string;
  /** The command that was run. */
  command: string;
  /** Failure classification. */
  reason: FailureReason;
  /** One-line human-readable explanation of `reason`. */
  detail: string;
  /** Tail of the captured stderr, if any. */
  stderrSnippet?: string;
  /** Tail of the captured stdout — the failure signal often lands here, not on stderr. */
  stdoutSnippet?: string;
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
  /** Working directory the child ran in. */
  workDir: string;
}

/**
 * EMPTY = the child exited 0 but its stdout is not a usable answer (an API
 * error, a truncated preamble, or fewer than `minOutputBytes`). Distinct from
 * FAILED so callers can tell "the process broke" from "the process lied".
 */
export type ModelState = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "EMPTY";

export interface ModelStatus {
  state: ModelState;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  outputSize: number;
  /** Populated on FAILED/TIMEOUT/EMPTY with details for the failure report. */
  error?: ModelError;
}

export interface TeamStatus {
  startedAt: string;
  models: Record<string, ModelStatus>;
}

export interface TeamRunOptions {
  claudeFlags?: string[]; // extra flags passed to child claudish
  onStatusChange?: (id: string, status: ModelStatus) => void;
  /**
   * Opt-in stub threshold: below this many stdout bytes an exit-0 run is
   * recorded EMPTY. Default 0 (off) — see DEFAULT_MIN_OUTPUT_BYTES for why.
   * Whitespace-only output is caught regardless of this setting.
   */
  minOutputBytes?: number;
  /**
   * Opt-in SHAPE contract: a JS regex source string the response must match, or
   * the run is recorded EMPTY with reason `shape_mismatch`.
   *
   * This is the only signal that catches a child which answered correctly and
   * then took one more turn. `claude -p` prints ONLY the final assistant
   * message, so any post-answer turn (a background Task completing, a
   * notification arriving) silently replaces the answer with an epilogue —
   * exit 0, no API error, real non-whitespace prose. Measured: two models
   * turned 7,743 and 4,737 output tokens into 250 B and 396 B of "the review
   * above stands", and both were reported `succeeded`.
   *
   * Byte counts cannot separate that from a legitimately short answer (a
   * measured 96 B reply is valid — see DEFAULT_MIN_OUTPUT_BYTES). A caller that
   * mandated an output shape, however, KNOWS what a complete answer looks like:
   * `team`'s prompts require a fenced ```vote block, so "```vote" is a precise
   * oracle where length is a guess.
   *
   * Matched against the FULL response, not the bounded tail.
   */
  requirePattern?: string;
  /**
   * How a child's answer is captured off its stdout. Default `"stream-json"`.
   *
   * - `"stream-json"` — children run under `--output-format stream-json` and
   *   the orchestrator concatenates every assistant text block. A child that
   *   answers and then takes one more turn keeps its answer.
   * - `"print"` — the pre-v7.50 raw pipe: whatever `claude -p` prints, which is
   *   ONLY the final assistant message. Kept as an escape hatch for diagnosing
   *   a capture problem by comparing the two, and reachable without a code
   *   change via `CLAUDISH_TEAM_CAPTURE=print`.
   *
   * `requirePattern` is worth keeping ON under `"stream-json"`: recovery fixes
   * answers that were LOST, not answers the model never shaped correctly.
   */
  captureMode?: TeamCaptureMode;
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
}

/**
 * A running team, handed back the moment its children exist.
 *
 * This is what makes a team run addressable without blocking on it. The caller
 * gets the ids it needs to ask questions later, and asks them through
 * `getStatus(sessionPath)` — which reports each slot's state, bytes and tokens —
 * rather than by holding a tool call open for the length of the run.
 */
export interface TeamHandle {
  /**
   * Stable id for the whole run: the session directory's basename. Already the
   * id used for this run's channel frames, so a caller correlating frames to a
   * run needs no second identifier.
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
   * Settles when every slot has finished. Nothing needs to await it — the run
   * completes and writes its files either way — and a caller that only polls
   * `getStatus` can ignore it entirely.
   */
  done: Promise<TeamStatus>;
}

/** What the registry needs to answer questions about a run still in flight. */
interface LiveTeamRun {
  sessionPath: string;
  processes: Map<string, ChildProcess>;
  idleMsFor: (slotId: string) => number | null;
  activityFor: (slotId: string) => string | null;
  liveBytesFor: (slotId: string) => number | null;
  /**
   * Whether the slot is still RUNNING. The run stays registered until its LAST
   * slot settles, so without this an exited slot kept reporting its frozen
   * activity and an idle clock that grew for as long as its siblings worked.
   */
  isRunning: (slotId: string) => boolean;
  /** Marked before the signal, so the exit handler can tell stopped from crashed. */
  cancelledSlots: Set<string>;
}

/**
 * Team runs currently in flight, keyed by `teamSessionId`.
 *
 * This exists because `startModels` returns before its children do. Once the
 * run outlives the call that started it, something has to let a later call
 * reach back into it — to read how long a slot has been quiet, and to stop one.
 *
 * Entries are removed when the run settles, so a completed run answers from
 * `status.json` on disk rather than from memory, and the map cannot grow without
 * bound in a long-lived MCP server.
 */
const liveTeamRuns = new Map<string, LiveTeamRun>();

/**
 * Seconds each still-running slot has been silent, or null if the run is not
 * live (never started here, or already settled — read `status.json` instead).
 *
 * INFORMATION ONLY. Nothing in claudish terminates a slot for being quiet. A
 * child inside `go test ./...` writes nothing for minutes and is working; only
 * the caller that set the task knows whether that is expected. Read this, then
 * call `cancelTeamRun` or do not.
 */
export function teamSlotIdleSeconds(teamSessionId: string): Record<string, number> | null {
  const run = liveTeamRuns.get(teamSessionId);
  if (!run) return null;
  const out: Record<string, number> = {};
  for (const slotId of run.processes.keys()) {
    if (!run.isRunning(slotId)) continue;
    const idle = run.idleMsFor(slotId);
    if (idle !== null) out[slotId] = Math.round(idle / 1000);
  }
  return out;
}

/**
 * What each still-running slot is doing, from the stream-json reducer:
 * `running`, `tool_executing` or `waiting_for_input`. Null for a run that is not
 * live; a slot is absent once it has exited (its outcome is `state` in
 * `status.json`), and under `"print"` capture, which emits no frames to read.
 *
 * The companion to `teamSlotIdleSeconds`, and the reason that number is safe to
 * publish without a verdict attached. Ninety seconds of silence in
 * `tool_executing` is a build running; the same ninety seconds in `running` is
 * a model that stopped mid-answer. The old reaper could not tell those apart —
 * it had no state at all — and killed the first kind.
 */
export function teamSlotActivity(teamSessionId: string): Record<string, string> | null {
  const run = liveTeamRuns.get(teamSessionId);
  if (!run) return null;
  const out: Record<string, string> = {};
  for (const slotId of run.processes.keys()) {
    if (!run.isRunning(slotId)) continue;
    const activity = run.activityFor(slotId);
    if (activity !== null) out[slotId] = activity;
  }
  return out;
}

/**
 * Bytes of ANSWER each still-running slot has produced so far, or null for a run
 * that is not live here.
 *
 * The field `outputSize` is not this. `outputSize` is written once, in `finish()`,
 * so it reads 0 for the whole life of a RUNNING slot however much that slot has
 * written — and a caller that reads it as progress concludes a working slot
 * produced nothing. That misreading is the reason this exists.
 *
 * Same unit as `outputSize`, deliberately: both count recovered answer prose, so
 * this number grows into the one the slot finishes with. It lags by at most one
 * unterminated line, which the stream-json reducer holds back until its newline
 * arrives (see `ModelRuntime.flushPartial`).
 *
 * Volume, not liveness. Read it with `teamSlotIdleSeconds` and `teamSlotActivity`:
 * a slot can legitimately sit at 0 B for minutes while a build runs.
 */
export function teamSlotLiveBytes(teamSessionId: string): Record<string, number> | null {
  const run = liveTeamRuns.get(teamSessionId);
  if (!run) return null;
  const out: Record<string, number> = {};
  for (const slotId of run.processes.keys()) {
    if (!run.isRunning(slotId)) continue;
    const bytes = run.liveBytesFor(slotId);
    if (bytes !== null) out[slotId] = bytes;
  }
  return out;
}

/**
 * Terminate one slot, or every slot in a run, on the caller's instruction.
 *
 * The ONLY thing that kills a team slot. The orchestrator used to do it on a
 * timer and got it wrong — three productive slots died in session
 * team-20260827-0015 because silence during a long tool call was read as death.
 * The decision now belongs to whoever set the task and can tell a slow build
 * from a hang.
 *
 * Kills the process GROUP, not the pid: `claudish` is a launcher that runs the
 * real CLI under Bun, which runs `claude`. Signalling the direct child reaches
 * only the launcher and leaves the tree alive, still billing and still holding
 * the response pipe open.
 */
export async function cancelTeamRun(
  teamSessionId: string,
  slotId?: string
): Promise<{ found: boolean; cancelled: string[] }> {
  const run = liveTeamRuns.get(teamSessionId);
  if (!run) return { found: false, cancelled: [] };

  const targets = slotId ? (run.processes.has(slotId) ? [slotId] : []) : [...run.processes.keys()];

  const cancelled: string[] = [];
  for (const id of targets) {
    const proc = run.processes.get(id);
    if (!proc) continue;
    // Marked BEFORE the signal. The exit handler can fire as soon as the process
    // dies, and a mark set afterwards would lose the race and file a deliberate
    // stop as a crash.
    run.cancelledSlots.add(id);
    await terminateChildTree(proc);
    cancelled.push(id);
  }
  return { found: true, cancelled };
}

/**
 * Terminate every live team run. Process shutdown only.
 *
 * Needed because `startModels` returns before its children do: a run now
 * outlives the call that started it, so nothing else would reach these children
 * when the host process is asked to stop. Without this they survive their parent
 * and keep billing — the same orphaning `cancelTeamRun` guards against, one
 * level up.
 *
 * The per-run SIGINT handler covers Ctrl+C. This covers SIGTERM, which that
 * handler does not see.
 */
export async function shutdownAllTeamRuns(): Promise<void> {
  await Promise.all([...liveTeamRuns.keys()].map((id) => cancelTeamRun(id).catch(() => undefined)));
}

export interface TeamJudgeOptions {
  judges?: string[]; // models to use as judges (default: same models as runners)
  claudeFlags?: string[];
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

// ─── Output Classification ────────────────────────────────────────────────────

/**
 * How many trailing stdout bytes we retain per child for diagnosis. Bounded so a
 * 30 KB answer isn't buffered twice; exported-by-const so `classifyRunOutput`
 * knows when the tail it was handed is the complete output.
 */
export const STDOUT_TAIL_LIMIT = 4000;

/** Budget for the stdout snippet recorded in `status.json`. */
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

/** Claude Code prints API failures into its stdout and still exits 0. */
const API_ERROR_RE = /\[API Error:\s*([^\]]{0,300})\]/i;

/**
 * Claude Code's print-mode background-task ceiling. When it fires, the turn is
 * terminated, whatever text was already emitted is flushed, and the exit code
 * is 0 — so the run looks successful while carrying only a partial answer.
 */
const BG_CEILING_RE = /Background tasks still running after (\d+)s; terminating/i;

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

/* Process-tree termination lives in ./process-tree.ts — shared with the channel
   session manager, which had the identical orphaning bug in `cancel_session`. */

/**
 * Decide whether an exit-0 run actually produced an answer.
 * Returns null when the output looks usable.
 */
export function classifyRunOutput(opts: {
  outputSize: number;
  stdoutTail: string;
  stderr: string;
  minOutputBytes: number;
  /** Caller's shape contract (regex source). See TeamRunOptions.requirePattern. */
  requirePattern?: string;
  /**
   * The complete stdout, when the caller could read it back off disk.
   *
   * `stdoutTail` holds only the LAST STDOUT_TAIL_LIMIT bytes, so matching a
   * pattern against it would silently fail for any contract whose marker sits
   * near the START of a long answer. Falls back to the tail when absent, which
   * is exact whenever the tail IS the whole output.
   */
  fullOutput?: string;
  /**
   * How the answer was captured. Only changes the `shape_mismatch` EXPLANATION,
   * never the verdict: under `"print"` a missing marker is most likely an
   * answer that was discarded, while under `"stream-json"` every assistant
   * message was kept, so the model genuinely did not produce one. Pointing the
   * caller at the wrong one of those costs a wasted investigation.
   */
  captureMode?: TeamCaptureMode;
}): { reason: FailureReason; detail: string } | null {
  const {
    outputSize,
    stdoutTail,
    stderr,
    minOutputBytes,
    requirePattern,
    fullOutput,
    captureMode = "print",
  } = opts;

  const apiError = API_ERROR_RE.exec(stdoutTail);
  if (apiError) {
    return {
      reason: "api_error",
      detail: `Child exited 0 but stdout carries an API error: ${apiError[1]?.trim() || "unknown"}`,
    };
  }

  const bgCeiling = BG_CEILING_RE.exec(stderr);
  if (bgCeiling) {
    return {
      reason: "background_task_ceiling",
      detail:
        `Claude Code terminated the turn after ${bgCeiling[1]}s waiting on background tasks, ` +
        "flushing only partial output. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 in the child " +
        "environment to wait indefinitely, or tell the model not to spawn background work.",
    };
  }

  // Nothing but whitespace is never a real answer, at any threshold. This is
  // what actually catches the observed 1-byte "\n" run.
  //
  // Guarded on outputSize: `stdoutTail` holds only the LAST STDOUT_TAIL_LIMIT
  // bytes, so a large answer that happens to end in padding would otherwise be
  // misread as empty. Only trust the tail when it IS the whole output.
  const tailIsWholeOutput = outputSize <= STDOUT_TAIL_LIMIT;
  if (outputSize === 0 || (tailIsWholeOutput && stdoutTail.trim().length === 0)) {
    return {
      reason: "empty_output",
      detail: `Child exited 0 but produced no non-whitespace output (${outputSize} B).`,
    };
  }

  // Opt-in stub threshold. Off by default — see DEFAULT_MIN_OUTPUT_BYTES.
  if (minOutputBytes > 0 && outputSize < minOutputBytes) {
    return {
      reason: "empty_output",
      detail:
        `Child exited 0 but produced only ${outputSize} B of stdout ` +
        `(caller required at least ${minOutputBytes} B).`,
    };
  }

  // Shape contract, checked LAST: the structural failures above are cheaper and
  // give better detail, and a run that hit one of them would fail this too —
  // reporting "no ```vote block" for what is really an API error would send the
  // caller after the wrong problem.
  if (requirePattern) {
    const haystack = fullOutput ?? stdoutTail;
    let re: RegExp | null = null;
    try {
      re = new RegExp(requirePattern);
    } catch {
      // An unusable pattern must never fail a run that may be perfectly good.
      // runModels validates up front so the caller hears about it before any
      // model is spawned; this branch only guards a direct call.
      re = null;
    }
    if (re && !re.test(haystack)) {
      const cause =
        captureMode === "stream-json"
          ? "Every assistant message this child produced was captured and concatenated, " +
            "so this is not the print-mode dropout: the model genuinely never emitted the " +
            "required shape. Re-prompt it, or relax the contract."
          : "This is the signature of a child that answered and then took one more turn: " +
            "`claude -p` prints only the FINAL assistant message, so a background task " +
            "completing (or any late notification) replaces the real answer with an " +
            "epilogue about it. The answer was generated, it just was not the last thing " +
            "said — re-run with the default stream-json capture to keep it.";
      return {
        reason: "shape_mismatch",
        detail:
          `Child exited 0 with ${outputSize} B, but the response does not match the ` +
          `required pattern /${requirePattern}/. ${cause}`,
      };
    }
  }

  return null;
}

/**
 * stderr lines that every healthy child emits, and which say nothing about the
 * run's outcome.
 *
 * `unrecognized_model` is Claude Code telling itself it does not know the model
 * name claudish routed — which is the NORMAL case for a proxied model and is
 * emitted by runs that exit 0 with a perfect answer. In session
 * team-20260815-115227 all four successful models produced an ~80 B
 * `errors/NN.log` containing nothing else, so the run looked like it had four
 * errors it did not have, and a reader scanning for real failures had to open
 * each one to find out.
 *
 * Deliberately anchored on Claude Code's own `[claude-code:...]` tag rather than
 * on the model name, so it cannot accidentally swallow a provider's message.
 */
const BENIGN_STDERR_PATTERNS: readonly RegExp[] = [/^\s*\[claude-code:unrecognized_model\]/];

/**
 * The part of stderr that is worth persisting — everything that is not known
 * boilerplate. Empty means "nothing happened worth a log file".
 *
 * NOTE this filters only what decides whether to WRITE a success-path log. A
 * genuine failure still persists the RAW stderr through `persistErrorLog`,
 * because in that case even the boilerplate is context for whoever is reading.
 */
export function meaningfulStderr(stderr: string): string {
  if (!stderr) return "";
  return stderr
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !BENIGN_STDERR_PATTERNS.some((re) => re.test(line)))
    .join("\n")
    .trim();
}

/**
 * Write the full diagnostic log for a run.
 *
 * Always called on failure, so `errorLogPath` in the status report is never a
 * dangling reference — including for timeouts, whose stderr used to be dropped.
 *
 * Credentials are stripped BEFORE the bytes hit disk. Provider stderr routinely
 * echoes key material, and the team result card now names this path for the agent
 * to read — so an unredacted log is a credential handed straight into an agent's
 * context. Redacting at write time is the only point that covers every reader
 * (the agent, a human, `report_error`, a future consumer).
 */
function persistErrorLog(
  errorLogPath: string,
  header: string,
  stderr: string,
  stdoutTail: string
): void {
  const parts = [`=== ${redactSecrets(header)} ===`, ""];
  parts.push("--- stderr ---", stderr.trim() ? redactSecrets(stderr) : "(empty)", "");
  parts.push(
    "--- stdout (tail) ---",
    stdoutTail.trim() ? redactSecrets(stdoutTail) : "(empty)",
    ""
  );
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

  // Initialize status.json with all models in PENDING state
  const status: TeamStatus = {
    startedAt: now,
    models: Object.fromEntries(
      Object.keys(manifest.models).map((id) => [
        id,
        {
          state: "PENDING" as const,
          exitCode: null,
          startedAt: null,
          completedAt: null,
          outputSize: 0,
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
 * Read the response back only when a shape contract needs the whole text —
 * otherwise this is pure cost on the happy path. Callers invoke this from
 * `finish`, which runs on the outputStream's "close", so the file is complete.
 *
 * Returns undefined when the read is unnecessary OR fails; the caller then
 * falls back to the tail, and a contract checked against less text can only
 * produce a false FAILURE, never a false success, with the detail string
 * naming the pattern either way.
 */
function readFullOutputIfNeeded(opts: {
  crashed: boolean;
  requirePattern: string | undefined;
  outputSize: number;
  outputPath: string;
}): string | undefined {
  const { crashed, requirePattern, outputSize, outputPath } = opts;
  if (crashed || !requirePattern || outputSize <= STDOUT_TAIL_LIMIT) return undefined;
  try {
    return readFileSync(outputPath, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Spawn every model in parallel and RETURN, without waiting for any of them.
 *
 * Resolves once the children exist: credentials are prehydrated (one 1Password
 * handshake for the whole run, not one per model) and every process is running.
 * The run itself continues in the background, and `handle.done` settles when the
 * last slot finishes.
 *
 * Why this is the primitive rather than a blocking call. A team slot is a full
 * Claude Code session and can legitimately work for a very long time; the
 * previous blocking shape forced a deadline on it, and enforcing that deadline
 * killed three productive slots in session team-20260827-0015. Nothing here
 * imposes a deadline any more. The caller polls `getStatus`, reads how long each
 * slot has been quiet, and decides for itself whether to keep waiting.
 *
 * Each model reads input.md and writes response-{ID}.md.
 */
export async function startModels(
  sessionPath: string,
  opts: TeamRunOptions = {}
): Promise<TeamHandle> {
  assertValidRequirePattern(opts.requirePattern);

  const manifest: TeamManifest = JSON.parse(
    readFileSync(join(sessionPath, "manifest.json"), "utf-8")
  );
  const statusPath = join(sessionPath, "status.json");

  const inputPath = join(sessionPath, "input.md");
  const inputContent = readFileSync(inputPath, "utf-8");

  // Resolve every model's credential AND its route HERE, before the spawn loop
  // below fires N children at once. Each child would otherwise open its own
  // 1Password SDK client, and the desktop app authorizes exactly one of them and
  // denies the rest ("Denied authorization for SDK client") — silently losing
  // whichever models depend on 1Password rather than a shell env var. Resolving
  // in the parent write-throughs the keys into process.env, which the children
  // inherit, and the returned plan pins each bare name to an explicit
  // "provider@model" spec so the child never re-walks the chain (which is how a
  // hydrated child still reached 1Password). See auth/credentials/prehydrate.ts
  // for the measured repro.
  const spawnPlan = await (opts.spawnPlanner ?? prehydrateCredentialsForSpawn)(
    Object.values(manifest.models).map((m) => m.model)
  );

  // In-memory status cache to eliminate read-modify-write races
  const statusCache: TeamStatus = JSON.parse(readFileSync(statusPath, "utf-8"));

  function updateModelStatus(id: string, update: Partial<ModelStatus>): void {
    statusCache.models[id] = { ...statusCache.models[id], ...update };
    writeFileSync(statusPath, JSON.stringify(statusCache, null, 2), "utf-8");
  }

  const minOutputBytes = opts.minOutputBytes ?? DEFAULT_MIN_OUTPUT_BYTES;
  const requirePattern = opts.requirePattern;
  const captureMode = resolveCaptureMode(opts.captureMode);

  /**
   * Re-judge a timed-out model once its stdout pipe has closed and the response
   * file is therefore final.
   *
   * A TIMEOUT is a statement about the CLOCK, not about the output. Those are
   * separate facts and the run reported only the first: a model killed at the
   * deadline was recorded `outputSize: 0` forever, even when a complete answer
   * landed microseconds later. Anything downstream that trusted the run's own
   * summary — the judging phase, a human, an orchestrating agent — discarded
   * real work.
   *
   * If the child did produce a usable answer, record it as COMPLETED and say
   * plainly that it arrived past the deadline. The file is on disk either way;
   * this only decides whether the run ADMITS to having it.
   */
  function reconcileTimedOutOutput(
    id: string,
    finalBytes: number,
    stdoutTail: string,
    stderr: string
  ): void {
    const current = statusCache.models[id];
    if (!current || current.state !== "TIMEOUT") return;
    if (finalBytes <= current.outputSize) return; // nothing new arrived

    const degraded = classifyRunOutput({
      outputSize: finalBytes,
      stdoutTail,
      stderr,
      minOutputBytes,
    });

    if (degraded) {
      // More bytes, but still not an answer (an API error, a preamble). Keep
      // TIMEOUT and just correct the byte count so the report is not a lie.
      updateModelStatus(id, { outputSize: finalBytes });
      return;
    }

    updateModelStatus(id, {
      state: "COMPLETED",
      outputSize: finalBytes,
      completedAt: new Date().toISOString(),
      error: undefined,
    });
    const note =
      `Recovered after the deadline: the child flushed ${finalBytes} B while shutting down, ` +
      "so its answer is complete and is being counted. The run still exceeded its timeout.";
    const rt = runtimes.get(id);
    if (rt) persistErrorLog(rt.errorLogPath, `RECOVERED: ${note}`, stderr, stdoutTail);
    opts.onStatusChange?.(id, statusCache.models[id]);
  }

  // Each child writes its token/cost stats here (one file per model).
  mkdirSync(statsDir(sessionPath), { recursive: true });

  const processes: Map<string, ChildProcess> = new Map();

  /**
   * Per-model diagnostic handles, readable from OUTSIDE the spawn closure.
   * A caller asking "what is slot 03 doing?" cannot reach into the closure, so
   * everything it needs to answer that is published here.
   */
  interface ModelRuntime {
    command: string;
    errorLogPath: string;
    getStderr: () => string;
    getStdoutTail: () => string;
    getByteCount: () => number;
    /**
     * Milliseconds since this child last wrote ANYTHING on either pipe.
     *
     * Reported, never acted on. This is the signal the deleted reaper lacked: it
     * read `stats/<id>.json`, which only advances when tokens flow, so a slot
     * inside a 90s `go test` looked dead and was killed. Raw pipe writes keep
     * arriving throughout — Claude Code emits `tool_progress` heartbeats every
     * 30s inside a long tool call — so this number distinguishes quiet-and-
     * working from wedged, which a token timestamp cannot.
     *
     * The caller reads it and decides. `cancelTeamRun` is how it acts.
     */
    getIdleMs: () => number;
    /**
     * What this slot is doing right now, from the shared stream-json reducer:
     * `running`, `tool_executing`, `waiting_for_input`, a terminal state, or
     * null under `"print"` capture, which produces no frames to read.
     *
     * This is the other half of the idle number. 90 seconds of silence means
     * one thing in `tool_executing` (a build is running) and quite another in
     * `running` (the model has stopped mid-answer), and a caller deciding
     * whether to cancel needs both.
     */
    getActivity: () => string | null;
    /**
     * Drain any partially-received line into the byte count, tail, and response
     * file. A no-op under `"print"` capture, which counts raw bytes as they
     * arrive.
     *
     * Required by the TIMEOUT path. The stream-json capture holds an unterminated
     * line back until its newline arrives, so a child that wrote a partial line
     * and then hung would be reported as 0 B — destroying the one diagnostic the
     * timeout handler exists to provide. Deliberately does NOT close the write
     * stream: that would fire `finish()` while the status is still RUNNING and
     * race the run to COMPLETED.
     */
    flushPartial: () => void;
  }
  const runtimes: Map<string, ModelRuntime> = new Map();

  /**
   * Slots the caller asked to stop, recorded BEFORE the signal goes out.
   *
   * The exit handler cannot otherwise tell a deliberate stop from a crash — both
   * arrive as a non-zero exit — and filing a cancellation as `nonzero_exit`
   * would put a fault in the permanent record for a decision the caller made.
   */
  const cancelledSlots = new Set<string>();

  // SIGINT handler: kill all child processes on Ctrl+C.
  //
  // This is now LOAD-BEARING rather than a convenience. Children are spawned
  // detached, so they are no longer in the terminal's foreground process group
  // and Ctrl+C does not reach them on its own. Signal each group directly.
  //
  // Synchronous by necessity — `process.exit` runs immediately after, so there
  // is no opportunity to await a SIGKILL escalation. SIGTERM to the group is
  // enough here because the launcher now forwards it (see bin/claudish.cjs).
  const sigintHandler = () => {
    for (const [, proc] of processes) {
      signalProcessTree(proc, "SIGTERM");
    }
    process.exit(1);
  };
  process.on("SIGINT", sigintHandler);

  const completionPromises: Promise<void>[] = [];

  for (const [anonId, entry] of Object.entries(manifest.models)) {
    const outputPath = join(sessionPath, `response-${anonId}.md`);
    const errorLogPath = join(sessionPath, "errors", `${anonId}.log`);
    const upstreamErrorLogPath = join(sessionPath, "errors", `${anonId}-upstream.jsonl`);

    // Spawn with the parent-resolved explicit spec when there is one, so the
    // child skips routing entirely and finds its key in the inherited env.
    // ABSENT from the map is not an error — it means "spawn it bare", which is
    // exactly the pre-pinning behaviour. The manifest keeps `entry.model` (the
    // user's string) as the run's identity; only argv changes.
    const spawnModel = spawnPlan.pinned.get(entry.model) ?? entry.model;

    // CRITICAL FIX: do NOT use -p flag (-p means --profile in claudish)
    // --stdin triggers non-interactive single-shot mode
    //
    // ORDER IS LOAD-BEARING when recovery is on. claudish consumes --verbose as
    // its OWN log-verbosity flag (it sets quiet=false) and separately forwards a
    // copy to the child `claude`, which hard-errors on
    // `--print --output-format stream-json` without it. Putting --verbose BEFORE
    // --quiet gets the forward while letting --quiet win claudish's own
    // verbosity — reversed, every child would narrate itself onto stderr.
    // `--output-format stream-json` is an unknown flag to claudish and passes
    // through to `claude` with its value.
    const args = [
      "--model",
      spawnModel,
      "-y",
      "--stdin",
      ...(captureMode === "stream-json"
        ? ["--verbose", "--quiet", "--output-format", "stream-json"]
        : ["--quiet"]),
      ...(opts.claudeFlags ?? []),
    ];

    updateModelStatus(anonId, {
      state: "RUNNING",
      startedAt: new Date().toISOString(),
    });

    // See session-manager: resolved so a harness can spawn the tree under test
    // instead of the installed binary. Unset in production → plain "claudish".
    const teamSpawnTarget = resolveClaudishSpawn();
    const proc = spawn(teamSpawnTarget.command, [...teamSpawnTarget.prefixArgs, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // Each child leads its OWN process group, so we can signal the whole
      // subtree with `process.kill(-pid)`.
      //
      // `claudish` is a tree, not a process: the bin is a Node launcher that
      // runs the real CLI under Bun, which spawns `claude`, which spawns its
      // own tools and MCP servers. Signalling the direct child alone reaches
      // only the launcher — measured 2026-08-15, both SIGTERM and SIGKILL to
      // the pid left the Bun process alive and still holding the write end of
      // the pipe feeding `response-<id>.md`, which is how a run declared
      // TIMEOUT with 0 B gained a complete 40,699 B answer six minutes later.
      // Only the group kill was clean.
      //
      // Trade-off: a detached child no longer receives the terminal's Ctrl+C
      // (that goes to the foreground group, which the child has just left), so
      // the SIGINT handler below MUST kill the groups explicitly. It also means
      // an orchestrator that dies without running its handlers leaves children
      // behind — the same exposure as before this change, not a new one.
      detached: KILL_PROCESS_GROUP,
      env: {
        ...process.env,
        // Point this child's token tracker at a path WE choose, so its
        // tokens/cost can be attributed back to this model. Without this the
        // child writes to tokens-<its-own-port>.json and nothing links the two.
        [ENV.CLAUDISH_TOKEN_FILE]: tokenFileFor(sessionPath, anonId),
        // Un-no-op `captureUpstreamError` (handlers/composed-handler.ts), which
        // is opt-in on this env var and was therefore a guaranteed no-op for
        // every team child. Its own comment says what that costs: `log()` only
        // persists under `--debug`, so the upstream body that separates a
        // retryable rate limit from a hard quota wall is gone the moment it has
        // been classified — and a run that already failed cannot be re-run with
        // a flag. The channel has set this all along; team never did.
        //
        // Per SLOT, unconditionally: the records carry no slot id, so one shared
        // path would interleave every model in the run into an unattributable
        // file.
        [UPSTREAM_ERROR_LOG_ENV]: upstreamErrorLogPath,
      },
    });

    /**
     * When this child last wrote on either pipe.
     *
     * A SEPARATE listener from the capture below, deliberately. Capture asks
     * "is this an answer?" and answers no for a `tool_progress` heartbeat or a
     * thinking frame; liveness asks "is anything alive down there?" and those
     * same frames answer yes. Conflating the two questions is precisely how the
     * old reaper concluded that a compiling child was dead.
     */
    let lastOutputAt = Date.now();
    const stampLiveness = (): void => {
      lastOutputAt = Date.now();
    };

    /**
     * One decoder per pipe, never shared.
     *
     * A `data` chunk ends at the pipe's read boundary, which lands mid-codepoint
     * often enough to matter: `chunk.toString()` replaces the dangling bytes
     * with U+FFFD, so any CJK character or emoji straddling a boundary was
     * permanently mangled in `response-<id>.md` and mis-sized in `outputSize`.
     * The channel has decoded this way all along; team did not.
     */
    const stdoutDecoder = newStdioDecoder();
    const stderrDecoder = newStdioDecoder();
    proc.stdout?.on("data", stampLiveness);
    proc.stderr?.on("data", stampLiveness);

    // Count bytes flowing through stdout for accurate outputSize tracking
    let byteCount = 0;
    // Bounded tail of stdout. Claude Code writes "[API Error: ...]" to stdout
    // and still exits 0, so the failure signal is often here rather than on
    // stderr. Bounded so a 30 KB answer doesn't get buffered twice.
    let stdoutTail = "";

    const outputStream = createWriteStream(outputPath);

    /** See ModelRuntime.flushPartial. Reassigned below when recovery is on. */
    let flushPartial: () => void = () => {};

    /**
     * The stream-json supervisor for this slot, or null under `"print"`.
     *
     * `team` used to drive `createAssistantTextCapture()` directly and hand-roll
     * everything around it. The channel wraps that SAME capture in
     * `StreamJsonReducer` and adds what team was missing: a state machine that
     * knows the difference between thinking and running a tool, and `sawResult`
     * — the child's own terminal `result` frame, which is a real completion
     * oracle where exit 0 is not (`claude -p` exits 0 on API errors too).
     *
     * Two implementations of one job existed because this file predates the
     * reducer by four months. There is now one parser; this is the caller that
     * moved onto it.
     */
    let reducer: StreamJsonReducer | null = null;

    if (captureMode === "print") {
      // Legacy path: whatever `claude -p` printed, byte for byte.
      proc.stdout?.on("data", (chunk: Buffer) => {
        byteCount += chunk.length;
        stdoutTail = (stdoutTail + decodeChunk(stdoutDecoder, chunk)).slice(-STDOUT_TAIL_LIMIT);
      });
      // Stream stdout to disk via pipe — no memory buffering
      proc.stdout?.pipe(outputStream);
    } else {
      // Recovery path. The child's stdout is a stream-json event log, so the
      // ANSWER has to be extracted from it rather than piped through.
      //
      // byteCount and stdoutTail are deliberately fed the RECOVERED prose, not
      // the raw JSON. Every downstream consumer — the empty check, the
      // minOutputBytes threshold, the [API Error:] match, the reported
      // outputSize — is asking about the answer, and raw JSON bytes would
      // inflate all of them (an empty answer wrapped in events is still
      // kilobytes). Feeding recovered prose keeps `classifyRunOutput`
      // completely unaware that the wire format changed.
      const slotReducer = new StreamJsonReducer({
        sessionId: anonId,
        // 0 disables the reducer's stall watchdog. That watchdog ANNOUNCES
        // silence; team publishes the number through `teamSlotIdleSeconds` and
        // leaves the verdict to the caller, so a second opinion on the same
        // question would only be noise. It also means no timer is armed here.
        stallSeconds: 0,
        // Preserve anything not positively recognised. `response-<id>.md` is the
        // only place a reader sees what this child printed, and discarding a
        // real answer is the failure this file has already been burned by —
        // see ai-docs/architecture/team-capture.md.
        keepUnrecognizedJson: true,
        // State changes are read on demand via `getActivity`, not pushed. Team
        // already has its own status file and progress ticker; routing reducer
        // transitions into a second notification path would duplicate it.
        callback: () => {},
      });
      reducer = slotReducer;

      const absorb = (text: string): void => {
        if (text.length === 0) return;
        byteCount += Buffer.byteLength(text);
        stdoutTail = (stdoutTail + text).slice(-STDOUT_TAIL_LIMIT);
        outputStream.write(text);
      };

      // `feed` returns exactly what `capture.write` returned — the recovered
      // prose for this chunk — so every downstream consumer of `byteCount` and
      // `stdoutTail` is unaffected by the swap.
      proc.stdout?.on("data", (chunk: Buffer) =>
        absorb(slotReducer.feed(decodeChunk(stdoutDecoder, chunk)))
      );

      // `end()` is idempotent, so a caller draining early does not disturb the
      // normal finalisation below.
      flushPartial = () => absorb(slotReducer.end());

      // The write stream is ours to close now that nothing pipes into it, and
      // `finish()` hangs off its "close". Both events are wired because "end"
      // does not fire on a destroyed stream (a killed child), and a run that
      // never resolves is worse than one that resolves empty.
      let captureFinalized = false;
      const finalizeCapture = (): void => {
        if (captureFinalized) return;
        captureFinalized = true;
        absorb(slotReducer.end());
        // NOT disposed here: `finish()` decides the slot's outcome later, off
        // outputStream "close", and a disposed reducer ignores `settle()`. It
        // settles and disposes the reducer there, once.
        outputStream.end();
      };
      proc.stdout?.on("end", finalizeCapture);
      proc.stdout?.on("close", finalizeCapture);
    }

    // Collect stderr for error logging
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += decodeChunk(stderrDecoder, chunk);
    });

    const command = `claudish ${args.join(" ")}`;
    runtimes.set(anonId, {
      command,
      errorLogPath,
      getStderr: () => stderr,
      getStdoutTail: () => stdoutTail,
      getByteCount: () => byteCount,
      // The raw-pipe stamp, not `reducer.idleMs`. The reducer's clock advances
      // per complete LINE, so a child writing one long line slowly would look
      // quiet; this one sees every byte, on both pipes. Broadest definition of
      // "still alive", which is the question being asked.
      getIdleMs: () => Math.max(0, Date.now() - lastOutputAt),
      getActivity: () => reducer?.state ?? null,
      flushPartial: () => flushPartial(),
    });

    // Pipe input to stdin. A slot cancelled (or a child that exits) before it
    // drains stdin closes the pipe under a pending write, and Node surfaces
    // that as an `error` event on the stream — unhandled, it is an uncaught
    // exception in the orchestrator, not the child. EPIPE here means only
    // "the reader went away", which the exit/close handlers already report;
    // anything else is still worth a log line.
    proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err?.code === "EPIPE") return;
      stderr += `[claudish] stdin error for slot ${anonId}: ${err?.message ?? String(err)}\n`;
    });
    proc.stdin?.write(inputContent);
    proc.stdin?.end();

    const completionPromise = new Promise<void>((resolve) => {
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let exited = false;
      let resolved = false;

      /**
       * Settle the reducer to the outcome just recorded, then release it.
       *
       * Without the settle the reducer stays wherever the stream left it — a
       * `result` frame parks it in `waiting_for_input` — so an exited slot read
       * as idle rather than done. Runs only once `state` is final, which is why
       * the dispose lives here and not in `finalizeCapture`. No-op under
       * `"print"`, which has no reducer.
       */
      const settleReducer = (): void => {
        if (!reducer) return;
        const state = statusCache.models[anonId]?.state;
        const failed = state === "FAILED" || state === "EMPTY";
        reducer.settle(
          failed && cancelledSlots.has(anonId)
            ? "cancelled"
            : state === "COMPLETED"
              ? "completed"
              : state === "TIMEOUT"
                ? "timeout"
                : "failed"
        );
        reducer.dispose();
      };

      const finish = () => {
        if (resolved) return;
        // The timeout handler may have fired between proc "exit" and
        // outputStream "close". Don't clobber TIMEOUT — but do RECONCILE.
        //
        // Reaching here means the child has exited and the stdout pipe has
        // closed, so `response-<id>.md` is final and `byteCount` is its true size. A child killed at the
        // deadline can still have flushed a complete answer in the window
        // between the signal and the pipe closing, and the old code threw that
        // away: it recorded whatever byte count existed at KILL time (0 B for a
        // `--quiet` child, which emits only at the end) and never looked again.
        // The judging phase then scored a real answer as an empty submission.
        if (statusCache.models[anonId].state === "TIMEOUT") {
          resolved = true;
          reconcileTimedOutOutput(anonId, byteCount, stdoutTail, stderr);
          // After the reconcile, which can upgrade TIMEOUT to COMPLETED.
          settleReducer();
          resolve();
          return;
        }
        resolved = true;

        const outputSize = byteCount;

        // A non-zero exit is an outright failure. A zero exit still has to earn
        // it: `claude -p` exits 0 on API errors and on background-task
        // termination, so exit code alone would file both as success.
        const crashed = exitCode !== 0;
        const fullOutput = readFullOutputIfNeeded({
          crashed,
          requirePattern,
          outputSize,
          outputPath,
        });
        const degraded = crashed
          ? null
          : classifyRunOutput({
              outputSize,
              stdoutTail,
              stderr,
              minOutputBytes,
              requirePattern,
              fullOutput,
              captureMode,
            });

        const failed = crashed || degraded !== null;
        const state: ModelState = crashed ? "FAILED" : degraded ? "EMPTY" : "COMPLETED";

        if (failed) {
          // A slot the caller stopped exited non-zero, but it did not crash and
          // saying so would be a lie in the permanent record. `cancelled` is the
          // one failure reason that is not a defect: the caller looked at the
          // evidence and decided. Nothing else in claudish can produce it.
          const wasCancelled = cancelledSlots.has(anonId);
          const reason: FailureReason = wasCancelled
            ? "cancelled"
            : crashed
              ? "nonzero_exit"
              : degraded!.reason;
          const detail = wasCancelled
            ? 'Stopped on the caller\'s instruction via team(mode:"cancel"). ' +
              "Whatever the child had written up to that point is in its response file."
            : crashed
              ? exitCode === null && exitSignal !== null
                ? `Child was killed by ${exitSignal}.`
                : `Child exited with code ${exitCode}.`
              : degraded!.detail;

          persistErrorLog(errorLogPath, `${state}: ${detail}`, stderr, stdoutTail);

          updateModelStatus(anonId, {
            state,
            exitCode: exitCode ?? 1,
            completedAt: new Date().toISOString(),
            outputSize,
            error: {
              model: anonId,
              command,
              reason,
              detail,
              // Redacted: these land in status.json on disk and are read back
              // by anything inspecting the run.
              stderrSnippet: stderr ? redactSecrets(stderr).slice(-2000) : undefined,
              stdoutSnippet: stdoutTail ? snippetHeadAndTail(redactSecrets(stdoutTail)) : undefined,
              errorLogPath,
              // Only when the child actually wrote one. Naming a file that does
              // not exist sends a reader after evidence that was never captured.
              upstreamErrorLogPath: existsSync(upstreamErrorLogPath)
                ? upstreamErrorLogPath
                : undefined,
              workDir: sessionPath,
            },
          });
        } else {
          updateModelStatus(anonId, {
            state,
            exitCode: exitCode ?? 0,
            completedAt: new Date().toISOString(),
            outputSize,
            error: undefined,
          });
        }

        // Before the caller's callback, so a throwing consumer cannot skip the
        // dispose and leak the reducer's tool-batch timer.
        settleReducer();
        opts.onStatusChange?.(anonId, statusCache.models[anonId]);
        resolve();
      };

      // A slot settles once the child has exited AND its output stream has
      // closed: "exit" gives the exit code, "close" makes `response-<id>.md`
      // final. The two arrive in either order. A child can still be flushing
      // its answer when "exit" arrives (a killed one included, which is what
      // the TIMEOUT reconcile in finish() re-measures), and a fast child's
      // output can close before its "exit" is delivered, when there is no exit
      // code yet to judge it by. `runModels` bounds the wait, so a pipe that
      // never closes degrades to a stale read rather than a hang.
      outputStream.on("close", () => {
        if (exited) finish();
      });

      proc.on("exit", (code, signal) => {
        const timedOut = statusCache.models[anonId]?.state === "TIMEOUT";

        // On TIMEOUT, persistErrorLog has just written the timeout diagnostics
        // to the error log, and a raw stderr dump would erase them. Otherwise
        // write a log only when there is something worth reading. Every healthy
        // child emits Claude Code's `unrecognized_model` line — normal for a
        // proxied model — and writing it produced an `errors/NN.log` for runs
        // that had no error at all, which is exactly the noise that hides a real
        // one. `finish()` still writes the full log on any genuine failure.
        if (!timedOut && meaningfulStderr(stderr)) {
          // Redacted like every other persistence point — provider stderr can
          // echo key material and this file is read by agents.
          writeFileSync(errorLogPath, redactSecrets(stderr), "utf-8");
        }

        exitCode = code;
        exitSignal = signal;
        exited = true;
        if (outputStream.destroyed) finish();
      });
    });

    processes.set(anonId, proc);
    completionPromises.push(completionPromise);
  }

  // ── Live progress ─────────────────────────────────────────────────────────
  // Children in --quiet print mode emit nothing until they finish, so without a
  // poll there is no signal at all between "started" and "done".
  //
  // Two different cadences, deliberately:
  //   · status.txt   — rewritten every poll. It is a file; frequency is free.
  //   · onProgress   — only when the run's state actually CHANGES, plus a slow
  //                    heartbeat. Each frame renders as its own new line in the
  //                    client, so a fixed short tick would bury the transcript
  //                    in near-identical rows (a 15-min run at 5s = ~180 lines).
  const runStartedMs = Date.now();
  const POLL_MS = 2000;
  const heartbeatMs = (opts.heartbeatSeconds ?? 60) * 1000;

  let lastSignature = "";
  let lastEmitMs = 0;

  /**
   * What "changed" means for emission purposes.
   *
   * EXCLUDES elapsed time — otherwise every poll differs and the dedupe never
   * suppresses anything.
   *
   * EXCLUDES raw token counts too. Tokens tick continuously while a model
   * streams, so keying on them re-creates the spam this dedupe exists to stop.
   * Token totals still ride along on whatever frame does get emitted, and the
   * heartbeat guarantees they refresh on a quiet run.
   */
  const stateSignature = (): string =>
    Object.entries(statusCache.models)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, m]) => `${id}:${m.state}:${m.outputSize}`)
      .join("|");

  const emitProgress = (phase: "running" | "settled" = "running"): void => {
    const elapsedSeconds = (Date.now() - runStartedMs) / 1000;
    writeStatusFile(sessionPath, manifest, statusCache, { elapsedSeconds });
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
        rendered: renderTeamStatsCompact(sessionPath, manifest, statusCache, { elapsedSeconds }),
        phase,
        allFailed: models.length > 0 && models.every((m) => m.state !== "COMPLETED"),
      });
    } catch {
      // A progress consumer must never be able to fail the run.
    }
  };

  emitProgress(); // one immediately, so status.txt exists from the start
  const progressHandle = setInterval(() => emitProgress("running"), POLL_MS);
  // Don't hold the event loop open on the ticker alone.
  progressHandle.unref?.();

  // Settlement runs in the background. Nothing awaits it here — that is the
  // whole point of this function — but it must still tear down the ticker, emit
  // the terminal frame, and release the SIGINT handler, or a caller that never
  // reads `done` leaks all three.
  const teamSessionId = basename(sessionPath);

  // Registered BEFORE `done` is built, so a caller that cancels immediately
  // finds the run rather than racing its own start.
  liveTeamRuns.set(teamSessionId, {
    sessionPath,
    processes,
    idleMsFor: (slotId) => runtimes.get(slotId)?.getIdleMs() ?? null,
    activityFor: (slotId) => runtimes.get(slotId)?.getActivity() ?? null,
    liveBytesFor: (slotId) => runtimes.get(slotId)?.getByteCount() ?? null,
    isRunning: (slotId) => statusCache.models[slotId]?.state === "RUNNING",
    cancelledSlots,
  });

  const done = (async (): Promise<TeamStatus> => {
    try {
      await Promise.all(completionPromises);
    } finally {
      clearInterval(progressHandle);
      // Terminal frame. Without this a status-tracking consumer never sees the
      // run close — every frame would read "running", including the last one.
      emitProgress("settled");
      process.off("SIGINT", sigintHandler);
      // A settled run answers from status.json, not from memory. Dropping the
      // entry is also what stops this map growing for the life of the server.
      liveTeamRuns.delete(teamSessionId);
    }
    return statusCache;
  })();

  // A caller that only polls `getStatus` never touches `done`. Without this an
  // unobserved rejection would take down the MCP server, which hosts every
  // other session too.
  done.catch(() => {});

  return {
    teamSessionId,
    sessionPath,
    // Display model → anonymised slot. The manifest is shuffled for blind
    // JUDGING, which protects the judge children reading response-<id>.md
    // without a manifest. It was never hidden from the orchestrating caller —
    // status.txt has printed model names beside slot ids all along.
    slots: Object.fromEntries(
      Object.entries(manifest.models).map(([anonId, entry]) => [entry.model, anonId])
    ),
    done,
  };
}

/**
 * Spawn every model and wait for all of them.
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
  await runModels(judgePath, { claudeFlags: opts.claudeFlags });

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
