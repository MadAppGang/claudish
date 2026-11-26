import { describe, expect, test } from "bun:test";
import { fileTemplate, turnFilePath } from "./prompt-delivery.js";
import {
  type FollowerState,
  INTERRUPT_PREFIX,
  type Witness,
  applyRecord,
  initialFollowerState,
  openTurnState,
  turnView,
} from "./transcript-follower.js";

/**
 * A turn delivered as a pointer line is bound to its submission by the path that line names:
 * a prompt record that carries the turn file's token (the path in backticks) is that turn's
 * witness, whatever else the record holds, and a record of another turn's file never is. The
 * text of the prompt plays no part.
 */

const TURN_DIR = "/tmp/claudish-mux-501/launch-AAAAAA";
const fileOf = (n: number): string => turnFilePath(TURN_DIR, n);
const pointer = (n: number): string => fileTemplate(fileOf(n), null);
const witnessOf = (n: number): Witness => ({
  kind: "turn_file",
  file: fileOf(n),
  line: pointer(n),
});

const TS = "2026-11-21T10:00:00.000Z";

function userRecord(
  content: unknown,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "user",
    isSidechain: false,
    message: { role: "user", content },
    uuid: "00000000-0000-4000-8000-000000000003",
    timestamp: TS,
    origin: { kind: "human" },
    ...extra,
  };
}

/** One open turn for `witness`, with `records` folded after its offset, one per byte position. */
function fold(
  witness: Witness,
  records: Record<string, unknown>[],
  setup: (s: FollowerState) => void = () => {}
): { state: FollowerState; view: ReturnType<typeof turnView> } {
  const state = initialFollowerState((p) => p);
  openTurnState(state, { index: 2, offset: 0, witness });
  setup(state);
  records.forEach((r, i) => applyRecord(state, r, 100 + i));
  return { state, view: turnView(state.turns[0]!) };
}

describe("a turn_file witness: a prompt record carrying the turn file's token", () => {
  test("a record holding the turn's pointer line is accepted, with one copy", () => {
    const { view } = fold(witnessOf(2), [userRecord(pointer(2))]);
    expect(view.acceptedAt).toBe(TS);
    expect(view.witnessCopies).toBe(1);
  });

  test("k joined copies of the pointer are accepted, and witnessCopies counts the tokens", () => {
    const { view } = fold(witnessOf(2), [userRecord(pointer(2).repeat(3))]);
    expect(view.acceptedAt).toBe(TS);
    expect(view.witnessCopies).toBe(3);
  });

  test("the pointer after an interrupt marker in the same record is accepted", () => {
    const content = [
      { type: "text", text: `${INTERRUPT_PREFIX}]` },
      { type: "text", text: pointer(2) },
    ];
    const { view } = fold(witnessOf(2), [userRecord(content)]);
    expect(view.acceptedAt).toBe(TS);
  });

  test("a record holding another turn's token does not witness this turn", () => {
    const { view } = fold(witnessOf(3), [userRecord(pointer(2))]);
    expect(view.acceptedAt).toBeNull();
  });

  test("a record of turn 1 is not matched inside turn 11's token, nor turn 11's inside turn 1's", () => {
    expect(fold(witnessOf(1), [userRecord(pointer(11))]).view.acceptedAt).toBeNull();
    expect(fold(witnessOf(11), [userRecord(pointer(1))]).view.acceptedAt).toBeNull();
  });

  test("a record holding the tokens of turns 2 and 3 witnesses turn 3 and marks a watched turn-2 copy seen", () => {
    const { state, view } = fold(witnessOf(3), [userRecord(pointer(2) + pointer(3))], (s) => {
      s.copy = { witness: witnessOf(2), after: 0, seen: false };
    });
    expect(view.acceptedAt).toBe(TS);
    expect(state.copy?.seen).toBe(true);
  });

  test("a record of another turn's file never marks a watched pointer copy seen", () => {
    const { state } = fold(witnessOf(4), [userRecord(pointer(3))], (s) => {
      s.copy = { witness: witnessOf(2), after: 0, seen: false };
    });
    expect(state.copy?.seen).toBe(false);
  });

  test("held: the turn's own record still accepts it", () => {
    const { view } = fold(witnessOf(3), [userRecord(pointer(3))], (s) => {
      s.copy = { witness: witnessOf(2), after: 0, seen: false };
      s.held = true;
    });
    expect(view.acceptedAt).toBe(TS);
  });

  test("held: the earlier copy's record does not accept it", () => {
    const { state, view } = fold(witnessOf(3), [userRecord(pointer(2))], (s) => {
      s.copy = { witness: witnessOf(2), after: 0, seen: false };
      s.held = true;
    });
    expect(view.acceptedAt).toBeNull();
    expect(state.copy?.seen).toBe(true);
  });

  test("a departed copy whose text is the pointer line takes the pointer's record: a pointer copy must never be departed", () => {
    // pane-session's departCopy keeps a pointer copy out of `departed`; this is what it prevents
    const { state, view } = fold(witnessOf(2), [userRecord(pointer(2))], (s) => {
      s.departed = { witness: { kind: "text", text: pointer(2) }, after: 0 };
    });
    expect(view.acceptedAt).toBeNull();
    expect(state.departed).toBeNull();
  });
});

describe("records that carry the token but are not a submission of the line", () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    [
      "a record whose origin is a task notification, with no notification tag",
      userRecord(`I read ${pointer(2)}`, { origin: { kind: "task-notification" } }),
    ],
    [
      "a task notification tag quoting the path, with a human origin",
      userRecord(`<task-notification>I read ${pointer(2)}</task-notification>`),
    ],
    [
      "a record holding the pointer as text beside a tool_result",
      userRecord([
        { type: "text", text: pointer(2) },
        { type: "tool_result", tool_use_id: "t1", content: "1\tdone" },
      ]),
    ],
    ["an isMeta record", userRecord(pointer(2), { isMeta: true })],
    ["a sidechain record", userRecord(pointer(2), { isSidechain: true })],
    ["a record whose origin is not human", userRecord(pointer(2), { origin: { kind: "hook" } })],
    ["a compact summary", userRecord(pointer(2), { isCompactSummary: true })],
    ["an assistant record", { ...userRecord(pointer(2)), type: "assistant" }],
  ];
  for (const [name, record] of refused) {
    test(`refused: ${name}`, () => {
      expect(fold(witnessOf(2), [record]).view.acceptedAt).toBeNull();
    });
  }

  test("a record with no origin field is accepted (Claude Code before 2.1.290)", () => {
    const record = userRecord(pointer(2));
    delete record.origin;
    expect(fold(witnessOf(2), [record]).view.acceptedAt).toBe(TS);
  });
});

describe("a human witness that excludes claudish's own pointer lines", () => {
  const human = (notTurnDir?: string): Witness =>
    notTurnDir === undefined ? { kind: "human" } : { kind: "human", notTurnDir };

  test("with notTurnDir, a pointer record of that turn directory is not a human prompt", () => {
    expect(fold(human(TURN_DIR), [userRecord(pointer(5))]).view.acceptedAt).toBeNull();
  });

  test("with notTurnDir, a prompt the human typed is still accepted", () => {
    expect(fold(human(TURN_DIR), [userRecord("fix the build")]).view.acceptedAt).toBe(TS);
  });

  test("with notTurnDir, a pointer of another turn directory is a human prompt", () => {
    const other = fileTemplate(turnFilePath("/tmp/elsewhere-BBBBBB", 1), null);
    expect(fold(human(TURN_DIR), [userRecord(other)]).view.acceptedAt).toBe(TS);
  });

  test("with notTurnDir, a human prompt naming a non-turn file in that directory is accepted", () => {
    const text = `look at \`${TURN_DIR}/turn-notes.md\` first`;
    expect(fold(human(TURN_DIR), [userRecord(text)]).view.acceptedAt).toBe(TS);
  });

  test("with notTurnDir, a human prompt naming turn-<n>.md without backticks is accepted", () => {
    const text = `what does ${TURN_DIR}/turn-3.md say?`;
    expect(fold(human(TURN_DIR), [userRecord(text)]).view.acceptedAt).toBe(TS);
  });

  test("without notTurnDir, a pointer record is a human prompt (unchanged)", () => {
    expect(fold(human(), [userRecord(pointer(5))]).view.acceptedAt).toBe(TS);
  });
});
