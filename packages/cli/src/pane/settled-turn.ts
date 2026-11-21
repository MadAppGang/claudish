/**
 * The settled turn's core, built from the transcript follower's `TurnView` and the settle
 * decision: what `PaneSession` hands its owner's `decide` (with the chain fields added). Pure,
 * so the join from transcript records to the verdict's inputs is testable with no pane.
 */

import type { Delivery } from "./prompt-delivery.js";
import type { SettleDecision } from "./settle-rule.js";
import type { TurnView } from "./transcript-follower.js";
import type { SettledTurn } from "./types.js";

/** A settled turn before the chain fields are added (§4.10). */
export type TurnCore = Omit<
  SettledTurn,
  "chainAnswers" | "chainDelivery" | "hookTurns" | "hookCaused"
>;

/**
 * The core of a turn that settled on the transcript. `delivery` is the plan the turn's prompt
 * was delivered by; `shape` the session's shape at the settle. `unverified` is set for a
 * file-carrying COMMAND turn with zero Reads (R3-M3): its text went to the command's own
 * expansion, which may never Read the pointer file, so its coverage is unknown rather than
 * failed (`complete: null`, never prompt_not_read).
 */
export function settledTurnCoreOf(
  t: TurnView,
  decision: SettleDecision & { settled: true },
  ctx: { delivery: Delivery | null; shape: SettledTurn["shape"] }
): { core: TurnCore; unverified: boolean } {
  const d = ctx.delivery;
  const unverified = d?.mode === "command" && !!t.delivery && t.readCoverage.reads === 0;
  const local = decision.by === "local_command";
  const core: TurnCore = {
    index: t.index,
    // a local command's answer is its own stdout: it has no assistant message (path L)
    answer: local ? (t.localCommandOutput ?? "") : t.assistantText.join("\n\n"),
    ...(local || !t.lastResponseEnd ? {} : { lastResponseEnd: t.lastResponseEnd }),
    acceptedAt: t.acceptedAt,
    apiError: t.apiError,
    stopReason: decision.stopReason,
    captureSource: "transcript",
    settledBy: decision.by,
    shape: ctx.shape,
    delivery: {
      mode: d && d.mode !== "refused" ? d.mode : "typed",
      linesTotal: t.delivery ? t.delivery.lines : null,
      linesRead: t.delivery ? t.readCoverage.linesReturned : null,
      complete: t.delivery && !unverified ? t.readCoverage.complete : null,
      preambleBytes: t.preambleBytes,
    },
    writtenFiles: local ? [] : t.writtenFiles,
  };
  return { core, unverified };
}
