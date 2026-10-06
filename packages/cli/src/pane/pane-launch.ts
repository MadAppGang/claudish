/**
 * Everything that happens before a pane exists (architecture §2.3): the socket root,
 * pane ids, the child's environment, the launcher and shell shim, the caller-flag check,
 * and the two spawns — the pane watcher, then magmux.
 *
 * The pane child must run in EXACTLY the MCP server's environment and cwd (D16), which
 * a pipe spawn gave for free and a pane does not: magmux starts the pane through
 * `$SHELL -l -c`, a login shell that would run the user's profile. So the environment
 * travels as a JSON snapshot in `CLAUDISH_PANE_ENV` (inherited, never on disk) that the
 * child re-applies (`child-env.ts`), and `$SHELL` is a generated shim that drops `-l`, so
 * no profile runs at all (X-M15).
 *
 * The pane command must never name `claude`: magmux attaches its ClaudeCodeController
 * to such a pane, and that controller's mtime-based transcript discovery can lock onto
 * the parent's or a sibling's transcript (research-magmux §3).
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CLAUDISH_EXITING_FLAGS,
  CLAUDISH_FLAG_ARITY,
  type PassthroughClassification,
  classifyPassthroughTokens,
} from "../cli.js";
import { ENV } from "../config.js";
import { findMagmuxBinaryOrNull } from "../launcher/magmux-binary.js";
import { STRIPPED_CHILD_VARS } from "../launcher/magmux-wrapper.js";
import { resolveClaudishSpawn } from "../spawn-claudish.js";
import { isPaneShellManagedKey } from "./child-env.js";
import { type WatcherArgs, isValidPaneId, sockPathOf, watcherArgv } from "./process-identity.js";

/* ───────────────────────────── socket root ───────────────────────────── */

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/**
 * The socket root for `env`: `CLAUDISH_PANE_ROOT` when set (a location, like
 * `CLAUDISH_SESSIONS_DIR`; every check below still applies), else `/tmp/claudish-mux-<uid>`.
 */
export function sockRootFor(env: Record<string, string | undefined> = process.env): string {
  const override = env[ENV.CLAUDISH_PANE_ROOT]?.trim();
  // resolved once: every path check compares against this exact spelling, and the
  // watcher's shell globs ("$ROOT"/launch-??????) never match `/x/` or `./x`
  return override ? resolve(override) : `/tmp/claudish-mux-${uid()}`;
}

/** The default socket root of this process. */
export const SOCK_ROOT: string = sockRootFor();

export class PaneRootError extends Error {
  readonly code = "pane_root";
}

function assertPrivateDir(p: string): void {
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new PaneRootError(`pane socket root ${p} is not a real directory`);
  if (st.uid !== uid())
    throw new PaneRootError(`pane socket root ${p} is not owned by uid ${uid()}`);
  if ((st.mode & 0o077) !== 0)
    throw new PaneRootError(
      `pane socket root ${p} has mode ${(st.mode & 0o777).toString(8)}; it must be 0700`
    );
}

/** Create (0700) and verify the socket root and its `panes/` record dir. Returns `root`. */
export function ensureSockRoot(given: string = sockRootFor()): string {
  const root = resolve(given);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      mkdirSync(root, { recursive: true, mode: 0o700 });
    else if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  assertPrivateDir(root);
  const panes = join(root, "panes");
  try {
    mkdirSync(panes, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  assertPrivateDir(panes);
  return root;
}

/* ───────────────────────────── ids ───────────────────────────── */

/** This process's start time in ms, base 36: with the pid it makes a reused owner pid detectable. */
export const OWNER_START36 = Math.round(Date.now() - process.uptime() * 1000).toString(36);

export { isValidPaneId };

/** `c<pid>-<ownerStart36>-<kind><label>-<6 hex>`, at most 40 characters. */
export function mintPaneId(kind: "t" | "s", label: string): string {
  const head = `c${process.pid}-${OWNER_START36}-${kind}`;
  const tail = `-${randomBytes(3).toString("hex")}`;
  const room = Math.max(0, 40 - head.length - tail.length);
  const clean = label.replace(/[^A-Za-z0-9_]/g, "").slice(0, room);
  const id = `${head}${clean}${tail}`;
  if (!isValidPaneId(id)) throw new Error(`minted an invalid pane id: ${id}`);
  return id;
}

/** Unix socket paths must stay under 100 bytes, or magmux silently binds elsewhere. */
export function sockPathFor(root: string, id: string): string {
  const p = sockPathOf(root, id);
  if (Buffer.byteLength(p) >= 100)
    throw new PaneRootError(
      `pane socket path ${p} is ${Buffer.byteLength(p)} bytes; it must be < 100`
    );
  return p;
}

/* ───────────────────────────── environment ───────────────────────────── */

/** Variables that steer a TUI's rendering and integrations (X-M16): never in a pane. */
export const TERMINAL_IDENTITY_VARS = [
  "TMUX",
  "TMUX_PANE",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "COLORTERM",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "WT_SESSION",
  "CLAUDE_CODE_SSE_PORT",
  "ENABLE_IDE_INTEGRATION",
] as const;

export const TERMINAL_IDENTITY_PREFIXES = [
  "ITERM_",
  "KITTY_",
  "WEZTERM_",
  "ALACRITTY_",
  "GHOSTTY_",
  "VSCODE_",
] as const;

/** The MCP server's HOST identity: describes the server's host, not the pane's fresh session. */
export const HOST_IDENTITY_VARS = [
  "CLAUDISH_LAUNCHER_PID",
  "CLAUDISH_LAUNCHER_PPID",
  "CLAUDE_CODE_SESSION_ID",
] as const;

/** Linux's per-variable limit (MAX_ARG_STRLEN 131,072) with a margin. */
export const LINUX_ENV_STRING_LIMIT = 131_000;

function strippedFromPane(key: string): boolean {
  return (
    (STRIPPED_CHILD_VARS as readonly string[]).includes(key) ||
    key.startsWith("MAGMUX_") ||
    (TERMINAL_IDENTITY_VARS as readonly string[]).includes(key) ||
    TERMINAL_IDENTITY_PREFIXES.some((p) => key.startsWith(p)) ||
    (HOST_IDENTITY_VARS as readonly string[]).includes(key)
  );
}

export class PaneEnvTooLargeError extends Error {
  readonly code = "pane_lost";
}

export interface PaneEnvInput {
  parentEnv: Record<string, string | undefined>;
  slotEnv: Record<string, string>;
  /** realpath of the spawn cwd */
  cwd: string;
  /** the control directory holding `sh-shim` */
  ctlDir: string;
  platform?: NodeJS.Platform;
}

/**
 * magmux's environment: the parent's minus the stripped, terminal-identity and host-
 * identity keys, plus the geometry, the slot env, the pane markers, the snapshot, and
 * finally `SHELL=<ctlDir>/sh-shim` (after the snapshot, which keeps the real `SHELL`).
 */
export function buildPaneEnv(input: PaneEnvInput): { magmuxEnv: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.parentEnv)) {
    if (v === undefined || strippedFromPane(k)) continue;
    env[k] = v;
  }
  env.COLUMNS = "160";
  env.LINES = "50";
  if (input.parentEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined)
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  Object.assign(env, input.slotEnv);
  env[ENV.CLAUDISH_PANE_CHILD] = "1";
  env[ENV.CLAUDISH_PANE_CWD] = input.cwd;
  delete env[ENV.CLAUDISH_PANE_ENV];

  const snapshot: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isPaneShellManagedKey(k) || k === ENV.CLAUDISH_PANE_ENV) continue;
    snapshot[k] = v;
  }
  const json = JSON.stringify(snapshot);
  const entryBytes = Buffer.byteLength(`${ENV.CLAUDISH_PANE_ENV}=${json}`);
  if ((input.platform ?? process.platform) === "linux" && entryBytes > LINUX_ENV_STRING_LIMIT)
    throw new PaneEnvTooLargeError(
      `pane environment snapshot is ${entryBytes} bytes, over Linux's 131072-byte limit per variable`
    );
  env[ENV.CLAUDISH_PANE_ENV] = json;
  env.SHELL = join(input.ctlDir, "sh-shim");
  return { magmuxEnv: env };
}

/* ───────────────────────────── child argv and flags ───────────────────────────── */

export function buildClaudishPaneArgv(
  spawnModel: string,
  sessionUuid: string,
  turnDir: string,
  callerFlags: string[]
): string[] {
  return [
    "-i",
    "--model",
    spawnModel,
    "-y",
    "--quiet",
    "--session-id",
    sessionUuid,
    "--add-dir",
    turnDir,
    ...callerFlags,
  ];
}

/** Our own argv, plus `--no-auto-approve`, which defeats `-y` (phase-2 s09). */
const OWN_ARGV = [
  "-i",
  "--interactive",
  "--model",
  "-m",
  "-y",
  "--auto-approve",
  "--no-auto-approve",
  "--quiet",
  "-q",
  "--session-id",
];

const TRANSPORT_BREAKERS = [
  "-p",
  "--print",
  "--stdin",
  "--output-format",
  "--input-format",
  "--include-partial-messages",
  "--replay-user-messages",
  "--json",
  "--bg",
  "--background",
];

const IDENTITY_BREAKERS = [
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--from-pr",
  "--teleport",
  "--fork-session",
  "-w",
  "--worktree",
  "--no-session-persistence",
];

/** Claude Code flags that only work with `--print` (X-M3). */
export const PRINT_ONLY_FLAGS = [
  "--max-turns",
  "--max-budget-usd",
  "--fallback-model",
  "--json-schema",
  "--permission-prompt-tool",
];

/** claudish's own mode flags: each would start a different claudish mode in the pane (X-L2). */
const MODE_FLAGS = [
  "--team",
  "-f",
  "--file",
  "--grid",
  "--probe",
  "--models",
  "--monitor",
  "--advisor",
  "--mcp",
  "--kimi-login",
  "--kimi-logout",
  ...CLAUDISH_EXITING_FLAGS,
];

/**
 * Words index.ts treats as a SUBCOMMAND anywhere in argv (`args.includes("update")`,
 * the first non-dash token, …): a caller flag VALUE equal to one of them would dispatch
 * a subcommand instead of the REPL, which the child-side assertion cannot catch.
 */
export const SUBCOMMAND_WORDS = [
  "update",
  "init",
  "profile",
  "config",
  "telemetry",
  "stats",
  "serve",
  "providers",
  "keychain",
  "behavior",
  "team",
  "login",
  "logout",
  "quota",
  "usage",
];

export type FlagCheck = { ok: true } | { ok: false; message: string };

function reservedMessage(flag: string): string | null {
  if (PRINT_ONLY_FLAGS.includes(flag))
    return `${flag} works only with --print; team slots and sessions are interactive panes, so it would be silently ignored`;
  if (OWN_ARGV.includes(flag))
    return `${flag} is set by claudish itself for a pane child (-i --model <m> -y --quiet --session-id <uuid>)`;
  if (TRANSPORT_BREAKERS.includes(flag))
    return `${flag} would break the interactive pane transport`;
  if (IDENTITY_BREAKERS.includes(flag))
    return `${flag} would move the session to another transcript or directory`;
  if ((MODE_FLAGS as readonly string[]).includes(flag))
    return `${flag} would start a different claudish mode inside the pane`;
  return null;
}

/** Whether the flags visibly remove the Read tool (§2.3 rule 4). */
export function flagsRemoveRead(flags: string[]): boolean {
  for (let i = 0; i < flags.length; i++) {
    const [name, inline] = splitFlag(flags[i] as string);
    const value = inline ?? flags[i + 1] ?? "";
    if (name === "--disallowedTools" || name === "--disallowed-tools") {
      if (/(^|[\s,])Read([\s,(]|$)/.test(value)) return true;
    }
    if (name === "--tools") {
      if (!/(^|[\s,])Read([\s,(]|$)/.test(value)) return true;
    }
  }
  return false;
}

function splitFlag(token: string): [string, string | undefined] {
  if (!token.startsWith("-")) return [token, undefined];
  const eq = token.indexOf("=");
  return eq > 0 ? [token.slice(0, eq), token.slice(eq + 1)] : [token, undefined];
}

/**
 * Claude Code flags that take a value: every option `claude --help` (2.1.291) prints with
 * `<…>` or `[…]`, plus the `-file` variants it names in prose. Any other passthrough flag
 * is a boolean to Claude Code, so a token after it is Claude Code's POSITIONAL PROMPT
 * (`--verbose "do X"` boots the pane with a turn the server never typed), even though
 * claudish's own walker reads it as the flag's value. Unknown flags are refused with a
 * value rather than guessed at: a refusal is visible, a stray turn is not.
 */
export const CLAUDE_CODE_VALUE_FLAGS: readonly string[] = [
  "--add-dir",
  "--agent",
  "--agents",
  "--allowedTools",
  "--allowed-tools",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--autocompact",
  "--betas",
  "--cloud",
  "-d",
  "--debug",
  "--debug-file",
  "--disallowedTools",
  "--disallowed-tools",
  "--effort",
  "--environment",
  "--fallback-model",
  "--file",
  "--from-pr",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--mcp-config",
  "--model",
  "-n",
  "--name",
  "--output-format",
  "--permission-mode",
  "--permission-prompt-tool",
  "--permission-prompts",
  "--plugin-dir",
  "--plugin-url",
  "--prompt-suggestions",
  "--remote-control",
  "--remote-control-session-name-prefix",
  "-r",
  "--resume",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--system-prompt-file",
  "--system-prompt-snapshot",
  "--teleport",
  "--tools",
  "-w",
  "--worktree",
];

/** A value token after a passthrough flag Claude Code reads as a boolean. */
function booleanFlagValue(c: PassthroughClassification): { flag: string; value: string } | null {
  for (const t of c.tokens) {
    if (t.kind !== "passthrough-value") continue;
    const flag = splitFlag(c.tokens.find((x) => x.index === t.index - 1)?.token ?? "")[0];
    if (!CLAUDE_CODE_VALUE_FLAGS.includes(flag)) return { flag, value: t.token };
  }
  return null;
}

/**
 * The server-side check of `claude_flags` (D18): reserved tokens, subcommand words, and
 * any positional token or `--` (claudish would turn a positional into a `-p` prompt),
 * including a value after a flag Claude Code reads as a boolean.
 */
export function checkChildFlags(flags: string[]): FlagCheck {
  for (const token of flags) {
    if (typeof token !== "string") return { ok: false, message: "claude_flags must be strings" };
    const [name] = splitFlag(token);
    const msg = token.startsWith("-") ? reservedMessage(name) : null;
    if (msg) return { ok: false, message: msg };
    if (SUBCOMMAND_WORDS.includes(token))
      return {
        ok: false,
        message: `"${token}" is a claudish subcommand name and would start that subcommand inside the pane`,
      };
  }
  // `--flag=value` is one token to parseArgs as well, so the original tokens are classified.
  const c = classifyPassthroughTokens(flags);
  if (c.separatorAt !== null)
    return {
      ok: false,
      message:
        "claude_flags may not contain `--`: claudish would treat what follows as a prompt; claudish takes one value per flag: write `--allowedTools Read,Bash`",
    };
  if (c.positionals.length > 0)
    return {
      ok: false,
      message: `claude_flags contains a positional token (${JSON.stringify(c.positionals[0])}); claudish takes one value per flag: write \`--allowedTools Read,Bash\``,
    };
  const stray = booleanFlagValue(c);
  if (stray)
    return {
      ok: false,
      message: `claude_flags: ${stray.flag} takes no value in Claude Code, so ${JSON.stringify(stray.value)} would become the session's first prompt; pass the flag alone`,
    };
  return { ok: true };
}

/** Known claudish flags (exported for the drift test). */
export const KNOWN_CLAUDISH_FLAGS: readonly string[] = Object.keys(CLAUDISH_FLAG_ARITY);

/* ───────────────────────────── magmux binary ───────────────────────────── */

export const MIN_MAGMUX_VERSION = "0.14.0";

export class MagmuxUnavailableError extends Error {
  readonly code = "magmux_unavailable";
}

export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const b = min.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

const magmuxCache = new Map<string, { binary: string; version: string }>();
const execFileAsync = promisify(execFile);

/** The magmux binary and its version (≥ 0.14.0), cached per process. Never a `-p` fallback. */
export async function assertMagmuxAvailable(
  binary?: string
): Promise<{ binary: string; version: string }> {
  const cached = magmuxCache.get(binary ?? "");
  if (cached) return cached;
  const found = binary ?? findMagmuxBinaryOrNull();
  if (!found)
    throw new MagmuxUnavailableError(
      "magmux_unavailable: magmux not found (bundled package or PATH); install it: brew install MadAppGang/tap/magmux"
    );
  let out = "";
  try {
    // async: the first create_session or team run must not stall the MCP server's event
    // loop for up to 5 s (every other session's frames and socket share it)
    out = (await execFileAsync(found, ["--version"], { encoding: "utf8", timeout: 5000 })).stdout;
  } catch (e) {
    throw new MagmuxUnavailableError(
      `magmux_unavailable: ${found} --version failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  const version = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "";
  if (!version || !versionAtLeast(version, MIN_MAGMUX_VERSION))
    throw new MagmuxUnavailableError(
      `magmux_unavailable: ${found} is version ${version || "unknown"}; panes need >= ${MIN_MAGMUX_VERSION}`
    );
  const result = { binary: found, version };
  magmuxCache.set(binary ?? "", result);
  return result;
}

/* ───────────────────────────── launcher ───────────────────────────── */

export interface ClaudishLaunch {
  command: string;
  prefixArgs: string[];
}

export class ClaudishNotFoundError extends Error {
  readonly code = "pane_lost";
}

/** Which claudish the launcher `exec`s: `CLAUDISH_BIN` (`*.ts` → `<bun> run <file>`), else PATH. */
export function resolveClaudishLaunch(
  parentEnv: Record<string, string | undefined>
): ClaudishLaunch {
  const t = resolveClaudishSpawn(parentEnv as NodeJS.ProcessEnv);
  if (t.command.includes("/")) return t;
  const found = Bun.which(t.command, { PATH: parentEnv.PATH ?? "" });
  if (!found) throw new ClaudishNotFoundError(`${t.command} not found on PATH`);
  return { command: found, prefixArgs: t.prefixArgs };
}

/** POSIX single-quote escaping. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The launcher: `cd` to the realpath cwd, then `exec` claudish (no watcher, no PATH line). */
export function launcherScript(cwd: string, launch: ClaudishLaunch, argv: string[]): string {
  const words = [launch.command, ...launch.prefixArgs, ...argv].map(shq).join(" ");
  return `cd -- ${shq(cwd)} || exit 97\nexec ${words}\n`;
}

export const SHELL_SHIM = '#!/bin/sh\n[ "$1" = -l ] && shift\nexec /bin/sh "$@"\n';

/** The `-e` value. It never names `claude` (research-magmux §3). */
export function paneCommand(ctlDir: string): string {
  const cmd = `. ${shq(join(ctlDir, "pane-launch.sh"))}`;
  if (/claude /.test(cmd) || /claude$/.test(cmd) || /(^|\/)claude['"]?$/.test(cmd))
    throw new Error(`pane command would attach magmux's Claude Code controller: ${cmd}`);
  return cmd;
}

export interface LaunchDirs {
  /** control directory: pane-launch.sh, sh-shim, magmux.pid, group — never shown to the model */
  ctlDir: string;
  /** turn directory: turn-<n>.md only; the child's `--add-dir` (R3-M2) */
  turnDir: string;
}

export function createLaunchDirs(root: string): LaunchDirs {
  const ctlDir = mkdtempSync(join(root, "launch-"));
  chmodSync(ctlDir, 0o700);
  const turnDir = mkdtempSync(join(root, "launch-"));
  chmodSync(turnDir, 0o700);
  return { ctlDir, turnDir };
}

export function writeLauncherFiles(ctlDir: string, script: string): void {
  writeFileSync(join(ctlDir, "pane-launch.sh"), script, { mode: 0o600, flag: "wx" });
  writeFileSync(join(ctlDir, "sh-shim"), SHELL_SHIM, { mode: 0o700, flag: "wx" });
}

/* ───────────────────────────── spawns ───────────────────────────── */

/**
 * The pane watcher (D15 layer 1): a detached `/bin/sh` whose stdin is a pipe from this
 * process. EOF on it — this process ended, by any means — makes it verify and kill the
 * pane's group and magmux, then clean the files; `done` ends it after a clean reap.
 */
export function spawnPaneWatcher(args: WatcherArgs): ChildProcess {
  const proc = spawn("/bin/sh", watcherArgv(args), {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
    env: { PATH: "/bin:/usr/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  });
  // EPIPE on `done\n` means the watcher is already gone, which is not an error (R3-M1).
  proc.stdin?.on("error", () => {});
  proc.on("error", () => {});
  proc.unref();
  (proc.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  return proc;
}

/** Fatal magmux stderr: it ignores an invalid id or socket dir and binds somewhere else. */
export const FATAL_MAGMUX_STDERR = /ignoring --id|ignoring --sock-dir|magmux: socket/;

export interface MagmuxSpawnInput {
  binary: string;
  paneId: string;
  sockRoot: string;
  ctlDir: string;
  cwd: string;
  env: Record<string, string>;
}

export function spawnPaneMagmux(input: MagmuxSpawnInput): ChildProcess {
  const proc = spawn(
    input.binary,
    [
      "--headless",
      "--no-status",
      "--id",
      input.paneId,
      "--sock-dir",
      input.sockRoot,
      "-e",
      paneCommand(input.ctlDir),
    ],
    { cwd: input.cwd, env: input.env, stdio: ["ignore", "ignore", "pipe"], detached: true }
  );
  proc.on("error", () => {});
  return proc;
}
