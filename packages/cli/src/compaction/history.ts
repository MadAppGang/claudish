/**
 * History compaction: a summary of the earlier conversation, prepared in the
 * background and swapped in at a human-turn boundary.
 *
 * - **Limit.** The effective limit of a request is the lower of the request
 *   model's catalog context window and the `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 *   this launch gave Claude Code. With no catalog window the request is left
 *   alone.
 * - **Measure.** A request is measured with the proxy's local token count
 *   (`localTokenEstimate`), the number `count_tokens` answers with.
 * - **Prepare** (at `precomputeAt`, never awaited by the request). The boundary
 *   `b` is the start of the last human turn. Messages `[0, b)` are rendered as
 *   plain text (tool_results in the form this request sends, truncated; no
 *   thinking) and summarised by the compaction model. The summary is keyed by
 *   the hash of messages `[0, b)`. A later summary rolls forward: its input is
 *   the previous summary plus the messages after that summary's boundary. One
 *   summary is in flight per conversation thread.
 * - **Swap** (at `applyAt`, only when a summary is ready AND the last message
 *   starts a human turn, never inside a tool round). The request becomes one
 *   user message holding the summary, followed by messages `[b, end)` with
 *   `thinking` / `redacted_thinking` blocks removed, followed by any newer
 *   messages unchanged. The swap is recorded and replayed byte-identically on
 *   every later request whose messages `[0, b)` and `[b, end)` hash the same.
 *   A request with another prefix (Claude Code's own `/compact`, a subagent's
 *   transcript) matches no swap and is left untouched.
 * - **Failures** are final for their boundary and never block a request.
 *
 * Every hash is taken over the messages as they stand after the tool-output
 * pass, which replays recorded forms deterministically, with Claude Code's
 * moving `cache_control` markers removed.
 */

import { createHash } from "node:crypto";
import { lookupModel, lookupModelForProvider } from "../adapters/model-catalog.js";
import { withoutCacheMarkers } from "../code-mode/hashes.js";
import { claudeApiContextWindow } from "../handlers/claude-api-meter.js";
import { log } from "../logger.js";
import { parseModelSpec } from "../providers/model-parser.js";
import { localTokenEstimate } from "../token-estimate.js";
import type { HistorySettings } from "./config.js";
import type { CompactionCallResult, CompactionClient } from "./haiku-client.js";
import {
  type CompactionRecord,
  type CompactionStore,
  type HistorySummaryRecord,
  type HistorySwapRecord,
  historyRecordKey,
} from "./store.js";

/** The first line of the summary message; the summary follows on the next line. */
export const HISTORY_SUMMARY_MARKER = "[claudish: summary of the earlier conversation]";

/** `max_tokens` of one summary call. */
export const HISTORY_SUMMARY_MAX_TOKENS = 8192;

/** A summary call is abandoned (and its boundary recorded failed) after this long. */
export const HISTORY_SUMMARY_TIMEOUT_MS = 180_000;

/** Each rendered tool_result is cut to this many characters. */
export const RENDER_TOOL_RESULT_MAX_CHARS = 2000;

/** Each rendered tool_use input is cut to this many characters. */
export const RENDER_TOOL_INPUT_MAX_CHARS = 1000;

/** Each rendered text block is cut to this many characters. */
export const RENDER_TEXT_MAX_CHARS = 20_000;

/**
 * The rendered conversation sent for one summary is cut to this many
 * characters: the first message stays, the oldest messages after it go.
 */
export const HISTORY_INPUT_MAX_CHARS = 400_000;

/** Claude Code's floor and ceiling for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. */
export const AUTO_COMPACT_WINDOW_FLOOR = 100_000;
export const AUTO_COMPACT_WINDOW_CEILING = 1_000_000;

/** claudish's own system prompt for a history summary. */
export const HISTORY_SYSTEM_PROMPT = [
  "You summarise the earlier part of a conversation between a user and a coding agent.",
  "The agent continues the work from your summary alone; the conversation itself is no longer available to it.",
  "Retain:",
  "- the user's goals and requests, in the user's own words where they are short;",
  "- decisions made, and the reasons given for them;",
  "- every file path, function, identifier and command that was read, changed or created, and what changed;",
  "- open tasks and next steps, including anything the user asked for that is not done yet;",
  "- errors met, with their exact messages, and whether and how each was resolved;",
  "- facts learned about the codebase, the tools and the environment.",
  "Drop greetings, repeated attempts that led nowhere (state only their outcome), and tool output the agent no longer needs.",
  "Write plain text in short headed sections. No preamble and no closing remarks.",
].join("\n");

/** The text of the summary message: the marker line, then the summary. */
export function summaryMessageText(summary: string): string {
  return `${HISTORY_SUMMARY_MARKER}\n${summary}`;
}

type Block = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The launch's auto-compact window
// ---------------------------------------------------------------------------

let launchAutoCompactWindow: number | undefined;

/**
 * Record the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` this launch gave Claude Code,
 * as Claude Code reads it: clamped to its floor and ceiling. An empty, absent
 * or non-numeric value records nothing (undefined).
 */
export function setLaunchAutoCompactWindow(value: string | number | undefined): void {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  launchAutoCompactWindow =
    Number.isFinite(n) && n > 0
      ? Math.min(Math.max(Math.floor(n), AUTO_COMPACT_WINDOW_FLOOR), AUTO_COMPACT_WINDOW_CEILING)
      : undefined;
}

/** The window recorded by `setLaunchAutoCompactWindow`, if any. */
export function getLaunchAutoCompactWindow(): number | undefined {
  return launchAutoCompactWindow;
}

/**
 * The catalog context window of a request's model: on its named provider for
 * a `provider@model` spec, on the Claude API for a `claude-*` name, else the
 * model's own. Undefined when the catalog knows none.
 */
export function catalogContextWindow(model: unknown): number | undefined {
  if (typeof model !== "string" || model.length === 0) return undefined;
  const positive = (n: number | undefined): number | undefined =>
    typeof n === "number" && n > 0 ? n : undefined;
  try {
    const parsed = parseModelSpec(model);
    if (parsed.isExplicitProvider) {
      return positive(lookupModelForProvider(parsed.model, parsed.provider));
    }
    if (/^claude-/i.test(model)) {
      const native = positive(claudeApiContextWindow(model));
      if (native !== undefined) return native;
    }
    return positive(lookupModel(model)?.contextWindow);
  } catch {
    return undefined;
  }
}

/**
 * The effective limit: the catalog window, lowered to the launch's
 * auto-compact window when one was given. Undefined (history off for the
 * request) when the catalog window is unknown.
 */
export function effectiveHistoryLimit(
  catalogWindow: number | undefined,
  autoCompactWindow: number | undefined
): number | undefined {
  if (!(typeof catalogWindow === "number" && catalogWindow > 0)) return undefined;
  if (typeof autoCompactWindow === "number" && autoCompactWindow > 0) {
    return Math.min(catalogWindow, autoCompactWindow);
  }
  return catalogWindow;
}

// ---------------------------------------------------------------------------
// Messages: hashing, turns, rendering
// ---------------------------------------------------------------------------

/** JSON with object keys sorted, so equal content hashes equal whatever its key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Block)
    .filter((k) => (value as Block)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Block)[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * sha256 hex of messages `[start, end)`, over their canonical JSON without
 * `cache_control` markers. Claude Code moves those prompt-cache breakpoints to
 * newer blocks on every request, so a hash that included them would stop
 * matching the same conversation one or two requests later.
 */
export function messagesHash(messages: readonly unknown[], start: number, end: number): string {
  const hash = createHash("sha256");
  hash.update("[");
  for (let i = start; i < end; i++) {
    if (i > start) hash.update(",");
    hash.update(canonicalJson(withoutCacheMarkers(messages[i])));
  }
  hash.update("]");
  return hash.digest("hex");
}

/** The conversation thread of a request: sha256 of its first message. */
export function threadOf(messages: readonly unknown[]): string {
  return messagesHash(messages, 0, Math.min(1, messages.length));
}

/**
 * True when `message` starts a human turn: a user message with user text and
 * no tool_result. A user message carrying a tool_result belongs to a tool
 * round, even when Claude Code added text blocks beside it.
 */
export function isHumanTurnStart(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as Block;
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return m.content.trim().length > 0;
  if (!Array.isArray(m.content)) return false;
  let hasText = false;
  for (const raw of m.content) {
    const block = raw as Block;
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_result") return false;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      hasText = true;
    }
  }
  return hasText;
}

/** Index of the last message that starts a human turn, or -1. */
export function lastHumanTurnStart(messages: readonly unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanTurnStart(messages[i])) return i;
  }
  return -1;
}

/**
 * A copy of `message` without `thinking` and `redacted_thinking` blocks when
 * it is an assistant message that has any; otherwise `message` itself. An
 * assistant message left with no block gets one fixed text block, so the
 * conversation keeps its shape.
 */
export function stripThinking(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const m = message as Block;
  if (m.role !== "assistant" || !Array.isArray(m.content)) return message;
  const kept = m.content.filter((raw) => {
    const type = (raw as Block | null)?.type;
    return type !== "thinking" && type !== "redacted_thinking";
  });
  if (kept.length === m.content.length) return message;
  return {
    ...m,
    content: kept.length > 0 ? kept : [{ type: "text", text: "(reasoning omitted)" }],
  };
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((raw) => {
      const b = raw as Block;
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      if (b?.type === "image") return "[image]";
      if (b?.type === "document") return "[document]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** One message as plain text. Thinking is never rendered. */
export function renderMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as Block;
  const role = m.role === "assistant" ? "assistant" : "user";
  const lines: string[] = [`[${role}]`];
  if (typeof m.content === "string") {
    lines.push(cut(m.content, RENDER_TEXT_MAX_CHARS));
    return lines.join("\n");
  }
  if (!Array.isArray(m.content)) return lines.join("\n");
  for (const raw of m.content) {
    const b = raw as Block;
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string") lines.push(cut(b.text, RENDER_TEXT_MAX_CHARS));
        break;
      case "tool_use": {
        let input = "";
        try {
          input = JSON.stringify(b.input ?? {}) ?? "";
        } catch {
          input = "";
        }
        lines.push(
          `[tool call ${String(b.name ?? "unknown")}] ${cut(input, RENDER_TOOL_INPUT_MAX_CHARS)}`
        );
        break;
      }
      case "tool_result": {
        const tag = b.is_error === true ? "tool error" : "tool result";
        lines.push(
          `[${tag}] ${cut(renderToolResultContent(b.content), RENDER_TOOL_RESULT_MAX_CHARS)}`
        );
        break;
      }
      case "image":
        lines.push("[image]");
        break;
      case "document":
        lines.push("[document]");
        break;
      default:
        // thinking, redacted_thinking and anything unknown are not rendered
        break;
    }
  }
  return lines.join("\n");
}

/**
 * Messages `[start, end)` as plain text, at most `HISTORY_INPUT_MAX_CHARS`.
 * Over the cap, the first rendered message stays (cut to
 * `RENDER_TEXT_MAX_CHARS`) and the oldest messages after it are dropped, with
 * one line saying how many.
 */
export function renderMessages(messages: readonly unknown[], start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i < end; i++) parts.push(renderMessage(messages[i]));
  const joined = parts.join("\n\n");
  if (joined.length <= HISTORY_INPUT_MAX_CHARS || parts.length < 2) {
    return joined.length <= HISTORY_INPUT_MAX_CHARS ? joined : cut(joined, HISTORY_INPUT_MAX_CHARS);
  }
  const head = cut(parts[0] ?? "", RENDER_TEXT_MAX_CHARS);
  const budget = HISTORY_INPUT_MAX_CHARS - head.length - 200;
  const tail: string[] = [];
  let used = 0;
  for (let i = parts.length - 1; i >= 1; i--) {
    const part = parts[i] ?? "";
    if (used + part.length + 2 > budget) break;
    tail.unshift(part);
    used += part.length + 2;
  }
  const dropped = parts.length - 1 - tail.length;
  return [head, `[${dropped} earlier messages omitted]`, ...tail].join("\n\n");
}

/** The user message of one summary call. */
export function summaryRequestText(rendered: string, previousSummary?: string): string {
  if (previousSummary !== undefined) {
    return [
      "The summary of the conversation up to an earlier point:",
      "<previous_summary>",
      previousSummary,
      "</previous_summary>",
      "",
      "The conversation after that point:",
      "<conversation>",
      rendered,
      "</conversation>",
      "",
      "Write one summary that replaces the previous summary and covers both.",
    ].join("\n");
  }
  return [
    "The conversation so far:",
    "<conversation>",
    rendered,
    "</conversation>",
    "",
    "Write the summary.",
  ].join("\n");
}

/** The messages a swap sends in place of `original`. */
export function applySwap(original: readonly unknown[], swap: HistorySwapRecord): unknown[] {
  return [
    { role: "user", content: summaryMessageText(swap.summary) },
    ...original.slice(swap.boundary, swap.end).map(stripThinking),
    ...original.slice(swap.end),
  ];
}

// ---------------------------------------------------------------------------
// The compactor
// ---------------------------------------------------------------------------

/** What one request's history pass did. */
export interface HistoryPassSummary {
  /** `replayed`: a recorded swap was applied; `swapped`: a new swap was recorded and applied. */
  applied: "none" | "replayed" | "swapped";
  /** The boundary of the swap applied, if any. */
  boundary?: number;
  /** True when this request started a background summary. */
  precomputeStarted: boolean;
  /** The effective limit, when known. */
  limit?: number;
  /** The outgoing request's local token count, when a limit is known. */
  estimate?: number;
}

export interface HistoryCompactorDeps {
  store: CompactionStore;
  client: CompactionClient;
  settings: HistorySettings;
  /** The catalog window of a request's model. Defaults to `catalogContextWindow`. */
  contextWindowOf?: (model: unknown) => number | undefined;
  /** The launch's auto-compact window. Defaults to `getLaunchAutoCompactWindow`. */
  autoCompactWindow?: () => number | undefined;
  /** The timeout of one summary call. Defaults to `HISTORY_SUMMARY_TIMEOUT_MS`. */
  summaryTimeoutMs?: number;
}

/** Memoised prefix and range hashes of one request's messages. */
class MessageHashes {
  private readonly cache = new Map<string, string>();
  constructor(private readonly messages: readonly unknown[]) {}
  range(start: number, end: number): string {
    const k = `${start}:${end}`;
    let h = this.cache.get(k);
    if (h === undefined) {
      h = messagesHash(this.messages, start, end);
      this.cache.set(k, h);
    }
    return h;
  }
  prefix(end: number): string {
    return this.range(0, end);
  }
}

export class HistoryCompactor {
  /** Background summaries in flight, by session and thread. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: HistoryCompactorDeps) {}

  /**
   * Replay a recorded swap, record a new one when the request qualifies, and
   * start a background summary when it reaches `precomputeAt`. Mutates
   * `payload.messages`. Synchronous: it never waits for a summary.
   */
  compact(payload: unknown, sessionId: string): HistoryPassSummary {
    const result: HistoryPassSummary = { applied: "none", precomputeStarted: false };
    const original = messagesOf(payload);
    if (!original) return result;
    const body = payload as Block;
    const hashes = new MessageHashes(original);
    const thread = threadOf(original);

    const active = this.matchSwap(sessionId, thread, original, hashes);
    if (active) {
      body.messages = applySwap(original, active);
      result.applied = "replayed";
      result.boundary = active.boundary;
    }

    const limit = effectiveHistoryLimit(
      (this.deps.contextWindowOf ?? catalogContextWindow)(body.model),
      (this.deps.autoCompactWindow ?? getLaunchAutoCompactWindow)()
    );
    if (limit === undefined) return result;
    result.limit = limit;
    let estimate = localTokenEstimate(payload);
    result.estimate = estimate;
    const { precomputeAt, applyAt } = this.deps.settings;

    const last = original.length - 1;
    if (estimate >= applyAt * limit && last > 0 && isHumanTurnStart(original[last])) {
      const swap = this.recordSwap(sessionId, thread, original, hashes, active?.boundary ?? 0);
      if (swap) {
        body.messages = applySwap(original, swap);
        result.applied = "swapped";
        result.boundary = swap.boundary;
        estimate = localTokenEstimate(payload);
        result.estimate = estimate;
        log(
          `[compaction] history swap in session ${sessionId}: messages 0..${swap.boundary} replaced by a summary of ${swap.summary.length} characters`
        );
      }
    }

    if (estimate >= precomputeAt * limit) {
      const current = result.boundary ?? 0;
      result.precomputeStarted = this.maybePrecompute(sessionId, thread, original, hashes, current);
    }
    return result;
  }

  /**
   * Record a swap at the ready summary with the largest boundary above
   * `above`, and return it. Undefined when no summary is ready or the record
   * did not reach disk: a swap that is not on disk could not be replayed after
   * a restart, so it is never sent.
   */
  private recordSwap(
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes,
    above: number
  ): HistorySwapRecord | undefined {
    const ready = this.bestSummary(sessionId, thread, original, hashes, above, original.length - 1);
    if (!ready) return undefined;
    const swap: HistorySwapRecord = {
      kind: "history-swap",
      thread,
      prefixHash: ready.prefixHash,
      tailHash: hashes.range(ready.boundary, original.length),
      boundary: ready.boundary,
      end: original.length,
      summary: ready.summary,
      decidedAt: new Date().toISOString(),
    };
    let stored: CompactionRecord;
    try {
      stored = this.deps.store.put(
        sessionId,
        historyRecordKey("history-swap", sessionId, swap.prefixHash),
        swap
      );
    } catch (err) {
      log(
        `[compaction] history swap not recorded: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
    // A swap recorded earlier for the same prefix with another tail is not
    // this request's: only a record whose hashes match is sent.
    if (stored.kind !== "history-swap" || stored.end > original.length) return undefined;
    return stored.tailHash === hashes.range(stored.boundary, stored.end) ? stored : undefined;
  }

  /**
   * Apply a recorded swap to `payload.messages` in place, deciding nothing and
   * calling nothing. For `count_tokens`. Returns true when a swap was applied.
   */
  replay(payload: unknown, sessionId: string): boolean {
    const original = messagesOf(payload);
    if (!original) return false;
    const hashes = new MessageHashes(original);
    const swap = this.matchSwap(sessionId, threadOf(original), original, hashes);
    if (!swap) return false;
    (payload as Block).messages = applySwap(original, swap);
    return true;
  }

  /** Resolves once no summary is in flight. For tests and shutdown. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  /** The recorded swap with the largest boundary whose hashes match `original`. */
  private matchSwap(
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes
  ): HistorySwapRecord | undefined {
    let best: HistorySwapRecord | undefined;
    for (const [, record] of this.deps.store.list(sessionId)) {
      if (record.kind !== "history-swap" || record.thread !== thread) continue;
      if (record.boundary < 1 || record.end <= record.boundary || record.end > original.length) {
        continue;
      }
      if (best && record.boundary <= best.boundary) continue;
      if (hashes.prefix(record.boundary) !== record.prefixHash) continue;
      if (hashes.range(record.boundary, record.end) !== record.tailHash) continue;
      best = record;
    }
    return best;
  }

  /**
   * The ready summary with the largest boundary in `(above, atMost]` whose
   * prefix hash matches `original`.
   */
  private bestSummary(
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes,
    above: number,
    atMost: number
  ): Extract<HistorySummaryRecord, { form: "ready" }> | undefined {
    let best: Extract<HistorySummaryRecord, { form: "ready" }> | undefined;
    for (const [, record] of this.deps.store.list(sessionId)) {
      if (record.kind !== "history-summary" || record.form !== "ready") continue;
      if (record.thread !== thread) continue;
      if (record.boundary <= above || record.boundary > atMost) continue;
      if (record.boundary > original.length) continue;
      if (best && record.boundary <= best.boundary) continue;
      if (hashes.prefix(record.boundary) !== record.prefixHash) continue;
      best = record;
    }
    return best;
  }

  /** Start one background summary when the request has a new boundary. */
  private maybePrecompute(
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes,
    currentBoundary: number
  ): boolean {
    if (this.deps.client.disabled) return false;
    const boundary = lastHumanTurnStart(original);
    if (boundary < 1 || boundary <= currentBoundary) return false;
    const flightKey = `${sessionId}\n${thread}`;
    if (this.inFlight.has(flightKey)) return false;
    const prefixHash = hashes.prefix(boundary);
    const key = historyRecordKey("history-summary", sessionId, prefixHash);
    if (this.deps.store.get(sessionId, key)) return false;

    const previous = this.bestSummary(sessionId, thread, original, hashes, 0, boundary - 1);
    // Rendered now, while the messages are this request's: the handler that
    // runs next may change the body.
    const rendered = renderMessages(original, previous?.boundary ?? 0, boundary);
    const user = summaryRequestText(rendered, previous?.summary);
    const job = this.runSummary({
      sessionId,
      thread,
      key,
      prefixHash,
      boundary,
      user,
      ...(previous ? { basedOn: previous.prefixHash } : {}),
    })
      .catch((err) => {
        log(
          `[compaction] history summary failed: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        this.inFlight.delete(flightKey);
      });
    this.inFlight.set(flightKey, job);
    log(
      `[compaction] history summary started in session ${sessionId}: messages 0..${boundary}${previous ? `, rolling forward from ${previous.boundary}` : ""}`
    );
    return true;
  }

  private async runSummary(job: {
    sessionId: string;
    thread: string;
    key: string;
    prefixHash: string;
    boundary: number;
    user: string;
    basedOn?: string;
  }): Promise<void> {
    let result: CompactionCallResult;
    try {
      result = await this.deps.client.complete({
        system: HISTORY_SYSTEM_PROMPT,
        user: job.user,
        maxTokens: HISTORY_SUMMARY_MAX_TOKENS,
        timeoutMs: this.deps.summaryTimeoutMs ?? HISTORY_SUMMARY_TIMEOUT_MS,
        purpose: `history summary of ${job.boundary} messages`,
      });
    } catch (err) {
      result = {
        ok: false,
        reason: `summary call threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const decidedAt = new Date().toISOString();
    const record: HistorySummaryRecord = result.ok
      ? {
          kind: "history-summary",
          form: "ready",
          thread: job.thread,
          prefixHash: job.prefixHash,
          boundary: job.boundary,
          summary: result.text,
          ...(job.basedOn ? { basedOn: job.basedOn } : {}),
          decidedAt,
        }
      : {
          kind: "history-summary",
          form: "failed",
          thread: job.thread,
          prefixHash: job.prefixHash,
          boundary: job.boundary,
          reason: result.reason,
          decidedAt,
        };
    try {
      this.deps.store.put(job.sessionId, job.key, record);
    } catch (err) {
      // A ready summary held only in memory is still usable by this process:
      // the swap it leads to is what must reach disk, and that write is checked.
      log(
        `[compaction] history summary record not written (${err instanceof Error ? err.message : String(err)}); held in memory`
      );
      this.deps.store.remember(job.sessionId, job.key, record);
    }
    log(
      record.form === "ready"
        ? `[compaction] history summary ready in session ${job.sessionId}: messages 0..${job.boundary}, ${record.summary.length} characters`
        : `[compaction] history summary failed in session ${job.sessionId} at message ${job.boundary}: ${record.reason}`
    );
  }
}

function messagesOf(payload: unknown): unknown[] | undefined {
  const messages = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length < 2) return undefined;
  if (!messages.every((m) => !!m && typeof m === "object")) return undefined;
  return messages;
}
