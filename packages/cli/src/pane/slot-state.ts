/**
 * The pane lifecycle as a transition table over INTERNAL phases (architecture §2.2,
 * D7), plus the one function that turns a phase into a contract `SlotState`.
 *
 * Phases make "booting vs. prompt in flight" and "idle vs. blocked on a question" legal-
 * transition distinctions instead of flags, while the wire keeps the frozen nine states.
 * Illegal transitions are refused and recorded by the caller — `nextPhase` returns null
 * and never throws — and terminals absorb: a late pane `exit` can never overturn a
 * CANCELLED or TIMEOUT already recorded.
 */

import type { SlotState } from "./contract.js";

export type Phase =
  | "BOOTING" // pane spawned, Claude Code not yet at an empty input box
  | "ADMITTING" // a prompt is being delivered / awaiting its acceptance witness
  | "RUNNING" // accepted turn in progress (incl. Stop hooks and background agents)
  | "IDLE" // interactive session between turns, input box empty
  | "QUESTION" // turn blocked on a pending AskUserQuestion
  | "PERMISSION" // turn blocked on a permission / plan-approval dialog
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "EMPTY";

export type PhaseEvent =
  | "boot_ready_idle"
  | "boot_ready_admit"
  | "boot_dialog"
  | "boot_blocked"
  | "boot_deadline"
  | "admit" // pump starts delivering a queued prompt (IDLE only)
  | "prompt_accepted" // witness found after the turn's offset
  | "admit_deadline" // first prompt never accepted → FAILED prompt_not_accepted
  | "admit_abandoned" // a later prompt never accepted → back to IDLE (anomaly, frame meta)
  | "blocked_question"
  | "blocked_permission"
  | "unblocked"
  | "turn_continue" // decide() returned "continue"
  | "rewake" // interactive IDLE: a background notification woke the model (D23)
  | "verdict_completed"
  | "verdict_empty"
  | "verdict_failed"
  | "exit_clean" // interactive child exited 0 while IDLE after a requested /exit or ≥ 1 settled turn
  | "pane_exit"
  | "pane_lost"
  | "cancel"
  | "timeout";

export const PHASES: readonly Phase[] = [
  "BOOTING",
  "ADMITTING",
  "RUNNING",
  "IDLE",
  "QUESTION",
  "PERMISSION",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "EMPTY",
];

export const TERMINAL_PHASES: readonly Phase[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "EMPTY",
];

const ANY_LIVE = {
  pane_exit: "FAILED",
  pane_lost: "FAILED",
  cancel: "CANCELLED",
  timeout: "TIMEOUT",
} as const;

export const TRANSITIONS = {
  BOOTING: {
    boot_ready_idle: "IDLE",
    boot_ready_admit: "ADMITTING",
    boot_dialog: "FAILED",
    boot_blocked: "FAILED",
    boot_deadline: "FAILED",
    ...ANY_LIVE,
  },
  ADMITTING: {
    prompt_accepted: "RUNNING",
    admit_deadline: "FAILED",
    admit_abandoned: "IDLE",
    ...ANY_LIVE,
  },
  RUNNING: {
    blocked_question: "QUESTION",
    blocked_permission: "PERMISSION",
    turn_continue: "IDLE",
    verdict_completed: "COMPLETED",
    verdict_empty: "EMPTY",
    verdict_failed: "FAILED",
    ...ANY_LIVE,
  },
  IDLE: { admit: "ADMITTING", rewake: "RUNNING", exit_clean: "COMPLETED", ...ANY_LIVE },
  QUESTION: { unblocked: "RUNNING", verdict_failed: "FAILED", ...ANY_LIVE },
  PERMISSION: { unblocked: "RUNNING", verdict_failed: "FAILED", ...ANY_LIVE },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
  TIMEOUT: {},
  EMPTY: {},
} as const satisfies Record<Phase, Partial<Record<PhaseEvent, Phase>>>;

/** The phase `ev` leads to from `from`, or null when the table has no such edge. */
export function nextPhase(from: Phase, ev: PhaseEvent): Phase | null {
  const row = TRANSITIONS[from] as Partial<Record<PhaseEvent, Phase>>;
  return row[ev] ?? null;
}

export function isTerminalPhase(p: Phase): boolean {
  return TERMINAL_PHASES.includes(p);
}

/**
 * The only place a phase becomes a contract SlotState. Keyed on the delivery, not the
 * turn index (X-M1): `initialDelivery` is true only while the prompt the session was
 * CREATED with is being admitted, so a promptless session's first send goes
 * AWAITING_INPUT → RUNNING and never back to STARTING.
 */
export function wireState(p: Phase, initialDelivery: boolean): SlotState {
  switch (p) {
    case "BOOTING":
      return "STARTING";
    case "ADMITTING":
      return initialDelivery ? "STARTING" : "RUNNING";
    case "RUNNING":
      return "RUNNING";
    case "IDLE":
    case "QUESTION":
      return "AWAITING_INPUT";
    case "PERMISSION":
      return "AWAITING_PERMISSION";
    default:
      return p;
  }
}
