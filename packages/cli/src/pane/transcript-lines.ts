/**
 * A Claude Code transcript entry as plain text lines (`transcript_session`, MTL-373).
 *
 * PURE and DETERMINISTIC: every function here is a function of its arguments alone. No
 * environment, no pane root, no signing-value lease, no I/O. The cursor of
 * `transcript_session` (`v1.<offset>.<k>.<id8>`, pane/transcript-page.ts) indexes the
 * k-th line one entry yields, so two calls — or two claudish servers reading the same
 * file — must mint the same lines from the same entry. Redaction, the tool argument's
 * whitespace and 160 cut, and splitting happen after this (pane/transcript-redaction.ts),
 * because redaction must see the FULL text and its signing-value half depends on live
 * leases.
 *
 * The line rules are the renderer revision `v1` (architecture § 2.2, § 2.3). A change
 * that alters how many lines one entry yields bumps the cursor prefix.
 */

import { parseInBandApiError } from "../in-band-api-error.js";
import type { TranscriptKind } from "./contract.js";
import { INTERRUPT_PREFIX, STDOUT_RE, isLocalCommandText } from "./transcript-follower.js";

/** A tool call's argument is cut to this many characters, `…` included. */
export const TOOL_ARG_MAX_CHARS = 160;

/**
 * One rendered line before redaction and splitting. `text` is sanitised and non-empty.
 * For a `tool` line `text` is the tool's name (one line) and `arg` its salient argument,
 * sanitised but WHOLE: neither whitespace-normalised nor cut, so redaction sees every
 * credential complete (pane/transcript-redaction.ts builds `Name(arg)`).
 */
export interface RenderedLine {
  kind: TranscriptKind;
  text: string;
  arg?: string;
}

// Transcript records are untyped JSON written by Claude Code; every read is guarded.
// biome-ignore lint/suspicious/noExplicitAny: raw JSON records, narrowed field by field
type Rec = Record<string, any>;

// ─── Sanitising ──────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the target
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the target
const STRING_SEQ_RE = /\x1b[PX^_][\s\S]*?\x1b\\/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the target
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const CSI8_RE = /\x9b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the target
const ESC2_RE = /\x1b[\x20-\x7e]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Plain text: escape sequences removed (OSC, DCS / SOS / PM / APC, CSI, 8-bit CSI, then
 * two-byte ESC), `\r\n` → `\n`, every C0 control but `\t` and `\n` removed (a lone `\r`
 * included), DEL and every C1 control removed, a lone surrogate → U+FFFD, trailing
 * whitespace trimmed. Returns "" for a text that is then empty.
 *
 * After this every UTF-16 code unit of the result costs at most 3 bytes of serialised
 * JSON (a lone surrogate would cost 6 as `\uDXXX`; U+FFFD costs 3).
 */
export function sanitiseText(s: string): string {
  if (!s) return "";
  return s
    .replace(OSC_RE, "")
    .replace(STRING_SEQ_RE, "")
    .replace(CSI_RE, "")
    .replace(CSI8_RE, "")
    .replace(ESC2_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(CONTROL_RE, "")
    .replace(LONE_SURROGATE_RE, "�")
    .trimEnd();
}

// ─── Splitting ───────────────────────────────────────────────────────────────

/** Bytes one UTF-16 code unit adds to `JSON.stringify`'s output, as UTF-8. */
function jsonUnitBytes(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return 2; // \" \\
  if (c < 0x20) return c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6;
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdbff) {
    const n = s.charCodeAt(i + 1);
    return n >= 0xdc00 && n <= 0xdfff ? 2 : 6; // half of a 4-byte pair, or `\uDXXX`
  }
  if (c >= 0xdc00 && c <= 0xdfff) {
    const p = s.charCodeAt(i - 1);
    return i > 0 && p >= 0xd800 && p <= 0xdbff ? 2 : 6;
  }
  return 3;
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * Where the chunk that starts at `pos` ends (exclusive), for `s` cut into chunks that each
 * satisfy BOTH bounds: at most `maxChars` UTF-16 code units, and at most `maxJsonBytes`
 * UTF-8 bytes as `JSON.stringify(chunk)` (quotes and escapes counted). A chunk ends after
 * the last `\n` inside the window (the `\n` stays in the earlier chunk), else after the
 * last space or tab, else hard — never between the two halves of a surrogate pair.
 *
 * LINEAR: the separators are searched only inside the window `[pos, end)`, never back
 * through the text before it (a `lastIndexOf` from `end` scanned the whole prefix of a
 * whitespace-free text for every chunk: 302 ms for 8 MiB, measured). Each chunk costs its
 * own window, so cutting a whole text is O(length).
 */
export function nextCut(s: string, pos: number, maxChars: number, maxJsonBytes: number): number {
  const contentBytes = Math.max(1, maxJsonBytes - 2); // the two quotes
  let end = pos;
  let bytes = 0;
  const limit = Math.min(s.length, pos + Math.max(1, maxChars));
  while (end < limit) {
    const b = jsonUnitBytes(s, end);
    if (bytes + b > contentBytes) break;
    bytes += b;
    end++;
  }
  if (end === s.length) return end;
  // never between a high and a low surrogate
  if (end > pos && isHigh(s.charCodeAt(end - 1)) && isLow(s.charCodeAt(end))) end--;
  // progress guard: at least one code point, whatever the bounds say
  if (end <= pos) return Math.min(s.length, pos + (isHigh(s.charCodeAt(pos)) ? 2 : 1));
  let space = -1;
  for (let i = end - 1; i >= pos; i--) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) return i + 1;
    if (space === -1 && (c === 0x20 || c === 0x09)) space = i;
  }
  return space !== -1 ? space + 1 : end;
}

/**
 * `s` cut by `nextCut` from the start. Joining the chunks with no separator gives `s`
 * back. Deterministic. A non-empty `s` yields at least one chunk; "" yields none.
 */
export function splitText(s: string, maxChars: number, maxJsonBytes: number): string[] {
  const chunks: string[] = [];
  for (let pos = 0; pos < s.length; ) {
    const cut = nextCut(s, pos, maxChars, maxJsonBytes);
    chunks.push(s.slice(pos, cut));
    pos = cut;
  }
  return chunks;
}

// ─── The tool one-liner ──────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** The salient argument of a known tool, from the measured input keys (§ 2.2). */
const TOOL_ARG: Record<string, (input: Rec) => string | undefined> = {
  Bash: (i) => str(i.command),
  Monitor: (i) => str(i.description) ?? str(i.command),
  Read: (i) => str(i.file_path),
  Write: (i) => str(i.file_path),
  Edit: (i) => str(i.file_path),
  MultiEdit: (i) => str(i.file_path),
  NotebookEdit: (i) => str(i.notebook_path),
  Glob: (i) => str(i.pattern),
  Grep: (i) => str(i.pattern),
  Agent: (i) => str(i.description) ?? str(i.subagent_type),
  Task: (i) => str(i.description) ?? str(i.subagent_type),
  Skill: (i) => str(i.skill),
  WebFetch: (i) => str(i.url),
  WebSearch: (i) => str(i.query),
  ToolSearch: (i) => str(i.query),
  SendMessage: (i) => str(i.to) ?? str(i.recipient),
  AskUserQuestion: (i) => (Array.isArray(i.questions) ? str(i.questions[0]?.question) : undefined),
  TaskStop: (i) => str(i.task_id),
  TaskCreate: (i) => str(i.subject),
  TaskUpdate: (i) => str(i.taskId),
  CronCreate: (i) => str(i.cron),
  ScheduleWakeup: (i) => str(i.reason),
};

/** Any other tool: the first input property, in the entry's own key order, that is a non-blank string. */
function firstStringInput(input: Rec): string | undefined {
  for (const v of Object.values(input)) {
    const s = str(v);
    if (s !== undefined) return s;
  }
  return undefined;
}

/**
 * Every whitespace run one space, trimmed. Two strings with whitespace at the same
 * positions collapse to two strings of the same length with spaces at the same positions.
 */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Where `s` is cut to at most `max` UTF-16 code units with a trailing `…`: the end of the
 * kept prefix, or `s.length` when it fits. Never half a surrogate pair.
 */
export function ellipsisCut(s: string, max: number): number {
  if (s.length <= max) return s.length;
  let end = max - 1;
  if (end > 0 && isHigh(s.charCodeAt(end - 1))) end--;
  return end;
}

/**
 * A tool call's line before redaction: `{kind: "tool", text: Name, arg?}`. The name is the
 * tool's own, MCP tools included, on one line. `arg`: the known tool's field (`TOOL_ARG`),
 * else the first non-blank string input, sanitised and WHOLE; absent when the call has
 * none. pane/transcript-redaction.ts redacts it, then puts it on one line and cuts it to
 * TOOL_ARG_MAX_CHARS characters ending `…` (`Name(arg)`). A path is shown as the session
 * wrote it (usually absolute).
 */
export function toolCall(name: unknown, input: unknown): RenderedLine {
  const n = collapseWhitespace(sanitiseText(typeof name === "string" ? name : "")) || "tool";
  const rec: Rec =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Rec) : {};
  const raw = TOOL_ARG[n]?.(rec) ?? firstStringInput(rec);
  const arg = raw === undefined ? "" : sanitiseText(raw);
  return arg ? { kind: "tool", text: n, arg } : { kind: "tool", text: n };
}

// ─── Entry → lines ───────────────────────────────────────────────────────────

/**
 * A claudish task file, by path shape: `…/launch-XXXXXX/turn-<n>.md` (the `mkdtemp`
 * suffix is six characters). Not anchored to a pane root: the root is per server, and a
 * renderer that read it would mint different lines on two servers.
 */
const TASK_FILE_RE = /\/launch-[A-Za-z0-9]{6}\/turn-\d+\.md$/;

const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const CAVEAT_RE = /^\s*<local-command-caveat>/;
const COMMAND_TAG_RE = /^\s*<command-(?:message|args)>[\s\S]*<command-name>/;
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/;

function line(kind: TranscriptKind, raw: string): RenderedLine[] {
  const text = sanitiseText(raw);
  return text ? [{ kind, text }] : [];
}

/** A user record's text: a string content, or its blocks joined with `\n` (`[image]`, `[document]`). */
function userContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "image") parts.push("[image]");
    else if (b?.type === "document") parts.push("[document]");
  }
  return parts.join("\n");
}

function isTaskNotificationText(text: string, origin: unknown): boolean {
  return (
    (origin as Rec | null)?.kind === "task-notification" || text.includes("<task-notification>")
  );
}

/**
 * The rules for a prompt-like text (a `user` text, a queued command, a `system/
 * local_command` content): interrupt, task notification, slash command, local-command
 * output, caveat, else a typed prompt as `fallback`.
 */
function promptTextLines(
  text: string,
  origin: unknown,
  fallback: TranscriptKind | null
): RenderedLine[] {
  if (text.startsWith(INTERRUPT_PREFIX)) return line("system", text);
  if (isTaskNotificationText(text, origin)) {
    const m = SUMMARY_RE.exec(text);
    return line("system", m ? (m[1] ?? "") : text);
  }
  // A slash command's record may lead with `<command-message>` (a model-invoking command,
  // measured: `/pear`) or with `<command-name>` (a local one); both carry `<command-name>`.
  if (isLocalCommandText(text) || COMMAND_TAG_RE.test(text)) {
    if (CAVEAT_RE.test(text)) return [];
    const name = COMMAND_NAME_RE.exec(text);
    if (name) {
      let cmd = (name[1] ?? "").trim();
      if (cmd && !cmd.startsWith("/")) cmd = `/${cmd}`;
      const args = (COMMAND_ARGS_RE.exec(text)?.[1] ?? "").trim();
      return line("user", args ? `${cmd} ${args}` : cmd);
    }
    const out = STDOUT_RE.exec(text);
    return out ? line("system", out[2] ?? "") : [];
  }
  return fallback ? line(fallback, text) : [];
}

function assistantLines(r: Rec): RenderedLine[] {
  const content = r.message?.content;
  const blocks: Rec[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : [];
  if (r.isApiErrorMessage === true) {
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    return line("error", text);
  }
  const out: RenderedLine[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      if (!b.text.trim()) continue;
      out.push(...line(parseInBandApiError(b.text) ? "error" : "assistant", b.text));
    } else if (b?.type === "tool_use" || b?.type === "server_tool_use") {
      out.push(toolCall(b.name, b.input));
    }
  }
  return out;
}

function userLines(r: Rec): RenderedLine[] {
  if (r.isCompactSummary === true || r.isMeta === true) return [];
  const content = r.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) {
    const file = r.toolUseResult?.file;
    const isTaskFile =
      typeof file?.filePath === "string" &&
      TASK_FILE_RE.test(file.filePath) &&
      typeof file.content === "string";
    const out: RenderedLine[] = [];
    let taskFileShown = false;
    for (const b of content) {
      if (b?.type === "tool_result") {
        if (isTaskFile && !taskFileShown) {
          taskFileShown = true;
          out.push(...line("task_file", file.content));
        }
      } else if (
        b?.type === "text" &&
        typeof b.text === "string" &&
        b.text.startsWith(INTERRUPT_PREFIX)
      ) {
        out.push(...line("system", b.text));
      }
    }
    return out;
  }
  return promptTextLines(userContentText(content), r.origin, "user");
}

const SYSTEM_WORDS: Record<string, string> = {
  scheduled_task_fire: "scheduled task fired",
  agents_killed: "agents killed",
  model_refusal_fallback: "model refusal: fell back",
};

function systemLines(r: Rec): RenderedLine[] {
  const subtype = typeof r.subtype === "string" ? r.subtype : "";
  const content = typeof r.content === "string" ? r.content : undefined;
  switch (subtype) {
    case "compact_boundary":
      return line("system", content ?? "Conversation compacted");
    case "local_command":
      return content === undefined ? [] : promptTextLines(content, null, null);
    case "scheduled_task_fire":
    case "agents_killed":
    case "model_refusal_fallback":
      return line("system", content ?? SYSTEM_WORDS[subtype] ?? subtype);
    case "api_error": {
      const e = r.error;
      const text = str(e?.formatted) ?? str(e?.message) ?? content ?? "API error";
      return line("error", text);
    }
    case "model_refusal_no_fallback":
      return line("error", content ?? "model refused, no fallback");
  }
  if (r.level === "error") return line("error", content ?? subtype.replace(/_/g, " "));
  return [];
}

/**
 * The lines one JSONL entry yields, in order, each `{kind, text}` with sanitised,
 * non-empty text. Pure and deterministic (see the module comment). Any value that is not
 * a plain object, and every `isSidechain` entry, yields nothing.
 */
export function renderEntry(rec: Record<string, unknown>): RenderedLine[] {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return [];
  const r = rec as Rec;
  if (r.isSidechain === true) return [];
  switch (r.type) {
    case "assistant":
      return assistantLines(r);
    case "user":
      return userLines(r);
    case "attachment": {
      const a = r.attachment;
      if (a?.type !== "queued_command" || typeof a.prompt !== "string") return [];
      return promptTextLines(a.prompt, a.origin ?? r.origin, "user");
    }
    case "system":
      return systemLines(r);
    case "continued-in": {
      const id = typeof r.continuedInSessionId === "string" ? r.continuedInSessionId : "";
      return line("system", `conversation continued in session ${id}`.trimEnd());
    }
    default:
      return [];
  }
}
