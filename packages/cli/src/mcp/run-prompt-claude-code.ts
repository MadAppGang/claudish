/**
 * `run_prompt` (and `compare_models`) for a Claude model: one Claude Code print-mode
 * call through claudish, signed in with Claude Code's own login.
 *
 * Why not the in-process proxy: for a bare Claude name the proxy takes the native
 * route, which forwards the CALLER's credential, and an MCP tool call has none — the
 * request reached Anthropic with no `x-api-key` and came back 401. claudish must never
 * read the Claude Code OAuth token or its Keychain item itself, so the only way onto
 * the user's subscription is the unmodified `claude` binary signing in on its own:
 *
 *   <claudish> -p --model <model> --output-format json --tools "" --strict-mcp-config
 *     --setting-sources "" --disable-slash-commands --no-session-persistence
 *     (--system-prompt-file <file> | --system-prompt "")
 *
 * The prompt goes on stdin, the child runs in an empty temporary directory (otherwise
 * CLAUDE.md and memory load: 8 718 input tokens instead of ~590), and the child's
 * environment drops the three `ANTHROPIC_*` variables that would take the request off
 * the login. Rationale and measurements: ai-docs/architecture/mcp-sessions.md
 * ("run_prompt") and headless-vs-interactive.md (why `-p` is safe for this one call).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV } from "../config.js";
import { PANE_LAUNCH_VARS } from "../pane/child-env.js";
import { isStrippedFromChildEnv, resolveClaudishLaunch } from "../pane/pane-launch.js";
import { sanitizeForReport } from "../redact.js";

/** What one `run_prompt` call answers, on either path. */
export interface RunPromptResult {
  /** The model's answer, verbatim. */
  content: string;
  /** Same shape as `runPromptViaProxy`'s. */
  usage?: { input: number; output: number };
  /**
   * Claude path only: how Claude Code authenticated, from the init frame's
   * `apiKeySource`. `"subscription"` when that is `"none"` (the Claude Code login),
   * any other value verbatim.
   */
  auth?: string;
}

/** The two frames of Claude Code's `--output-format json` this module reads. */
export interface ClaudeCodePrintResult {
  /** The result frame's `result`; `""` when absent. */
  result: string;
  isError: boolean;
  /** `api_error_status` when it is a number, else null. */
  apiErrorStatus: number | null;
  terminalReason?: string;
  usage?: { input: number; output: number };
  /** The init frame's `apiKeySource`, when an init frame was printed. */
  apiKeySource?: string;
}

/** The flags every print child gets, in order, before the system-prompt flag. */
const PRINT_FLAGS = [
  "-p",
  "--output-format",
  "json",
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-session-persistence",
] as const;

/**
 * The argv after claudish's own launch words. No positional prompt and no flag value
 * that could start with `-`: claudish's passthrough parser takes a value only when it
 * does not start with `-`, so the prompt travels on stdin and the system prompt in a
 * file. `--system-prompt ""` replaces Claude Code's default system prompt (3 232 input
 * tokens) when the caller gave none, because the proxy path sends none either.
 */
export function claudeCodePrintArgv(model: string, systemPromptFile: string | undefined): string[] {
  const head = [PRINT_FLAGS[0], "--model", model, ...PRINT_FLAGS.slice(1)];
  return systemPromptFile !== undefined
    ? [...head, "--system-prompt-file", systemPromptFile]
    : [...head, "--system-prompt", ""];
}

/**
 * The pane markers the print child must not inherit: the launch markers, and
 * `CLAUDISH_PANE_CHILD`. Inside a session (a nested server) the flag would make
 * `assertNotNested` refuse `-p` with exit 64, and `run_prompt` is one of the tools
 * nested mode keeps. Dropping it does not open a second level of nesting: the
 * child runs with no tools, no MCP servers, no setting sources and no slash
 * commands (PRINT_FLAGS), so it cannot start a session, a pane or a claudish.
 */
const PRINT_CHILD_DROPPED_MARKERS: readonly string[] = [
  ...PANE_LAUNCH_VARS,
  ENV.CLAUDISH_PANE_CHILD,
];

/**
 * The print child's environment: the server's, minus the set no claudish child may
 * inherit (the same predicate the pane spawner uses), minus the pane markers
 * (PRINT_CHILD_DROPPED_MARKERS), minus the three `ANTHROPIC_*`
 * variables. `ANTHROPIC_API_KEY` goes unconditionally: a Claude model in `run_prompt`
 * runs on the Claude Code login; the metered Anthropic API is `anthropic@claude-*`,
 * which is not native and never reaches this module.
 */
export function claudeCodePrintEnv(
  parent: Record<string, string | undefined>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined || isStrippedFromChildEnv(k)) continue;
    if (PRINT_CHILD_DROPPED_MARKERS.includes(k)) continue;
    env[k] = v;
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

type Frame = Record<string, unknown>;

function isFrame(v: unknown): v is Frame {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonDocument(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A stray non-JSON line before the document (a banner) must not hide it: try the
    // last line that looks like a JSON document.
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("[") && !line.startsWith("{")) continue;
      try {
        return JSON.parse(line);
      } catch {
        // keep looking
      }
    }
    return undefined;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Read Claude Code's `--output-format json` output: an ARRAY of frames on 2.1.301
 * (`system/init`, `assistant`, `rate_limit_event`, `result`), a single result object in
 * older releases. Takes the last `type: "result"` frame and the `system/init` frame.
 * Null when there is no result frame, so an unknown shape is never a false success.
 */
export function parseClaudeCodePrintOutput(stdout: string): ClaudeCodePrintResult | null {
  const doc = parseJsonDocument(stdout);
  const frames: Frame[] = Array.isArray(doc) ? doc.filter(isFrame) : isFrame(doc) ? [doc] : [];
  let result: Frame | undefined;
  let init: Frame | undefined;
  for (const f of frames) {
    if (f.type === "result") result = f;
    else if (f.type === "system" && f.subtype === "init" && init === undefined) init = f;
  }
  if (!result) return null;

  const parsed: ClaudeCodePrintResult = {
    result: typeof result.result === "string" ? result.result : "",
    isError: result.is_error === true,
    apiErrorStatus: typeof result.api_error_status === "number" ? result.api_error_status : null,
  };
  if (typeof result.terminal_reason === "string") parsed.terminalReason = result.terminal_reason;
  if (isFrame(result.usage)) {
    const u = result.usage;
    // A cached prefix is still context the model saw, so it counts as input.
    parsed.usage = {
      input:
        num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
      output: num(u.output_tokens),
    };
  }
  if (init && typeof init.apiKeySource === "string") parsed.apiKeySource = init.apiKeySource;
  return parsed;
}

/** `apiKeySource` → the `auth` field: `"none"` is the Claude Code login. */
function authFrom(apiKeySource: string | undefined): string | undefined {
  if (apiKeySource === undefined) return undefined;
  return apiKeySource === "none" ? "subscription" : apiKeySource;
}

/* ───────────────────────────── process lifetime ───────────────────────────── */

/** Print children still running, so server shutdown can stop them. */
const inFlight = new Set<ChildProcess>();

const KILL_GRACE_MS = 5000;

/**
 * Stop a print child's whole process group: SIGTERM, then SIGKILL after 5 s. The
 * group, not the pid, because `claudish` on PATH may be the `bin/claudish.cjs`
 * launcher, which orphans the real process on a plain SIGTERM.
 */
function killGroup(proc: ChildProcess): void {
  const send = (sig: NodeJS.Signals): void => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, sig);
      else proc.kill(sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  send("SIGTERM");
  const timer = setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
  timer.unref?.();
}

/** Stop every print child still running. Called from the MCP server's shutdown. */
export function stopAllClaudeCodePrintChildren(): void {
  for (const proc of inFlight) killGroup(proc);
}

const STDERR_TAIL_CHARS = 2000;

function stderrTail(stderr: string): string {
  return sanitizeForReport(stderr.slice(-STDERR_TAIL_CHARS).trim());
}

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one Claude model prompt as `claudish -p` and return its answer. Throws an
 * `Error` whose message is the `run_prompt` error text (without the `Error: ` prefix).
 *
 * There is no wall-clock deadline, as on the proxy path: the child stops only on the
 * call's `signal` (the host cancelled or timed out) or server shutdown.
 */
export async function runPromptViaClaudeCode(
  model: string,
  prompt: string,
  systemPrompt: string | undefined,
  opts: { signal?: AbortSignal; parentEnv?: Record<string, string | undefined> } = {}
): Promise<RunPromptResult> {
  const signal = opts.signal;
  if (signal?.aborted) throw new Error("cancelled");
  const parentEnv = opts.parentEnv ?? process.env;

  let launch: ReturnType<typeof resolveClaudishLaunch>;
  try {
    launch = resolveClaudishLaunch(parentEnv);
  } catch (e) {
    throw new Error(
      `cannot start claudish (${parentEnv.CLAUDISH_BIN?.trim() || "claudish"}): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  // The child's cwd is a subdirectory, so it is EMPTY when Claude Code starts; the
  // system prompt file sits beside it, never inside it.
  const root = mkdtempSync(join(tmpdir(), "claudish-run-prompt-"));
  try {
    const cwd = join(root, "cwd");
    mkdirSync(cwd, { mode: 0o700 });
    let systemPromptFile: string | undefined;
    if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
      systemPromptFile = join(root, "system-prompt.txt");
      writeFileSync(systemPromptFile, systemPrompt, { mode: 0o600 });
    }

    const argv = claudeCodePrintArgv(model, systemPromptFile);
    const outcome = await runChild(
      launch,
      argv,
      cwd,
      claudeCodePrintEnv(parentEnv),
      prompt,
      signal
    );

    if (signal?.aborted) throw new Error("cancelled");

    const parsed = parseClaudeCodePrintOutput(outcome.stdout);
    if (parsed === null) {
      const how =
        outcome.code !== null ? `exited ${outcome.code}` : `exited ${outcome.signal ?? "?"}`;
      const tail = stderrTail(outcome.stderr);
      const noFrame = outcome.code === 0 ? " with no result frame in its output" : "";
      throw new Error(`claudish -p ${how}${noFrame}${tail ? `: ${tail}` : ""}`);
    }
    if (parsed.isError) {
      const status = parsed.apiErrorStatus !== null ? ` (HTTP ${parsed.apiErrorStatus})` : "";
      throw new Error(`Claude Code: ${parsed.result || parsed.terminalReason || "error"}${status}`);
    }
    if (parsed.result === "") throw new Error("Model returned empty response");

    const answer: RunPromptResult = { content: parsed.result };
    if (parsed.usage) answer.usage = parsed.usage;
    const auth = authFrom(parsed.apiKeySource);
    if (auth !== undefined) answer.auth = auth;
    return answer;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Spawn the child with all three stdio streams PIPED: this process's stdin and stdout
 * are the MCP JSON-RPC transport, so an inherited stdin would eat the host's requests
 * and an inherited stdout would corrupt the stream. `detached` gives the child its own
 * process group for `killGroup`.
 */
function runChild(
  launch: { command: string; prefixArgs: string[] },
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  prompt: string,
  signal: AbortSignal | undefined
): Promise<ChildOutcome> {
  return new Promise((resolvePromise, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(launch.command, [...launch.prefixArgs, ...argv], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      reject(startError(launch.command, e));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const onAbort = (): void => killGroup(proc);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      inFlight.delete(proc);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // EPIPE when the child exits before reading its stdin is not an error of its own;
    // the exit code and output say what happened.
    proc.stdin?.on("error", () => {});

    proc.on("error", (e) => finish(() => reject(startError(launch.command, e))));
    proc.on("close", (code, sig) =>
      finish(() => resolvePromise({ code, signal: sig, stdout, stderr }))
    );

    inFlight.add(proc);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    proc.stdin?.end(prompt);
  });
}

function startError(command: string, e: unknown): Error {
  const code = (e as { code?: unknown } | null)?.code;
  const detail =
    typeof code === "string" ? code : e instanceof Error ? e.message : String(e ?? "unknown");
  return new Error(`cannot start claudish (${command}): ${detail}`);
}
