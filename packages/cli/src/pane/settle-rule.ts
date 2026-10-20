/**
 * The settle rule (architecture §2.8, D14), as one pure decision over the current
 * turn's transcript facts and the screen.
 *
 * A turn is settled by Claude Code's OWN end-of-turn evidence, turn-scoped:
 *
 *   P  `turn_duration` after the last assistant message with no background agent
 *      pending. Claude Code writes it only after Stop hooks finish (captured: 30,077 ms
 *      after the answer with a `sleep 30` Stop hook), so P waits for hooks by construction.
 *   I  `[Request interrupted by user…]` after the last assistant message. `turn_duration`
 *      is optional: a declined dialog writes one, Esc on a running Bash does not, a plain
 *      interrupt does not (all captured).
 *   S  no `turn_duration`, no interrupt: an ending `stop_reason`, Stop hooks KNOWN to be
 *      finished, and full quiet for `secondaryQuietMs`. A running Stop hook can never
 *      satisfy S: until its summary is written there is none, and the screen's working
 *      row is rewritten every second while it runs.
 *   X  only when the pane has exited: an ending `stop_reason` and nothing waking after it.
 *   L  a LOCAL slash command (`/compact`, `/model x`): its `<local-command-stdout>` after
 *      the witness and no assistant message. Claude Code writes neither an assistant record
 *      nor `turn_duration` for one (captured, 2.1.290 and 2.1.291).
 *
 * Nothing here is a timer that ends work (D10): S's window only confirms an ending that
 * has already happened, and an unsettled turn just reports its `activity`.
 *
 * Corroboration (architecture-v2 §7.1, R1.5.1) reads magmux's input gate, not the box: an
 * ending is clean when the gate is ready (which already means an EMPTY box), names no
 * dialog, and no working row is drawn above the box located by the cursor. Corroboration
 * can DELAY a transcript-proven ending, never veto it: after `corroborationGraceMs` of chat
 * quiet the turn settles anyway, with `settle_gate_unconfirmed:<why>`. That window confirms
 * an ending Claude Code already recorded, the same standing as S's window, so D10 holds.
 */

import type { SessionFacts, TurnView } from "./transcript-follower.js";

/**
 * `max(15 000, 2 × p99)` of the `stop_hook_summary` → next main-chain assistant gap after
 * an `end_turn`, over 3,001 local transcripts (1,944 cases, p99 15,832 ms → 31,664 ms),
 * rounded up. Measured 2026-10-06; see phase2-captures.md §5.
 */
export const SECONDARY_QUIET_MS = 32_000;

/** No further main-chain chat record for this long before a P/I/S settle is corroborated. */
export const CORROBORATION_MS = 500;

/** Stop reasons the harness itself continues; they never end a turn except through I. */
const CONTINUING = new Set(["tool_use", "pause_turn"]);

/**
 * The most corroboration may delay a transcript-proven ending (Jack's decision J2, R1.6):
 * the secondary window, so a gate that cannot confirm idle costs at most what S costs.
 */
export const CORROBORATION_GRACE_MS = SECONDARY_QUIET_MS;

/** What the gate and the screen say at a candidate ending (architecture-v2 §3.2, R1.5.1). */
export interface CorroborationFacts {
  /**
   * magmux's published input gate; null when its last reading is stale. `ready` already
   * means the box is empty: the published view refuses `box_not_empty` (R1.5.1).
   */
  gate: { ready: boolean; dialog: string | null; reason: string | null } | null;
  /** a working row above the LOCATED box; null when the box is not located (never a veto) */
  working: boolean | null;
  /** ms since a row above the located box last changed; null when the box is not located */
  aboveBoxQuietMs: number | null;
}

export interface SettleInput {
  turn: TurnView | null;
  session: SessionFacts;
  /** ms since the last append to the main transcript or any subagent file */
  transcriptQuietMs: number;
  /** ms since this turn's last main-chain chat record was READ (corroboration window) */
  chatQuietMs: number;
  /** null while the socket is disconnected: the in-memory screen and the gate are stale */
  facts: CorroborationFacts | null;
  paneExited: boolean;
  secondaryQuietMs?: number;
  corroborationMs?: number;
  /** default CORROBORATION_GRACE_MS */
  corroborationGraceMs?: number;
}

export type SettledBy = "turn_duration" | "interrupt" | "quiet" | "exit" | "local_command";

export type SettleDecision =
  | { settled: true; by: SettledBy; stopReason: string | null; anomalies: string[] }
  | { settled: false; activity: string };

function agentsBalanced(t: TurnView): boolean {
  return t.agentsLaunched === t.agentsCompleted;
}

function endingStop(t: TurnView): boolean {
  const la = t.lastAssistant;
  if (!la) return false;
  return la.isApiError || !CONTINUING.has(la.stopReason ?? "");
}

/** Stop hooks are known to be finished (S's gate). */
function stopHooksFinished(t: TurnView, s: SessionFacts): boolean {
  const la = t.lastAssistant;
  if (!la) return false;
  // Stop hooks do not run after an API error (captured, s10) or a refusal (corpus).
  return (
    t.stopHookSummaryAfterLast || s.provenHookless || la.isApiError || la.stopReason === "refusal"
  );
}

function activityOf(t: TurnView | null): string {
  if (!t || !t.lastAssistant) return "thinking";
  if (t.pendingTool) return t.pendingTool.name || "thinking";
  if (t.wakingAfterLast) return "thinking";
  const pending = t.turnDurationAfterLast?.pendingBackgroundAgentCount ?? 0;
  if ((t.turnDurationAfterLast && pending > 0) || (t.turnDurationAfterLast && !agentsBalanced(t)))
    return "background";
  if (endingStop(t)) return "finishing";
  return "thinking";
}

/**
 * Why the gate does not confirm idle, or null when it does (R1.5.1). A stale gate reading
 * is unknown; an unlocated box (`working: null`) is not a reason.
 */
function unconfirmedBy(f: CorroborationFacts): string | null {
  const g = f.gate;
  if (g === null) return "gate_unknown";
  if (!g.ready || g.dialog !== null) return (g.reason ?? "not_ready").slice(0, 48);
  if (f.working === true) return "working";
  return null;
}

function corroborated(input: SettleInput): { ok: boolean; anomaly?: string } {
  const quiet = input.corroborationMs ?? CORROBORATION_MS;
  if (input.chatQuietMs < quiet) return { ok: false };
  if (!input.facts) return { ok: true, anomaly: "screen_unverified" };
  const why = unconfirmedBy(input.facts);
  if (why === null) return { ok: true };
  // never a permanent veto: an ending the transcript proved settles after the grace
  if (input.chatQuietMs >= (input.corroborationGraceMs ?? CORROBORATION_GRACE_MS))
    return { ok: true, anomaly: `settle_gate_unconfirmed:${why}` };
  return { ok: false };
}

type Path = SettleDecision | null; // null = this path does not apply / not yet

function settledAs(
  by: SettledBy,
  stopReason: string | null,
  c: { anomaly?: string },
  extra: string[] = []
): SettleDecision {
  return {
    settled: true,
    by,
    stopReason,
    anomalies: [...(c.anomaly ? [c.anomaly] : []), ...extra],
  };
}

/** I — interrupt (resolves the pending tool; turn_duration optional). */
function pathInterrupt(input: SettleInput): Path {
  const c = corroborated(input);
  return c.ok ? settledAs("interrupt", "interrupted", c) : null;
}

/** L — a local command's stdout (corroborated like P; no screen once the pane exited). */
function pathLocalCommand(input: SettleInput): Path {
  if (input.paneExited) return settledAs("local_command", null, {});
  const c = corroborated(input);
  return c.ok ? settledAs("local_command", null, c) : null;
}

/** P — turn_duration with no background agent pending. */
function pathPrimary(t: TurnView, input: SettleInput): Path {
  const td = t.turnDurationAfterLast;
  if (!td) return null;
  const pending = td.pendingBackgroundAgentCount ?? 0;
  if (pending !== 0 || !agentsBalanced(t)) return null;
  const c = corroborated(input);
  return c.ok ? settledAs("turn_duration", t.lastAssistant?.stopReason ?? null, c) : null;
}

/** S — no turn_duration: Stop hooks known finished and full quiet for the secondary window. */
function pathSecondary(t: TurnView, input: SettleInput): Path {
  if (!endingStop(t) || !stopHooksFinished(t, input.session)) return null;
  if (!input.facts) return null; // S waits for the reconnect
  const window = input.secondaryQuietMs ?? SECONDARY_QUIET_MS;
  if (input.transcriptQuietMs < window) return null;
  // box not located: the transcript's quiet decides alone (S is already gated on Stop hooks)
  const above = input.facts.aboveBoxQuietMs;
  if (above !== null && above < window) return null;
  const c = corroborated(input);
  return c.ok
    ? settledAs("quiet", t.lastAssistant?.stopReason ?? null, c, ["settled_without_turn_duration"])
    : null;
}

/**
 * claudish's pending background agents disagreeing with Claude Code's own count at the
 * turn's end record. Claude Code writes `pendingBackgroundAgentCount` only above 0, so
 * absent means 0. A witness, never a decider (D23): session 779a03f0 counted 2 pending
 * where Claude Code reported 0, and nothing said so.
 */
export function agentCountMismatch(
  t: TurnView | null
): { counted: number; reported: number } | null {
  if (!t || !t.turnDurationAfterLast || t.wakingAfterLast) return null;
  const counted = t.agentsLaunched - t.agentsCompleted;
  const reported = t.turnDurationAfterLast.pendingBackgroundAgentCount ?? 0;
  return counted === reported ? null : { counted, reported };
}

export function decideSettle(input: SettleInput): SettleDecision {
  const t = input.turn;
  const notYet: SettleDecision = { settled: false, activity: activityOf(t) };
  if (t && t.acceptedAt !== null && !t.lastAssistant && t.localCommandOutput !== null)
    return pathLocalCommand(input) ?? notYet;
  // 1. accepted, with an assistant message after the witness; 2. nothing waking after it
  if (!t || t.acceptedAt === null || !t.lastAssistant || t.wakingAfterLast) return notYet;
  if (t.interruptAfterLast) return pathInterrupt(input) ?? notYet;
  // 4. no pending tool, background agents balanced
  if (t.pendingTool) return notYet;
  if (t.turnDurationAfterLast) return pathPrimary(t, input) ?? notYet;
  if (!agentsBalanced(t)) return notYet;
  // X — exit (pane dead: no screen corroboration)
  if (input.paneExited)
    return endingStop(t) ? settledAs("exit", t.lastAssistant.stopReason, {}) : notYet;
  return pathSecondary(t, input) ?? notYet;
}
