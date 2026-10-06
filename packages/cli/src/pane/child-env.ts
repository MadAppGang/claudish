/**
 * Runs inside the claudish that an MCP `team` slot or `create_session` starts in a
 * headless magmux pane — "the pane child". Nothing here runs anywhere else: every
 * entry point returns at once unless `CLAUDISH_PANE_CHILD === "1"`.
 *
 * The pane child must run in EXACTLY the environment and working directory of the MCP
 * server that started it (D16). Two things stand between them:
 *
 *   - magmux starts the pane through `$SHELL -l -c`, so a login profile could re-export
 *     `OPENAI_API_KEY`, `CLAUDE_CONFIG_DIR`, `PATH`, or `cd` somewhere else. The server
 *     therefore passes a JSON snapshot of its environment as `CLAUDISH_PANE_ENV`
 *     (inherited, never written to disk), and `applyPaneEnvSnapshot` re-applies it
 *     here: every snapshot key is set, every key the snapshot lacks is removed, except
 *     the shell-managed set below, which the pane's own shell and terminal own.
 *   - the cwd: `CLAUDISH_PANE_CWD` is the realpath the server spawned in, and Claude
 *     Code derives the transcript directory from the cwd, so a profile `cd` would move
 *     the transcript out of the place the server reads it from.
 *
 * This module is imported FIRST by the CLI entry (`index.ts`), before `.env` loading
 * and before any module that reads the environment at import time. Its one side
 * effect is `bootstrapPaneChild()` at the bottom, which is a no-op without the marker.
 *
 * After `parseArgs`, `assertPaneChildInteractive` refuses any flag combination that
 * would make the pane child anything but an interactive Claude Code REPL. The server
 * checks `claude_flags` first; this is the defence in depth for a token its walker
 * mis-classifies (architecture §2.3 rule 3).
 *
 * Every refusal prints `claudish: pane child refused: <reason>` and exits 64, which the
 * server reports as FAILED `child_exited` with that line.
 */

import { realpathSync } from "node:fs";
import { ENV } from "../config.js";

/** Exit status of a refused pane child (EX_USAGE). */
export const PANE_CHILD_REFUSED_EXIT = 64;

/**
 * The internal markers. claude-runner deletes all three from Claude Code's
 * environment, so a claudish started from a slot's Bash tool is an ordinary launch.
 */
export const PANE_MARKER_VARS = [
  ENV.CLAUDISH_PANE_CHILD,
  ENV.CLAUDISH_PANE_ENV,
  ENV.CLAUDISH_PANE_CWD,
] as const;

/**
 * Keys owned by the pane's shell and terminal, not by the server's environment.
 * Excluded from the snapshot when it is built and kept when it is applied. Every
 * `MAGMUX_*` key belongs here too: `MAGMUX_SOCK`, injected by magmux into the pane,
 * is what tells the child it is already inside a multiplexer.
 */
export const PANE_SHELL_MANAGED_KEYS = [
  "COLUMNS",
  "LINES",
  "TERM",
  "SHLVL",
  "PWD",
  "OLDPWD",
  "_",
] as const;

export function isPaneShellManagedKey(key: string): boolean {
  return key.startsWith("MAGMUX_") || (PANE_SHELL_MANAGED_KEYS as readonly string[]).includes(key);
}

type Env = Record<string, string | undefined>;

/** Whether this process is a pane child. The one predicate every reader uses. */
export function isPaneChild(env: Env = process.env): boolean {
  return env[ENV.CLAUDISH_PANE_CHILD] === "1";
}

export type PaneBootResult = { ok: true; note?: string } | { ok: false; reason: string };

/**
 * Re-apply the server's environment snapshot onto `env`, in place.
 *
 * Set every snapshot key; delete every key the snapshot lacks, except the shell-managed
 * set and the pane markers (a snapshot missing the marker must not turn the child back
 * into an ordinary launch); delete `CLAUDISH_PANE_ENV`. No snapshot is not an error:
 * the child then runs with what it inherited.
 */
export function applyPaneEnvSnapshot(env: Env): PaneBootResult {
  const raw = env[ENV.CLAUDISH_PANE_ENV];
  if (raw === undefined) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad env snapshot" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "bad env snapshot" };
  }
  const snapshot = parsed as Record<string, unknown>;
  for (const value of Object.values(snapshot)) {
    if (typeof value !== "string") return { ok: false, reason: "bad env snapshot" };
  }
  const keep = new Set<string>([ENV.CLAUDISH_PANE_CHILD, ENV.CLAUDISH_PANE_CWD]);
  for (const key of Object.keys(env)) {
    if (Object.hasOwn(snapshot, key) || keep.has(key) || isPaneShellManagedKey(key)) continue;
    delete env[key];
  }
  for (const [key, value] of Object.entries(snapshot as Record<string, string>)) {
    env[key] = value;
  }
  delete env[ENV.CLAUDISH_PANE_ENV];
  return { ok: true };
}

export interface CwdOps {
  cwd: () => string;
  realpath: (path: string) => string;
  chdir: (path: string) => void;
}

const processCwdOps: CwdOps = {
  cwd: () => process.cwd(),
  realpath: (path) => realpathSync(path),
  chdir: (path) => process.chdir(path),
};

/**
 * Move into `CLAUDISH_PANE_CWD` when the process is not already there. A failed
 * `chdir` is a refusal: the transcript would land in a directory the server does not
 * read, and the slot would look like it never answered.
 */
export function enterPaneCwd(env: Env, ops: CwdOps = processCwdOps): PaneBootResult {
  const target = env[ENV.CLAUDISH_PANE_CWD];
  if (!target) return { ok: true };
  let here: string | null;
  try {
    here = ops.realpath(ops.cwd());
  } catch {
    here = null;
  }
  if (here === target) return { ok: true };
  try {
    ops.chdir(target);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `cannot enter ${target}: ${why}` };
  }
  return { ok: true, note: `[pane-child] cwd ${here ?? "(unresolvable)"} -> ${target}` };
}

/** The `parseArgs` fields the interactive assertion reads. */
export interface PaneChildConfigView {
  interactive?: boolean;
  team?: string[];
  stdin?: boolean;
  _hasPositionalPrompt?: boolean;
  _hasPrintFlag?: boolean;
}

/**
 * Why this parsed configuration cannot run as a pane child, or null when it can.
 * A pane child is an interactive REPL, never a team run, never print mode, and never
 * has a positional prompt (the prompt is typed into the REPL by the server).
 */
export function paneChildRefusal(config: PaneChildConfigView): string | null {
  if (config.team !== undefined) return "--team would start a team run instead of a REPL";
  if (config._hasPrintFlag) return "-p/--print would start print mode instead of a REPL";
  if (config.stdin) return "--stdin would start print mode instead of a REPL";
  if (config._hasPositionalPrompt) {
    return "a positional prompt reached the child; claudish takes one value per flag: write `--allowedTools Read,Bash`";
  }
  if (!config.interactive) return "the child is not interactive";
  return null;
}

function refuse(reason: string): never {
  process.stderr.write(`claudish: pane child refused: ${reason}\n`);
  process.exit(PANE_CHILD_REFUSED_EXIT);
}

/** Notes recorded before the logger exists; `logPaneChildBootNotes` flushes them. */
const bootNotes: string[] = [];

export function paneChildBootNotes(): readonly string[] {
  return bootNotes;
}

let bootstrapped = false;

/**
 * Restore the server's environment and cwd. Runs once, at import time from the CLI
 * entry; a no-op without the marker. Exits 64 on a bad snapshot or an unreachable cwd.
 */
export function bootstrapPaneChild(env: Env = process.env): void {
  if (bootstrapped || !isPaneChild(env)) return;
  bootstrapped = true;
  const snapshot = applyPaneEnvSnapshot(env);
  if (!snapshot.ok) refuse(snapshot.reason);
  const cwd = enterPaneCwd(env);
  if (!cwd.ok) refuse(cwd.reason);
  if (cwd.note) bootNotes.push(cwd.note);
}

/** Exit 64 unless the parsed configuration is an interactive REPL (§2.3 rule 3). */
export function assertPaneChildInteractive(
  config: PaneChildConfigView,
  env: Env = process.env
): void {
  if (!isPaneChild(env)) return;
  const reason = paneChildRefusal(config);
  if (reason !== null) refuse(reason);
}

bootstrapPaneChild();
