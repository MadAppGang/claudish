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
 * magmux runs a pane DECLARED: `--controller claude-code --session-id <uuid> --transcript
 * <path>` before `-e` names the session and the transcript claudish already gives Claude
 * Code and its own transcript follower, so magmux's input gate reads exactly that file
 * and never its mtime-based discovery, which can lock onto the parent's or a sibling's
 * transcript (research-magmux §3; architecture-v2 R1.0). `PaneSession` verifies the
 * binding from `list` on every attach (`gate-binding.ts`). The pane command itself still
 * never names `claude`: a direct `claude` launch would be gated with basis `direct`, by
 * discovery, and have its `--settings` rewritten.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  CLAUDISH_EXITING_FLAGS,
  CLAUDISH_FLAG_ARITY,
  type PassthroughClassification,
  classifyPassthroughTokens,
} from "../cli.js";
import { ENV } from "../config.js";
import { findMagmuxCandidates } from "../launcher/magmux-binary.js";
import { STRIPPED_CHILD_VARS } from "../launcher/magmux-wrapper.js";
import { log } from "../logger.js";
import { resolveClaudishSpawn } from "../spawn-claudish.js";
import { isPaneShellManagedKey } from "./child-env.js";
import { DEFAULT_PANE_COLS, DEFAULT_PANE_ROWS } from "./pane-size.js";
import { type WatcherArgs, isValidPaneId, watcherArgv } from "./process-identity.js";

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

/** Create (0700) and verify one directory directly under a verified socket root. Returns its path. */
export function ensurePrivateSubdir(root: string, name: string): string {
  const dir = join(root, name);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  assertPrivateDir(dir);
  return dir;
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
export function mintPaneId(kind: "t" | "s" | "r", label: string): string {
  const head = `c${process.pid}-${OWNER_START36}-${kind}`;
  const tail = `-${randomBytes(3).toString("hex")}`;
  const room = Math.max(0, 40 - head.length - tail.length);
  const clean = label.replace(/[^A-Za-z0-9_]/g, "").slice(0, room);
  const id = `${head}${clean}${tail}`;
  if (!isValidPaneId(id)) throw new Error(`minted an invalid pane id: ${id}`);
  return id;
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

/**
 * A multiplexer's address for the pane that started this server. A Claude Code child that
 * inherits it runs the user's session hooks against that address, so the child reports its
 * own session into the caller's multiplexer pane.
 */
export const MULTIPLEXER_IDENTITY_PREFIXES = ["HERDR_"] as const;

export const MULTIPLEXER_IDENTITY_VARS = [
  "HC_TERMINAL_ID",
  "HC_TERMINAL_SOCKET",
  "HC_SCOPE",
  "HC_SESSION",
  "HC_SOCKET",
] as const;

/** The MCP server's HOST identity: describes the server's host, not the pane's fresh session. */
export const HOST_IDENTITY_VARS = [
  "CLAUDISH_LAUNCHER_PID",
  "CLAUDISH_LAUNCHER_PPID",
  "CLAUDE_CODE_SESSION_ID",
] as const;

/** Linux's per-variable limit (MAX_ARG_STRLEN 131,072) with a margin. */
export const LINUX_ENV_STRING_LIMIT = 131_000;

/**
 * Whether `key` is withheld from every claudish child this server starts: a pane child
 * (`buildPaneEnv`) and `run_prompt`'s print child (`mcp/run-prompt-claude-code.ts`).
 * One list for both spawners: `STRIPPED_CHILD_VARS` (a nested-session marker), every
 * `MAGMUX_*` key, the terminal-identity and multiplexer-identity sets and the server's
 * host identity.
 */
export function isStrippedFromChildEnv(key: string): boolean {
  return (
    (STRIPPED_CHILD_VARS as readonly string[]).includes(key) ||
    key.startsWith("MAGMUX_") ||
    (TERMINAL_IDENTITY_VARS as readonly string[]).includes(key) ||
    TERMINAL_IDENTITY_PREFIXES.some((p) => key.startsWith(p)) ||
    MULTIPLEXER_IDENTITY_PREFIXES.some((p) => key.startsWith(p)) ||
    (MULTIPLEXER_IDENTITY_VARS as readonly string[]).includes(key) ||
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
  /**
   * This process's active `--config` / `CLAUDISH_CONFIG` file (`getConfigFileOverride()`),
   * or null. Set as the child's `CLAUDISH_CONFIG`, so the child reads the config its
   * parent reads, whatever `parentEnv` carries.
   */
  configFile: string | null;
  platform?: NodeJS.Platform;
  /** the pane's size at launch (already clamped); DEFAULT_PANE_COLS × DEFAULT_PANE_ROWS when absent */
  cols?: number;
  rows?: number;
}

/**
 * magmux's environment: the parent's minus the stripped, terminal-identity and host-
 * identity keys, plus the geometry, the slot env, the parent's config file, the pane
 * markers, the snapshot, and finally `SHELL=<ctlDir>/sh-shim` (after the snapshot,
 * which keeps the real `SHELL`). The markers and the config travel only here, in the
 * spawn environment: the child honours them because no env file can set them
 * (launch-env.ts).
 */
export function buildPaneEnv(input: PaneEnvInput): { magmuxEnv: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.parentEnv)) {
    if (v === undefined || isStrippedFromChildEnv(k)) continue;
    env[k] = v;
  }
  env.COLUMNS = String(input.cols ?? DEFAULT_PANE_COLS);
  env.LINES = String(input.rows ?? DEFAULT_PANE_ROWS);
  // Two independent defaults; a caller's own value of either is kept. Each is checked on
  // its own, because a caller that turns traffic off itself still needs the cursor
  // default. Traffic off leaves Claude Code's tengu_native_cursor flag at its default
  // false, so Claude draws
  // its own reverse-video cursor on the first rune of the faint "Try …" placeholder,
  // which magmux's input gate reads as text in the box (box_not_empty) and boot never
  // becomes ready. CLAUDE_CODE_NATIVE_CURSOR restores the terminal's native cursor;
  // Claude Code reads it as set or unset, so any non-empty value (even "0") turns it on.
  if (input.parentEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined)
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  if (input.parentEnv.CLAUDE_CODE_NATIVE_CURSOR === undefined) env.CLAUDE_CODE_NATIVE_CURSOR = "1";
  // The delegating conversation comes from this spawn's `slotEnv` only: a value the
  // owner inherited (its user's shell) names no conversation of this call.
  delete env[ENV.CLAUDISH_PARENT_SESSION];
  Object.assign(env, input.slotEnv);
  if (input.configFile !== null) env.CLAUDISH_CONFIG = input.configFile;
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

/* ───────────────────────────── a replay's environment and argv ───────────────────────────── */

/**
 * The only parent variables a replay inherits. An allowlist, so a credential or a provider
 * switch a later Claude Code adds cannot pass by being unknown. `HOME` and `CLAUDE_CONFIG_DIR`
 * lead to credential files; `--bare` stops those reads.
 */
export const REPLAY_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
] as const;

/**
 * magmux's environment for a replay: the allowlist and seven fixed keys, nothing else. No
 * snapshot and no `CLAUDISH_PANE_CWD`, which exist for a claudish child, and a replay has
 * none. `CLAUDE_CONFIG_DIR` is copied or overridden, never defaulted: unset, Claude Code
 * reads `~/.claude.json`, and pointing it at `~/.claude` would lose every trust entry.
 *
 * Two switches keep a read-only replay from writing plugin state into that config or drawing a
 * dialog over the conversation; `--bare` stops neither. Without the first, a start against a
 * config with no official marketplace installs it (about 580 files, 14 MB under `plugins/`).
 * The second leaves file history empty, so the LSP plugin recommendation, which offers a
 * plugin for the file types the resumed conversation touched, finds no file to match even
 * where a marketplace is already installed; it also stops an empty `file-history/<fork>/`.
 */
export function buildReplayEnv(input: {
  parentEnv: Record<string, string | undefined>;
  ctlDir: string;
  cols: number;
  rows: number;
  /** set only when it differs from `claudeConfigDir(parentEnv)` */
  configDirOverride?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of REPLAY_ENV_ALLOWLIST) {
    const v = input.parentEnv[k];
    if (v) env[k] = v;
  }
  if (input.configDirOverride) env.CLAUDE_CONFIG_DIR = input.configDirOverride;
  env.SHELL = join(input.ctlDir, "sh-shim");
  env[ENV.CLAUDISH_PANE_CHILD] = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = "1";
  env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = "1";
  env.COLUMNS = String(input.cols);
  env.LINES = String(input.rows);
  return env;
}

/**
 * `claude`'s argv. `--setting-sources ""` closes every settings file, whose `env` block could
 * otherwise carry a key or a provider switch; `--session-id` names the one record a fork could
 * write. `claudeSessionId` comes from a record on disk: the caller checks it is a uuid first,
 * because quoting stops the shell but not a value that starts with `-`.
 */
export function buildReplayArgv(
  claudeSessionId: string,
  forkUuid: string,
  settingsJson: string
): string[] {
  return [
    "--resume",
    claudeSessionId,
    "--fork-session",
    "--session-id",
    forkUuid,
    "--bare",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    settingsJson,
  ];
}

/**
 * The `--settings` value: only the known keys `statusLine`, `wheelScrollAccelerationEnabled`
 * and `tui`, so `env` and `apiKeyHelper` cannot enter. `tui: "fullscreen"` is set because
 * `--setting-sources ""` keeps the user's `tui` from reaching the replay, and without it Claude
 * Code picks its view by install and feature gates; the classic view ignores the SGR wheel
 * events `scroll_session` sends.
 */
export function replaySettingsJson(statusLine: unknown | null): string {
  return JSON.stringify({
    ...(statusLine === null ? {} : { statusLine }),
    wheelScrollAccelerationEnabled: false,
    tui: "fullscreen",
  });
}

const MAX_USER_SETTINGS_BYTES = 1024 * 1024;

/**
 * The `statusLine` object of `<configDir>/settings.json`, else null: absent, unreadable,
 * oversized, invalid JSON or any other value. Never throws. Project and local settings files
 * are never read.
 */
export function readUserStatusLine(configDir: string): unknown | null {
  try {
    const path = join(configDir, "settings.json");
    if (statSync(path).size > MAX_USER_SETTINGS_BYTES) return null;
    const v = (JSON.parse(readFileSync(path, "utf8")) as { statusLine?: unknown } | null)
      ?.statusLine;
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
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
  "account",
  "update",
  "init",
  "profile",
  "config",
  "telemetry",
  "stats",
  "serve",
  "providers",
  "keychain",
  "subscription",
  "hooks",
  "team",
  "login",
  "logout",
  "quota",
  "usage",
  "view",
  "herdr",
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

/**
 * SlotRow.agent_requested: the value of the LAST `--agent` in the child's flags (both
 * `--agent x` and `--agent=x`); null when there is none. `buildChildClaudeFlags` has
 * already folded the `agent` argument and any `--agent` in `claude_flags` into one pair.
 */
export function requestedAgentOf(flags: readonly string[]): string | null {
  let agent: string | null = null;
  for (let i = 0; i < flags.length; i++) {
    const [name, inline] = splitFlag(flags[i] as string);
    if (name !== "--agent") continue;
    const value = inline ?? flags[i + 1];
    if (value && !value.startsWith("-")) agent = value;
  }
  return agent;
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

/**
 * The first magmux that serves a read-only view socket beside the control socket (0.19.0,
 * `--view-sock`). It also carries what 0.18.0 and 0.17.0 introduced: a socket at any path
 * depth, and the Claude Code input gate with a declared transcript (`--session-id`,
 * `--transcript`, and `list`'s `bound`/`sessionId`/`transcriptPath`). A pre-release such as
 * `0.19.0-rc1` passes: `versionAtLeast` compares the numeric triple only.
 */
export const MIN_MAGMUX_VERSION = "0.19.0";

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

type MagmuxBinary = { binary: string; version: string };

/** Successes only: a failed probe is never cached, so the next caller probes again. */
const magmuxCache = new Map<string, MagmuxBinary>();
/** The probe in flight per key: six slots starting at once run `--version` once, not six times. */
const magmuxProbes = new Map<string, Promise<MagmuxBinary>>();

/** The magmux binary and its version (≥ `MIN_MAGMUX_VERSION`), cached per process. Never a `-p` fallback. */
export async function assertMagmuxAvailable(binary?: string): Promise<MagmuxBinary> {
  const key = binary ?? "";
  const cached = magmuxCache.get(key);
  if (cached) return cached;
  const inFlight = magmuxProbes.get(key);
  if (inFlight) return inFlight;
  const probe = (async () => {
    try {
      const result = await probeMagmux(binary);
      magmuxCache.set(key, result);
      return result;
    } finally {
      magmuxProbes.delete(key);
    }
  })();
  magmuxProbes.set(key, probe);
  return probe;
}

async function probeMagmux(binary?: string): Promise<MagmuxBinary> {
  if (binary !== undefined) return probeOneMagmux(binary);
  return selectMagmux(findMagmuxCandidates());
}

/**
 * A pane magmux is a 0.x release at or above `MIN_MAGMUX_VERSION`. A version off the 0.x line
 * is not a newer magmux: a stale bundled build reported "3.4.2", which passes any 0.x floor.
 */
export function isUsableMagmuxVersion(version: string): boolean {
  return /^0\./.test(version) && versionAtLeast(version, MIN_MAGMUX_VERSION);
}

/** What a pane magmux needs, named in every refusal. */
const MAGMUX_NEEDS =
  "a read-only view socket, a socket at any path depth, and the Claude Code input gate bound to a named transcript";

/** The `X.Y.Z` of one binary, asked twice when the first run printed none. */
async function versionOf(found: string): Promise<string> {
  // Under load a run has exited 0 with no version in its output, and six concurrent probes
  // refused a good 0.17.0 as "version unknown". Ask once more before refusing; a real version
  // below the floor is an answer and is not retried.
  const version = await readMagmuxVersion(found);
  return version || readMagmuxVersion(found);
}

/** An explicit binary is the only candidate: it is used, or the session is refused. */
async function probeOneMagmux(found: string): Promise<MagmuxBinary> {
  const version = await versionOf(found);
  if (!version || !isUsableMagmuxVersion(version))
    throw new MagmuxUnavailableError(
      `magmux_unavailable: ${found} is version ${version || "unknown"}${version && !/^0\./.test(version) ? " (not a 0.x release)" : ""}; panes need >= ${MIN_MAGMUX_VERSION} (${MAGMUX_NEEDS}); upgrade: brew upgrade MadAppGang/tap/magmux`
    );
  return { binary: found, version };
}

/**
 * The first candidate that passes `isUsableMagmuxVersion`, probed in order; the walk stops at the
 * first pass. Only when none passes is the session refused, naming every candidate and what it
 * reported, so a stale bundled copy never hides a good magmux on PATH.
 */
export async function selectMagmux(candidates: readonly string[]): Promise<MagmuxBinary> {
  if (candidates.length === 0)
    throw new MagmuxUnavailableError(
      "magmux_unavailable: magmux not found (bundled package or PATH); install it: brew install MadAppGang/tap/magmux"
    );
  const refused: string[] = [];
  for (const found of candidates) {
    let version: string;
    try {
      version = await versionOf(found);
    } catch (e) {
      refused.push(`${found} --version failed (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (version && isUsableMagmuxVersion(version)) {
      log(`[pane] magmux ${found} ${version}`);
      return { binary: found, version };
    }
    if (!version) refused.push(`${found} reports no version`);
    else if (!/^0\./.test(version)) refused.push(`${found} reports ${version} (not a 0.x release)`);
    else refused.push(`${found} reports ${version}`);
  }
  throw new MagmuxUnavailableError(
    `magmux_unavailable: no usable magmux; panes need a 0.x release >= ${MIN_MAGMUX_VERSION} (${MAGMUX_NEEDS}): ${refused.join(", ")}; upgrade: brew upgrade MadAppGang/tap/magmux`
  );
}

/** How long one `magmux --version` run may take before it is killed and counted as no answer. */
const MAGMUX_VERSION_TIMEOUT_MS = 5000;

/** The `X.Y.Z` from one `<binary> --version` run, read from stdout and stderr together; "" when absent. */
async function readMagmuxVersion(found: string): Promise<string> {
  const out = await runMagmuxVersion(found, MAGMUX_VERSION_TIMEOUT_MS);
  return out.match(VERSION_PATTERN)?.[1] ?? "";
}

/**
 * One `<binary> --version` run. It answers as soon as the output holds a version, and otherwise
 * shortly after the child exits; it never waits for the pipes to close, because another process
 * can hold their write ends long after magmux exited. A deadline that depends on neither the exit
 * nor the pipes bounds it: a child that ignores SIGTERM once kept the promise pending, and because
 * `assertMagmuxAvailable` hands one in-flight probe to every caller, every later pane start in the
 * process hung with it. On expiry the run rejects at once, the child is SIGKILLed, and its pipes
 * are released.
 */
function runMagmuxVersion(found: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const startedAt = performance.now();
    const timer = setTimeout(() => {
      // a timer that ran late, or a child already reaped, points at a blocked event loop;
      // a timer on time with the child still running points at magmux itself
      const ranAt = Math.round(performance.now() - startedAt);
      const code = child?.exitCode ?? child?.signalCode ?? null;
      const childState = code === null ? "still running" : `already exited (${code})`;
      fail(`no answer in ${timeoutMs} ms (timer ran at ${ranAt} ms; child ${childState})`);
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }, timeoutMs);
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const fail = (detail: string): void => {
      if (!settle()) return;
      rejectRun(
        new MagmuxUnavailableError(`magmux_unavailable: ${found} --version failed: ${detail}`)
      );
    };
    let out = "";
    const done = (): void => {
      if (!settle()) return;
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolveRun(out);
    };
    const read = (chunk: string): void => {
      out += chunk;
      // the answer is in: never wait for the pipes to close, since a process spawned at the same
      // moment can inherit their write ends (macOS has no pipe2(O_CLOEXEC)) and hold them open
      if (VERSION_PATTERN.test(out)) done();
    };
    try {
      // async: the first create_session or team run must not stall the MCP server's event
      // loop for up to 5 s (every other session's frames and socket share it)
      child = spawn(found, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.setEncoding("utf8").on("data", read);
      child.stderr?.setEncoding("utf8").on("data", read);
      child.on("error", (e) => fail(e.message));
      child.on("exit", (code, signal) => {
        // output written just before the exit can still be in flight; a held pipe never closes
        setTimeout(() => {
          if (code === 0 || VERSION_PATTERN.test(out)) return done();
          fail(`exited with ${code ?? signal}${out.trim() ? `: ${out.trim()}` : ""}`);
        }, EXIT_DRAIN_MS);
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });
}

/** The version in `magmux --version` output. */
const VERSION_PATTERN = /(\d+\.\d+\.\d+)/;
/** After the child exits, how long its last output may take to arrive. */
const EXIT_DRAIN_MS = 100;

/* ───────────────────────────── launcher ───────────────────────────── */

export interface ClaudishLaunch {
  command: string;
  prefixArgs: string[];
}

export class ClaudishNotFoundError extends Error {
  readonly code = "pane_lost";
}

/** Which claudish the launcher `exec`s: `CLAUDISH_BIN` (`*.ts` → `<bun> --no-env-file run <file>`), else PATH. */
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

/**
 * A replay's launcher. Its first line closes descriptor 3, the replay lock magmux holds
 * (`spawnReplayMagmux`): magmux's pane shell inherits it across `exec`, and a lock any child
 * keeps would outlive the replay. Then the real `SHELL` goes back in place, because magmux
 * needed the shim and a status line or a `!` command should see the user's own shell.
 */
export function replayLauncherScript(
  realShell: string,
  cwd: string,
  launch: ClaudishLaunch,
  argv: string[]
): string {
  return `exec 3>&-\nexport SHELL=${shq(realShell)}\n${launcherScript(cwd, launch, argv)}`;
}

export const SHELL_SHIM = '#!/bin/sh\n[ "$1" = -l ] && shift\nexec /bin/sh "$@"\n';

/** The `-e` value. It never names `claude`: the pane is declared, not a direct launch. */
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

/**
 * Fatal magmux stderr: an invalid `--id` (magmux ignores it and binds under its pid), an
 * unusable `--sock-dir` / `MAGMUX_SOCK_DIR` (magmux exits 1), a failed control socket bind,
 * or a failed view socket bind (`magmux: view socket <path>: <error>`, exit 1).
 */
export const FATAL_MAGMUX_STDERR =
  /ignoring --id|magmux: (?:--sock-dir|MAGMUX_SOCK_DIR) |magmux: socket|magmux: view socket /;

export interface MagmuxSpawnInput {
  binary: string;
  paneId: string;
  sockRoot: string;
  ctlDir: string;
  cwd: string;
  /**
   * magmux's environment (`buildPaneEnv`). It is built from the same parent environment
   * the transcript path is derived from, so a `CLAUDE_CONFIG_DIR` the session uses is in
   * magmux's own environment too, where magmux resolves the session registry.
   */
  env: Record<string, string>;
  /** the `--session-id` claudish passes Claude Code */
  sessionUuid: string;
  /** the transcript claudish's follower reads; made absolute here (magmux requires it) */
  transcriptPath: string;
}

/**
 * magmux's argv. The declaration comes before `-e`, which it binds; `--id <paneId>
 * --sock-dir` stays adjacent, because that pair is how the reap, the sweep and the pane
 * watcher recognise this pane's magmux (`magmuxNeedle`). `--view-sock` (a flag with no value)
 * comes before that pair, so it never splits it; `--view-op` is never passed, so a client on
 * the view socket can call no plugin op.
 */
export function paneMagmuxArgv(input: Omit<MagmuxSpawnInput, "binary" | "cwd" | "env">): string[] {
  return [
    "--headless",
    "--no-status",
    "--controller",
    "claude-code",
    "--session-id",
    input.sessionUuid,
    "--transcript",
    resolve(input.transcriptPath),
    "--view-sock",
    "--id",
    input.paneId,
    "--sock-dir",
    input.sockRoot,
    "-e",
    paneCommand(input.ctlDir),
  ];
}

export function spawnPaneMagmux(input: MagmuxSpawnInput): ChildProcess {
  const proc = spawn(input.binary, paneMagmuxArgv(input), {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  proc.on("error", () => {});
  return proc;
}

export type ReplayMagmuxInput = Omit<MagmuxSpawnInput, "sessionUuid" | "transcriptPath"> & {
  /**
   * The replay lock's descriptor, handed to magmux as its fd 3 (no close-on-exec in the
   * child), so the kernel holds the lock exactly as long as magmux lives.
   */
  holdFd?: number;
};

/**
 * A replay's magmux argv: no `--controller`, `--session-id` or `--transcript`, because nothing
 * reads a gate on this pane. `--id <paneId> --sock-dir` stays adjacent, for `magmuxNeedle`.
 */
export function replayMagmuxArgv(
  input: Omit<ReplayMagmuxInput, "binary" | "cwd" | "env">
): string[] {
  return [
    "--headless",
    "--no-status",
    "--view-sock",
    "--id",
    input.paneId,
    "--sock-dir",
    input.sockRoot,
    "-e",
    paneCommand(input.ctlDir),
  ];
}

export function spawnReplayMagmux(input: ReplayMagmuxInput): ChildProcess {
  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "ignore", "pipe"];
  if (input.holdFd !== undefined) stdio.push(input.holdFd);
  const proc = spawn(input.binary, replayMagmuxArgv(input), {
    cwd: input.cwd,
    env: input.env,
    stdio,
    detached: true,
  });
  proc.on("error", () => {});
  return proc;
}
