/**
 * The join from transcript records to the verdict, with no pane: the follower folds Claude
 * Code's records into a `TurnView`, `settledTurnCoreOf` carries the fields the verdict needs
 * into the settled turn, and `classifyRunOutput` decides. A turn that narrated, then ended in a
 * response of [prose, marker] under one `message.id`, with the proxy's record of that error, is
 * an `api_error`; dropping `lastResponseEnd` or `acceptedAt` on the way loses it.
 */

import { describe, expect, test } from "bun:test";

import { formatInBandApiError } from "../in-band-api-error.js";
import { classifyRunOutput } from "../team-orchestrator.js";
import type { Delivery } from "./prompt-delivery.js";
import type { SettleDecision } from "./settle-rule.js";
import { settledTurnCoreOf } from "./settled-turn.js";
import { type Rec, transcriptRecords, witnessIndex } from "./test-helpers/transcript-fixtures.js";
import {
  type TurnView,
  applyRecord,
  initialFollowerState,
  openTurnState,
  turnView,
} from "./transcript-follower.js";
import { type SettledTurn, chainAnswerOf } from "./types.js";

const PEAR = "Reply with exactly PEAR and nothing else.";
const MARKER = formatInBandApiError(
  "cyber_policy",
  "This content was flagged for possible cybersecurity risk."
);
const DECISION: SettleDecision & { settled: true } = {
  settled: true,
  by: "turn_duration",
  stopReason: "end_turn",
  anomalies: [],
};

/** The captured pear turn, rewritten into an earlier progress response and a final [prose, marker]. */
function followedTurn(): TurnView {
  const records = transcriptRecords("pear-hookless");
  const state = initialFollowerState((p) => p);
  openTurnState(state, { index: 1, offset: 0, witness: { kind: "text", text: PEAR } });
  let offset = 1;
  const feed = (r: Rec) => applyRecord(state, r, offset++);
  feed(records[witnessIndex("pear-hookless", PEAR)]!);
  const responses = [
    { id: "msg_progress", texts: ["Reading the module first."] },
    { id: "msg_final", texts: ["The handler parses three fields.", MARKER] },
  ];
  for (const [n, resp] of responses.entries()) {
    for (const [k, t] of resp.texts.entries()) {
      const rec = structuredClone(records[19]!);
      rec.uuid = `text-${n}-${k}`;
      rec.message.id = resp.id;
      rec.message.content = [{ type: "text", text: t }];
      feed(rec);
    }
  }
  return turnView(state.turns[0]!);
}

function settled(view: TurnView): SettledTurn {
  const { core } = settledTurnCoreOf(view, DECISION, { delivery: null, shape: "one-shot" });
  return {
    ...core,
    chainAnswers: [],
    chainDelivery: core.delivery,
    hookTurns: 0,
    hookCaused: false,
  };
}

function verdictOf(turn: SettledTurn, record: { code: string; at: string } | null) {
  return classifyRunOutput({
    answer: chainAnswerOf(turn),
    lastResponseEnd: turn.lastResponseEnd,
    proxyInBandError: record,
    turnStartedAt: turn.acceptedAt ?? null,
    apiError: turn.apiError,
    stopReason: turn.stopReason,
    promptRead: turn.chainDelivery,
    requirePattern: "VERDICT:",
  });
}

describe("transcript records → settled turn → verdict", () => {
  test("a final [prose, marker] response with the proxy's record is FAILED api_error", () => {
    const view = followedTurn();
    expect(view.acceptedAt).not.toBeNull();
    const turn = settled(view);
    expect(turn.lastResponseEnd).toEqual({ blockType: "text", text: MARKER });
    expect(turn.acceptedAt).toBe(view.acceptedAt);
    const at = new Date(Date.parse(view.acceptedAt!) + 1000).toISOString();
    const v = verdictOf(turn, { code: "cyber_policy", at });
    expect(v?.state).toBe("FAILED");
    expect(v?.reason).toBe("api_error");
    expect(v?.detail).toContain("content policy");
  });

  test("the same records without the proxy's record are the model's text", () => {
    const v = verdictOf(settled(followedTurn()), null);
    expect(v?.reason).toBe("shape_mismatch");
  });
});

describe("a file-delivered turn's answer waits for complete read coverage", () => {
  const FILE = "/turns/turn-1.md";
  const LINE = `Your task is in the file \`${FILE}\`.`;
  const fileDelivery: Delivery = {
    mode: "file",
    line: LINE,
    file: FILE,
    fileContent: "one\ntwo\nthree\n",
    lines: 3,
    witness: { kind: "turn_file", file: FILE, line: LINE },
  };
  const commandDelivery: Delivery = {
    mode: "command",
    line: "/review",
    witness: { kind: "command", name: "review" },
    file: FILE,
    fileContent: "one\ntwo\nthree\n",
    lines: 3,
  };

  /** The pear turn's records, as a turn delivered by `FILE` whose Reads returned `returned` lines. */
  function readTurn(returned: number, reads: number): TurnView {
    return {
      ...followedTurn(),
      delivery: { file: FILE, lines: 3 },
      readCoverage: {
        linesReturned: returned,
        complete: returned === 3,
        reads,
        completedAtOffset: null,
      },
    };
  }

  function turnOf(view: TurnView, delivery: Delivery): SettledTurn {
    const { core } = settledTurnCoreOf(view, DECISION, { delivery, shape: "one-shot" });
    return {
      ...core,
      chainAnswers: [],
      chainDelivery: core.delivery,
      hookTurns: 0,
      hookCaused: false,
    };
  }

  test("no Read at all: the answer is empty; the verdict is still prompt_not_read", () => {
    const turn = turnOf(readTurn(0, 0), fileDelivery);
    expect(turn.answer).toBe("");
    expect(turn.delivery).toMatchObject({ complete: false, linesRead: 0, linesTotal: 3 });
    const v = verdictOf(turn, null);
    expect(v).toMatchObject({ state: "FAILED", reason: "prompt_not_read" });
    expect(v?.detail).toBe("the task file was never read, so the answer cannot be about the task");
  });

  test("a partial Read: the answer is empty; the verdict is still prompt_not_read", () => {
    const turn = turnOf(readTurn(2, 1), fileDelivery);
    expect(turn.answer).toBe("");
    expect(turn.delivery).toMatchObject({ complete: false, linesRead: 2 });
    const v = verdictOf(turn, null);
    expect(v).toMatchObject({ state: "FAILED", reason: "prompt_not_read" });
    expect(v?.detail).toBe("the child's Read calls returned 2 of 3 lines of the task file");
  });

  test("every line read: the answer is the turn's text", () => {
    const text = followedTurn().assistantText.join("\n\n");
    expect(turnOf(readTurn(3, 1), fileDelivery).answer).toBe(text);
  });

  test("a command turn with zero Reads keeps its text (its coverage is unknown)", () => {
    const text = followedTurn().assistantText.join("\n\n");
    expect(turnOf(readTurn(0, 0), commandDelivery).answer).toBe(text);
  });
});
