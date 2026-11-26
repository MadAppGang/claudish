/**
 * The turn-scoped transcript oracle (architecture §2.7, D3).
 *
 * Claude Code writes `<config>/projects/<slug(realpath cwd)>/<uuid>.jsonl` for the
 * session claudish started with `--session-id <uuid>`, and subagents write
 * `<uuid>/subagents/agent-<id>.jsonl`. The follower tails both, partial-line safe, and
 * reduces the records into the facts the settle rule (`settle-rule.ts`) reads.
 *
 * Turns are segmented by claudish's OWN deliveries, never by user records: turn N owns
 * every record whose byte offset is past N's offset (taken BEFORE delivery) and before
 * N+1's offset, so evidence from an earlier turn can never satisfy a later one (C3, H12).
 *
 * Record shapes are pinned by the phase-2 captures of Claude Code 2.1.290
 * (`ai-docs/reports/mcp-magmux-panes/phase2-captures.md`), notably:
 *   - the witness is a main-chain user record whose text equals the typed line
 *     (`origin.kind:"human"`; for `/compact` with no `origin`), or a
 *     `<command-name>/x</command-name>` record;
 *   - between the last assistant record and `turn_duration` Claude Code writes
 *     `attachment/prompt_snapshot` and state records, so "directly followed" means "no
 *     `stop_hook_summary` in between";
 *   - a background agent is recognised by its RESULT (`toolUseResult.isAsync`), not by
 *     `run_in_background` in the input — haiku launched one with neither flag set;
 *   - an `isMeta` user record after the last assistant message is Claude Code waking the
 *     model itself (the `max_tokens` continuation "Output token limit hit…", the refusal
 *     companion), so the turn is not over;
 *   - Read returns `toolUseResult.file {content, startLine, numLines, totalLines}`;
 *     `offset:0` reports `startLine:0` for content that starts at file line 1, and CRs
 *     are stripped.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { SlotStep } from "./contract.js";
import { turnFileToken } from "./prompt-delivery.js";
import { RECENT_STEP_LIMIT, stepOf } from "./slot-steps.js";
import { type MetaFile, SubagentLedger } from "./subagent-ledger.js";
import type { SubagentRow } from "./view-contract.js";

export type Witness =
  /** a typed line, exact (whole copies, `wholeCopies`): a Read-less session's prompt */
  | { kind: "text"; text: string }
  /**
   * A pointer line naming the turn's own file: any prompt record that carries the file's token
   * (`turnFileToken`, `isPromptRecord`). `line` is the typed pointer, for diagnostics only.
   */
  | { kind: "turn_file"; file: string; line: string }
  /** slash command: its `<command-name>` record, or the plain user record of the typed `line` */
  | { kind: "command"; name: string; line?: string }
  /**
   * A prompt a HUMAN typed (the interactive driver, hook-system §7.5): matched by
   * provenance, never by text. See `isHumanPrompt`. With `notTurnDir`, a record carrying a
   * pointer into that turn directory is claudish's own injection, never the human's prompt.
   */
  | { kind: "human"; notTurnDir?: string };

export interface TurnDelivery {
  /** absolute path of the turn file the child must Read */
  file: string;
  /** the exact bytes written to it */
  text: string;
}

export interface ReadCoverage {
  linesReturned: number;
  complete: boolean;
  reads: number;
  completedAtOffset: number | null;
}

export interface TurnView {
  index: number;
  acceptedAt: string | null; // ISO of the witness record; null until accepted
  acceptedOffset: number | null;
  /** assistant text blocks after the witness, in order (excl. isApiErrorMessage); for a file-delivered
   * turn only those after the Read result that completed coverage */
  assistantText: string[];
  /** the last content block of the turn's last assistant API response (records grouped by
   * `message.id`): its type, and its text when it is a text block; never cut at the task Read, so
   * an error written as that response's final text is seen. null with no such response, or when
   * the last one is an `isApiErrorMessage` record */
  lastResponseEnd: { blockType: string; text: string | null } | null;
  lastAssistant: { messageId: string; stopReason: string | null; isApiError: boolean } | null;
  turnDurationAfterLast: { pendingBackgroundAgentCount: number | null } | null;
  /** the record time (ISO) of the `turn_duration` behind `turnDurationAfterLast`; null without one */
  turnDurationAt: string | null;
  stopHookSummaryAfterLast: boolean;
  interruptAfterLast: { forToolUse: boolean } | null;
  /** a main-chain user record that wakes the model (task notification, Stop-hook feedback, an isMeta
   * continuation) arrived after the last assistant record, and no assistant record followed it yet */
  wakingAfterLast: boolean;
  /** the latest unresolved tool_use; `input` is the tool's raw input (the question text of an AskUserQuestion) */
  pendingTool: { id: string; name: string; input?: unknown } | null;
  agentsLaunched: number;
  agentsCompleted: number;
  backgroundShellsOpen: string[];
  apiError: { status: number | null; category: string | null; text: string } | null;
  compactions: number;
  delivery: { file: string; lines: number } | null;
  readCoverage: ReadCoverage;
  preambleBytes: number;
  /** files the turn created or overwrote with a successful `Write`, de-duplicated, in first-write
   * order; for a file-delivered turn only Writes after the same Read cut as assistantText */
  writtenFiles: string[];
  /** offset of the last main-chain chat record (user or assistant) of this turn */
  lastChatOffset: number | null;
  /** a local command's `<local-command-stdout>` after its witness (ANSI removed); null otherwise */
  localCommandOutput: string | null;
  /** the last RECENT_STEP_LIMIT steps of this turn, oldest first (SlotRow.recent); [] before the first */
  recent: SlotStep[];
  /**
   * Before the witness: the offset of the first main-chain record that shows the model
   * working without any prompt of this turn (an assistant record, or a task notification
   * waking it). The interactive driver reads it as a re-wake of the turn it settled
   * (D23); panes never open a turn ahead of their own delivery and ignore it.
   */
  unwitnessedChatOffset: number | null;
  /**
   * Copies of the typed line the witness record held: whole copies for a text witness, the
   * turn file's tokens for a pointer (k > 1: a doubled submit), 1 otherwise; null until accepted.
   */
  witnessCopies: number | null;
  /**
   * Before the witness: this turn's facts folded, by the same reducer, from every main-chain
   * record past the turn's offset, as if the turn had been accepted there; its own
   * `acceptedAt` is null and its `unwitnessed` null. A screen-read turn whose witness never
   * arrives reads its end record here. null once the witness arrived.
   */
  unwitnessed: TurnView | null;
}

export interface SessionFacts {
  stopHooksSeen: boolean;
  provenHookless: boolean;
}

export interface TranscriptView {
  availability: "ok" | "absent" | "empty" | "off";
  current: TurnView | null;
  settledTurns: number;
  usage: { tokensIn: number; tokensOut: number };
  toolCalls: number;
  lastAppendAt: number | null;
  session: SessionFacts;
  /** the agent Claude Code loaded: the latest `agent-setting` record; null = none written */
  agentSetting: string | null;
}

/* ───────────────────────────── pure reducer ───────────────────────────── */

interface ReadState {
  delivery: TurnDelivery;
  fileLines: string[];
  required: number;
  covered: Set<number>;
  reads: number;
  readIds: Set<string>;
  completedAtOffset: number | null;
  lastReadOffset: number | null;
}

interface TurnState {
  index: number;
  offset: number;
  witness: Witness;
  acceptedAt: string | null;
  acceptedOffset: number | null;
  texts: Array<{ offset: number; text: string }>;
  /** Write tool_uses; ok once a non-error tool_result arrives */
  writes: Array<{ id: string; path: string; offset: number; ok: boolean }>;
  lastAssistant: {
    messageId: string;
    stopReason: string | null;
    isApiError: boolean;
    offset: number;
  } | null;
  /** the last non-empty content block seen in `lastAssistant`'s response */
  lastBlock: { blockType: string; text: string | null } | null;
  td: { pendingBackgroundAgentCount: number | null } | null;
  tdAt: string | null;
  stopHookAfterLast: boolean;
  interrupt: { forToolUse: boolean } | null;
  waking: boolean;
  pending: Map<string, string>; // tool_use id → name
  pendingInput: Map<string, unknown>; // tool_use id → input
  agents: Set<string>;
  agentsDone: Set<string>;
  shells: Map<string, string>; // backgroundTaskId → command
  shellToolIds: Map<string, string>; // tool_use id → command (until its result names the task id)
  apiError: TurnView["apiError"];
  compactions: number;
  read: ReadState | null;
  lastChatOffset: number | null;
  localOutput: { text: string; offset: number } | null;
  /** at most RECENT_STEP_LIMIT, oldest dropped first */
  steps: SlotStep[];
  unwitnessedChat: number | null;
  witnessCopies: number | null;
  /** the records past the offset folded as if accepted, until the witness arrives */
  shadow: TurnState | null;
}

export interface FollowerState {
  turns: TurnState[];
  usage: Map<string, { in: number; out: number }>;
  toolUseIds: Set<string>;
  /** main-chain assistant message ids, in first-seen order, each once (the monitor's replies) */
  mainAssistantIds: string[];
  mainAssistantSeen: Set<string>;
  session: SessionFacts;
  /** `{"type":"agent-setting","agentSetting":"dev:reviewer"}`: written at line 2, repeated later */
  agentSetting: string | null;
  records: number;
  resolvePath: (p: string) => string;
  /**
   * A copy that may still be unread in Claude Code's input (the session's `unreadCopy`): its
   * witness, and the offset it was typed after. `seen` once a main-chain record of it lands
   * after that offset, whichever turn is open, or none.
   */
  copy: { witness: Witness; after: number; seen: boolean } | null;
  /**
   * The open turn's admission has typed nothing yet (it waits on `copy`). For a residual
   * (typed) witness a record accepts it only when it is exactly one copy of its own line and
   * that line is the copy's (`heldMayAccept`); any other matching record is the earlier
   * copy's. A pointer turn's own token is in no earlier record, so holding changes nothing.
   */
  held: boolean;
  /**
   * A typed copy of another line that left the input box and was forgotten before its record
   * landed (`refuseDeparted`): its witness, and the offset it was typed after. The first record
   * that is exactly one copy of it (`isOneCopyOf`) is that copy's, and accepts no turn; it is
   * then cleared. Without it, "PEARPEAR" landing late reads as two joined copies of "PEAR". Never
   * set for a pointer copy, whose record carries its own token.
   */
  departed: { witness: Witness; after: number } | null;
  /** the session's subagents; lives across turns and survives `rewindTo` */
  ledger: SubagentLedger;
}

export function initialFollowerState(
  resolvePath: (p: string) => string = safeRealpath
): FollowerState {
  return {
    turns: [],
    usage: new Map(),
    toolUseIds: new Set(),
    mainAssistantIds: [],
    mainAssistantSeen: new Set(),
    session: { stopHooksSeen: false, provenHookless: false },
    agentSetting: null,
    records: 0,
    resolvePath,
    copy: null,
    held: false,
    departed: null,
    ledger: new SubagentLedger(),
  };
}

export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Transcript records are untyped JSON written by Claude Code; every read below is guarded.
// biome-ignore lint/suspicious/noExplicitAny: raw JSON records, narrowed field by field
type Rec = Record<string, any>;

function contentOf(r: Rec): unknown {
  return r.message?.content;
}

/** Text of a user record: a string content, or its text blocks joined. */
export function userText(r: Rec): string {
  const c = contentOf(r);
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function hasToolResult(r: Rec): boolean {
  const c = contentOf(r);
  return Array.isArray(c) && c.some((b) => b?.type === "tool_result");
}

function isMainUser(r: Rec): boolean {
  return r.type === "user" && !r.isSidechain;
}

/**
 * A local slash command's own records: `<local-command-caveat>`, `<command-name>` and
 * `<local-command-stdout>`. Claude Code writes them for a command the user ran in the
 * REPL (captured: `/exit` in 2.1.282/2.1.285, `/model`, `/compact` in 2.1.291); they
 * never wake the model, so they are never a re-wake of a settled turn.
 */
const LOCAL_COMMAND_RE =
  /^\s*<(local-command-caveat|command-name|local-command-stdout|local-command-stderr)>/;

export function isLocalCommandText(text: string): boolean {
  return LOCAL_COMMAND_RE.test(text);
}

function isTaskNotification(r: Rec): boolean {
  return r.origin?.kind === "task-notification" || userText(r).includes("<task-notification>");
}

/**
 * A `<task-notification>` Claude Code absorbed into a turn still running: a main-chain
 * `attachment` with `attachment.type:"queued_command"` (captured 2.1.263 and 2.1.301). The
 * prefix test keeps out a peer `<agent-message>` that merely quotes one.
 */
function queuedTaskNotification(r: Rec): string | null {
  const a = r.type === "attachment" ? r.attachment : null;
  if (a?.type !== "queued_command" || typeof a.prompt !== "string") return null;
  return a.prompt.startsWith("<task-notification>") ? a.prompt : null;
}

function taskIdOf(text: string): string | null {
  const m = text.match(/<task-id>([^<]+)<\/task-id>/);
  return m ? (m[1] ?? "").trim() : null;
}

/** A `system/local_command` record (2.1.287+ `/color`): the command line or its stdout. */
function isLocalCommandSystem(r: Rec): boolean {
  return r.type === "system" && r.subtype === "local_command" && !r.isSidechain;
}

export const INTERRUPT_PREFIX = "[Request interrupted by user";

/**
 * A prompt a human typed, by PROVENANCE (hook-system §3.2, §7.5): a main-chain user
 * record that is not `isMeta`, carries no `tool_result`, and is none of the records
 * Claude Code writes on its own — a task notification, a local command's records, an
 * interrupt marker, a compact summary. When the record carries `origin` (2.1.290+ always
 * does for typed prompts), `origin.kind` must be `"human"`. A background notification
 * (`origin.kind: "task-notification"`) therefore never reads as a human turn, so a D23
 * re-wake stays the turn it woke.
 */
export function isHumanPrompt(record: Record<string, unknown>): boolean {
  const r = record as Rec;
  if (!isMainUser(r) || r.isMeta || hasToolResult(r) || r.isCompactSummary) return false;
  if (isTaskNotification(r)) return false;
  const text = userText(r);
  if (!text.trim() || isLocalCommandText(text) || text.startsWith(INTERRUPT_PREFIX)) return false;
  const origin = r.origin;
  if (origin !== undefined && origin !== null) return origin?.kind === "human";
  return true;
}

/**
 * How many times `text` holds `line` as whole copies joined end to end: k >= 1, or 0 when it
 * is not the line at all. Under load Claude
 * Code can read a typed line into its buffer before drawing it, so a second copy is typed onto
 * the first and Enter submits both; that record is still the submitted line. Both sides are
 * compared trimmed; a typed line never has whitespace at its ends (`isPlainLine`,
 * `normalizedLine`), and neither does the file template. Empty text, a partial copy and any
 * other text are refused (0).
 */
function wholeCopies(text: string, line: string): number {
  const got = text.trim();
  const core = line.trim();
  if (!core) return got === core ? 1 : 0;
  if (got.length % core.length !== 0) return 0;
  const k = got.length / core.length;
  return k >= 1 && got === core.repeat(k) ? k : 0;
}

/**
 * A prompt a user record submitted, whatever its text: a main-chain user record that is not
 * `isMeta`, carries no `tool_result`, is no compact summary and no task notification, and whose
 * `origin`, when present, is human. That is `isHumanPrompt` without its interrupt-marker
 * exclusion: a send made while a question dialog is open presses Escape, and Claude Code can
 * write the next prompt into the record that holds the interrupt marker.
 */
function isPromptRecord(r: Rec): boolean {
  if (!isMainUser(r) || r.isMeta || hasToolResult(r) || r.isCompactSummary) return false;
  if (isTaskNotification(r)) return false;
  const origin = r.origin;
  return origin === undefined || origin === null || origin?.kind === "human";
}

/** Non-overlapping occurrences of `token` in `text`. */
function countOccurrences(text: string, token: string): number {
  if (!token) return 0;
  let n = 0;
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length)) n++;
  return n;
}

/** How many times a prompt record carries the turn file's token: 0 for any other record. */
function turnFileCopies(r: Rec, w: Extract<Witness, { kind: "turn_file" }>): number {
  return isPromptRecord(r) ? countOccurrences(userText(r), turnFileToken(w.file)) : 0;
}

/**
 * A pointer into `turnDir`, as the typed pointer line spells one: an exact turn-file token,
 * `` `<turnDir>/turn-<digits>.md` ``. Another file of that directory (`turn-notes.md`), or a
 * turn file named without its backticks, is a human's text.
 */
function carriesPointerInto(r: Rec, turnDir: string): boolean {
  const open = turnFileToken(join(turnDir, "turn-")).slice(0, -1);
  const text = userText(r);
  for (let at = text.indexOf(open); at !== -1; at = text.indexOf(open, at + 1))
    if (/^\d+\.md`/.test(text.slice(at + open.length))) return true;
  return false;
}

function matchesWitness(r: Rec, w: Witness): boolean {
  if (w.kind === "human")
    return isHumanPrompt(r) && !(w.notTurnDir && carriesPointerInto(r, w.notTurnDir));
  if (w.kind === "turn_file") return turnFileCopies(r, w) > 0;
  // Some local commands are written as system records, not user records (captured:
  // 2.1.291 `/color yellow` → two `system/local_command` records).
  if (w.kind === "command" && isLocalCommandSystem(r))
    return isCommandRecordOf(String(r.content ?? ""), w);
  if (!isMainUser(r) || hasToolResult(r)) return false;
  const text = userText(r);
  if (w.kind === "text") return !r.isMeta && wholeCopies(text, w.text) > 0;
  // `/compact` writes its <command-name> record only AFTER compaction finishes, which takes
  // minutes on a real context; the plain record of the typed line is written at submit
  // (captured: 2.1.290 and 2.1.291, `"content":"/compact"`, no isMeta), so it is the witness.
  if (w.line !== undefined && !r.isMeta && text.trim() === w.line.trim()) return true;
  return isCommandRecordOf(text, w);
}

/**
 * A command record (`<command-name>/x</command-name>`, `<command-args>…</command-args>`) of
 * THIS turn's command: the same name and the same arguments as its typed line. A pointer
 * line's arguments name its own turn file, so a record of an earlier `/x` with other arguments,
 * or another turn file, never matches. A record with no `<command-args>` matches only a line
 * with none.
 */
function isCommandRecordOf(text: string, w: Extract<Witness, { kind: "command" }>): boolean {
  const tags = commandTags(text);
  if (!tags || tags.get("name") !== `/${w.name}`) return false;
  if (w.line === undefined) return true;
  const want = w.line
    .trim()
    .slice(w.name.length + 1)
    .trim();
  return (tags.get("args") ?? "").trim() === want;
}

const COMMAND_TAG = /<command-(name|message|args)>([\s\S]*?)<\/command-\1>/g;

/**
 * The tags of a record in the shape Claude Code writes for a command: its whole content is
 * `<command-name>`, `<command-message>` and `<command-args>` elements, each at most once and
 * separated only by whitespace, with a name. Anything else, such as a prompt that quotes those
 * markers inside its own text, is null.
 */
function commandTags(text: string): Map<string, string> | null {
  const t = text.trim();
  const tags = new Map<string, string>();
  let at = 0;
  for (const m of t.matchAll(COMMAND_TAG)) {
    const [whole, tag = "", body = ""] = m;
    if (t.slice(at, m.index).trim() !== "" || tags.has(tag)) return null;
    tags.set(tag, body);
    at = m.index + whole.length;
  }
  return tags.has("name") && t.slice(at).trim() === "" ? tags : null;
}

function recordUsage(state: FollowerState, r: Rec): void {
  if (r.type !== "assistant") return;
  const m = r.message;
  const id = m?.id;
  if (typeof id !== "string") return;
  const u = m.usage ?? {};
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  state.usage.set(id, {
    in: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    out: num(u.output_tokens),
  });
  for (const b of m.content ?? [])
    if (b?.type === "tool_use" && typeof b.id === "string") state.toolUseIds.add(b.id);
}

function turnFor(state: FollowerState, offset: number): TurnState | null {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const t = state.turns[i];
    if (t && offset > t.offset) return t;
  }
  return null;
}

/** Strip a trailing CR: Read returns CRLF files with LF line ends (captured). */
function stripCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

function newReadState(d: TurnDelivery): ReadState {
  const fileLines = d.text.split("\n").map(stripCr);
  // Read numbers the empty line after a final newline; coverage does not require it.
  const required =
    fileLines.length > 0 && fileLines[fileLines.length - 1] === ""
      ? fileLines.length - 1
      : fileLines.length;
  return {
    delivery: d,
    fileLines,
    required,
    covered: new Set(),
    reads: 0,
    readIds: new Set(),
    completedAtOffset: null,
    lastReadOffset: null,
  };
}

/** Lines a Read result returned, as [fileLineNumber, text] pairs. */
function returnedLines(r: Rec, block: Rec): Array<[number, string]> {
  const f = r.toolUseResult?.file;
  if (f && typeof f.content === "string") return fileResultLines(f);
  return renderedLines(blockText(block));
}

/** `toolUseResult.file`: `offset:0` reports `startLine:0` for content that starts at line 1. */
function fileResultLines(f: Rec): Array<[number, string]> {
  const start = Math.max(1, typeof f.startLine === "number" ? f.startLine : 1);
  let lines = (f.content as string).split("\n").map(stripCr);
  if (typeof f.numLines === "number") lines = lines.slice(0, f.numLines);
  return lines.map((t: string, k: number) => [start + k, t]);
}

function blockText(block: Rec): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map((c: Rec) => c?.text ?? "").join("");
  return "";
}

/** Fallback: parse the numbered rendering `N\t<line>` (labels start at 0 for offset:0). */
function renderedLines(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let shift = 0;
  let first = true;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\t(.*)$/);
    if (!m) continue;
    const label = Number(m[1]);
    if (first) {
      shift = label === 0 ? 1 : 0;
      first = false;
    }
    out.push([label + shift, stripCr(m[2] ?? "")]);
  }
  return out;
}

function applyReadUse(state: FollowerState, t: TurnState, block: Rec): void {
  if (!t.read || block?.type !== "tool_use" || block.name !== "Read") return;
  const fp = block.input?.file_path;
  if (typeof fp !== "string") return;
  if (state.resolvePath(fp) === state.resolvePath(t.read.delivery.file))
    t.read.readIds.add(block.id);
}

function applyReadResult(t: TurnState, r: Rec, block: Rec, offset: number): void {
  const rs = t.read;
  if (!rs || block?.type !== "tool_result" || !rs.readIds.has(block.tool_use_id)) return;
  rs.lastReadOffset = offset;
  if (block.is_error) return;
  rs.reads++;
  for (const [n, text] of returnedLines(r, block)) {
    if (n >= 1 && n <= rs.fileLines.length && rs.fileLines[n - 1] === text) rs.covered.add(n);
  }
  if (rs.completedAtOffset === null && isComplete(rs)) rs.completedAtOffset = offset;
}

function isComplete(rs: ReadState): boolean {
  for (let n = 1; n <= rs.required; n++) if (!rs.covered.has(n)) return false;
  return true;
}

function applyAssistant(state: FollowerState, t: TurnState, r: Rec, offset: number): void {
  const m = r.message ?? {};
  const isApiError = r.isApiErrorMessage === true;
  const messageId = String(m.id ?? "");
  trackResponseEnd(t, messageId, isApiError ? [] : (m.content ?? []));
  t.lastAssistant = {
    messageId,
    stopReason: m.stop_reason ?? null,
    isApiError,
    offset,
  };
  t.lastChatOffset = offset;
  t.td = null;
  t.tdAt = null;
  t.stopHookAfterLast = false;
  t.interrupt = null;
  t.waking = false;
  t.apiError = isApiError ? apiErrorOf(r) : null;
  if (isApiError) return;
  const at = typeof r.timestamp === "string" ? r.timestamp : new Date().toISOString();
  for (const b of m.content ?? []) {
    applyAssistantBlock(state, t, b, offset);
    const step = stepOf(b, at);
    if (step) {
      t.steps.push(step);
      if (t.steps.length > RECENT_STEP_LIMIT) t.steps.shift();
    }
  }
}

/**
 * Keep the last content block of the response this record belongs to. Claude Code writes one
 * record per content block under one `message.id`; a record with no id is its own response.
 * Runs before `lastAssistant` moves to this record.
 */
function trackResponseEnd(t: TurnState, messageId: string, content: Rec[]): void {
  if (!messageId || t.lastAssistant?.messageId !== messageId) t.lastBlock = null;
  for (const b of content) t.lastBlock = contentBlockOf(b) ?? t.lastBlock;
}

/** A content block's type and text; null for a malformed or empty text block. */
function contentBlockOf(b: Rec): { blockType: string; text: string | null } | null {
  if (typeof b?.type !== "string") return null;
  if (b.type !== "text") return { blockType: b.type, text: null };
  return typeof b.text === "string" && b.text.length > 0
    ? { blockType: "text", text: b.text }
    : null;
}

function apiErrorOf(r: Rec): TurnView["apiError"] {
  const text = (r.message?.content ?? [])
    .filter((b: Rec) => b?.type === "text")
    .map((b: Rec) => b.text)
    .join("");
  return {
    status: typeof r.apiErrorStatus === "number" ? r.apiErrorStatus : null,
    category: typeof r.error === "string" ? r.error : null,
    text,
  };
}

function applyAssistantBlock(state: FollowerState, t: TurnState, b: Rec, offset: number): void {
  if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) {
    t.texts.push({ offset, text: b.text });
    return;
  }
  if (b?.type !== "tool_use" || typeof b.id !== "string") return;
  t.pending.set(b.id, String(b.name ?? ""));
  t.pendingInput.set(b.id, b.input);
  // Write only: an Edit changes a file that predates the task, so its text proves nothing.
  if (b.name === "Write" && typeof b.input?.file_path === "string")
    t.writes.push({ id: b.id, path: b.input.file_path, offset, ok: false });
  if (b.name === "Bash" && b.input?.run_in_background)
    t.shellToolIds.set(b.id, String(b.input?.command ?? ""));
  applyReadUse(state, t, b);
}

function applyToolResults(t: TurnState, r: Rec, blocks: Rec[], offset: number): void {
  const tur = r.toolUseResult && typeof r.toolUseResult === "object" ? r.toolUseResult : null;
  for (const b of blocks) {
    if (b?.type !== "tool_result") continue;
    t.pending.delete(b.tool_use_id);
    t.pendingInput.delete(b.tool_use_id);
    markWriteResult(t, b);
    // A background agent is recognised by its result, not by run_in_background in its input.
    if (tur?.isAsync === true && typeof tur.agentId === "string") t.agents.add(tur.agentId);
    if (typeof tur?.backgroundTaskId === "string")
      t.shells.set(tur.backgroundTaskId, t.shellToolIds.get(b.tool_use_id) ?? "");
    applyReadResult(t, r, b, offset);
  }
}

/** A Write counts once its tool_result arrives without is_error: a failed overwrite leaves
 * the old content, which is not an answer. */
function markWriteResult(t: TurnState, b: Rec): void {
  if (b.is_error === true) return;
  const w = t.writes.find((x) => x.id === b.tool_use_id);
  if (w) w.ok = true;
}

export const STDOUT_RE = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences in local-command output
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * A command turn's settle evidence (§2.7): the `<local-command-stdout>` record a LOCAL
 * command writes after its `<command-name>` witness, with no assistant message (captured:
 * `/compact`, `/model x` in 2.1.291). A command that prompts the model (`/pear`) writes
 * none and settles like any other turn.
 */
function applyLocalCommandRecord(t: TurnState, text: string, offset: number): void {
  if (t.witness.kind !== "command" || t.lastAssistant || t.localOutput) return;
  const m = text.match(STDOUT_RE);
  if (!m) return;
  t.localOutput = { text: (m[2] ?? "").replace(ANSI_RE, "").trim(), offset };
  t.lastChatOffset = offset;
}

function applyNotification(t: TurnState, text: string): void {
  const id = taskIdOf(text);
  if (!id) return;
  if (t.agents.has(id)) t.agentsDone.add(id);
  t.shells.delete(id);
}

/**
 * Completes the agent or closes the shell only, never waking and never chat activity: the
 * attachment rides an API request already in flight, and the assistant record that answers it
 * follows (1,133 of 1,134 corpus notification attachments; the other was a file still being
 * written).
 */
function applyQueuedNotification(t: TurnState, r: Rec): void {
  const text = queuedTaskNotification(r);
  if (text) applyNotification(t, text);
}

function applyUser(t: TurnState, r: Rec, offset: number): void {
  const c = contentOf(r);
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) {
    applyToolResults(t, r, c as Rec[], offset);
    return;
  }
  if (r.isCompactSummary) {
    t.compactions++;
    return;
  }
  const text = userText(r);
  if (isLocalCommandText(text)) {
    applyLocalCommandRecord(t, text, offset);
    return;
  }
  if (text.startsWith(INTERRUPT_PREFIX)) {
    t.interrupt = { forToolUse: text.includes("for tool use") };
    t.pending.clear();
    t.pendingInput.clear();
    return;
  }
  if (isTaskNotification(r)) applyNotification(t, text);
  if (t.lastAssistant && !t.interrupt) {
    t.waking = true;
    t.lastChatOffset = offset;
  }
}

/** A main-chain record of the remembered copy, after the offset it was typed at (`FollowerState.copy`). */
function noteCopyRecord(state: FollowerState, r: Rec, offset: number): void {
  const c = state.copy;
  if (!c || c.seen || offset <= c.after || r.isSidechain) return;
  if (matchesWitness(r, c.witness)) c.seen = true;
}

/** The departed copy's own record (`FollowerState.departed`), taken once: it is no witness. */
function takeDepartedRecord(state: FollowerState, r: Rec, offset: number): boolean {
  const d = state.departed;
  if (!d || offset <= d.after || !isOneCopyOf(r, d.witness)) return false;
  state.departed = null;
  return true;
}

/**
 * A main-chain record of exactly one submission of the line `w` stands for. Never a pointer's:
 * its record carries its own token, so no departed rule is needed for it.
 */
function isOneCopyOf(r: Rec, w: Witness): boolean {
  if (w.kind === "turn_file") return false;
  if (w.kind === "text")
    return isMainUser(r) && !r.isMeta && !hasToolResult(r) && userText(r).trim() === w.text.trim();
  return w.kind === "command" && matchesWitness(r, w);
}

/**
 * `acceptIfWitness`, except that a held turn accepts only what `heldMayAccept` allows, and the
 * departed copy's own record (`departed`, `takeDepartedRecord`) accepts nothing.
 */
function acceptUnlessHeld(
  state: FollowerState,
  t: TurnState,
  r: Rec,
  offset: number,
  departed: boolean
): void {
  if (departed) return;
  if (!state.held || heldMayAccept(state, t, r)) acceptIfWitness(t, r, offset);
}

/**
 * A held turn (`FollowerState.held`) is accepted only by one copy of its own line, and only
 * when that line is the remembered copy's: the admission typed nothing, so the record is that
 * copy, submitted once. Joined copies, or a record of a line that is not the copy's, are not
 * this turn's. A command is held the same way: the remembered copy is the same command line,
 * and its own record (bound to its arguments, `isCommandRecordOf`) is one submission of it.
 */
function heldMayAccept(state: FollowerState, t: TurnState, r: Rec): boolean {
  const w = t.witness;
  // a pointer turn's own token is in no record before its own send: holding changes nothing
  if (w.kind === "turn_file") return matchesWitness(r, w);
  const c = state.copy?.witness;
  if (w.kind === "command")
    return c?.kind === "command" && c.name === w.name && c.line === w.line && matchesWitness(r, w);
  if (w.kind !== "text" || c?.kind !== "text" || c.text !== w.text) return false;
  return isMainUser(r) && !r.isMeta && wholeCopies(userText(r), w.text) === 1;
}

function acceptIfWitness(t: TurnState, r: Rec, offset: number): void {
  if (!matchesWitness(r, t.witness)) return;
  t.acceptedAt = typeof r.timestamp === "string" ? r.timestamp : new Date().toISOString();
  t.acceptedOffset = offset;
  t.witnessCopies = witnessCopiesOf(r, t.witness);
  t.lastChatOffset = offset;
}

/** Copies of the submitted line the witness record holds: tokens for a pointer, whole copies for text. */
function witnessCopiesOf(r: Rec, w: Witness): number {
  if (w.kind === "text") return wholeCopies(userText(r), w.text);
  if (w.kind === "turn_file") return turnFileCopies(r, w);
  return 1;
}

/** One main-chain assistant message id, once: Claude Code writes one record per content block. */
function noteMainAssistant(state: FollowerState, r: Rec): void {
  const id = r.type === "assistant" ? r.message?.id : undefined;
  if (typeof id !== "string" || !id) return;
  if (state.mainAssistantSeen.has(id)) return;
  state.mainAssistantSeen.add(id);
  state.mainAssistantIds.push(id);
}

/** Pure: fold one main-transcript record at byte `offset` into the state. */
export function applyRecord(
  state: FollowerState,
  record: Record<string, unknown>,
  offset: number
): FollowerState {
  const r = record as Rec;
  state.records++;
  recordUsage(state, r);
  state.ledger.foldMain(r, isoOf(r));
  if (r.isSidechain) return state;
  noteMainAssistant(state, r);
  if (r.type === "agent-setting" && typeof r.agentSetting === "string" && r.agentSetting)
    state.agentSetting = r.agentSetting;
  if (r.type === "system" && r.subtype === "stop_hook_summary") {
    state.session.stopHooksSeen = true;
    state.session.provenHookless = false;
  }
  // the departed copy's own record is read first: it marks no watched copy seen ("PEARPEAR"
  // would read as two copies of a watched "PEAR") and accepts no turn
  const departed = takeDepartedRecord(state, r, offset);
  if (!departed) noteCopyRecord(state, r, offset);
  const t = turnFor(state, offset);
  if (!t) return state;

  if (t.acceptedAt === null) {
    acceptUnlessHeld(state, t, r, offset, departed);
    if (t.acceptedAt !== null) {
      t.shadow = null;
      return state;
    }
    if (t.unwitnessedChat === null && wakesModel(r)) t.unwitnessedChat = offset;
    if (t.shadow) foldTurnRecord(state, t.shadow, r, offset);
    return state;
  }
  foldTurnRecord(state, t, r, offset);
  return state;
}

/** Fold one main-chain record into an accepted turn (or an unwitnessed turn's shadow). */
function foldTurnRecord(state: FollowerState, t: TurnState, r: Rec, offset: number): void {
  if (r.type === "assistant") applyAssistant(state, t, r, offset);
  else if (r.type === "user") applyUser(t, r, offset);
  else if (isLocalCommandSystem(r)) applyLocalCommandRecord(t, String(r.content ?? ""), offset);
  else if (r.type === "system" && r.subtype === "stop_hook_summary") {
    if (t.lastAssistant) t.stopHookAfterLast = true;
  } else if (r.type === "system" && r.subtype === "turn_duration") applyTurnDuration(state, t, r);
  applyQueuedNotification(t, r); // attachment records only; the predicate rejects every other type
  // compact_boundary carries no turn fact; compactions are counted on the isCompactSummary record
}

/** A main-chain record that shows the model working with no prompt: its reply, or a notification. */
function wakesModel(r: Rec): boolean {
  if (r.type === "assistant") return true;
  return isMainUser(r) && !hasToolResult(r) && isTaskNotification(r);
}

function applyTurnDuration(state: FollowerState, t: TurnState, r: Rec): void {
  const la = t.lastAssistant;
  if (!la || t.waking) return;
  const p = r.pendingBackgroundAgentCount;
  t.td = { pendingBackgroundAgentCount: typeof p === "number" ? p : null };
  t.tdAt = isoOf(r);
  // `end_turn` → `turn_duration` with no stop_hook_summary between proves the session has no
  // Stop hooks (attachments and state records in between are normal: prompt_snapshot, mode, …).
  const proves =
    !t.stopHookAfterLast && !t.interrupt && la.stopReason === "end_turn" && !la.isApiError;
  if (proves && !state.session.stopHooksSeen) state.session.provenHookless = true;
}

function isoOf(r: Rec): string {
  return typeof r.timestamp === "string" ? r.timestamp : new Date().toISOString();
}

/**
 * Fold one subagent record: usage, tool calls, a Read of the turn file delegated to a subagent,
 * and, given the file's agent id, the subagent's row.
 */
export function applySubagentRecord(
  state: FollowerState,
  record: Record<string, unknown>,
  offsetKey: number,
  agentId?: string
): FollowerState {
  const r = record as Rec;
  recordUsage(state, r);
  if (agentId) state.ledger.foldSubRecord(agentId, r, isoOf(r));
  const last = state.turns[state.turns.length - 1];
  const t = last && last.acceptedAt === null ? last.shadow : last;
  if (!t?.read) return state;
  if (r.type === "assistant") for (const b of r.message?.content ?? []) applyReadUse(state, t, b);
  if (r.type === "user" && Array.isArray(contentOf(r)))
    for (const b of contentOf(r) as Rec[]) applyReadResult(t, r, b, offsetKey);
  return state;
}

/**
 * Open turn `t`. Only the newest turn can ever receive a record (offsets only grow and the
 * new turn's offset is taken after a poll), so the previous turn's state, which can hold a
 * whole task file and every text block, is dropped here rather than kept for the session.
 */
export function openTurnState(
  state: FollowerState,
  t: { index: number; offset: number; witness: Witness; delivery?: TurnDelivery | null }
): FollowerState {
  state.turns.length = 0;
  state.held = false;
  const turn = newTurnState(t);
  turn.shadow = newTurnState(t);
  state.turns.push(turn);
  return state;
}

function newTurnState(t: {
  index: number;
  offset: number;
  witness: Witness;
  delivery?: TurnDelivery | null;
}): TurnState {
  return {
    index: t.index,
    offset: t.offset,
    witness: t.witness,
    acceptedAt: null,
    acceptedOffset: null,
    texts: [],
    writes: [],
    lastAssistant: null,
    lastBlock: null,
    td: null,
    tdAt: null,
    stopHookAfterLast: false,
    interrupt: null,
    waking: false,
    pending: new Map(),
    pendingInput: new Map(),
    agents: new Set(),
    agentsDone: new Set(),
    shells: new Map(),
    shellToolIds: new Map(),
    apiError: null,
    compactions: 0,
    read: t.delivery ? newReadState(t.delivery) : null,
    lastChatOffset: null,
    localOutput: null,
    steps: [],
    unwitnessedChat: null,
    witnessCopies: null,
    shadow: null,
  };
}

/** The last content block of the turn's last assistant response; null after an API error record. */
function lastResponseEndOf(t: TurnState): TurnView["lastResponseEnd"] {
  const last = t.lastAssistant;
  if (!last || last.isApiError) return null;
  return t.lastBlock;
}

export function turnView(t: TurnState): TurnView {
  const rs = t.read;
  let texts = t.texts;
  let writes = t.writes;
  let preambleBytes = 0;
  if (rs) {
    const cut = rs.completedAtOffset ?? rs.lastReadOffset;
    if (cut !== null) {
      const before = texts.filter((x) => x.offset < cut);
      preambleBytes = before.reduce((n, x) => n + Buffer.byteLength(x.text), 0);
      texts = texts.filter((x) => x.offset > cut);
      // A file written before the task was read cannot answer it, exactly as narration cannot.
      writes = writes.filter((x) => x.offset > cut);
    }
  }
  const pendingEntry = [...t.pending.entries()].pop();
  return {
    index: t.index,
    acceptedAt: t.acceptedAt,
    acceptedOffset: t.acceptedOffset,
    assistantText: texts.map((x) => x.text),
    lastResponseEnd: lastResponseEndOf(t),
    lastAssistant: t.lastAssistant
      ? {
          messageId: t.lastAssistant.messageId,
          stopReason: t.lastAssistant.stopReason,
          isApiError: t.lastAssistant.isApiError,
        }
      : null,
    turnDurationAfterLast: t.td,
    turnDurationAt: t.tdAt,
    stopHookSummaryAfterLast: t.stopHookAfterLast,
    interruptAfterLast: t.interrupt,
    wakingAfterLast: t.waking,
    pendingTool: pendingEntry
      ? { id: pendingEntry[0], name: pendingEntry[1], input: t.pendingInput.get(pendingEntry[0]) }
      : null,
    agentsLaunched: t.agents.size,
    agentsCompleted: [...t.agents].filter((a) => t.agentsDone.has(a)).length,
    backgroundShellsOpen: [...t.shells.values()],
    apiError: t.apiError,
    compactions: t.compactions,
    delivery: rs ? { file: rs.delivery.file, lines: rs.fileLines.length } : null,
    readCoverage: rs
      ? {
          linesReturned: rs.covered.size,
          complete: isComplete(rs),
          reads: rs.reads,
          completedAtOffset: rs.completedAtOffset,
        }
      : { linesReturned: 0, complete: true, reads: 0, completedAtOffset: null },
    preambleBytes,
    writtenFiles: [...new Set(writes.filter((x) => x.ok).map((x) => x.path))],
    lastChatOffset: t.lastChatOffset,
    localCommandOutput: t.localOutput?.text ?? null,
    recent: [...t.steps],
    unwitnessedChatOffset: t.unwitnessedChat,
    witnessCopies: t.witnessCopies,
    unwitnessed: t.acceptedAt === null && t.shadow ? turnView(t.shadow) : null,
  };
}

/* ───────────────────────────── file tailing ───────────────────────────── */

/**
 * Partial-line-safe tail. The remainder after the last newline is kept as BYTES and a
 * line is decoded only once it is complete, so a poll that lands inside a multi-byte
 * character can never decode either half as U+FFFD; offsets are byte positions.
 */
export class Tail {
  offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  constructor(readonly path: string) {}

  /** Read again from byte `offset` (a line start): the next `read()` returns every line from there. */
  seek(offset: number): void {
    this.offset = Math.max(0, offset);
    this.rest = Buffer.alloc(0);
  }

  /** Read appended bytes; return complete lines with the byte offset each starts at. */
  read(): Array<{ offset: number; line: string }> {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return [];
      const chunk = Buffer.alloc(size - this.offset);
      const got = readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += got;
      const fresh = chunk.subarray(0, got);
      const buf = this.rest.length ? Buffer.concat([this.rest, fresh]) : fresh;
      let pos = this.offset - buf.length;
      const out: Array<{ offset: number; line: string }> = [];
      let start = 0;
      let nl = buf.indexOf(0x0a, start);
      while (nl >= 0) {
        out.push({ offset: pos, line: buf.toString("utf8", start, nl) });
        pos += nl + 1 - start;
        start = nl + 1;
        nl = buf.indexOf(0x0a, start);
      }
      this.rest = Buffer.from(buf.subarray(start));
      return out;
    } finally {
      closeSync(fd);
    }
  }
}

export class TranscriptFollower {
  private state: FollowerState;
  private main: Tail;
  private subs = new Map<string, Tail>();
  /** meta file name → mtime last read */
  private metas = new Map<string, number>();
  private lastAppend: number | null = null;
  private settled = 0;
  private savingOff = false;
  private clock: () => number;

  constructor(
    readonly path: string,
    readonly subagentsDir: string,
    opts: { now?: () => number; resolvePath?: (p: string) => string } = {}
  ) {
    this.state = initialFollowerState(opts.resolvePath);
    this.main = new Tail(path);
    this.clock = opts.now ?? Date.now;
  }

  /** Read appended bytes of the main transcript and every subagent file. True when anything was new. */
  poll(): boolean {
    let any = false;
    for (const { offset, line } of this.main.read()) {
      any = true;
      const rec = parseRecord(line);
      // Offsets are 1-based positions past the line start so a record AT the turn offset
      // (written after the mark) is strictly greater than it.
      if (rec) applyRecord(this.state, rec, offset + 1);
    }
    if (this.pollSubagents()) any = true;
    if (any) this.lastAppend = this.clock();
    return any;
  }

  private subagentEntries(): string[] {
    if (!existsSync(this.subagentsDir)) return [];
    try {
      return readdirSync(this.subagentsDir);
    } catch {
      return [];
    }
  }

  private pollSubagents(): boolean {
    let any = false;
    const names = this.subagentEntries();
    for (const f of names) {
      if (!f.endsWith(".jsonl")) continue;
      let tail = this.subs.get(f);
      if (!tail) {
        tail = new Tail(join(this.subagentsDir, f));
        this.subs.set(f, tail);
      }
      const agentId = AGENT_FILE_RE.exec(f)?.[1];
      for (const { line } of tail.read()) {
        any = true;
        const rec = parseRecord(line);
        if (rec) applySubagentRecord(this.state, rec, this.main.offset + 1, agentId);
      }
    }
    for (const f of names) {
      const agentId = AGENT_META_RE.exec(f)?.[1];
      if (agentId && this.state.ledger.wantsMeta(agentId)) this.readMeta(f, agentId);
    }
    return any;
  }

  /** Read a subagent's meta file when it is new or was replaced since the last read. */
  private readMeta(name: string, agentId: string): void {
    const path = join(this.subagentsDir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return;
    }
    if (this.metas.get(name) === mtime) return;
    let meta: MetaFile;
    try {
      const v = JSON.parse(readFileSync(path, "utf8"));
      if (!v || typeof v !== "object") return;
      meta = v as MetaFile;
    } catch {
      return; // replaced mid-read: the next poll reads it again
    }
    this.metas.set(name, mtime);
    this.state.ledger.foldMeta(agentId, meta, new Date(this.clock()).toISOString());
  }

  /** The session's subagents, at most 20, oldest first; `version` moves whenever they change. */
  subagents(): { rows: SubagentRow[]; version: number } {
    return { rows: this.state.ledger.rows(), version: this.state.ledger.version };
  }

  /** Current byte offset of the main transcript (after a poll). The turn boundary. */
  size(): number {
    return this.main.offset;
  }

  openTurn(t: {
    index: number;
    offset: number;
    witness: Witness;
    delivery?: TurnDelivery | null;
  }): void {
    openTurnState(this.state, t);
  }

  /**
   * Re-open turn `t` from its own offset and fold its records again. The interactive
   * driver does this on a re-wake (D23): it had opened the NEXT turn after the settle,
   * so the continuation's records were read into a turn that never accepted them. Usage,
   * tool ids and assistant ids are keyed, so folding a record twice counts it once.
   */
  rewindTo(t: {
    index: number;
    offset: number;
    witness: Witness;
    delivery?: TurnDelivery | null;
  }): void {
    this.main.seek(t.offset);
    openTurnState(this.state, t);
    this.poll();
  }

  /** Watch for a record of the copy that may still be unread (null: none). */
  watchCopy(witness: Witness | null, after: number): void {
    this.state.copy = witness ? { witness, after, seen: false } : null;
  }

  /** A record of the watched copy has landed. */
  copySeen(): boolean {
    return this.state.copy?.seen === true;
  }

  /**
   * A copy of another line left the input box and is forgotten before its record landed: that
   * record, when it lands after `after`, is the copy's and accepts no turn
   * (`FollowerState.departed`). A later departed copy replaces this one.
   */
  refuseDeparted(witness: Witness, after: number): void {
    this.state.departed = { witness, after };
  }

  /** The open turn's admission has typed nothing (`FollowerState.held`). */
  holdTurn(held: boolean): void {
    this.state.held = held;
  }

  markSettled(): void {
    this.settled++;
  }

  /** Main-chain assistant message ids seen so far, in first-seen order, each once. */
  assistantMessageIds(): readonly string[] {
    return this.state.mainAssistantIds;
  }

  markSavingOff(): void {
    this.savingOff = true;
  }

  view(): TranscriptView {
    const t = this.state.turns[this.state.turns.length - 1] ?? null;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const u of this.state.usage.values()) {
      tokensIn += u.in;
      tokensOut += u.out;
    }
    let availability: TranscriptView["availability"];
    if (this.savingOff) availability = "off";
    else if (!existsSync(this.path)) availability = "absent";
    else if (t && t.acceptedAt === null && fileSize(this.path) <= t.offset) availability = "empty";
    else if (!t && fileSize(this.path) === 0) availability = "empty";
    else availability = "ok";
    return {
      availability,
      current: t ? turnView(t) : null,
      settledTurns: this.settled,
      usage: { tokensIn, tokensOut },
      toolCalls: this.state.toolUseIds.size,
      lastAppendAt: this.lastAppend,
      session: { ...this.state.session },
      agentSetting: this.state.agentSetting,
    };
  }
}

/**
 * The byte offset of the line holding the LAST human prompt in a transcript, or null
 * when it holds none. The interactive driver opens a turn there when it learns a session
 * id from a proxy request rather than minting it (`--resume`, `--continue`,
 * `--fork-session`, `/clear`): Claude Code writes the prompt before it sends the
 * request that names the session, so the prompt is already on disk and is the turn's
 * witness.
 */
export function lastHumanPromptOffset(path: string): number | null {
  const tail = new Tail(path);
  let found: number | null = null;
  for (const { offset, line } of tail.read()) {
    const rec = parseRecord(line);
    if (rec && isHumanPrompt(rec)) found = offset;
  }
  return found;
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

const AGENT_FILE_RE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const AGENT_META_RE = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/;

/** One JSONL line as an object, or null (blank, not JSON, or not an object). Never throws. */
export function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
