/**
 * The token count history compaction measures a request with.
 *
 * The proxy's local estimate (`localTokenEstimate`, JSON characters / 4) runs
 * far under the real count on agent work: tool output, code and JSON run
 * nearer 2.5 characters a token, so a 170K-token request reads as about 105K
 * and never reaches the thresholds before Claude Code compacts on its own.
 *
 * So the count comes from the upstream itself. When a response ends, its
 * `usage` (`input_tokens + cache_read_input_tokens +
 * cache_creation_input_tokens`, the whole prompt) is recorded against what
 * that request sent: its thread, its message count, the hash of its last
 * message and its JSON length. The next request of the same thread counts as
 * that real number plus the characters appended since, divided by the
 * characters-per-token ratio the same measurement gave.
 *
 * - **usage**: the thread has a measurement and the request still holds the
 *   measured messages (same count reached, same last measured message).
 * - **calibrated**: no matching measurement; the request's JSON length divided
 *   by the session's most recent measured ratio.
 * - **estimate**: nothing measured in the session yet; `localTokenEstimate`.
 */

import type { AnthropicUsage } from "../handlers/shared/claude-api-usage.js";
import { localTokenEstimate } from "../token-estimate.js";
import type { CacheWriteSplit } from "./cache-prices.js";
import { messageHash } from "./history.js";

/** A measured ratio is kept inside these bounds (characters per token). */
export const MIN_CHARS_PER_TOKEN = 1;
export const MAX_CHARS_PER_TOKEN = 8;

/** At most this many threads are remembered; the oldest go first. */
export const MAX_MEASURED_THREADS = 512;

/** Growth per request is the mean over at most this many recent measurements. */
export const GROWTH_WINDOW = 6;

/** What the swap policy reads about one thread's recent requests. */
export interface ThreadObservation {
  /** Time since the thread's previous request was sent; undefined for the first. */
  gapMs?: number;
  /** Mean prompt growth per request over the recent measurements; undefined below two. */
  growthPerRequest?: number;
  /** The newest measured cache write's split by TTL, if a response reported one. */
  writeSplit?: CacheWriteSplit;
}

/** What one request sent, for the measurement its response brings back. */
export interface UsageMark {
  sessionId: string;
  thread: string;
  /** The thread's send order: a later request of the thread has a larger one. */
  sequence: number;
  messageCount: number;
  lastMessageHash: string;
  chars: number;
}

/** One request's count and where it came from. */
export interface RequestCount {
  tokens: number;
  source: "usage" | "calibrated" | "estimate";
  /** For `usage`: the measured prompt tokens of the earlier request. */
  measured?: number;
  /** For `usage`: the tokens estimated for what was appended since. */
  added?: number;
}

interface Measurement {
  messageCount: number;
  lastMessageHash: string;
  chars: number;
  tokens: number;
}

/** The JSON length of a body, or 0 when it does not serialise. */
export function charsOf(body: unknown): number {
  try {
    return JSON.stringify(body)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** The whole prompt of one response's usage: uncached, cache read and cache write. */
export function promptTokens(usage: AnthropicUsage | undefined): number {
  if (!usage) return 0;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return (
    n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens)
  );
}

function ratioOf(chars: number, tokens: number): number {
  return Math.min(Math.max(chars / tokens, MIN_CHARS_PER_TOKEN), MAX_CHARS_PER_TOKEN);
}

/** The TTL split of a usage's cache write, when it reports one. */
function writeSplitOf(usage: AnthropicUsage | undefined): CacheWriteSplit | undefined {
  const c = usage?.cache_creation;
  if (!c || typeof c !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const split = {
    fiveMinute: n(c.ephemeral_5m_input_tokens),
    oneHour: n(c.ephemeral_1h_input_tokens),
  };
  return split.fiveMinute + split.oneHour > 0 ? split : undefined;
}

/** Set `key` as the newest entry of `map`, dropping the oldest past `MAX_MEASURED_THREADS`. */
function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_MEASURED_THREADS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export class RealTokenCount {
  private readonly byThread = new Map<string, Measurement>();
  private readonly ratioBySession = new Map<string, number>();
  private readonly sentAt = new Map<string, number>();
  private readonly recent = new Map<string, number[]>();
  private readonly splitByThread = new Map<string, CacheWriteSplit>();
  /** The sequence of the newest mark of each thread. */
  private readonly markedSeq = new Map<string, number>();
  /** The sequence of the newest mark of each thread whose usage was recorded. */
  private readonly recordedSeq = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The thread's gap, growth and cache-write split, as of a request about to
   * be sent. Read before `mark`, which records this request's send time.
   */
  observe(sessionId: string, thread: string): ThreadObservation {
    const key = `${sessionId}\n${thread}`;
    const out: ThreadObservation = {};
    const sent = this.sentAt.get(key);
    if (sent !== undefined) out.gapMs = Math.max(0, this.now() - sent);
    const counts = this.recent.get(key);
    if (counts && counts.length >= 2) {
      const growth = (counts[counts.length - 1] - counts[0]) / (counts.length - 1);
      if (growth > 0) out.growthPerRequest = growth;
    }
    const split = this.splitByThread.get(key);
    if (split) out.writeSplit = { ...split };
    return out;
  }

  /** Tokens for `chars` characters of JSON, at the session's measured ratio, else 4. */
  tokensOfChars(sessionId: string, chars: number): number {
    const ratio = this.ratioBySession.get(sessionId) ?? 4;
    return Math.ceil(Math.max(0, chars) / ratio);
  }

  /** Describe what `payload` sends, for `record` once its response ends. Records the send time. */
  mark(sessionId: string, thread: string, payload: unknown, chars = charsOf(payload)): UsageMark {
    const key = `${sessionId}\n${thread}`;
    setBounded(this.sentAt, key, this.now());
    const sequence = (this.markedSeq.get(key) ?? 0) + 1;
    setBounded(this.markedSeq, key, sequence);
    const messages = messagesOf(payload);
    const last = messages[messages.length - 1];
    return {
      sessionId,
      thread,
      sequence,
      messageCount: messages.length,
      lastMessageHash: last === undefined ? "" : messageHash(last),
      chars,
    };
  }

  /** Record the prompt tokens the upstream reported for the request `mark` describes. */
  record(mark: UsageMark, usage: AnthropicUsage | undefined): void {
    const tokens = promptTokens(usage);
    if (tokens <= 0 || mark.chars <= 0 || mark.messageCount === 0) return;
    const key = `${mark.sessionId}\n${mark.thread}`;
    // Overlapping requests: the response of an older request that ends after
    // a newer one's measures an earlier prompt. Its smaller count is not a
    // drop, so it neither replaces the newer measurement nor restarts growth.
    const newest = this.recordedSeq.get(key);
    if (newest !== undefined && mark.sequence < newest) return;
    setBounded(this.recordedSeq, key, mark.sequence);
    setBounded(this.byThread, key, {
      messageCount: mark.messageCount,
      lastMessageHash: mark.lastMessageHash,
      chars: mark.chars,
      tokens,
    });
    setBounded(this.ratioBySession, mark.sessionId, ratioOf(mark.chars, tokens));
    // A drop (a swap, or Claude Code's own compaction) starts the growth window again.
    const previous = this.recent.get(key) ?? [];
    const last = previous[previous.length - 1];
    const counts = last !== undefined && tokens < last ? [tokens] : [...previous, tokens];
    setBounded(this.recent, key, counts.slice(-GROWTH_WINDOW));
    const split = writeSplitOf(usage);
    if (split) setBounded(this.splitByThread, key, split);
  }

  /** The count of `payload`, as it would be sent now. */
  count(
    sessionId: string,
    thread: string,
    payload: unknown,
    chars = charsOf(payload)
  ): RequestCount {
    const m = this.byThread.get(`${sessionId}\n${thread}`);
    if (m) {
      const messages = messagesOf(payload);
      const measured = messages[m.messageCount - 1];
      if (
        messages.length >= m.messageCount &&
        measured !== undefined &&
        messageHash(measured) === m.lastMessageHash
      ) {
        const added = Math.ceil(Math.max(0, chars - m.chars) / ratioOf(m.chars, m.tokens));
        return { tokens: m.tokens + added, source: "usage", measured: m.tokens, added };
      }
    }
    const ratio = this.ratioBySession.get(sessionId);
    if (ratio !== undefined) return { tokens: Math.ceil(chars / ratio), source: "calibrated" };
    return { tokens: localTokenEstimate(payload), source: "estimate" };
  }
}

function messagesOf(payload: unknown): readonly unknown[] {
  const messages = (payload as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? messages : [];
}
