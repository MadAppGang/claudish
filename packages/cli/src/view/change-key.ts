/**
 * Stage one of the status stream's change gate: an in-memory key of a pane snapshot.
 *
 * `PaneSession` calls `onChange` about four times a second on a session doing nothing, so an owner
 * compares this key before it notifies the feed. A field missing here goes stale in every client
 * until the next transition, so a field added to `PaneSnapshot` has to be classified: either it
 * feeds the key, or it is one of the four that deliberately do not (`idleSeconds`, `screenTail`,
 * `liveAnswerBytes`, and the screen's sequence number, which a snapshot does not carry).
 */

import type { PaneSnapshot } from "../pane/types.js";

/** `last_activity_at` reaches clients at most this often. */
export const ACTIVITY_BUCKET_MS = 5_000;

function activityBucket(at: string | null): number | null {
  if (at === null) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? Math.floor(ms / ACTIVITY_BUCKET_MS) : null;
}

export function paneChangeKey(snap: PaneSnapshot): string {
  const recent = snap.recent;
  return JSON.stringify([
    snap.paneId,
    snap.state,
    snap.reason,
    snap.detail,
    snap.activity,
    snap.turnEndRecordMissing,
    snap.agentCountMismatch,
    snap.toolCalls,
    snap.turnsCompleted,
    snap.tokensIn,
    snap.tokensOut,
    snap.pendingInputs,
    snap.pendingHookInputs,
    snap.promptsSent ?? 0,
    snap.subagentsVersion ?? 0,
    snap.connected,
    snap.viewSockPath ?? null,
    snap.exitCode,
    snap.endedAt,
    snap.agent ?? null,
    recent?.length ?? 0,
    recent?.[recent.length - 1]?.at ?? null,
    activityBucket(snap.lastActivityAt),
  ]);
}
