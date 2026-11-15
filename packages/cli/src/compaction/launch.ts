/**
 * What compaction adds to Claude Code's argv: `--add-dir` for the session's
 * own compaction folder, so the model may Read a compressed output's recovery
 * file without a permission prompt, and no other session's folder.
 *
 * The folder is named by the session id, which must be known before Claude
 * Code starts:
 *
 * | The user's arguments                         | Session id               |
 * |----------------------------------------------|--------------------------|
 * | `--session-id <uuid>`                        | that id                  |
 * | `--resume <uuid>` / `-r <uuid>`              | that id                  |
 * | `--fork-session` with `--session-id <uuid>`  | the `--session-id` id    |
 * | `--continue` / `-c`, a bare `--resume`, `--resume <search term>`, `--fork-session` alone | unknown: nothing added |
 * | none of these                                | a minted UUID, passed as `--session-id <uuid>` |
 *
 * Nothing is written to Claude Code's environment.
 */

import { randomUUID } from "node:crypto";
import { logStderr } from "../logger.js";
import { ensureSessionFolder } from "./store.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session id the user's arguments fix before launch, or why none is known. */
export type CompactionSessionPlan =
  | { kind: "known"; sessionId: string }
  | { kind: "mint" }
  | { kind: "unknown"; reason: "continue" | "resume-picker" | "fork" | "not-a-uuid" };

function flagValue(args: ReadonlyArray<string>, i: number, eq: number): string | undefined {
  const a = args[i] as string;
  const v = eq > 0 ? a.slice(eq + 1) : args[i + 1];
  return v !== undefined && !v.startsWith("-") ? v : undefined;
}

/** Read the user's arguments (up to `--`) for the session id. */
export function compactionSessionPlan(args: ReadonlyArray<string>): CompactionSessionPlan {
  let sessionId: string | undefined;
  let resumeId: string | undefined;
  let resumed = false;
  let continued = false;
  let forked = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") break;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name === "--session-id") {
      const v = flagValue(args, i, eq);
      if (v !== undefined) sessionId = v;
    } else if (name === "--resume" || name === "-r") {
      resumed = true;
      const v = flagValue(args, i, eq);
      if (v !== undefined) resumeId = v;
    } else if (name === "--continue" || name === "-c") {
      continued = true;
    } else if (name === "--fork-session") {
      forked = true;
    }
  }
  if (forked) {
    return sessionId && UUID_PATTERN.test(sessionId)
      ? { kind: "known", sessionId }
      : { kind: "unknown", reason: "fork" };
  }
  if (continued) return { kind: "unknown", reason: "continue" };
  if (resumed) {
    return resumeId && UUID_PATTERN.test(resumeId)
      ? { kind: "known", sessionId: resumeId }
      : { kind: "unknown", reason: "resume-picker" };
  }
  if (sessionId !== undefined) {
    return UUID_PATTERN.test(sessionId)
      ? { kind: "known", sessionId }
      : { kind: "unknown", reason: "not-a-uuid" };
  }
  return { kind: "mint" };
}

/**
 * The session folders the startup purge must keep: the session the user's
 * arguments name in any of the forms `compactionSessionPlan` reads
 * (`--resume <id>`, `-r <id>`, `--resume=<id>`, `--session-id <id>`, ...),
 * and the one the resume picker chose.
 */
export function compactionKeepSessionIds(
  args: ReadonlyArray<string>,
  pickedSessionId: string | null
): string[] {
  const plan = compactionSessionPlan(args);
  const ids = new Set<string>();
  if (plan.kind === "known") ids.add(plan.sessionId);
  if (pickedSessionId) ids.add(pickedSessionId);
  return [...ids];
}

/** What the launcher puts in front of Claude Code's argv for compaction. */
export interface CompactionLaunch {
  /** Arguments for the FRONT of argv: `[--session-id <minted>] --add-dir <folder>`, or none. */
  leadingArgs: string[];
  /** The session id the folder is named by; null when unknown. */
  sessionId: string | null;
  /** The id claudish minted and passes as `--session-id`; null when it minted none. */
  mintedSessionId: string | null;
  /** The folder added; null when none. */
  dir: string | null;
}

/**
 * Plan compaction's arguments and create the session's folder (0700). The
 * arguments go at the FRONT of argv: `--add-dir` takes a variadic list, so
 * placed after the user's arguments it would swallow a positional prompt.
 */
export function prepareCompactionLaunch(
  userArgs: ReadonlyArray<string>,
  root: string,
  mint: () => string = randomUUID
): CompactionLaunch {
  const plan = compactionSessionPlan(userArgs);
  if (plan.kind === "unknown") {
    return { leadingArgs: [], sessionId: null, mintedSessionId: null, dir: null };
  }
  const minted = plan.kind === "mint" ? mint() : null;
  const sessionId = plan.kind === "known" ? plan.sessionId : (minted as string);
  const dir = ensureSessionFolder(root, sessionId);
  return {
    leadingArgs: [...(minted ? ["--session-id", minted] : []), "--add-dir", dir],
    sessionId,
    mintedSessionId: minted,
    dir,
  };
}

/**
 * The launcher's compaction step: `prepareCompactionLaunch`, and when the
 * session folder cannot be prepared, no arguments and one warning through
 * `logStderr`, which redacts every value on a signing lease and also writes
 * the debug log.
 */
export function compactionLaunchArgs(
  userArgs: ReadonlyArray<string>,
  root: string,
  mint: () => string = randomUUID
): { leadingArgs: string[]; mintedSessionId: string | null } {
  try {
    const launch = prepareCompactionLaunch(userArgs, root, mint);
    return { leadingArgs: launch.leadingArgs, mintedSessionId: launch.mintedSessionId };
  } catch (err) {
    logStderr(
      `[compaction] the session folder could not be prepared; no --add-dir added: ${err instanceof Error ? err.message : String(err)}`
    );
    return { leadingArgs: [], mintedSessionId: null };
  }
}
