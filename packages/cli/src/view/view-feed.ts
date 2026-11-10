/**
 * The in-process status stream: owners say a target changed, subscribers get full rows.
 *
 * Stage two of the change gate lives here. A flush builds the target's row once and compares it,
 * without the three clock-derived fields, against the last row published. An equal row publishes
 * nothing; a row that differs only in `last_activity_at` publishes at most once per 5 s, the last
 * one when that window ends. Nothing runs while nothing changes: every timer is armed by a change.
 */

import { log } from "../logger.js";
import type { ViewItem, ViewRemoveReason } from "../pane/view-contract.js";

export type ViewFeedEvent =
  | { event: "upsert"; item: ViewItem }
  | { event: "remove"; target: string; reason: ViewRemoveReason };

export type ViewFeedListener = (event: ViewFeedEvent) => void;

export const FEED_DEBOUNCE_MS = 250;
export const ACTIVITY_PUBLISH_MS = 5_000;

export interface ViewFeedOptions {
  debounceMs?: number;
  activityPublishMs?: number;
  now?: () => number;
}

interface Published {
  stable: string;
  lastActivityAt: string | null;
  at: number;
}

function gateFields(item: ViewItem): { stable: string; lastActivityAt: string | null } {
  if (item.kind === "replay") return { stable: JSON.stringify(item), lastActivityAt: null };
  const { idle_seconds: _idle, last_activity_at: lastActivityAt, ...rest } = item;
  const { elapsed_seconds: _elapsed, ...stable } = rest as typeof rest & {
    elapsed_seconds?: number;
  };
  return { stable: JSON.stringify(stable), lastActivityAt };
}

export class ViewFeed {
  private build: (target: string) => ViewItem | null = () => null;
  private readonly listeners = new Set<ViewFeedListener>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly published = new Map<string, Published>();
  private readonly debounceMs: number;
  private readonly activityPublishMs: number;
  private readonly now: () => number;

  constructor(options: ViewFeedOptions = {}) {
    this.debounceMs = options.debounceMs ?? FEED_DEBOUNCE_MS;
    this.activityPublishMs = options.activityPublishMs ?? ACTIVITY_PUBLISH_MS;
    this.now = options.now ?? Date.now;
  }

  /** The row builder; set once, after the owners that notify have been constructed. */
  setBuilder(build: (target: string) => ViewItem | null): void {
    this.build = build;
  }

  /** `urgent` flushes now; otherwise the target flushes once, 250 ms after its first change. */
  changed(target: string, urgent = false): void {
    if (this.listeners.size === 0) return;
    if (urgent) {
      this.cancelTimer(target);
      this.flush(target);
      return;
    }
    this.arm(target, this.debounceMs);
  }

  /** One pending flush per target; an armed one is kept. */
  private arm(target: string, ms: number): void {
    if (this.timers.has(target)) return;
    const timer = setTimeout(() => {
      this.timers.delete(target);
      this.flush(target);
    }, ms);
    timer.unref?.();
    this.timers.set(target, timer);
  }

  removed(target: string, reason: ViewRemoveReason): void {
    this.cancelTimer(target);
    this.published.delete(target);
    this.emit({ event: "remove", target, reason });
  }

  /** The returned function unsubscribes. With no listener left the gate forgets what it sent. */
  subscribe(listener: ViewFeedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      for (const target of [...this.timers.keys()]) this.cancelTimer(target);
      this.published.clear();
    };
  }

  /**
   * A snapshot has just shown these rows to a subscriber, so an identical row need not follow it.
   * A row the gate already holds stays: another subscriber may not have seen this one. Neither is a
   * row with a change pending: the subscribers already listening have not been sent it yet.
   */
  noteDelivered(items: readonly ViewItem[]): void {
    for (const item of items) {
      if (this.published.has(item.target) || this.timers.has(item.target)) continue;
      this.published.set(item.target, { ...gateFields(item), at: this.now() });
    }
  }

  private cancelTimer(target: string): void {
    const timer = this.timers.get(target);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(target);
  }

  private flush(target: string): void {
    let item: ViewItem | null;
    try {
      item = this.build(target);
    } catch (e) {
      log(`[view] row build failed for ${target}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // not resolvable yet: the owner's registration notify raises it again
    if (!item) return;
    const { stable, lastActivityAt } = gateFields(item);
    const last = this.published.get(target);
    const now = this.now();
    if (last && last.stable === stable) {
      if (last.lastActivityAt === lastActivityAt) return;
      if (now - last.at < this.activityPublishMs) {
        // once the window ends, the newest activity time goes out even if nothing else changes
        this.arm(target, this.activityPublishMs - (now - last.at));
        return;
      }
    }
    this.published.set(target, { stable, lastActivityAt, at: now });
    this.emit({ event: "upsert", item });
  }

  private emit(event: ViewFeedEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (e) {
        log(`[view] feed listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
