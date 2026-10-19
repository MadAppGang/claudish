/**
 * Turn records: the exact ordered Responses items of one downstream Claude
 * message across all its upstream legs — reasoning, commentary messages,
 * interstitial `custom_tool_call` + output pairs, the final leg's preceding
 * items — so the next request replays them verbatim instead of the lossy view
 * Claude Code's message keeps. A record ENDS BEFORE the final
 * `custom_tool_call` when the message ended on nested calls: that call belongs
 * to its exec group, which the input builder emits exactly once.
 *
 * Keyed by `(sessionKey, anchor)`. The anchor is the message's first tool_use
 * id when it has one, else a hash of the session, the message it answered and
 * its text blocks (`turnAnchorFor`), so two turns ending in the same short
 * text after different prompts never share an anchor.
 *
 * Byte ceiling the model cannot raise (architecture §5.8): ≤ 2,000 records AND
 * ≤ 32 MiB, counted as the UTF-8 length of `JSON.stringify(items)` at insert; a
 * single record over 8 MiB is never stored (logged). Eviction is LRU by last
 * render; an evicted anchor goes to a bounded FIFO set so the input builder
 * renders that message from Claude Code's view, byte-stably.
 */

import { createHash } from "node:crypto";
import { log } from "../logger.js";
import { canonicalJson } from "./hashes.js";
import type { ClaudeMessage, ResponsesItem } from "./types.js";

export interface TurnRecord {
  sessionKey: string;
  anchor: string;
  items: ResponsesItem[];
  bytes: number;
}

export interface TurnRecordLimits {
  maxRecords: number;
  maxBytes: number;
  maxRecordBytes: number;
  maxEvictedIds: number;
}

export const DEFAULT_TURN_RECORD_LIMITS: TurnRecordLimits = {
  maxRecords: 2_000,
  maxBytes: 32 * 1024 * 1024,
  maxRecordBytes: 8 * 1024 * 1024,
  maxEvictedIds: 20_000,
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function recordKey(sessionKey: string, anchor: string): string {
  return `${sessionKey}\0${anchor}`;
}

/**
 * The anchor of an assistant message: its first tool_use id, else
 * `sha256(sessionKey ‖ sha256(canonical previous message) ‖ text blocks
 * trimmed and joined with "\n")`. `previousMessage` is the user message the
 * assistant message answered — the last message of the request that produced
 * it, which precedes it in every later history.
 */
export function turnAnchorFor(
  sessionKey: string,
  message: ClaudeMessage,
  previousMessage: ClaudeMessage | undefined
): string {
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const block of blocks) {
    if (block.type === "tool_use" && typeof block.id === "string" && block.id) return block.id;
  }
  const texts =
    typeof message.content === "string"
      ? [message.content.trim()]
      : blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => (b.text as string).trim());
  const previous = previousMessage ? sha256Hex(canonicalJson(previousMessage)) : "";
  return sha256Hex(`${sessionKey}\0${previous}\0${texts.join("\n")}`);
}

export class TurnRecords {
  /** Map order is LRU order: a render re-inserts the record at the end. */
  private readonly records = new Map<string, TurnRecord>();
  private readonly evicted = new Set<string>();
  private readonly limits: TurnRecordLimits;
  private totalBytes = 0;

  constructor(opts: { limits?: Partial<TurnRecordLimits> } = {}) {
    this.limits = { ...DEFAULT_TURN_RECORD_LIMITS, ...opts.limits };
  }

  /**
   * Store the items of one downstream message. False (logged) when the record
   * alone exceeds the per-record ceiling; it is then never stored.
   */
  put(sessionKey: string, anchor: string, items: ResponsesItem[]): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(items), "utf8");
    if (bytes > this.limits.maxRecordBytes) {
      log(
        `[CodeMode] turn record ${anchor.slice(0, 16)} is ${bytes} bytes, over the ${this.limits.maxRecordBytes}-byte ceiling; not stored`
      );
      return false;
    }
    const key = recordKey(sessionKey, anchor);
    const existing = this.records.get(key);
    if (existing) {
      this.records.delete(key);
      this.totalBytes -= existing.bytes;
    }
    this.records.set(key, { sessionKey, anchor, items, bytes });
    this.totalBytes += bytes;
    this.evicted.delete(key);
    this.enforceCaps();
    return true;
  }

  /** The record for a message (a render: refreshes its LRU position). */
  get(sessionKey: string, anchor: string): TurnRecord | undefined {
    const key = recordKey(sessionKey, anchor);
    const record = this.records.get(key);
    if (!record) return undefined;
    this.records.delete(key);
    this.records.set(key, record);
    return record;
  }

  /** True when the record was evicted under the caps. */
  isEvicted(sessionKey: string, anchor: string): boolean {
    return this.evicted.has(recordKey(sessionKey, anchor));
  }

  get size(): number {
    return this.records.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.records.clear();
    this.evicted.clear();
    this.totalBytes = 0;
  }

  private enforceCaps(): void {
    let evictedNow = 0;
    while (
      this.records.size > this.limits.maxRecords ||
      (this.totalBytes > this.limits.maxBytes && this.records.size > 0)
    ) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.records.get(oldestKey);
      this.records.delete(oldestKey);
      if (oldest) this.totalBytes -= oldest.bytes;
      this.markEvicted(oldestKey);
      evictedNow++;
    }
    if (evictedNow > 0) {
      log(
        `[CodeMode] turn records over their cap; evicted ${evictedNow} (now ${this.records.size}, ${this.totalBytes} bytes)`
      );
    }
  }

  private markEvicted(key: string): void {
    this.evicted.delete(key);
    this.evicted.add(key);
    while (this.evicted.size > this.limits.maxEvictedIds) {
      const oldest = this.evicted.values().next().value;
      if (oldest === undefined) break;
      this.evicted.delete(oldest);
    }
  }
}
