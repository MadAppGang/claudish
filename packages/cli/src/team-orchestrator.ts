import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  createWriteStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import path, { basename, dirname, join, resolve } from "node:path";

import { resolveClaudishSpawn } from "./claudish-spawn.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamManifest {
  created: string;
  models: Record<string, { model: string; assignedAt: string }>;
  shuffleOrder: string[];
}

/**
 * Failure details attached to a FAILED ModelStatus (#538). The MCP failure
 * report (mcp-server.ts formatTeamResult) renders exactly these five fields —
 * before this type existed the report block read `m.error.*` that no producer
 * ever set, so the promised stderr snippet and log path never appeared.
 */
export interface ModelStatusError {
  model: string;
  command: string;
  stderrSnippet: string;
  errorLogPath: string;
  workDir: string;
}

export interface ModelStatus {
  state: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT";
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  outputSize: number;
  error?: ModelStatusError;
}

export interface TeamStatus {
  startedAt: string;
  models: Record<string, ModelStatus>;
}

export interface TeamRunOptions {
  timeout?: number; // seconds, default 300
  claudeFlags?: string[]; // extra flags passed to child claudish
  onStatusChange?: (id: string, status: ModelStatus) => void;
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

// ─── Path Validation ──────────────────────────────────────────────────────────

/**
 * Minimal path-module surface for isWithinDir — satisfied by `path`, `path.win32`
 * and `path.posix`, so both platform semantics can be pinned on any host (#504).
 */
export interface PathModuleLike {
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
  sep: string;
}

/**
 * Pure containment check: is `target` inside `base` (or equal to it)?
 * Uses relative() so separators and drive-letter case follow the injected
 * path module instead of a hardcoded "/" prefix. A sibling named `..cache`
 * stays inside — only a real parent hop (`..` or `..<sep>…`) or a jump to
 * another absolute root is rejected.
 */
export function isWithinDir(base: string, target: string, p: PathModuleLike): boolean {
  const rel = p.relative(base, target);
  return rel !== ".." && !rel.startsWith(".." + p.sep) && !p.isAbsolute(rel);
}

/**
 * Real path of `candidate`, resolving the nearest EXISTING ancestor and re-appending
 * the non-existent tail verbatim — so a session directory that does not exist yet is
 * still adjudicated by where its parent really lives (#586).
 *
 * `lstatSync` rather than `statSync` is deliberate: a dangling symlink counts as
 * existing, so `realpathSync` throws on it and the caller refuses a path it cannot
 * vouch for instead of silently accepting its un-resolved spelling.
 *
 * Returns null when nothing along the chain can be resolved.
 */
function realpathOfNearestExisting(candidate: string): string | null {
  let existing = candidate;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  try {
    return join(realpathSync(existing), ...tail);
  } catch {
    return null;
  }
}

/**
 * Validate that sessionPath is within cwd (prevents path traversal in MCP tools).
 * Returns the resolved absolute path, in the caller's spelling.
 *
 * The comparison is on REAL paths, never on spellings (#586). A lexical check gets
 * both directions wrong: it accepts a symlink that sits inside cwd and points out of
 * it (a traversal hole), and it refuses a legitimate alternate spelling of cwd (a
 * symlinked checkout, or macOS' /var → /private/var).
 */
export function validateSessionPath(sessionPath: string): string {
  const resolved = resolve(sessionPath);
  const outside = () => new Error(`Session path must be within current directory: ${sessionPath}`);

  const real = realpathOfNearestExisting(resolved);
  if (real === null) throw outside(); // a dangling symlink leads nowhere we can vouch for
  if (!isWithinDir(realpathSync(process.cwd()), real, path)) throw outside();

  return resolved;
}

// ─── Child stdin guard ───────────────────────────────────────────────────────

/** The slice of a child's stdin this module needs — injectable for tests. */
export interface StdinLike {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Guard the write end of a child's stdin (#586, ported from upstream 03409b25).
 *
 * A slot cancelled — or a child that exits — before it drains stdin closes the
 * pipe under a pending write. Node surfaces that as an `error` event on the
 * stream, and an unhandled `error` event is an uncaught exception in the
 * ORCHESTRATOR, not in the child: one cancelled slot would take down the whole
 * run instead of just itself.
 *
 * EPIPE means only "the reader went away", which the exit/close handlers
 * already report, so it is swallowed. Any other stdin error is forwarded to the
 * slot's captured stderr, so it lands in the error log next to the child's own
 * output instead of vanishing.
 */
export function attachStdinErrorGuard(
  stdin: StdinLike | null | undefined,
  anonId: string,
  appendStderr: (text: string) => void
): void {
  stdin?.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") return;
    appendStderr(`[claudish] stdin error for slot ${anonId}: ${err?.message ?? String(err)}\n`);
  });
}

// ─── Sentinel Model Validation ───────────────────────────────────────────────

/**
 * Model names that are semantic directives for the calling agent, not real
 * external model IDs. These must never be passed to claudish child processes.
 */
const SENTINEL_MODELS = new Set([
  "internal",   // means "use a local Claude Code Task agent"
  "default",    // means "use whatever Claude Code is configured with"
  "opus",       // Claude tier selector — calling agent should handle
  "sonnet",     // Claude tier selector — calling agent should handle
  "haiku",      // Claude tier selector — calling agent should handle
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

/** Bounded stderr excerpt kept inside status.json — the full stderr goes to errors/<id>.log. */
const STDERR_SNIPPET_MAX = 500;

/**
 * Build the error details for a FAILED run (#538). Pure — runModels' finish()
 * calls it with the values the spawn closure already holds, so every field the
 * MCP failure report renders is backed by a real measurement of the failed
 * child (spawn site has model, argv, collected stderr, log path and cwd).
 */
export function failureDetails(
  entry: { model: string },
  args: string[],
  stderr: string,
  errorLogPath: string,
  workDir: string
): ModelStatusError {
  return {
    model: entry.model,
    command: `claudish ${args.join(" ")}`,
    stderrSnippet: stderr.slice(0, STDERR_SNIPPET_MAX),
    errorLogPath,
    workDir,
  };
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
      `Session already exists at ${sessionPath}. ` +
      `Use a new directory path or delete the existing session first.`
    );
  }

  // Reject sentinel model names that should be handled by the calling agent
  const sentinels = models.filter(isSentinelModel);
  if (sentinels.length > 0) {
    throw new Error(
      `Invalid model(s) for team run: ${sentinels.join(", ")}. ` +
      `These are Claude Code agent selectors, not external model IDs. ` +
      `Use real external models (e.g., "gemini-2.0-flash", "gpt-4o", "or@deepseek/deepseek-r1"). ` +
      `For Claude models, use a Task agent instead of the team tool.`
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

  // In-memory status cache to eliminate read-modify-write races
  const statusCache: TeamStatus = JSON.parse(readFileSync(statusPath, "utf-8"));

  function updateModelStatus(id: string, update: Partial<ModelStatus>): void {
    statusCache.models[id] = { ...statusCache.models[id], ...update };
    writeFileSync(statusPath, JSON.stringify(statusCache, null, 2), "utf-8");
  }

  const processes: Map<string, ChildProcess> = new Map();

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

    // CRITICAL FIX: do NOT use -p flag (-p means --profile in claudish)
    // --stdin triggers non-interactive single-shot mode
    const args = ["--model", entry.model, "-y", "--stdin", "--quiet", ...(opts.claudeFlags ?? [])];

    updateModelStatus(anonId, {
      state: "RUNNING",
      startedAt: new Date().toISOString(),
    });

    // #646: a bare `spawn("claudish")` cannot reach a .cmd-shimmed Windows
    // install (bun: no PATHEXT; node: EINVAL since the CVE-2024-27980
    // hardening) — resolve the real executable instead. Resolved once per
    // model entry from the same `args`; non-win32 is the old bare spawn.
    const spawnSpec = resolveClaudishSpawn(args);
    if (spawnSpec.command === null) {
      // Nothing resolvable: fail the model with a message naming the
      // executable forms that were looked for (#646 acceptance), shaped like
      // any other failure so the MCP report renders it.
      let refusedLogPath = "";
      try {
        mkdirSync(join(sessionPath, "errors"), { recursive: true });
        writeFileSync(errorLogPath, spawnSpec.refusal ?? "claudish not found", "utf-8");
        refusedLogPath = errorLogPath;
      } catch {
        refusedLogPath = "";
      }
      updateModelStatus(anonId, {
        state: "FAILED",
        exitCode: 1,
        completedAt: new Date().toISOString(),
        error: failureDetails(entry, args, spawnSpec.refusal ?? "", refusedLogPath, process.cwd()),
      });
      opts.onStatusChange?.(anonId, statusCache.models[anonId]);
      continue;
    }
    const proc = spawn(spawnSpec.command, spawnSpec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: spawnSpec.verbatim,
    });
    const workDir = process.cwd();

    // Count bytes flowing through stdout for accurate outputSize tracking
    let byteCount = 0;
    proc.stdout?.on("data", (chunk: Buffer) => { byteCount += chunk.length; });

    // Stream stdout to disk via pipe — no memory buffering
    const outputStream = createWriteStream(outputPath);
    proc.stdout?.pipe(outputStream);

    // Collect stderr for error logging
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Pipe input to stdin — the error guard must be attached BEFORE the write:
    // a listener added afterwards never sees the failure it was meant to catch.
    attachStdinErrorGuard(proc.stdin, anonId, (text) => {
      stderr += text;
    });
    proc.stdin?.write(inputContent);
    proc.stdin?.end();

    const completionPromise = new Promise<void>((resolve) => {
      let exitCode: number | null = null;
      let exitKnown = false;
      let streamClosed = false;
      let settled = false;

      // #538: settle the run only once BOTH signals are in — the child's exit
      // (real exit code, stderr fully drained) and the output stream's close
      // (response file flushed). Settling on either alone is a race: stdout
      // close routinely wins over "exit", which recorded exitCode=1 for real
      // exit-3 failures (27/30 measured) and advertised a log path whose file
      // did not exist yet, while never writing one at all for an exit-0 child
      // misclassified FAILED.
      const settle = () => {
        if (settled || !exitKnown || !streamClosed) return;
        settled = true;

        // Don't overwrite TIMEOUT state — the timeout handler may have fired
        // and killed the child before these events landed.
        if (statusCache.models[anonId].state === "TIMEOUT") {
          resolve();
          return;
        }

        // #538: the error log is written HERE, where the status that
        // advertises it is produced, so path and file cannot disagree.
        // A FAILED run writes its log even when stderr is empty. The dir is
        // created if missing and the write is guarded — throwing out of a
        // process event handler would kill the whole orchestrator.
        let advertisedLogPath = "";
        if (exitCode !== 0) {
          try {
            mkdirSync(join(sessionPath, "errors"), { recursive: true });
            writeFileSync(errorLogPath, stderr, "utf-8");
            advertisedLogPath = errorLogPath;
          } catch {
            // Unwritable session dir: keep the details, advertise no path.
            advertisedLogPath = "";
          }
        }

        updateModelStatus(anonId, {
          state: exitCode === 0 ? "COMPLETED" : "FAILED",
          exitCode: exitCode ?? 1,
          completedAt: new Date().toISOString(),
          outputSize: byteCount,
          // #538: attach the details the MCP failure report renders. Completed
          // runs carry no error field; a FAILED run always does.
          ...(exitCode === 0
            ? {}
            : { error: failureDetails(entry, args, stderr, advertisedLogPath, workDir) }),
        });

        opts.onStatusChange?.(anonId, statusCache.models[anonId]);
        resolve();
      };

      outputStream.on("close", () => {
        streamClosed = true;
        settle();
      });

      // proc "close" (not "exit"): it fires after the process ended AND its
      // stdio streams closed, so the exit code and the drained stderr are
      // both known here.
      proc.on("close", (code) => {
        exitKnown = true;
        exitCode = code;
        settle();
      });
    });

    processes.set(anonId, proc);
    completionPromises.push(completionPromise);
  }

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
            updateModelStatus(id, {
              state: "TIMEOUT",
              completedAt: new Date().toISOString(),
            });
            opts.onStatusChange?.(id, statusCache.models[id]);
          }
        }
        resolve();
      }, timeoutMs);
    }),
  ]);

  if (timeoutHandle !== null) clearTimeout(timeoutHandle);

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
  prompt += input + "\n\n";
  prompt += "---\n\n";
  prompt += "### Responses to Evaluate\n\n";
  prompt +=
    "Evaluate each response independently. You do not know which model produced which response.\n\n";

  for (const id of ids) {
    prompt += `#### Response ${id}\n\n`;
    prompt += responses[id] + "\n\n";
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
        confidence: parseInt(confidenceMatch?.[1] ?? "5", 10),
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
