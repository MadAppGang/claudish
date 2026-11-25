/**
 * The text claudish writes into an answer when a provider reports a terminal
 * error inside an HTTP 200 stream (the Responses parser, `responses-turn.ts`).
 * It is sent as an ordinary assistant text block ending `end_turn`, because an
 * error event would make Claude Code retry a request that fails again. Claude
 * Code therefore never flags it `isApiErrorMessage`, so a session classifier
 * that reads only that flag reports the next rule instead: a billing failure
 * (`credit_balance_exhausted`) read as `prompt_not_read` (recommended-effort
 * bench, run12). One definition, so the writer and the reader cannot drift.
 */

import { redactSecrets } from "./redact.js";

/** The in-band text for a terminal in-stream API error. */
export function formatInBandApiError(code: string, message: string): string {
  return `\n\n[API Error: ${code} ${message}]`;
}

/**
 * The proxy's record of the last in-band error it wrote, as the token file's
 * `in_band_api_error` (`TokenTracker.recordInBandApiError`): the code only, never the
 * message, which is upstream text. `at` is the ISO time the proxy saw the error.
 */
export interface InBandApiErrorRecord {
  code: string;
  at: string;
}

const ERROR_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * The code as the token file stores it and as a marker is compared: the code's first
 * whitespace-free word, verbatim when that word is an identifier that `redactSecrets`
 * leaves unchanged, else `malformed`. The first word because the marker is
 * `<code> <message>`, so a parser reads only the code's first word back from it; the
 * identifier and redaction checks because the code comes from the provider's error body
 * and the token file is not a redacted surface, so a live signing value or a key-shaped
 * word never reaches it. The writer and the reader both key through this function. A
 * word the redaction changes keys to `malformed`, so a record written while that value
 * was live never matches a marker carrying it: the proof fails closed.
 */
export function inBandErrorCodeKey(code: string): string {
  const word = /\S+/.exec(code)?.[0] ?? "";
  if (!ERROR_CODE_SHAPE.test(word)) return "malformed";
  return redactSecrets(word) === word ? word : "malformed";
}

/**
 * Whether the proxy proved that a marker with `code` is its own: its token file records an
 * in-band error with the same code at or after the turn's start. Text alone cannot tell
 * the writer's `[API Error: <code> <message>]` from a model quoting one, because the
 * message is upstream text that may hold `]` and newlines. A missing record, an unknown
 * or unreadable turn start, or a record from before the turn proves nothing.
 */
export function proxyProvesInBandError(
  code: string,
  record: InBandApiErrorRecord | null | undefined,
  turnStartedAt: string | null | undefined
): boolean {
  if (!record || typeof record.code !== "string" || typeof record.at !== "string") return false;
  if (!turnStartedAt) return false;
  const at = Date.parse(record.at);
  const start = Date.parse(turnStartedAt);
  if (!Number.isFinite(at) || !Number.isFinite(start) || at < start) return false;
  return record.code === inBandErrorCodeKey(code);
}

/**
 * The error when the WHOLE answer is one in-band marker, else null. A marker
 * inside a longer answer is the model's own text and is never read as an error.
 * `trailing` also accepts a marker that ENDS the answer after a blank line, as
 * the writer appends it after a preamble ("I'll read the file."); the caller
 * passes it only for a turn that never read its task file, where nothing after
 * the preamble can be an answer.
 */
export function parseInBandApiError(
  answer: string,
  opts: { trailing?: boolean } = {}
): { code: string; text: string } | null {
  const trimmed = answer.trim();
  const m =
    /^\[API Error: (\S+)([\s\S]*)\]$/.exec(trimmed) ??
    (opts.trailing ? /\n\n\[API Error: (\S+)([^\n\]]*)\]$/.exec(trimmed) : null);
  if (!m) return null;
  return { code: m[1], text: `${m[1]}${m[2]}` };
}
