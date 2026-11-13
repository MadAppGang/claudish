/**
 * Finished runs read from their records, for a reader that must keep showing them after the
 * server that ran them evicted them, restarted or exited: `claudish view --list --include-finished`
 * and the feed relay.
 *
 * Every directory under the sessions directory is one run: a session (`<id>/`), or a team run's
 * record (`team-<8 hex>/spawn.json`, whose `teamPath` holds the run's `status.json`). They are
 * taken newest first by the directory's mtime (a record written by rename moves it), up to
 * `limit` runs. Rows come from the same builders the MCP tools use for a run they do not hold:
 * `SessionManager.diskSessionRow` and `teamRunRowFromDisk`.
 *
 * The directory only grows (about 12 000 entries measured, 60 ms to stat them all), so callers
 * read it on an event, not on a timer.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionsDirFrom } from "../mcp-session/home-dir.js";
import { SessionManager } from "../mcp-session/session-manager.js";
import type { SessionRow } from "../pane/contract.js";
import {
  type ViewDetail,
  type ViewItem,
  targetOfSession,
  targetOfSlot,
} from "../pane/view-contract.js";
import { type TeamStatus, getStatus, teamRunRowFromDisk } from "../team-orchestrator.js";
import { promptSummaryOf } from "./prompt-summary.js";

/** runs listed from the records, newest first */
export const HISTORY_LIMIT = 30;
/** bytes of `prompt.md` read for its first line */
const PROMPT_HEAD_BYTES = 4096;

export interface HistoryOptions {
  /** default `~/.claudish/sessions` */
  sessionsDir?: string;
  /** runs, not items: a team run counts once */
  limit?: number;
}

/** What a record cannot know: nothing runs, nothing is pending, nobody views it. */
function finishedDetail(promptSummary: string | null): ViewDetail {
  return {
    prompt_summary: promptSummary,
    prompts_sent: promptSummary === null ? 0 : 1,
    pending_inputs: 0,
    subagents: [],
    magmux: null,
  };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readHead(path, 64 * 1024) ?? "") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readHead(path: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Run directories, newest first. */
function runDirs(sessionsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const dated: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      const st = statSync(join(sessionsDir, name));
      if (st.isDirectory()) dated.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // removed while listing
    }
  }
  return dated.sort((a, b) => b.mtimeMs - a.mtimeMs).map((d) => d.name);
}

function sessionItem(row: SessionRow, promptSummary: string | null): ViewItem {
  const target = targetOfSession(row.session_id);
  return { ...row, ...finishedDetail(promptSummary), view: null, kind: "session", target };
}

/** The slots of the team run a `team-*` record names; null when its status cannot be read. */
function teamItems(spawn: Record<string, unknown>): { runId: string; items: ViewItem[] } | null {
  const path = typeof spawn.teamPath === "string" ? spawn.teamPath : null;
  if (!path) return null;
  let status: TeamStatus;
  try {
    status = getStatus(path);
  } catch {
    return null;
  }
  if (!status || typeof status !== "object" || typeof status.startedAt !== "string") return null;
  const run = teamRunRowFromDisk(path, status);
  const items: ViewItem[] = run.slots.map((slot) => ({
    ...slot,
    ...finishedDetail(null),
    view: null,
    kind: "team_slot",
    target: targetOfSlot(run.run_id, slot.slot),
    run_id: run.run_id,
    run_path: run.path,
    run_kind: run.kind,
  }));
  return { runId: run.run_id, items };
}

/** The items of the run in one record directory; null when it is not a readable run, or one already listed. */
function runItems(
  sessions: SessionManager,
  dir: string,
  name: string,
  seenRuns: Set<string>
): ViewItem[] | null {
  const spawn = readJson(join(dir, "spawn.json"));
  if (spawn?.kind === "team" || name.startsWith("team-")) {
    const team = spawn ? teamItems(spawn) : null;
    if (!team || seenRuns.has(team.runId) || team.items.length === 0) return null;
    seenRuns.add(team.runId);
    return team.items;
  }
  // a directory with neither record is not a session's
  if (!spawn && readJson(join(dir, "meta.json")) === null) return null;
  const row = sessions.diskSessionRow(name);
  if (!row) return null;
  const prompt = readHead(join(dir, "prompt.md"), PROMPT_HEAD_BYTES);
  return [sessionItem(row, prompt ? promptSummaryOf(prompt) : null)];
}

/** The newest `limit` runs in the records, as view items. Never throws. */
export function readHistory(o: HistoryOptions = {}): ViewItem[] {
  const sessionsDir = o.sessionsDir ?? sessionsDirFrom(process.env);
  const limit = o.limit ?? HISTORY_LIMIT;
  const sessions = new SessionManager({ sessionsDir, hostPid: process.pid });
  const seenRuns = new Set<string>();
  const out: ViewItem[] = [];
  let runs = 0;
  for (const name of runDirs(sessionsDir)) {
    if (runs >= limit) break;
    const items = runItems(sessions, join(sessionsDir, name), name, seenRuns);
    if (!items) continue;
    out.push(...items);
    runs++;
  }
  return out;
}

/**
 * The item `target` (`s:<session_id>` or `t:<run_id>/<slot>`) names, from its record however old;
 * null when no record holds it. A session's record is its own directory; a team slot's run is
 * searched newest first, reading only team records. Never throws.
 */
export function findRecordedItem(target: string, o: HistoryOptions = {}): ViewItem | null {
  const sessionsDir = o.sessionsDir ?? sessionsDirFrom(process.env);
  const sessions = new SessionManager({ sessionsDir, hostPid: process.pid });
  if (target.startsWith("s:")) {
    const id = target.slice(2);
    if (!id || id.includes("/") || id.startsWith(".")) return null;
    const items = runItems(sessions, join(sessionsDir, id), id, new Set());
    return items?.find((i) => i.target === target) ?? null;
  }
  if (!target.startsWith("t:")) return null;
  const seenRuns = new Set<string>();
  for (const name of runDirs(sessionsDir)) {
    const dir = join(sessionsDir, name);
    if (!name.startsWith("team-") && readJson(join(dir, "spawn.json"))?.kind !== "team") continue;
    const found = runItems(sessions, dir, name, seenRuns)?.find((i) => i.target === target);
    if (found) return found;
  }
  return null;
}
