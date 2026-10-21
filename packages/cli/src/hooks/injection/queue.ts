/**
 * The injection queue policy (architecture §7.2, §4.7 rules 1-7). Pure: every
 * function takes the state and returns a decision or a new state, with the clock
 * passed in. `PaneSession` owns one state and applies what `next` decides.
 *
 * Two item kinds share one queue:
 *
 * - `caller`: `send_input` text (or a session's initial prompt). Always first.
 *   It is the only kind that may press Esc on a dialog (D17, unchanged).
 * - `hook`: an injection a hook returned. Delivered only in IDLE, never over a
 *   dialog or a running turn. It goes STALE once a caller turn is admitted after
 *   it was queued: staleness is counted in caller admissions (`callerSeq`), so a
 *   `sessionStart` injection, queued after the initial prompt started admission,
 *   survives that prompt.
 *
 * At one idle every live hook item merges into ONE turn: texts joined with
 * "\n\n" in queue order, exact duplicates once. The merged text is checked
 * against the delivery rules BEFORE admission; one that cannot be delivered is
 * dropped `delivery_unavailable` and never retried.
 */

import type { Phase } from "../../pane/slot-state.js";

/** An injection delivered more than this long after it was queued is dropped `expired`. */
export const INJECTION_EXPIRY_MS = 10 * 60_000;

/** Where a hook item came from; decides merge order and how drops are journaled. */
export type InjectionSource = "sessionStart" | "proxy" | "sessionIdle";

export type QueueItem =
  | { kind: "caller"; text: string }
  | {
      kind: "hook";
      text: string;
      hookIds: string[];
      queuedAt: number;
      /** `callerAdmitted` when the item was queued; stale once a later caller turn is admitted */
      callerSeq: number;
      source?: InjectionSource;
    };

export type HookQueueItem = Extract<QueueItem, { kind: "hook" }>;

export interface InjectionQueueState {
  items: QueueItem[];
  /** caller/human turns admitted so far, the initial prompt included */
  callerAdmitted: number;
  consecutiveHookTurns: number;
  maxConsecutive: number;
}

export type DropReason = "stale" | "expired" | "capped" | "delivery_unavailable";

export interface NextResult {
  /** the item to admit now: the first caller item, or the merged hook item */
  deliver?: QueueItem;
  /** hook items removed without delivery, with why */
  drop: Array<{ item: HookQueueItem; reason: DropReason }>;
  /** Esc a dialog: only a CALLER item does that, and only in QUESTION / PERMISSION */
  pressEscape: boolean;
  /** the queue after this decision: `deliver` and every dropped or merged item removed */
  remaining: QueueItem[];
}

export function emptyQueueState(maxConsecutive: number): InjectionQueueState {
  return { items: [], callerAdmitted: 0, consecutiveHookTurns: 0, maxConsecutive };
}

export function callerCount(state: InjectionQueueState): number {
  let n = 0;
  for (const i of state.items) if (i.kind === "caller") n++;
  return n;
}

export function hookCount(state: InjectionQueueState): number {
  return state.items.length - callerCount(state);
}

/** A hook item is stale once a caller turn was admitted after it was queued. */
export function isStale(state: InjectionQueueState, item: HookQueueItem): boolean {
  return state.callerAdmitted > item.callerSeq;
}

/**
 * Decide what the queue does now. Delivery happens only in IDLE; in a dialog only
 * the Esc decision is made. Pure: the caller replaces `state.items` with
 * `remaining` (and, when it admits `deliver`, applies `afterAdmission`).
 */
export function next(
  state: InjectionQueueState,
  now: number,
  phase: Phase,
  canDeliver: (text: string) => boolean
): NextResult {
  const firstCaller = state.items.find((i) => i.kind === "caller");
  if (phase === "QUESTION" || phase === "PERMISSION") {
    return { drop: [], pressEscape: firstCaller !== undefined, remaining: state.items };
  }
  if (phase !== "IDLE") return { drop: [], pressEscape: false, remaining: state.items };

  if (firstCaller) {
    return {
      deliver: firstCaller,
      drop: [],
      pressEscape: false,
      remaining: state.items.filter((i) => i !== firstCaller),
    };
  }

  const drop: NextResult["drop"] = [];
  const live: HookQueueItem[] = [];
  const overCap = state.consecutiveHookTurns >= state.maxConsecutive;
  for (const item of state.items) {
    if (item.kind !== "hook") continue;
    if (isStale(state, item)) drop.push({ item, reason: "stale" });
    else if (now - item.queuedAt > INJECTION_EXPIRY_MS) drop.push({ item, reason: "expired" });
    else if (overCap) drop.push({ item, reason: "capped" });
    else live.push(item);
  }
  if (live.length === 0) return { drop, pressEscape: false, remaining: [] };

  const merged = mergeHookItems(live);
  if (!canDeliver(merged.text)) {
    for (const item of live) drop.push({ item, reason: "delivery_unavailable" });
    return { drop, pressEscape: false, remaining: [] };
  }
  return { deliver: merged, drop, pressEscape: false, remaining: [] };
}

/** Every live hook item as one: queue order, "\n\n", exact duplicates once. */
export function mergeHookItems(items: ReadonlyArray<HookQueueItem>): HookQueueItem {
  const texts: string[] = [];
  const hookIds: string[] = [];
  for (const item of items) {
    if (!texts.includes(item.text)) texts.push(item.text);
    for (const id of item.hookIds) if (!hookIds.includes(id)) hookIds.push(id);
  }
  const first = items[0] as HookQueueItem;
  return {
    kind: "hook",
    text: texts.join("\n\n"),
    hookIds,
    queuedAt: Math.min(...items.map((i) => i.queuedAt)),
    callerSeq: Math.max(...items.map((i) => i.callerSeq)),
    ...(items.length === 1 && first.source ? { source: first.source } : {}),
  };
}

/**
 * The counters after an item was taken off the queue for admission (L1): a caller
 * turn counts as admitted and resets the hook-turn run; a hook item extends it.
 * An admission that is later abandoned still counts.
 */
export function afterAdmission(
  state: InjectionQueueState,
  item: QueueItem
): Pick<InjectionQueueState, "callerAdmitted" | "consecutiveHookTurns"> {
  return item.kind === "caller"
    ? { callerAdmitted: state.callerAdmitted + 1, consecutiveHookTurns: 0 }
    : {
        callerAdmitted: state.callerAdmitted,
        consecutiveHookTurns: state.consecutiveHookTurns + 1,
      };
}
