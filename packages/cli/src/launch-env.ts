/**
 * Which environment values may steer claudish itself.
 *
 * A handful of variables decide what code claudish runs or what role the process
 * plays: the config file (it names the hook modules claudish imports, the endpoints
 * keys are sent to, and the 1Password sources), the pane-child markers and the
 * snapshot that re-creates the parent's environment, the hook inbox, and the claudish
 * binary a child is spawned from. These are the CONTROL VARIABLES. Their one rule:
 *
 *   a control variable comes from the real environment of the process — the user's
 *   shell, an MCP host's `env`, or the parent claudish that spawned it — and NEVER
 *   from an env file in the working directory.
 *
 * The working directory is often a checkout the user has not reviewed, and Claude
 * Code starts the claudish MCP server there before its folder-trust dialog. Two
 * loaders read env files from it, and each is closed at its source:
 *
 *   - Bun loads `.env`, `.env.<NODE_ENV>`, `.env.<NODE_ENV>.local` and `.env.local`
 *     before any claudish code runs, merged into `process.env` with nothing marking
 *     which values came from a file. Every launch path therefore turns that off: the
 *     npm launcher and the `dist/index.js` shebang pass `--no-env-file`, the compiled
 *     binary is built with `--no-compile-autoload-dotenv`, and a claudish child under
 *     `CLAUDISH_BIN=<file>.ts` runs `bun --no-env-file run <file>`. A launch that left it
 *     on (a hand-typed `bun <entry>`) is detected by `bunLoadedCwdEnvFiles`. Then every
 *     control variable is dropped, since none of them can be told apart from a file's,
 *     and so is every other name Bun's env files set in this directory
 *     (`bin/env-files.cjs` asks Bun which). The npm launcher does the same for itself
 *     when Bun, not Node, runs it.
 *   - claudish's own `.env` load sets provider API keys and model settings only
 *     (`dotenv-allowlist.ts`).
 *
 * Matching Bun's file list or its parser is NOT the rule: both differ from dotenv's
 * and change between Bun releases, and an earlier version of this check that compared
 * values was bypassed by `.env.development.local`, by a quoting difference, and by a
 * pane snapshot carrying the variable. Bun itself is asked for the names.
 *
 * Imports nothing from claudish, so `launch-guard.ts` can run it before any module
 * that reads the environment while it is being evaluated.
 */

import { createRequire } from "node:module";

/** The control variables. Spelled out rather than imported, to keep this module a leaf. */
export const CONTROL_VARS = [
  "CLAUDISH_CONFIG",
  "CLAUDISH_PANE_CHILD",
  "CLAUDISH_PANE_ENV",
  "CLAUDISH_PANE_CWD",
  "CLAUDISH_HOOK_INBOX",
  "CLAUDISH_HOOK_SESSION",
  "CLAUDISH_PARENT_SESSION",
  "CLAUDISH_BIN",
] as const;

/** Bun's flag that turns off its env-file autoload. */
export const NO_ENV_FILE_FLAG = "--no-env-file";

type Env = Record<string, string | undefined>;

/**
 * True when `entryPath` is inside a `bun build --compile` executable: Bun serves the
 * embedded module graph from `/$bunfs/` (POSIX) or `B:\~BUN\` (Windows). The drive
 * is always `B:`; any other drive is a real directory someone could name `~BUN`.
 */
export function isCompiledEntry(entryPath: string): boolean {
  return entryPath.startsWith("/$bunfs/") || /^B:[\\/]~BUN[\\/]/.test(entryPath);
}

/**
 * True when Bun loaded the working directory's env files before claudish ran.
 *
 * Off only with `--no-env-file` on Bun's own argv (`process.execArgv`; `--env-file=<x>`
 * is not enough, since `<x>` can be a file in the checkout), or in a compiled binary,
 * which `build:binary` and `release.yml` build with `--no-compile-autoload-dotenv`
 * (pinned by `launch-env.test.ts`). A compiled binary reports an empty `execArgv`, so
 * it is recognised by its entry path instead.
 */
export function bunLoadedCwdEnvFiles(execArgv: readonly string[], entryPath: string): boolean {
  if (isCompiledEntry(entryPath)) return false;
  return !execArgv.includes(NO_ENV_FILE_FLAG);
}

/** Delete every control variable present in `env`; returns the names deleted. */
export function dropControlVars(env: Env): string[] {
  return dropNames(env, CONTROL_VARS);
}

/** Delete each of `names` present in `env`; returns the names deleted, in order. */
function dropNames(env: Env, names: readonly string[]): string[] {
  const dropped: string[] = [];
  for (const key of names) {
    if (env[key] === undefined) continue;
    delete env[key];
    dropped.push(key);
  }
  return dropped;
}

/**
 * Set by the npm launcher (`bin/claudish.cjs`) when Bun ran it with the env-file
 * autoload on: the comma-separated names it left out of this process's environment.
 * It only feeds the stderr notice, and it is read once and deleted, so no child
 * inherits it.
 */
export const LAUNCHER_DROPPED_VAR = "CLAUDISH_LAUNCHER_DROPPED";

/** Read and delete `LAUNCHER_DROPPED_VAR`; returns the names it carried. */
export function takeLauncherDropped(env: Env): string[] {
  const raw = env[LAUNCHER_DROPPED_VAR];
  delete env[LAUNCHER_DROPPED_VAR];
  return raw ? raw.split(",").filter((name) => name.length > 0) : [];
}

/** `bin/env-files.cjs`: one implementation, shared with the npm launcher. */
interface EnvFilesModule {
  envFileKeys(opts: {
    bunPath: string;
    execArgv: readonly string[];
    cwd: string;
    env: Env;
  }): string[] | null;
  droppedByAutoloadNotice(names: readonly string[]): string;
  probeFailedNotice(): string;
}

/**
 * Loaded only on the unsupported launch. The path holds from `src/` and from the
 * bundled `dist/`, both one level below the package root that ships `bin/`.
 */
function envFilesModule(): EnvFilesModule {
  return createRequire(import.meta.url)("../bin/env-files.cjs") as EnvFilesModule;
}

/** What `dropEnvFileValues` did: the names dropped, or that Bun could not answer. */
export type EnvFileDrop = { ok: true; dropped: string[] } | { ok: false };

/**
 * For a Bun that loaded the working directory's env files: delete every control
 * variable, and every other name those files set, from `env`. A real value that shares
 * a name with a file's is lost too, which is the safe direction.
 */
export function dropEnvFileValues(
  env: Env,
  probe: { bunPath: string; execArgv: readonly string[]; cwd: string }
): EnvFileDrop {
  const fileKeys = envFilesModule().envFileKeys({ ...probe, env });
  if (fileKeys === null) return { ok: false };
  const dropped = dropControlVars(env);
  for (const key of dropNames(env, fileKeys)) dropped.push(key);
  return { ok: true, dropped };
}

/** The one stderr line for names dropped because Bun's env-file autoload was on. */
export function droppedByAutoloadNotice(names: readonly string[]): string {
  return envFilesModule().droppedByAutoloadNotice(names);
}

/** The one stderr line when Bun could not say which names its env files set. */
export function probeFailedNotice(): string {
  return envFilesModule().probeFailedNotice();
}
