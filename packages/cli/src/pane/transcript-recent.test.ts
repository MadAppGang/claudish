import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotStep } from "./contract.js";
import { RECENT_STEP_LIMIT } from "./slot-steps.js";
import { FIXTURES } from "./test-helpers/fixtures.js";
import {
  type Rec,
  textOf,
  transcriptRecords,
  witnessIndex,
} from "./test-helpers/transcript-fixtures.js";
import {
  applyRecord,
  applySubagentRecord,
  initialFollowerState,
  openTurnState,
  turnView,
} from "./transcript-follower.js";

const NAME = "tools-session";
const RECORDS = transcriptRecords(NAME);
const PROMPT =
  "Your task is in the file `/tmp/cc2/launch-XW9UoC/turn-1.md`. Read all of it with the Read tool (in parts if it is long), then do exactly what it says, treating its content as the user's message.";
const AT = witnessIndex(NAME, PROMPT);
const END = RECORDS.findIndex((r, i) => i > AT && r.subtype === "turn_duration");
const TURN = RECORDS.slice(AT, END + 1);
const READ_STEP: SlotStep = {
  at: "2026-10-06T01:16:15.109Z",
  kind: "tool",
  tool: "Read",
  summary: "/tmp/cc2/launch-XW9UoC/turn-1.md",
};
const TEXT_STEP: SlotStep = {
  at: "2026-10-06T01:16:16.646Z",
  kind: "text",
  tool: null,
  summary: "KIWI",
};

/** Replay unchanged real records; byte offsets increase even when a record is replayed. */
function reducer() {
  const state = initialFollowerState((p) => p);
  let offset = 0;
  const push = (record: Rec) => {
    offset += Buffer.byteLength(JSON.stringify(record)) + 1;
    applyRecord(state, record, offset);
  };
  for (const record of RECORDS.slice(0, AT)) push(record);
  const open = (index: number) =>
    openTurnState(state, { index, offset, witness: { kind: "text", text: PROMPT } });
  open(1);
  return { state, push, open, view: () => turnView(state.turns[0]!) };
}

describe("current-turn recent steps from real transcripts", () => {
  test("the capture has a file witness, a Read, a result and a multiline text answer", () => {
    expect(AT).toBeGreaterThan(0);
    expect(END).toBeGreaterThan(AT);
    expect(textOf(TURN[0]!)).toBe(PROMPT);
    expect(
      TURN.some(
        (r) =>
          r.type === "user" &&
          Array.isArray(r.message?.content) &&
          r.message.content.some((b: Rec) => b.type === "tool_result")
      )
    ).toBe(true);
    expect(
      TURN.find(
        (r) => r.type === "assistant" && r.message.content.some((b: Rec) => b.type === "text")
      )?.message.content[0].text
    ).toBe("KIWI\n5");
  });

  test("Read and text steps retain record order, input file_path, first line and exact timestamps", () => {
    const r = reducer();
    for (const record of TURN) r.push(record);
    expect(r.view().recent).toEqual([READ_STEP, TEXT_STEP]);
    for (const step of r.view().recent) {
      const record = TURN.find((record) => record.timestamp === step.at);
      expect(record?.type).toBe("assistant");
      expect(step.at).toBe(record?.timestamp);
    }
  });

  test("assistant blocks before the witness are excluded, including earlier turns", () => {
    const r = reducer();
    expect(r.view().recent).toEqual([]);
    const textRecord = TURN.find(
      (record) => record.type === "assistant" && textOf(record) === "KIWI\n5"
    )!;
    r.push(textRecord);
    expect(r.view().acceptedAt).toBeNull();
    expect(r.view().recent).toEqual([]);
    for (const record of TURN) r.push(record);
    expect(r.view().recent).toEqual([READ_STEP, TEXT_STEP]);
  });

  test("real sidechain records add no steps through either reducer entry point", () => {
    const sidechain: Rec[] = readFileSync(
      join(FIXTURES, "transcripts", "tools-session", "subagents", "agent-a6d024f5474e98666.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const assistants = sidechain.filter((record) => record.type === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants.every((record) => record.isSidechain === true)).toBe(true);
    expect(assistants.some((record) => textOf(record) === "OK")).toBe(true);
    const r = reducer();
    for (const record of TURN) r.push(record);
    for (const record of sidechain) {
      r.push(record);
      applySubagentRecord(r.state, record, 1_000_000);
    }
    expect(r.view().recent).toEqual([READ_STEP, TEXT_STEP]);
  });

  test("real isApiErrorMessage records add no steps", () => {
    const errors = transcriptRecords("api-error-hookless").filter(
      (record) => record.isApiErrorMessage
    );
    expect(errors).toHaveLength(1);
    const r = reducer();
    r.push(TURN[0]!);
    for (const record of errors) r.push(record);
    expect(r.view().apiError?.status).toBe(401);
    expect(r.view().recent).toEqual([]);
    for (const record of TURN.slice(1)) r.push(record);
    for (const record of errors) r.push(record);
    expect(r.view().recent).toEqual([READ_STEP, TEXT_STEP]);
  });

  test("tool_result records never add steps or summaries", () => {
    const r = reducer();
    let results = 0;
    for (const record of TURN) {
      const before = r.view().recent;
      r.push(record);
      if (
        record.type === "user" &&
        Array.isArray(record.message?.content) &&
        record.message.content.some((b: Rec) => b.type === "tool_result")
      ) {
        results++;
        expect(r.view().recent).toEqual(before);
      }
    }
    expect(results).toBeGreaterThan(0);
    expect(r.view().recent).toEqual([READ_STEP, TEXT_STEP]);
  });

  test("the 20-step limit drops the oldest steps, not the newest", () => {
    const r = reducer();
    for (const record of TURN) r.push(record);
    const expected = [READ_STEP, TEXT_STEP];
    const assistants = TURN.filter((record) => record.type === "assistant");
    // Replaying unmodified real assistant records is allowed by Brief H.
    for (let i = 0; i < 10; i++) {
      for (const record of assistants) r.push(record);
      expected.push(READ_STEP, TEXT_STEP);
    }
    // A distinct last step makes dropping the newest distinguishable from dropping the oldest.
    const plum = RECORDS.find(
      (record) => record.type === "assistant" && textOf(record) === "PLUM"
    )!;
    r.push(plum);
    expected.push({ at: plum.timestamp, kind: "text", tool: null, summary: "PLUM" });
    expect(expected).toHaveLength(23);
    expect(r.view().recent).toHaveLength(20);
    expect(r.view().recent).toEqual(expected.slice(-RECENT_STEP_LIMIT));
    expect(r.view().recent[0]).toEqual(TEXT_STEP);
    expect(r.view().recent.at(-1)?.summary).toBe("PLUM");
  });

  test("steps survive turn_duration and reset only when a new turn opens", () => {
    const r = reducer();
    for (const record of TURN.slice(0, -1)) r.push(record);
    expect(r.view().turnDurationAfterLast).toBeNull();
    expect(r.view().recent).toEqual([READ_STEP, TEXT_STEP]);
    r.push(TURN.at(-1)!);
    expect(r.view().turnDurationAfterLast).not.toBeNull();
    expect(r.view().recent).toEqual([READ_STEP, TEXT_STEP]);
    expect(r.view().recent).toEqual([READ_STEP, TEXT_STEP]); // polling does not consume steps
    r.open(2);
    expect(r.view().index).toBe(2);
    expect(r.view().recent).toEqual([]);
    r.push(TURN[0]!);
    expect(r.view().acceptedAt).not.toBeNull();
    expect(r.view().recent).toEqual([]);
  });
});
