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
 *     (`origin.kind:"human"`), or a `<command-name>/x</command-name>` record;
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
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export type Witness =
  | { kind: "text"; text: string } // typed plain line or the file-reference instruction (exact)
  | { kind: "command"; name: string }; // slash command: its <command-name> record

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
  lastAssistant: { messageId: string; stopReason: string | null; isApiError: boolean } | null;
  turnDurationAfterLast: { pendingBackgroundAgentCount: number | null } | null;
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
  /** offset of the last main-chain chat record (user or assistant) of this turn */
  lastChatOffset: number | null;
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
  lastAssistant: {
    messageId: string;
    stopReason: string | null;
    isApiError: boolean;
    offset: number;
  } | null;
  td: { pendingBackgroundAgentCount: number | null } | null;
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
}

export interface FollowerState {
  turns: TurnState[];
  usage: Map<string, { in: number; out: number }>;
  toolUseIds: Set<string>;
  /** main-chain assistant message ids, in first-seen order, each once (the monitor's replies) */
  mainAssistantIds: string[];
  mainAssistantSeen: Set<string>;
  session: SessionFacts;
  records: number;
  resolvePath: (p: string) => string;
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
    records: 0,
    resolvePath,
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

function isTaskNotification(r: Rec): boolean {
  return r.origin?.kind === "task-notification" || userText(r).includes("<task-notification>");
}

function taskIdOf(text: string): string | null {
  const m = text.match(/<task-id>([^<]+)<\/task-id>/);
  return m ? (m[1] ?? "").trim() : null;
}

function matchesWitness(r: Rec, w: Witness): boolean {
  if (!isMainUser(r) || hasToolResult(r)) return false;
  const text = userText(r);
  if (w.kind === "text") return !r.isMeta && text.trim() === w.text.trim();
  return text.includes(`<command-name>/${w.name}</command-name>`);
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
  t.lastAssistant = {
    messageId: String(m.id ?? ""),
    stopReason: m.stop_reason ?? null,
    isApiError,
    offset,
  };
  t.lastChatOffset = offset;
  t.td = null;
  t.stopHookAfterLast = false;
  t.interrupt = null;
  t.waking = false;
  t.apiError = isApiError ? apiErrorOf(r) : null;
  if (isApiError) return;
  for (const b of m.content ?? []) applyAssistantBlock(state, t, b, offset);
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
    // A background agent is recognised by its result, not by run_in_background in its input.
    if (tur?.isAsync === true && typeof tur.agentId === "string") t.agents.add(tur.agentId);
    if (typeof tur?.backgroundTaskId === "string")
      t.shells.set(tur.backgroundTaskId, t.shellToolIds.get(b.tool_use_id) ?? "");
    applyReadResult(t, r, b, offset);
  }
}

function applyNotification(t: TurnState, text: string): void {
  const id = taskIdOf(text);
  if (!id) return;
  if (t.agents.has(id)) t.agentsDone.add(id);
  t.shells.delete(id);
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
  if (text.startsWith("[Request interrupted by user")) {
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

function acceptIfWitness(t: TurnState, r: Rec, offset: number): void {
  if (!matchesWitness(r, t.witness)) return;
  t.acceptedAt = typeof r.timestamp === "string" ? r.timestamp : new Date().toISOString();
  t.acceptedOffset = offset;
  t.lastChatOffset = offset;
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
  if (r.isSidechain) return state;
  noteMainAssistant(state, r);
  if (r.type === "system" && r.subtype === "stop_hook_summary") {
    state.session.stopHooksSeen = true;
    state.session.provenHookless = false;
  }
  const t = turnFor(state, offset);
  if (!t) return state;

  if (t.acceptedAt === null) {
    acceptIfWitness(t, r, offset);
    return state;
  }

  if (r.type === "assistant") applyAssistant(state, t, r, offset);
  else if (r.type === "user") applyUser(t, r, offset);
  else if (r.type === "system" && r.subtype === "stop_hook_summary") {
    if (t.lastAssistant) t.stopHookAfterLast = true;
  } else if (r.type === "system" && r.subtype === "turn_duration") applyTurnDuration(state, t, r);
  // compact_boundary carries no turn fact; compactions are counted on the isCompactSummary record
  return state;
}

function applyTurnDuration(state: FollowerState, t: TurnState, r: Rec): void {
  const la = t.lastAssistant;
  if (!la || t.waking) return;
  const p = r.pendingBackgroundAgentCount;
  t.td = { pendingBackgroundAgentCount: typeof p === "number" ? p : null };
  // `end_turn` → `turn_duration` with no stop_hook_summary between proves the session has no
  // Stop hooks (attachments and state records in between are normal: prompt_snapshot, mode, …).
  const proves =
    !t.stopHookAfterLast && !t.interrupt && la.stopReason === "end_turn" && !la.isApiError;
  if (proves && !state.session.stopHooksSeen) state.session.provenHookless = true;
}

/** Fold one subagent record: usage, tool calls, and a Read of the turn file delegated to a subagent. */
export function applySubagentRecord(
  state: FollowerState,
  record: Record<string, unknown>,
  offsetKey: number
): FollowerState {
  const r = record as Rec;
  recordUsage(state, r);
  const t = state.turns[state.turns.length - 1];
  if (!t?.read || t.acceptedAt === null) return state;
  if (r.type === "assistant") for (const b of r.message?.content ?? []) applyReadUse(state, t, b);
  if (r.type === "user" && Array.isArray(contentOf(r)))
    for (const b of contentOf(r) as Rec[]) applyReadResult(t, r, b, offsetKey);
  return state;
}

export function openTurnState(
  state: FollowerState,
  t: { index: number; offset: number; witness: Witness; delivery?: TurnDelivery | null }
): FollowerState {
  state.turns.push({
    index: t.index,
    offset: t.offset,
    witness: t.witness,
    acceptedAt: null,
    acceptedOffset: null,
    texts: [],
    lastAssistant: null,
    td: null,
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
  });
  return state;
}

export function turnView(t: TurnState): TurnView {
  const rs = t.read;
  let texts = t.texts;
  let preambleBytes = 0;
  if (rs) {
    const cut = rs.completedAtOffset ?? rs.lastReadOffset;
    if (cut !== null) {
      const before = texts.filter((x) => x.offset < cut);
      preambleBytes = before.reduce((n, x) => n + Buffer.byteLength(x.text), 0);
      texts = texts.filter((x) => x.offset > cut);
    }
  }
  const pendingEntry = [...t.pending.entries()].pop();
  return {
    index: t.index,
    acceptedAt: t.acceptedAt,
    acceptedOffset: t.acceptedOffset,
    assistantText: texts.map((x) => x.text),
    lastAssistant: t.lastAssistant
      ? {
          messageId: t.lastAssistant.messageId,
          stopReason: t.lastAssistant.stopReason,
          isApiError: t.lastAssistant.isApiError,
        }
      : null,
    turnDurationAfterLast: t.td,
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
    lastChatOffset: t.lastChatOffset,
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
      const rec = parse(line);
      // Offsets are 1-based positions past the line start so a record AT the turn offset
      // (written after the mark) is strictly greater than it.
      if (rec) applyRecord(this.state, rec, offset + 1);
    }
    if (this.pollSubagents()) any = true;
    if (any) this.lastAppend = this.clock();
    return any;
  }

  private subagentFiles(): string[] {
    if (!existsSync(this.subagentsDir)) return [];
    try {
      return readdirSync(this.subagentsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
  }

  private pollSubagents(): boolean {
    let any = false;
    for (const f of this.subagentFiles()) {
      let tail = this.subs.get(f);
      if (!tail) {
        tail = new Tail(join(this.subagentsDir, f));
        this.subs.set(f, tail);
      }
      for (const { line } of tail.read()) {
        any = true;
        const rec = parse(line);
        if (rec) applySubagentRecord(this.state, rec, this.main.offset + 1);
      }
    }
    return any;
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
    };
  }
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function parse(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
