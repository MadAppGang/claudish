/**
 * One contract `SlotRow` from a pane snapshot and its accounting (architecture §2.12,
 * §8 B). Pure; the polling verbs call it on memory only.
 */

import type { Accounting } from "./accounting.js";
import { type SlotRow, isTerminalState } from "./contract.js";
import type { PaneSnapshot } from "./types.js";

export function toSlotRow(
  id: { slot: string; model: string; spawnModel: string | null },
  snap: PaneSnapshot,
  acct: Accounting,
  now: number = Date.now()
): SlotRow {
  const terminal = isTerminalState(snap.state);
  let idle: number | null = null;
  if (!terminal && snap.lastActivityAt) {
    const t = Date.parse(snap.lastActivityAt);
    if (Number.isFinite(t)) idle = Math.max(0, Math.floor((now - t) / 1000));
  }
  return {
    slot: id.slot,
    model: id.model,
    provider: acct.provider,
    state: snap.state,
    // set on FAILED / EMPTY / CANCELLED / TIMEOUT; null otherwise
    reason: snap.state === "COMPLETED" || !terminal ? null : snap.reason,
    tokens_in: acct.tokensIn,
    tokens_out: acct.tokensOut,
    cost_usd: acct.costUsd,
    tool_calls: acct.toolCalls,
    turns_completed: snap.turnsCompleted,
    last_activity_at: snap.lastActivityAt,
    idle_seconds: idle,
    // R3-M4: the row says so too (§8: an unknown activity value reads as busy)
    activity: terminal
      ? null
      : snap.turnEndRecordMissing && snap.activity
        ? `${snap.activity}: turn_end_record_missing`
        : snap.activity,
    pane: snap.paneId || null,
  };
}
