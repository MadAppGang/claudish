import { type ChildProcess, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type SpawnPlan, prehydrateCredentialsForSpawn } from "./auth/credentials/prehydrate.js";
import { redactSecrets } from "./redact.js";
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
  | "timeout"
  | "api_error"
  | "background_task_ceiling"
  | "empty_output";

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
  timeout?: number; // seconds, default 300
  claudeFlags?: string[]; // extra flags passed to child claudish
  onStatusChange?: (id: string, status: ModelStatus) => void;
  /**
   * Opt-in stub threshold: below this many stdout bytes an exit-0 run is
   * recorded EMPTY. Default 0 (off) — see DEFAULT_MIN_OUTPUT_BYTES for why.
   * Whitespace-only output is caught regardless of this setting.
   */
  minOutputBytes?: number;
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

/**
 * Decide whether an exit-0 run actually produced an answer.
 * Returns null when the output looks usable.
 */
export function classifyRunOutput(opts: {
  outputSize: number;
  stdoutTail: string;
  stderr: string;
  minOutputBytes: number;
}): { reason: FailureReason; detail: string } | null {
  const { outputSize, stdoutTail, stderr, minOutputBytes } = opts;

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

  return null;
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

// ─── Sentinel Model Validation ───────────────────────────────────────────────

/**
 * Model names that are semantic directives for the calling agent, not real
 * external model IDs. These must never be passed to claudish child processes.
 */
const SENTINEL_MODELS = new Set([
  "internal", // means "use a local Claude Code Task agent"
  "default", // means "use whatever Claude Code is configured with"
  "opus", // Claude tier selector — calling agent should handle
  "sonnet", // Claude tier selector — calling agent should handle
  "haiku", // Claude tier selector — calling agent should handle
]);

/**
 * Check if a model ID is a sentinel or native Anthropic model.
 * These cannot be run as external claudish processes.
 */
function isSentinelModel(model: string): boolean {
  const lower = model.toLowerCase();
  if (SENTINEL_MODELS.has(lower)) return true;
  if (lower.startsWith("claude-")) return true;
  return false;
}

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

  // Reject sentinel model names that should be handled by the calling agent
  const sentinels = models.filter(isSentinelModel);
  if (sentinels.length > 0) {
    throw new Error(
      `Invalid model(s) for team run: ${sentinels.join(", ")}. These are Claude Code agent selectors, not external model IDs. Use real external models (e.g., "gemini-2.0-flash", "gpt-4o", "or@deepseek/deepseek-r1"). For Claude models, use a Task agent instead of the team tool.`
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
 * Run all models in parallel.
 * Each model reads input.md and writes response-{ID}.md.
 * Returns when all models complete or timeout.
 */
export async function runModels(
  sessionPath: string,
  opts: TeamRunOptions = {}
): Promise<TeamStatus> {
  const timeoutMs = (opts.timeout ?? 300) * 1000;
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

  // Each child writes its token/cost stats here (one file per model).
  mkdirSync(statsDir(sessionPath), { recursive: true });

  const processes: Map<string, ChildProcess> = new Map();

  /**
   * Per-model diagnostic handles, readable from OUTSIDE the spawn closure.
   * The timeout handler lives outside that closure and previously had no way to
   * reach the child's stderr — which is why timed-out runs reported nothing.
   */
  interface ModelRuntime {
    command: string;
    errorLogPath: string;
    getStderr: () => string;
    getStdoutTail: () => string;
    getByteCount: () => number;
  }
  const runtimes: Map<string, ModelRuntime> = new Map();

  // SIGINT handler: kill all child processes on Ctrl+C
  const sigintHandler = () => {
    for (const [, proc] of processes) {
      if (!proc.killed) proc.kill("SIGTERM");
    }
    process.exit(1);
  };
  process.on("SIGINT", sigintHandler);

  const completionPromises: Promise<void>[] = [];

  for (const [anonId, entry] of Object.entries(manifest.models)) {
    const outputPath = join(sessionPath, `response-${anonId}.md`);
    const errorLogPath = join(sessionPath, "errors", `${anonId}.log`);

    // Spawn with the parent-resolved explicit spec when there is one, so the
    // child skips routing entirely and finds its key in the inherited env.
    // ABSENT from the map is not an error — it means "spawn it bare", which is
    // exactly the pre-pinning behaviour. The manifest keeps `entry.model` (the
    // user's string) as the run's identity; only argv changes.
    const spawnModel = spawnPlan.pinned.get(entry.model) ?? entry.model;

    // CRITICAL FIX: do NOT use -p flag (-p means --profile in claudish)
    // --stdin triggers non-interactive single-shot mode
    const args = ["--model", spawnModel, "-y", "--stdin", "--quiet", ...(opts.claudeFlags ?? [])];

    updateModelStatus(anonId, {
      state: "RUNNING",
      startedAt: new Date().toISOString(),
    });

    const proc = spawn("claudish", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: {
        ...process.env,
        // Point this child's token tracker at a path WE choose, so its
        // tokens/cost can be attributed back to this model. Without this the
        // child writes to tokens-<its-own-port>.json and nothing links the two.
        CLAUDISH_TOKEN_FILE: tokenFileFor(sessionPath, anonId),
      },
    });

    // Count bytes flowing through stdout for accurate outputSize tracking
    let byteCount = 0;
    // Bounded tail of stdout. Claude Code writes "[API Error: ...]" to stdout
    // and still exits 0, so the failure signal is often here rather than on
    // stderr. Bounded so a 30 KB answer doesn't get buffered twice.
    let stdoutTail = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      byteCount += chunk.length;
      stdoutTail = (stdoutTail + chunk.toString()).slice(-STDOUT_TAIL_LIMIT);
    });

    // Stream stdout to disk via pipe — no memory buffering
    const outputStream = createWriteStream(outputPath);
    proc.stdout?.pipe(outputStream);

    // Collect stderr for error logging
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const command = `claudish ${args.join(" ")}`;
    runtimes.set(anonId, {
      command,
      errorLogPath,
      getStderr: () => stderr,
      getStdoutTail: () => stdoutTail,
      getByteCount: () => byteCount,
    });

    // Pipe input to stdin
    proc.stdin?.write(inputContent);
    proc.stdin?.end();

    const completionPromise = new Promise<void>((resolve) => {
      let exitCode: number | null = null;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        // Don't overwrite TIMEOUT state — timeout handler may have fired
        // between proc "exit" and outputStream "close" events
        if (statusCache.models[anonId].state === "TIMEOUT") {
          resolved = true;
          resolve();
          return;
        }
        resolved = true;

        const outputSize = byteCount;

        // A non-zero exit is an outright failure. A zero exit still has to earn
        // it: `claude -p` exits 0 on API errors and on background-task
        // termination, so exit code alone would file both as success.
        const crashed = exitCode !== 0;
        const degraded = crashed
          ? null
          : classifyRunOutput({ outputSize, stdoutTail, stderr, minOutputBytes });

        const failed = crashed || degraded !== null;
        const state: ModelState = crashed ? "FAILED" : degraded ? "EMPTY" : "COMPLETED";

        if (failed) {
          const reason: FailureReason = crashed ? "nonzero_exit" : degraded!.reason;
          const detail = crashed ? `Child exited with code ${exitCode}.` : degraded!.detail;

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
              stdoutSnippet: stdoutTail ? redactSecrets(stdoutTail).slice(-2000) : undefined,
              errorLogPath,
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

        opts.onStatusChange?.(anonId, statusCache.models[anonId]);
        resolve();
      };

      // "close" always fires after the stream ends or errors — single resolution point
      outputStream.on("close", finish);

      proc.on("exit", (code) => {
        // CRITICAL FIX: guard against overwriting TIMEOUT state
        const current = statusCache.models[anonId];
        if (current?.state === "TIMEOUT") {
          resolved = true;
          resolve();
          return;
        }

        if (stderr) {
          // Redacted like every other persistence point — provider stderr can
          // echo key material and this file is read by agents.
          writeFileSync(errorLogPath, redactSecrets(stderr), "utf-8");
        }

        exitCode = code;
        // If the stream already closed before exit fired, finish immediately
        if (outputStream.destroyed) {
          finish();
        }
        // Otherwise wait for outputStream "close" to call finish()
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

  // Wait for all processes, or until timeout fires
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  await Promise.race([
    Promise.all(completionPromises),
    new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        for (const [id, proc] of processes) {
          const current = statusCache.models[id];
          // Only timeout models that are still RUNNING — not ones that already
          // completed/failed. proc.killed is NOT reliable: it's only true when
          // the parent called .kill(), not when the child exited naturally.
          if (current.state === "RUNNING") {
            if (!proc.killed) proc.kill("SIGTERM");

            // Capture diagnostics BEFORE the status flips to TIMEOUT. The exit
            // handler short-circuits on TIMEOUT, so this is the only chance to
            // persist what the child said — previously it was all discarded.
            const rt = runtimes.get(id);
            const stderr = rt?.getStderr() ?? "";
            const stdoutTail = rt?.getStdoutTail() ?? "";
            const bytes = rt?.getByteCount() ?? 0;
            const detail =
              `Killed by the orchestrator after ${timeoutMs / 1000}s with ${bytes} B of stdout. ` +
              "In --quiet print mode the child emits its answer only at the end, so 0 B means " +
              `"did not finish", not "produced nothing".`;

            if (rt) persistErrorLog(rt.errorLogPath, `TIMEOUT: ${detail}`, stderr, stdoutTail);

            updateModelStatus(id, {
              state: "TIMEOUT",
              completedAt: new Date().toISOString(),
              outputSize: bytes,
              error: rt
                ? {
                    model: id,
                    command: rt.command,
                    reason: "timeout",
                    detail,
                    stderrSnippet: stderr ? redactSecrets(stderr).slice(-2000) : undefined,
                    stdoutSnippet: stdoutTail ? redactSecrets(stdoutTail).slice(-2000) : undefined,
                    errorLogPath: rt.errorLogPath,
                    workDir: sessionPath,
                  }
                : undefined,
            });
            opts.onStatusChange?.(id, statusCache.models[id]);
          }
        }
        resolve();
      }, timeoutMs);
    }),
  ]);

  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  clearInterval(progressHandle);
  // Terminal frame. Without this a status-tracking consumer never sees the run
  // close — every frame would read "running", including the last one.
  emitProgress("settled");

  // Remove SIGINT handler after we're done
  process.off("SIGINT", sigintHandler);

  return statusCache;
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
