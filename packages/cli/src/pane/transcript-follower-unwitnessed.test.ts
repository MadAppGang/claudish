/**
 * The facts of a turn whose witness never arrives: every main-chain record past the turn's
 * offset is folded into `TurnView.unwitnessed` by the same reducer a witnessed turn uses, so
 * a screen-read turn can still end at Claude Code's own `turn_duration`.
 */
import { describe, expect, test } from "bun:test";
import {
  applyRecord,
  initialFollowerState,
  openTurnState,
  turnView,
} from "./transcript-follower.js";

const T = (s: number) => new Date(Date.UTC(2026, 10, 21, 12, 0, s)).toISOString();

const prompt = (text: string, s: number) => ({
  type: "user",
  timestamp: T(s),
  origin: { kind: "human" },
  message: { role: "user", content: text },
});
const answer = (id: string, text: string, s: number, stop = "end_turn") => ({
  type: "assistant",
  timestamp: T(s),
  message: { id, role: "assistant", stop_reason: stop, content: [{ type: "text", text }] },
});
const turnDuration = (s: number, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "turn_duration",
  timestamp: T(s),
  durationMs: 1000,
  ...extra,
});

function fold(records: Array<Record<string, unknown>>) {
  const state = initialFollowerState((p) => p);
  openTurnState(state, { index: 1, offset: 0, witness: { kind: "text", text: "do the task" } });
  records.forEach((r, i) => applyRecord(state, r, i + 1));
  return turnView(state.turns[0]!);
}

describe("an unwitnessed turn's own facts", () => {
  test("a main-chain turn_duration after an answer is folded, with its record time", () => {
    const t = fold([prompt("do the tsak", 1), answer("m1", "the answer", 2), turnDuration(3)]);
    expect(t.acceptedAt).toBeNull();
    expect(t.turnDurationAfterLast).toBeNull();
    expect(t.unwitnessed?.assistantText).toEqual(["the answer"]);
    expect(t.unwitnessed?.turnDurationAfterLast).toEqual({ pendingBackgroundAgentCount: null });
    expect(t.unwitnessed?.turnDurationAt).toBe(T(3));
  });

  test("a sidechain turn_duration is not folded", () => {
    const t = fold([
      prompt("do the tsak", 1),
      answer("m1", "the answer", 2, "tool_use"),
      turnDuration(3, { isSidechain: true }),
    ]);
    expect(t.unwitnessed?.turnDurationAfterLast).toBeNull();
    expect(t.unwitnessed?.turnDurationAt).toBeNull();
  });

  test("a witness that arrives drops the unwitnessed facts", () => {
    const t = fold([prompt("do the task", 1), answer("m1", "the answer", 2), turnDuration(3)]);
    expect(t.acceptedAt).not.toBeNull();
    expect(t.unwitnessed).toBeNull();
    expect(t.turnDurationAt).toBe(T(3));
  });
});
