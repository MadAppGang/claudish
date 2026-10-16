/**
 * `SlotRow.reason_detail` (mod contract v1, additive): one readable line that says WHY a
 * terminal slot or session did not complete, so a reader of `team(mode="status")` or
 * `list_sessions` sees "no-such-model-zz9 is not a valid model ID" beside `api_error`
 * instead of having to open `status.json` or `get_diagnostics`.
 *
 * `reasonDetail` is pure; both row builders (team's `toSlotRow` / `teamRunRowFromDisk`
 * and the channel's `sessionRowOf`) call it. `upstreamRecordsFor` is the one bounded
 * read of the upstream-error capture file, done only when the rule can use it.
 *
 * Only the provider's `error.message` is ever lifted out of an upstream body: the body
 * itself carries account identifiers (`user_id`), so no other field and never the whole
 * body reaches a row.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { type FailureReason, type SlotState, isTerminalState } from "./contract.js";

/** Longest `reason_detail`, ellipsis included. */
export const REASON_DETAIL_MAX_CHARS = 160;

/** Tail of the upstream-error file read for the last record (one record is ≤ ~2.3 KB). */
const UPSTREAM_TAIL_BYTES = 16 * 1024;

export interface ReasonDetailInput {
  state: SlotState;
  reason: FailureReason | null;
  /** the owner's verdict detail (`PaneSnapshot.detail`, `status.json` `error.detail`) */
  detail: string | null | undefined;
}

/**
 * The row's `reason_detail`: null on every non-terminal state, on COMPLETED, and when
 * nothing readable exists. For `api_error`, the provider's `error.message` from the LAST
 * upstream record when it has one, else the child's API-error text without claudish's
 * "The turn ended in an API error (status N): API Error: N" boilerplate. For every other
 * reason, the first line of its detail. One line, at most REASON_DETAIL_MAX_CHARS.
 *
 * `upstreamRecords` are raw JSONL lines of the capture file, oldest first.
 */
export function reasonDetail(
  input: ReasonDetailInput,
  upstreamRecords: readonly string[] = []
): string | null {
  if (!isTerminalState(input.state) || input.state === "COMPLETED") return null;
  if (input.reason === "api_error") {
    const last = upstreamRecords.length ? upstreamRecords[upstreamRecords.length - 1] : undefined;
    const upstream = last === undefined ? null : upstreamMessage(last);
    if (upstream) return oneLine(upstream);
    const child = firstLine(input.detail);
    return child ? oneLine(apiErrorText(child)) : null;
  }
  const first = firstLine(input.detail);
  return first ? oneLine(first) : null;
}

/**
 * The upstream records `reasonDetail` needs for this row: the capture file's tail when
 * the row is a terminal `api_error`, else none (no read at all). Never throws.
 */
export function upstreamRecordsFor(
  input: Pick<ReasonDetailInput, "state" | "reason">,
  upstreamLogPath: string | null | undefined
): string[] {
  if (!upstreamLogPath || input.reason !== "api_error" || !isTerminalState(input.state)) return [];
  return readTailLines(upstreamLogPath, UPSTREAM_TAIL_BYTES);
}

function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

/** Whitespace collapsed, cut to the cap with an ellipsis; null when nothing is left. */
function oneLine(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > REASON_DETAIL_MAX_CHARS
    ? `${flat.slice(0, REASON_DETAIL_MAX_CHARS - 1).trimEnd()}…`
    : flat;
}

/**
 * The child's API-error line without its boilerplate. `classifyRunOutput` writes
 * "The turn ended in an API error (status 400): API Error: 400 <text>"; Claude Code's
 * own line is "API Error: 400 <text>", where <text> may be the provider's JSON body.
 */
function apiErrorText(detail: string): string {
  const text = detail
    // a team verdict's appended notes (" · background_shell_open …") are not the error
    .split(" · ")[0]
    .replace(/^The turn ended in an API error(?:\s*\(status \d+\))?:\s*/i, "")
    .replace(/^API Error:?\s*(?:\d{3}\b)?\s*/i, "")
    .trim();
  if (/^[[{]/.test(text)) return messageOfJsonText(text) ?? "";
  return text;
}

/** `error.message` of one upstream-capture JSONL record's `body`, or null. */
function upstreamMessage(record: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const body = parsed.body;
  if (typeof body === "string") return messageOfJsonText(body);
  return messageOf(body);
}

/**
 * `error.message` from a JSON text. A body cut at the capture cap no longer parses; its
 * message is then the first `"message":"…"` string, still never any other field.
 */
function messageOfJsonText(text: string): string | null {
  try {
    return messageOf(JSON.parse(text));
  } catch {
    const m = /"error"\s*:\s*\{[^{}]*?"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (!m) return null;
    try {
      return nonEmpty(JSON.parse(`"${m[1]}"`));
    } catch {
      return null;
    }
  }
}

/** `{error:{message}}`, or the first element of an array of those (Gemini's shape). */
function messageOf(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!isObject(v) || !isObject(v.error)) return null;
  return nonEmpty(v.error.message);
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The last `maxBytes` of a JSONL file as whole non-empty lines; [] on any failure. */
function readTailLines(path: string, maxBytes: number): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim().length > 0);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing to recover
      }
    }
  }
}
