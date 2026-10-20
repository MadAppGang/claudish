// ─── Host pid and the parent conversation ────────────────────────────────────
//
// Two facts a session or team record carries so an observer outside this
// process — the magus `claudish` plugin monitor — can tell which Claude Code
// window started a run:
//
//   * `hostPid`: the Claude Code process that launched this MCP server. A
//     structural fact, read once at startup from the process tree we were given
//     (our parent, or our launcher's parent). Never searched for.
//   * `parentClaudeSessionId`: the Claude Code CONVERSATION live in that window
//     when the tool call ran. Read once per call from the host's session record
//     `<configDir>/sessions/<hostPid>.json`, which Claude Code rewrites on every
//     session switch (`/clear`, `/resume`). Only when no record can be read does
//     it fall back to `CLAUDE_CODE_SESSION_ID`, the id the server was started
//     with, which goes stale on the first `/clear`.
//
// Why not prove it from the transcript: Claude Code (measured on 2.1.290)
// appends the call's `tool_use` record only AFTER the MCP tool call returns, so
// no search made while the tool runs can find the call it is attributing.
//
// Accepted race: a `/clear` typed in the very moment a call runs may attribute
// that run to the new conversation. It is always a conversation of the same
// window — the record is keyed by this server's own host pid.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { userHomeFrom } from "./home-dir.js";

/** What a Claude Code session id may look like. Also the path-safety gate. */
export const CLAUDE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

// ─── hostPid ─────────────────────────────────────────────────────────────────

export interface HostPids {
  /** The Claude Code process that launched this MCP server. */
  hostPid: number;
  /**
   * The npm `node` launcher (`bin/claudish.cjs`) between Claude Code and this
   * process, when there is one. Present exactly when `hostPid` came from the
   * launcher branch, so every record says which branch produced it.
   */
  launcherPid?: number;
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The host pid, from the environment and our own parent pid. Pure.
 *
 * - npm / bun global install: Claude Code → `node` launcher → `bun` (us). The
 *   launcher sets `CLAUDISH_LAUNCHER_PID` (itself) and `CLAUDISH_LAUNCHER_PPID`
 *   (its parent). When `CLAUDISH_LAUNCHER_PID` is OUR parent, the host is the
 *   launcher's parent.
 * - compiled binary, or `bun src/index.ts`: our parent is the host.
 *
 * The pair check makes a leaked pair inert: a nested claudish that inherits an
 * outer launcher's variables sees `CLAUDISH_LAUNCHER_PID` ≠ its own parent and
 * ignores them. No `ps`, no walk.
 */
export function hostPidFrom(env: Record<string, string | undefined>, ppid: number): HostPids {
  const launcherPpid = positiveInt(env.CLAUDISH_LAUNCHER_PPID);
  if (
    env.CLAUDISH_LAUNCHER_PID === String(ppid) &&
    launcherPpid !== undefined &&
    launcherPpid !== ppid
  ) {
    return { hostPid: launcherPpid, launcherPid: ppid };
  }
  return { hostPid: ppid };
}

// ─── parentClaudeSessionId ───────────────────────────────────────────────────

/**
 * The conversation id this server was started with, when it is usable at all.
 *
 * `CLAUDE_CODE_SESSION_ID` when it is well formed and `CLAUDE_CODE_CHILD_SESSION`
 * is empty. Claude Code sets the latter for Bash-tool children and monitors and
 * strips it from the stdio MCP servers it launches, so its presence means this
 * server was not started by Claude Code directly. The fallback only: it is
 * current until the first `/clear` and stale after it.
 */
export function parentSessionIdFrom(env: Record<string, string | undefined>): string | undefined {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (id === undefined || !CLAUDE_ID_RE.test(id)) return undefined;
  if (env.CLAUDE_CODE_CHILD_SESSION) return undefined;
  return id;
}

/**
 * `CLAUDE_CONFIG_DIR`, else `<home>/.claude`, with `<home>` resolved by the
 * same `$HOME`-first rule as the sessions directory (home-dir.ts): Claude Code
 * follows `$HOME`, and Bun's `os.homedir()` does not.
 */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(userHomeFrom(env), ".claude");
}

/** The host's live session record, as far as claudish trusts it. */
export interface HostSessionRecord {
  sessionId: string;
}

/**
 * `<configDir>/sessions/<hostPid>.json`, the record Claude Code writes at
 * startup and rewrites on every session switch, so its `sessionId` is the
 * window's live conversation (`/clear` moves it to the new id, `/resume` back).
 * Used only when it parses, its `pid === hostPid`, and its `sessionId` is well
 * formed; anything else is `undefined`. Never throws.
 */
export async function readHostSessionRecord(opts: {
  configDir: string;
  hostPid: number;
}): Promise<HostSessionRecord | undefined> {
  try {
    const raw = await readFile(join(opts.configDir, "sessions", `${opts.hostPid}.json`), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const rec = parsed as { pid?: unknown; sessionId?: unknown };
    if (rec.pid !== opts.hostPid) return undefined;
    if (typeof rec.sessionId !== "string" || !CLAUDE_ID_RE.test(rec.sessionId)) return undefined;
    return { sessionId: rec.sessionId };
  } catch {
    return undefined;
  }
}

/**
 * The `parentClaudeSessionId` for one `create_session` or `team(mode:"run")`
 * call, read once at call time: the host session record's `sessionId`, else
 * the environment's id, else `undefined` (the field is then omitted). One file
 * read, no search, no wait. Never throws.
 */
export async function parentSessionForCall(opts: {
  hostPid: number;
  env?: Record<string, string | undefined>;
}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const record = await readHostSessionRecord({
    configDir: claudeConfigDir(env),
    hostPid: opts.hostPid,
  });
  return record?.sessionId ?? parentSessionIdFrom(env);
}
