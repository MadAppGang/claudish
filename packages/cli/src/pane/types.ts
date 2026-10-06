/**
 * Shapes shared between the pure pane core (this phase) and `PaneSession` (architecture
 * §2.9): what a settled turn hands its owner, the owner's verdict, and the in-memory
 * snapshot every polling verb reads.
 */

import type { FailureReason, SlotState } from "./contract.js";
import type { Delivery } from "./prompt-delivery.js";
import type { SettledBy } from "./settle-rule.js";
import type { Phase } from "./slot-state.js";
import type { TurnView } from "./transcript-follower.js";

export interface SettledTurn {
  index: number;
  answer: string;
  apiError: TurnView["apiError"];
  stopReason: string | null;
  captureSource: "transcript" | "screen" | "none";
  settledBy: SettledBy | "screen";
  /** the session's shape at the moment of the settle: a send converts one-shot to interactive
   * before its own evaluation, so an owner reads this, never a copy it holds */
  shape: "one-shot" | "interactive";
  /** owners map `complete === false` → prompt_not_read */
  delivery: {
    mode: Delivery["mode"];
    linesTotal: number | null;
    linesRead: number | null;
    complete: boolean | null;
    preambleBytes: number;
  };
}

export interface FinalVerdict {
  state: "COMPLETED" | "EMPTY" | "FAILED";
  reason?: FailureReason;
  detail?: string;
}

export interface PaneSnapshot {
  paneId: string;
  phase: Phase;
  state: SlotState;
  reason: FailureReason | null;
  detail: string | null;
  activity: string | null;
  lastActivityAt: string | null;
  idleSeconds: number | null;
  turnsCompleted: number;
  /** from the transcript (main chain + subagents, once per message.id); null = no source yet */
  tokensIn: number | null;
  tokensOut: number | null;
  toolCalls: number;
  liveAnswerBytes: number;
  exitCode: number | null;
  captureSource: SettledTurn["captureSource"] | null;
  turnSource: "transcript" | "screen";
  pendingInputs: number;
  connected: boolean;
  startedAt: string;
  endedAt: string | null;
  transcriptPath: string;
  panePid: number | null;
  screenTail: string;
  anomalies: string[];
  /** the child's Claude Code version, read from its boot banner (R3-M4); null until seen */
  claudeCodeVersion: string | null;
  /** the session's shape now: a send to a one-shot session converts it to interactive */
  shape: "one-shot" | "interactive";
  /**
   * R3-M4, LIVE: the turn is `finishing` with a static screen and no Stop-hook UI for 3
   * secondary windows. False again as soon as activity leaves `finishing`; the anomaly of
   * the same name stays in `anomalies` as history.
   */
  turnEndRecordMissing: boolean;
}
