/**
 * History compaction: a summary of the earlier conversation, prepared in the
 * background and swapped in at a human-turn start or after a complete tool
 * round.
 *
 * - **Limit.** The effective limit of a request is the lower of the request
 *   model's catalog context window and the `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 *   this launch gave Claude Code. With no catalog window the request is left
 *   alone.
 * - **Measure.** A request is measured with the real count (`RealTokenCount`):
 *   the upstream usage of the thread's previous request plus an estimate of
 *   what was appended since, calibrated by that same measurement.
 * - **Prepare** (at `precomputeAt`, or earlier by `projectedTokens`; awaited
 *   only by the last request before Claude Code's own compaction point, for
 *   at most `HISTORY_SWAP_WAIT_MS`). The boundary
 *   `b` is chosen by `summaryBoundary`: the start of the last human turn, or,
 *   inside a turn, the assistant message that keeps the newest
 *   `MID_TURN_TAIL_ROUNDS` complete tool rounds out of the summary. Messages
 *   `[0, b)` are rendered as
 *   plain text (tool_results in the form this request sends, truncated; no
 *   thinking) and summarised by the compaction model. The summary is keyed by
 *   the hash of messages `[0, b)`. A later summary rolls forward: its input is
 *   the previous summary plus the messages after that summary's boundary. One
 *   summary is in flight per conversation thread, and inside a turn a new one
 *   starts only `MID_TURN_MIN_ADVANCE` messages past the newest one.
 * - **Swap** (at `applyAt`, only when a summary is ready AND the last message
 *   starts a human turn or answers every tool_use of the assistant message
 *   before it; never between a tool_use and its result). Message `b` never
 *   holds a tool_result, so every kept tool_result keeps its tool_use. The
 *   request becomes one
 *   user message holding the summary, followed by messages `[b, end)` with
 *   `thinking` / `redacted_thinking` blocks removed, followed by any newer
 *   messages unchanged. The swap is recorded and replayed on every later
 *   request of the same thread whose messages `[0, b)` hash the same and that
 *   holds at least `end` messages; the summary bytes are identical on each.
 *   Messages `[b, end)` are taken from the current request, so a change to one
 *   of them changes only that message. A request with another prefix (Claude Code's own `/compact`, a subagent's
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
import { claudeApiContextWindow, claudeApiTurnPricing } from "../handlers/claude-api-meter.js";
import type { AnthropicUsage } from "../handlers/shared/claude-api-usage.js";
import { log } from "../logger.js";
import { ONE_MILLION_CONTEXT_SUFFIX } from "../providers/claude-code-aliases.js";
import { parseModelSpec } from "../providers/model-parser.js";
import { type CachePricing, cacheRatios, cacheTtlMs } from "./cache-prices.js";
import { DEFAULT_TOPIC_SETTINGS, type HistorySettings } from "./config.js";
import type { CompactionCallResult, CompactionClient } from "./haiku-client.js";
import { isHarnessCompactionMessage, isHarnessCompactionRequest } from "./harness-compaction.js";
import {
  RealTokenCount,
  type RequestCount,
  type ThreadObservation,
  type UsageMark,
  charsOf,
} from "./real-count.js";
import {
  type CompactionRecord,
  type CompactionStore,
  type HistorySummaryRecord,
  type HistorySwapRecord,
  historyRecordKey,
} from "./store.js";
import { type HistoryPolicy, type SwapDecision, decideHistorySwap } from "./swap-policy.js";
import { type TopicDecider, type TopicResult, decideTopicAction } from "./topic.js";

/** The first line of the summary message; the summary follows on the next line. */
export const HISTORY_SUMMARY_MARKER = "[claudish: summary of the earlier conversation]";

/**
 * The text block that follows the summary when a swap inside a turn keeps
 * that turn's user prompt; the prompt's own blocks follow it.
 */
export const HISTORY_PINNED_PROMPT_MARKER =
  "[claudish: the user's request for this turn, verbatim]";

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
/**
 * The fraction of the effective limit at which Claude Code compacts on its
 * own: measured near 0.83 on a 200K window.
 */
export const CLAUDE_CODE_COMPACT_AT = 0.83;

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
export function catalogContextWindow(name: unknown): number | undefined {
  if (typeof name !== "string" || name.length === 0) return undefined;
  // Claude Code's `[1m]` selector is not part of any catalog id.
  const model = name.toLowerCase().endsWith(ONE_MILLION_CONTEXT_SUFFIX)
    ? name.slice(0, -ONE_MILLION_CONTEXT_SUFFIX.length)
    : name;
  if (model.length === 0) return undefined;
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

/**
 * sha256 hex of one message: canonical JSON without `cache_control` markers,
 * with a content of exactly one text block hashed as that text. Claude Code
 * sends its newest message as one text block carrying a cache marker, and
 * the same message as a plain string on every later request; both hash
 * equal here. Used to recognise one message across requests (a swap's tail,
 * the real count's measured message), never for the prefix hashes.
 */
export function messageHash(message: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(withSingleTextAsString(withoutCacheMarkers(message))))
    .digest("hex");
}

function withSingleTextAsString(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const m = message as Block;
  if (!Array.isArray(m.content) || m.content.length !== 1) return message;
  const only = m.content[0] as Block | null;
  if (!only || only.type !== "text" || typeof only.text !== "string") return message;
  if (Object.keys(only).some((k) => k !== "type" && k !== "text")) return message;
  return { ...m, content: only.text };
}

/** The conversation thread of a request: sha256 of its first message. */
export function threadOf(messages: readonly unknown[]): string {
  return messagesHash(messages, 0, Math.min(1, messages.length));
}

/**
 * True when `message` starts a human turn: a user message with user text and
 * no tool_result. A user message carrying a tool_result belongs to a tool
 * round, even when Claude Code added text blocks beside it. Claude Code's
 * compaction instruction is not a human turn.
 */
export function isHumanTurnStart(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as Block;
  if (m.role !== "user") return false;
  if (isHarnessCompactionMessage(m)) return false;
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
 * A summary made inside a turn leaves this many complete tool rounds out of
 * it, so the model keeps its newest tool outputs verbatim after a swap.
 */
export const MID_TURN_TAIL_ROUNDS = 2;

/**
 * Inside a turn, a new summary starts only when its boundary is at least this
 * many messages past the newest summary of the thread, so a long turn does not
 * start one summary per request.
 */
export const MID_TURN_MIN_ADVANCE = 8;

function blocksOf(message: unknown): Block[] {
  const content = (message as Block | null)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function holdsToolResult(message: unknown): boolean {
  return blocksOf(message).some((b) => b?.type === "tool_result");
}

/**
 * True when message `i` is a user message of tool_results that answers every
 * tool_use of the assistant message right before it.
 */
export function isCompleteToolRound(messages: readonly unknown[], i: number): boolean {
  const results = messages[i] as Block | undefined;
  const asking = messages[i - 1] as Block | undefined;
  if (results?.role !== "user" || asking?.role !== "assistant") return false;
  const answered = new Set(
    blocksOf(results)
      .filter((b) => b?.type === "tool_result")
      .map((b) => b.tool_use_id)
  );
  if (answered.size === 0) return false;
  const asked = blocksOf(asking).filter((b) => b?.type === "tool_use");
  return asked.length > 0 && asked.every((b) => answered.has(b.id));
}

/**
 * True when a swap may be sent on a request whose last message is
 * `messages[last]`: it starts a human turn, or it answers every tool_use of
 * the assistant message before it.
 */
export function isSwapPoint(messages: readonly unknown[]): boolean {
  const last = messages.length - 1;
  if (last < 1) return false;
  return isHumanTurnStart(messages[last]) || isCompleteToolRound(messages, last);
}

/**
 * True when messages `[0, b)` can be replaced by a summary: message `b` holds
 * no tool_result, so no kept tool_result loses its tool_use.
 */
export function isSafeBoundary(messages: readonly unknown[], b: number): boolean {
  return b >= 1 && b < messages.length && !holdsToolResult(messages[b]);
}

/**
 * The boundary a new summary of `messages` covers up to.
 *
 * - The last message starts a human turn: the start of that turn.
 * - Otherwise (inside a turn): the later of the last human turn start and the
 *   assistant message that begins the `MID_TURN_TAIL_ROUNDS`-th newest
 *   complete tool round, so those rounds stay out of the summary.
 */
export function summaryBoundary(messages: readonly unknown[]): number {
  const human = lastHumanTurnStart(messages);
  const last = messages.length - 1;
  if (last >= 0 && isHumanTurnStart(messages[last])) return human;
  let found = 0;
  for (let b = last; b > human && b >= 2; b--) {
    if ((messages[b] as Block | undefined)?.role !== "assistant") continue;
    if (!isCompleteToolRound(messages, b - 1)) continue;
    found += 1;
    if (found === MID_TURN_TAIL_ROUNDS) return b;
  }
  return human;
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

/** The text a person wrote or read in one message: its string content, or its text blocks joined. */
export function messageText(message: unknown): string {
  const content = (message as Block | undefined)?.content;
  if (typeof content === "string") return content;
  return blocksOf(message)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
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

/**
 * The human turn start a swap at `boundary` keeps verbatim, or undefined.
 * A boundary inside a turn (message `boundary` is not a human turn start)
 * pins the start of that turn, so its user prompt survives the swap as
 * written; a boundary at a human turn start keeps that prompt as message
 * `boundary` and pins nothing.
 */
export function pinnedPromptIndex(
  messages: readonly unknown[],
  boundary: number
): number | undefined {
  if (boundary < 1 || boundary >= messages.length) return undefined;
  if (isHumanTurnStart(messages[boundary])) return undefined;
  const start = lastHumanTurnStart(messages.slice(0, boundary));
  return start >= 0 ? start : undefined;
}

/** The blocks of a pinned prompt as sent: its content without cache markers. */
function pinnedPromptBlocks(message: unknown): Block[] {
  const content = (message as Block).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (withoutCacheMarkers(content) as Block[]).filter((b) => b?.type !== "tool_result");
}

/**
 * The user message that replaces messages `[0, b)`: the summary, and, when
 * `pinned` names a human turn start below `b`, that turn's prompt verbatim
 * after `HISTORY_PINNED_PROMPT_MARKER`. Cache markers are dropped from the
 * copy, so the bytes are the same on every request whatever message Claude
 * Code marks.
 */
export function summaryMessage(
  summary: string,
  original: readonly unknown[],
  boundary: number,
  pinned: number | undefined
): { role: "user"; content: string | Block[] } {
  const text = summaryMessageText(summary);
  if (
    pinned === undefined ||
    !Number.isInteger(pinned) ||
    pinned < 0 ||
    pinned >= boundary ||
    !isHumanTurnStart(original[pinned])
  ) {
    return { role: "user", content: text };
  }
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "text", text: HISTORY_PINNED_PROMPT_MARKER },
      ...pinnedPromptBlocks(original[pinned]),
    ],
  };
}

/**
 * The hold decision for a swap that pins a prompt yet leaves the request at
 * or above Claude Code's compaction point: the swap would cost a cache write
 * and Claude Code would still compact. Undefined when the swap can bring the
 * request under that point, or pins nothing.
 */
export function pinnedPromptTooLarge(
  pinned: number | undefined,
  afterSwapTokens: number,
  ccCompactAt: number
): SwapDecision | undefined {
  if (pinned === undefined || afterSwapTokens < ccCompactAt) return undefined;
  return {
    swap: false,
    reason: `the current turn's prompt and newest rounds are ${afterSwapTokens} tokens, at or above Claude Code's compaction point ${Math.round(ccCompactAt)}`,
  };
}

/**
 * The summary latency assumed before a session has timed one: bench summaries
 * took 10.6 s and 14 s.
 */
export const HISTORY_SUMMARY_LATENCY_MS = 15_000;

/**
 * The longest one request waits for a summary in flight before Claude Code's
 * own compaction point, the same bound as one request's tool-output
 * compression (`compaction.toolOutputs.timeoutMs` default).
 */
export const HISTORY_SWAP_WAIT_MS = 20_000;

/** The most requests a projection looks ahead, however short the gap between them. */
export const MAX_PROJECTED_REQUESTS = 8;

/**
 * The count `requests` requests from now, where `requests` is how many the
 * thread sends while one summary runs (`latencyMs` over the gap between
 * requests, at most `MAX_PROJECTED_REQUESTS`). The count itself when growth
 * or the gap is not measured yet.
 */
export function projectedTokens(
  count: number,
  observed: Pick<ThreadObservation, "gapMs" | "growthPerRequest">,
  latencyMs: number
): { tokens: number; requests: number } {
  const { gapMs, growthPerRequest } = observed;
  if (
    growthPerRequest === undefined ||
    !(growthPerRequest > 0) ||
    !(gapMs !== undefined && gapMs > 0)
  ) {
    return { tokens: count, requests: 0 };
  }
  const requests = Math.min(MAX_PROJECTED_REQUESTS, Math.ceil(latencyMs / gapMs));
  return { tokens: count + Math.round(growthPerRequest * requests), requests };
}

/** The messages a swap sends in place of `original`. */
export function applySwap(original: readonly unknown[], swap: HistorySwapRecord): unknown[] {
  return [
    summaryMessage(swap.summary, original, swap.boundary, swap.pinned),
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
  /** The outgoing request's token count (see `RealTokenCount`), when a limit is known. */
  estimate?: number;
  /** Where `estimate` came from. */
  countSource?: RequestCount["source"];
  /** What this request sends, for `recordUsage` once its response ends. */
  mark?: UsageMark;
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
  /** The longest a request waits for a summary in flight. Defaults to `HISTORY_SWAP_WAIT_MS`. */
  swapWaitMs?: number;
  /** The request counter. Defaults to a new `RealTokenCount` on `now`. */
  counter?: RealTokenCount;
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * The rates of a request's model for an input of `inputTokens`. Defaults to
   * the Claude API connection's rates for a `claude-*` name, else undefined.
   */
  pricesOf?: (model: unknown, inputTokens: number) => CachePricing | undefined;
  /** What the Haiku call behind a ready summary cost, in dollars. */
  haikuCostOf?: (summary: Extract<HistorySummaryRecord, { form: "ready" }>) => number;
  /** The `topic` policy's decider. Without one, `topic` swaps only on its threshold rule. */
  topicDecider?: TopicDecider;
}

/** The Claude API rates of a `claude-*` model; undefined for any other name. */
export function claudeApiPrices(model: unknown, inputTokens: number): CachePricing | undefined {
  if (typeof model !== "string") return undefined;
  const name = model.toLowerCase().endsWith(ONE_MILLION_CONTEXT_SUFFIX)
    ? model.slice(0, -ONE_MILLION_CONTEXT_SUFFIX.length)
    : model;
  if (!/^claude-/i.test(name)) return undefined;
  return claudeApiTurnPricing(name, inputTokens);
}

/** The dollars a summary's recorded Haiku usage cost at `haikuModel`'s rates; 0 when not recorded. */
export function summaryHaikuCost(
  summary: Extract<HistorySummaryRecord, { form: "ready" }>,
  haikuModel: string
): number {
  const input = summary.inputTokens ?? 0;
  const output = summary.outputTokens ?? 0;
  if (input + output <= 0) return 0;
  const rates = claudeApiTurnPricing(haikuModel, input);
  return (input * rates.inputCostPer1M + output * rates.outputCostPer1M) / 1_000_000;
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
  private readonly counter: RealTokenCount;
  /** Sessions and models already told that history is off for want of a window. */
  private readonly windowUnknownLogged = new Set<string>();
  /** The newest summary's duration per session, in ms, for `projectedTokens`. */
  private readonly summaryLatency = new Map<string, number>();

  constructor(private readonly deps: HistoryCompactorDeps) {
    this.counter = deps.counter ?? new RealTokenCount(deps.now);
  }

  /**
   * Replay a recorded swap, record a new one when the request qualifies, and
   * start a background summary when it reaches `precomputeAt`. Mutates
   * `payload.messages`. Synchronous: it never waits for a summary (only
   * `compactAsync` does, in `waitBeforeCcCompact`).
   *
   * `routedModel` is the model the request is routed to; its context window
   * is the limit. Absent, the body's own `model` is used.
   */
  /**
   * `compact`, after the `topic` policy's decision for a request that starts
   * a human turn: the one step that waits, for the decider's answer, bounded
   * by its own timeout. Every other policy goes straight to `compact`.
   */
  async compactAsync(
    payload: unknown,
    sessionId: string,
    routedModel?: string
  ): Promise<HistoryPassSummary> {
    const original = messagesOf(payload);
    const harness = original !== undefined && isHarnessCompactionRequest(original);
    if (original && !harness) {
      await this.waitBeforeCcCompact(payload, original, sessionId, routedModel);
    }
    const topicSwap =
      this.deps.settings.policy === "topic" && !harness
        ? await this.topicDecision(payload, sessionId)
        : undefined;
    return this.compact(payload, sessionId, routedModel, topicSwap);
  }

  /**
   * Wait, at most `swapWaitMs`, for the thread's summary in flight when this
   * request is the last one before Claude Code's own compaction point: it is
   * a swap point at or above the swap gate, and the count plus one request's
   * measured growth reaches `CLAUDE_CODE_COMPACT_AT` of the limit. Claude Code
   * decides to compact from the usage of this request's response, so a swap
   * on any later request comes too late. A summary that is not ready in time
   * leaves the request as it was; Claude Code's compaction stays the fallback.
   */
  private async waitBeforeCcCompact(
    payload: unknown,
    original: readonly unknown[],
    sessionId: string,
    routedModel: string | undefined
  ): Promise<void> {
    const thread = threadOf(original);
    const flight = this.inFlight.get(`${sessionId}\n${thread}`);
    if (!flight || !isSwapPoint(original)) return;
    const limit = effectiveHistoryLimit(
      (this.deps.contextWindowOf ?? catalogContextWindow)(routedModel ?? (payload as Block).model),
      (this.deps.autoCompactWindow ?? getLaunchAutoCompactWindow)()
    );
    if (limit === undefined) return;
    const { precomputeAt, applyAt } = this.deps.settings;
    const gate = (this.deps.settings.policy === "cost" ? precomputeAt : applyAt) * limit;
    const tokens = this.counter.count(sessionId, thread, payload).tokens;
    const growth = this.counter.observe(sessionId, thread).growthPerRequest;
    const ccCompactAt = CLAUDE_CODE_COMPACT_AT * limit;
    if (tokens < gate || growth === undefined || tokens + growth < ccCompactAt) return;

    const now = this.deps.now ?? Date.now;
    const started = now();
    const capMs = this.deps.swapWaitMs ?? HISTORY_SWAP_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      flight.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), capMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    log(
      `[compaction] history waited ${Math.max(0, now() - started)} ms in session ${sessionId}: ${tokens} tokens now, next request projected ${Math.round(tokens + growth)}, Claude Code compacts at ${Math.round(ccCompactAt)}; ${ready ? "summary ready" : `summary not ready after ${capMs} ms`}`
    );
  }

  /**
   * The prefix hash of the ready summary to swap in for a new topic, or
   * undefined to hold. Decided only at a human turn start with at least
   * `floorTokens` of history and a ready summary above the active swap, so
   * history is never dropped without a summary and the decider is never
   * asked a question whose answer cannot act.
   */
  private async topicDecision(payload: unknown, sessionId: string): Promise<string | undefined> {
    const decider = this.deps.topicDecider;
    const settings = this.deps.settings.topic ?? DEFAULT_TOPIC_SETTINGS;
    const original = messagesOf(payload);
    if (!decider || !original || original.length < 2) return undefined;
    const last = original.length - 1;
    if (!isHumanTurnStart(original[last])) return undefined;
    const thread = threadOf(original);
    if (this.counter.count(sessionId, thread, payload).tokens < settings.floorTokens) {
      return undefined;
    }
    const hashes = new MessageHashes(original);
    const active = this.matchSwap(sessionId, thread, original, hashes);
    const ready = this.bestSummary(
      sessionId,
      thread,
      original,
      hashes,
      active?.boundary ?? 0,
      last
    );
    const logDecision = (verdict: TopicResult, action: { swap: boolean; reason: string }) => {
      const v = verdict.ok ? verdict.verdict : undefined;
      log(
        `[compaction] topic decision ${decider.name}: ${v?.topic ?? "unknown"}, confidence=${v?.confidence ?? "unknown"}, similarity=${v?.similarity === undefined ? "unknown" : v.similarity.toFixed(3)}, action=${action.swap ? "swap" : "hold"}, reason=${action.reason}`
      );
    };
    if (!ready) {
      const none: TopicResult = { ok: false, reason: "no ready summary to swap in" };
      logDecision(none, { swap: false, reason: none.reason });
      return undefined;
    }
    const recent = original
      .slice(ready.boundary, last)
      .map(messageText)
      .filter((t) => t.length > 0);
    let result: TopicResult;
    try {
      result = await decider.decide({
        prompt: messageText(original[last]),
        summary: ready.summary,
        recent,
      });
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const observed = this.counter.observe(sessionId, thread);
    const action = decideTopicAction({
      result,
      minConfidence: settings.minConfidence,
      summaryReady: true,
      coldCache: observed.gapMs !== undefined && observed.gapMs > cacheTtlMs(observed.writeSplit),
    });
    logDecision(result, action);
    return action.swap ? ready.prefixHash : undefined;
  }

  compact(
    payload: unknown,
    sessionId: string,
    routedModel?: string,
    topicSwap?: string
  ): HistoryPassSummary {
    const result: HistoryPassSummary = { applied: "none", precomputeStarted: false };
    const original = messagesOf(payload);
    if (!original) return result;
    const body = payload as Block;
    const hashes = new MessageHashes(original);
    const thread = threadOf(original);

    const active = this.replayActive(body, sessionId, thread, original, hashes, result);
    // Claude Code's compaction request: the swap the model already works
    // from is replayed (a cache read), and nothing new is decided, because no
    // later request repeats this one's prefix.
    if (isHarnessCompactionRequest(original)) return result;

    const windowModel = routedModel ?? body.model;
    const limit = effectiveHistoryLimit(
      (this.deps.contextWindowOf ?? catalogContextWindow)(windowModel),
      (this.deps.autoCompactWindow ?? getLaunchAutoCompactWindow)()
    );
    if (limit === undefined) {
      this.logWindowUnknown(sessionId, windowModel);
      return result;
    }
    result.limit = limit;
    const counter = this.counter;
    let chars = charsOf(payload);
    let count = counter.count(sessionId, thread, payload, chars);
    const prepareAt = this.prepareAt(limit);
    if (count.tokens >= prepareAt) logCount(sessionId, count, limit);

    const swap =
      (topicSwap !== undefined
        ? this.topicSwap(sessionId, thread, original, hashes, active, topicSwap)
        : undefined) ??
      this.decidedSwap(sessionId, thread, body, original, hashes, active, count, limit);
    if (swap) {
      body.messages = applySwap(original, swap);
      result.applied = "swapped";
      result.boundary = swap.boundary;
      chars = charsOf(payload);
      count = counter.count(sessionId, thread, payload, chars);
      logSwap(sessionId, swap, original);
    }
    result.estimate = count.tokens;
    result.countSource = count.source;

    result.precomputeStarted = this.maybePrepare(
      sessionId,
      thread,
      original,
      hashes,
      result.boundary ?? 0,
      count.tokens,
      prepareAt
    );
    result.mark = counter.mark(sessionId, thread, payload, chars);
    return result;
  }

  /**
   * Start a background summary when the count reaches `prepareAt`, or
   * earlier when the thread's measured growth projects it there before a
   * summary started now would be ready (`projectedTokens`). A fast-growing
   * turn otherwise reaches Claude Code's own compaction point while its
   * summary is still running.
   */
  private maybePrepare(
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes,
    currentBoundary: number,
    tokens: number,
    prepareAt: number
  ): boolean {
    if (tokens >= prepareAt) {
      return this.maybePrecompute(sessionId, thread, original, hashes, currentBoundary);
    }
    const projected = projectedTokens(
      tokens,
      this.counter.observe(sessionId, thread),
      this.summaryLatency.get(sessionId) ?? HISTORY_SUMMARY_LATENCY_MS
    );
    if (projected.tokens < prepareAt) return false;
    const started = this.maybePrecompute(sessionId, thread, original, hashes, currentBoundary);
    if (started) {
      log(
        `[compaction] history summary started early in session ${sessionId}: ${tokens} tokens now, projected ${projected.tokens} in ${projected.requests} requests, prepareAt ${Math.round(prepareAt)}`
      );
    }
    return started;
  }

  /**
   * The count at which summaries are prepared: `precomputeAt` of the limit,
   * or for `topic` the topic floor when that is lower, so a summary is ready
   * when a topic changes.
   */
  /** One line per session and model: history is off because no window is known. */
  private logWindowUnknown(sessionId: string, model: unknown): void {
    const name = typeof model === "string" && model.length > 0 ? model : "the request's model";
    const key = `${sessionId}\0${name}`;
    if (this.windowUnknownLogged.has(key)) return;
    this.windowUnknownLogged.add(key);
    log(
      `[compaction] session ${sessionId}: history off: the catalog publishes no context window for ${name}`
    );
  }

  private prepareAt(limit: number): number {
    const at = this.deps.settings.precomputeAt * limit;
    if (this.deps.settings.policy !== "topic") return at;
    return Math.min(at, (this.deps.settings.topic ?? DEFAULT_TOPIC_SETTINGS).floorTokens);
  }

  /** Record the swap a topic decision chose: the ready summary with prefix hash `prefixHash`. */
  private topicSwap(
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes,
    active: HistorySwapRecord | undefined,
    prefixHash: string
  ): HistorySwapRecord | undefined {
    const last = original.length - 1;
    const ready = this.bestSummary(
      sessionId,
      thread,
      original,
      hashes,
      active?.boundary ?? 0,
      last
    );
    if (!ready || ready.prefixHash !== prefixHash) return undefined;
    return this.recordSwap(sessionId, thread, original, hashes, ready);
  }

  /** Apply the recorded swap that matches `original`, if any, and return it. */
  private replayActive(
    body: Block,
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes,
    result: HistoryPassSummary
  ): HistorySwapRecord | undefined {
    const active = this.matchSwap(sessionId, thread, original, hashes);
    if (!active) return undefined;
    if (tailChanged(active, original, hashes)) logTailChange(sessionId, active, original);
    body.messages = applySwap(original, active);
    result.applied = "replayed";
    result.boundary = active.boundary;
    return active;
  }

  /**
   * Record the usage the upstream reported for the request `mark` describes.
   * The next request of the same thread is counted from it.
   */
  recordUsage(mark: UsageMark, usage: AnthropicUsage | undefined): void {
    this.counter.record(mark, usage);
  }

  /**
   * The new swap this request sends, recorded, or undefined. A decision is
   * made at a swap point with a ready summary above the active boundary, once
   * the count reaches `applyAt` (`threshold`, `early`) or `precomputeAt` (`cost`).
   */
  private decidedSwap(
    sessionId: string,
    thread: string,
    body: Block,
    original: readonly unknown[],
    hashes: MessageHashes,
    active: HistorySwapRecord | undefined,
    count: RequestCount,
    limit: number
  ): HistorySwapRecord | undefined {
    const policy: HistoryPolicy = this.deps.settings.policy ?? "threshold";
    const { precomputeAt, applyAt } = this.deps.settings;
    const gate = policy === "cost" ? precomputeAt : applyAt;
    if (count.tokens < gate * limit || !isSwapPoint(original)) return undefined;
    const last = original.length - 1;
    const ready = this.bestSummary(
      sessionId,
      thread,
      original,
      hashes,
      active?.boundary ?? 0,
      last
    );
    if (!ready) return undefined;
    const decision = this.decide(policy, sessionId, thread, body, original, ready, count, limit);
    return decision.swap ? this.recordSwap(sessionId, thread, original, hashes, ready) : undefined;
  }

  /**
   * Decide, with `decideHistorySwap`, whether swapping `ready` in now pays,
   * and log the decision. The token figures are measured at the session's
   * characters-per-token ratio: L the kept tail with thinking stripped, S the
   * summary message, R the prefix it replaces less S.
   */
  private decide(
    policy: HistoryPolicy,
    sessionId: string,
    thread: string,
    body: Block,
    original: readonly unknown[],
    ready: Extract<HistorySummaryRecord, { form: "ready" }>,
    count: RequestCount,
    limit: number
  ): SwapDecision {
    const counter = this.counter;
    const observed = counter.observe(sessionId, thread);
    const tailTokens = counter.tokensOfChars(
      sessionId,
      charsOf(original.slice(ready.boundary).map(stripThinking))
    );
    const pinned = pinnedPromptIndex(original, ready.boundary);
    const summaryTokens = counter.tokensOfChars(
      sessionId,
      charsOf(summaryMessage(ready.summary, original, ready.boundary, pinned))
    );
    const prefixTokens = counter.tokensOfChars(
      sessionId,
      charsOf(original.slice(0, ready.boundary))
    );
    const removedTokens = Math.max(0, prefixTokens - summaryTokens);
    const pricing = (this.deps.pricesOf ?? claudeApiPrices)(body.model, count.tokens);
    const ratios = cacheRatios(pricing, observed.writeSplit);
    const haikuCostUsd = (
      this.deps.haikuCostOf ?? ((s) => summaryHaikuCost(s, this.deps.client.model))
    )(ready);
    const ccCompactAt = CLAUDE_CODE_COMPACT_AT * limit;
    const decision =
      pinnedPromptTooLarge(pinned, tailTokens + summaryTokens, ccCompactAt) ??
      decideHistorySwap({
        policy,
        count: count.tokens,
        limit,
        precomputeAt: this.deps.settings.precomputeAt,
        applyAt: this.deps.settings.applyAt,
        ccCompactAt,
        tailTokens,
        summaryTokens,
        removedTokens,
        ...(ratios ? { ratios } : {}),
        haikuCostUsd,
        ...(observed.gapMs !== undefined ? { gapMs: observed.gapMs } : {}),
        cacheTtlMs: cacheTtlMs(observed.writeSplit),
        ...(observed.growthPerRequest !== undefined
          ? { growthPerRequest: observed.growthPerRequest }
          : {}),
      });
    const show = (n: number | undefined) =>
      n === undefined ? "unknown" : Number.isFinite(n) ? n.toFixed(1) : "infinite";
    log(
      `[compaction] history decision ${policy}: ${decision.swap ? "swap" : "hold"}, nStar=${show(decision.nStar)}, projected=${decision.projectedRequestsBeforeCcCompact ?? "unknown"}, L=${tailTokens}, S=${summaryTokens}, R=${removedTokens}, reason=${decision.reason}`
    );
    return decision;
  }

  /**
   * Record a swap at the ready summary `ready`, and return it. Undefined when
   * the record did not reach disk: a swap that is not on disk could not be
   * replayed after a restart, so it is never sent.
   */
  private recordSwap(
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes,
    ready: Extract<HistorySummaryRecord, { form: "ready" }>
  ): HistorySwapRecord | undefined {
    const swap: HistorySwapRecord = {
      kind: "history-swap",
      thread,
      prefixHash: ready.prefixHash,
      tailHash: hashes.range(ready.boundary, original.length),
      tailMessageHashes: original.slice(ready.boundary).map(messageHash),
      boundary: ready.boundary,
      end: original.length,
      summary: ready.summary,
      decidedAt: new Date().toISOString(),
    };
    const pinned = pinnedPromptIndex(original, ready.boundary);
    if (pinned !== undefined) swap.pinned = pinned;
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
    // A swap recorded earlier for the same prefix is sent on the replay rule:
    // it covers `[0, b)`, and this request reaches its `end`.
    if (stored.kind !== "history-swap" || stored.end > original.length) return undefined;
    return stored;
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

  /**
   * The recorded swap with the largest boundary whose thread and prefix hash
   * match `original`, and whose `end` `original` reaches. Messages `[b, end)`
   * need not hash as recorded: the summary replaces only `[0, b)`, so its
   * bytes are the same either way, and `applySwap` sends the current
   * `[b, end)`. Refusing the swap over a changed tail message would instead
   * resend the whole original prefix and lose the cached summary prefix.
   */
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
      if (!isSafeBoundary(original, record.boundary)) continue;
      if (hashes.prefix(record.boundary) !== record.prefixHash) continue;
      best = record;
    }
    return best;
  }

  /**
   * The largest boundary, at most `atMost`, of any summary of `thread`
   * recorded so far, ready or failed; 0 when there is none.
   */
  private newestSummaryBoundary(sessionId: string, thread: string, atMost: number): number {
    let newest = 0;
    for (const [, record] of this.deps.store.list(sessionId)) {
      if (record.kind !== "history-summary" || record.thread !== thread) continue;
      if (record.boundary <= atMost && record.boundary > newest) newest = record.boundary;
    }
    return newest;
  }

  /** Start one background summary when the request has a new boundary. */
  private maybePrecompute(
    sessionId: string,
    thread: string,
    original: readonly unknown[],
    hashes: MessageHashes,
    currentBoundary: number
  ): boolean {
    if (this.deps.client.disabled || this.deps.client.closed) return false;
    const boundary = summaryBoundary(original);
    if (boundary < 1 || boundary <= currentBoundary) return false;
    const flightKey = `${sessionId}\n${thread}`;
    if (this.inFlight.has(flightKey)) return false;
    if (!isHumanTurnStart(original[boundary])) {
      const newest = this.newestSummaryBoundary(sessionId, thread, boundary);
      if (boundary - newest < MID_TURN_MIN_ADVANCE) return false;
    }
    const prefixHash = hashes.prefix(boundary);
    const key = historyRecordKey("history-summary", sessionId, prefixHash);
    if (this.deps.store.get(sessionId, key)) return false;

    const previous = this.bestSummary(sessionId, thread, original, hashes, 0, boundary - 1);
    // Rendered now, while the messages are this request's: the handler that
    // runs next may change the body.
    const rendered = renderMessages(original, previous?.boundary ?? 0, boundary);
    const user = summaryRequestText(rendered, previous?.summary);
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const job = this.runSummary({
      sessionId,
      thread,
      key,
      prefixHash,
      boundary,
      user,
      ...(previous ? { basedOn: previous.prefixHash } : {}),
    })
      .then(() => {
        this.summaryLatency.set(sessionId, Math.max(0, now() - startedAt));
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
    // Cut short by shutdown: no decision about this boundary was made, so
    // nothing is recorded and a later process may still summarise it.
    if (!result.ok && result.cancelled) return;
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
          ...(result.usage
            ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }
            : {}),
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

/** Log a new swap, and whether it was sent inside a turn. */
function logSwap(sessionId: string, swap: HistorySwapRecord, original: readonly unknown[]): void {
  const midTurn = !isHumanTurnStart(original[original.length - 1]);
  log(
    `[compaction] history swap in session ${sessionId}${midTurn ? " mid-turn, after a complete tool round" : ""}: messages 0..${swap.boundary} replaced by a summary of ${swap.summary.length} characters`
  );
}

/** Log the count a request was measured with and where it came from. */
function logCount(sessionId: string, count: RequestCount, limit: number): void {
  const from =
    count.source === "usage"
      ? `usage ${count.measured} + ~${count.added} appended since`
      : count.source === "calibrated"
        ? "calibrated from the session's measured characters per token"
        : "estimated at 4 characters per token, no usage yet";
  log(
    `[compaction] session ${sessionId}: history count ${count.tokens} of ${limit} tokens (${from})`
  );
}

/**
 * True when a message of a replayed swap's `[b, end)` differs from the
 * recorded one, by `messageHash`, so the swap request's newest message
 * coming back as a string is not a change. A record without per-message
 * hashes compares the whole `[b, end)`.
 */
function tailChanged(
  swap: HistorySwapRecord,
  original: readonly unknown[],
  hashes: MessageHashes
): boolean {
  const recorded = swap.tailMessageHashes;
  if (!Array.isArray(recorded) || recorded.length !== swap.end - swap.boundary) {
    return hashes.range(swap.boundary, swap.end) !== swap.tailHash;
  }
  for (let i = swap.boundary; i < swap.end; i++) {
    if (messageHash(original[i]) !== recorded[i - swap.boundary]) return true;
  }
  return false;
}

/**
 * Log which messages of a replayed swap's `[b, end)` differ from the recorded
 * ones, by the first 12 hex of each message's hash. No message content.
 */
function logTailChange(
  sessionId: string,
  swap: HistorySwapRecord,
  original: readonly unknown[]
): void {
  const short = (h: unknown) => String(h).slice(0, 12);
  const recorded = Array.isArray(swap.tailMessageHashes)
    ? swap.tailMessageHashes.map(short).join(",")
    : "unknown";
  const current = original
    .slice(swap.boundary, swap.end)
    .map((m) => short(messageHash(m)))
    .join(",");
  log(
    `[compaction] session ${sessionId}: history replayed at ${swap.boundary}, tail changed: recorded [${recorded}] current [${current}]`
  );
}

function messagesOf(payload: unknown): unknown[] | undefined {
  const messages = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length < 2) return undefined;
  if (!messages.every((m) => !!m && typeof m === "object")) return undefined;
  return messages;
}
