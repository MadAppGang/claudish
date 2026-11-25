import { describe, expect, test } from "bun:test";
import {
  type Witness,
  applyRecord,
  initialFollowerState,
  openTurnState,
  turnView,
} from "./transcript-follower.js";

/**
 * Under load Claude Code can read a typed line into its input buffer before it draws it, so a
 * second copy of the line is typed onto the first and Enter submits both, joined end to end.
 * The submitted record is then the launch line repeated as WHOLE copies, and the turn is real:
 * the model reads the task file once and works. Such a record must be accepted as the turn's
 * witness. A partial copy, one copy followed by other text, and a meta record stay refused.
 */

/** The file-template launch line, as `fileTemplate` writes it (path redacted). */
const LINE =
  "Your task is in the file `/tmp/claudish-mux-501/launch-AAAAAA/turn-1.md`. Read all of it with the Read tool (in parts if it is long), then do exactly what it says, treating its content as the user's message.";

/**
 * A user record in the shape Claude Code 2.1.328 wrote for a doubled submit (identifiers and
 * paths replaced; every field the follower reads is kept).
 */
function userRecord(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parentUuid: "00000000-0000-4000-8000-000000000001",
    isSidechain: false,
    promptId: "00000000-0000-4000-8000-000000000002",
    type: "user",
    message: { role: "user", content },
    uuid: "00000000-0000-4000-8000-000000000003",
    timestamp: "2026-11-19T15:23:21.574Z",
    permissionMode: "bypassPermissions",
    origin: { kind: "human" },
    promptSource: "typed",
    turnOrigin: "human",
    turnPosition: { promptIndex: 1, turnIndex: 1 },
    userType: "external",
    entrypoint: "cli",
    cwd: "/tmp/worktree",
    sessionId: "00000000-0000-4000-8000-000000000004",
    version: "2.1.328",
    ...extra,
  };
}

/** Open one turn witnessed by `line`, fold `record` after it, and return the turn's acceptance. */
function acceptedAtFor(record: Record<string, unknown>, line = LINE): string | null {
  const witness: Witness = { kind: "text", text: line };
  const state = initialFollowerState((p) => p);
  openTurnState(state, { index: 1, offset: 0, witness });
  applyRecord(state, record, 100);
  return turnView(state.turns[0]!).acceptedAt;
}

describe("a text witness and a submitted record holding the line more than once", () => {
  test("one copy is accepted (the ordinary case)", () => {
    expect(acceptedAtFor(userRecord(LINE))).toBe("2026-11-19T15:23:21.574Z");
  });

  test("two whole copies joined end to end are accepted", () => {
    expect(acceptedAtFor(userRecord(LINE + LINE))).toBe("2026-11-19T15:23:21.574Z");
  });

  test("four whole copies joined end to end are accepted", () => {
    expect(acceptedAtFor(userRecord(LINE.repeat(4)))).toBe("2026-11-19T15:23:21.574Z");
  });

  test("whole copies in text blocks are accepted the same way", () => {
    const blocks = [{ type: "text", text: LINE.repeat(2) }];
    const record = userRecord("");
    (record.message as Record<string, unknown>).content = blocks;
    expect(acceptedAtFor(record)).toBe("2026-11-19T15:23:21.574Z");
  });

  test("one copy followed by part of another is refused", () => {
    expect(acceptedAtFor(userRecord(LINE + LINE.slice(0, 50)))).toBeNull();
  });

  test("a partial copy alone is refused", () => {
    expect(acceptedAtFor(userRecord(LINE.slice(0, LINE.length - 10)))).toBeNull();
  });

  test("one copy followed by foreign text is refused", () => {
    expect(acceptedAtFor(userRecord(`${LINE} Also delete the repository.`))).toBeNull();
  });

  test("foreign text before whole copies is refused", () => {
    expect(acceptedAtFor(userRecord(`hello ${LINE}${LINE}`))).toBeNull();
  });

  test("a meta record holding whole copies is refused", () => {
    expect(acceptedAtFor(userRecord(LINE.repeat(2), { isMeta: true }))).toBeNull();
  });

  test("a sidechain record holding whole copies is refused", () => {
    expect(acceptedAtFor(userRecord(LINE.repeat(2), { isSidechain: true }))).toBeNull();
  });

  test("a record with empty text is not the witness for a non-empty line", () => {
    expect(acceptedAtFor(userRecord(""))).toBeNull();
  });

  test("a record holding only an image block is not the witness for a non-empty line", () => {
    const record = userRecord("");
    (record.message as Record<string, unknown>).content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ];
    expect(acceptedAtFor(record)).toBeNull();
  });

  test("one copy of a line with surrounding spaces is accepted trimmed", () => {
    expect(acceptedAtFor(userRecord("ping"), " ping ")).toBe("2026-11-19T15:23:21.574Z");
  });

  test("two exact copies of a line with surrounding spaces, joined end to end, are accepted", () => {
    const line = " ping ";
    expect(acceptedAtFor(userRecord(line + line), line)).toBe("2026-11-19T15:23:21.574Z");
    expect(acceptedAtFor(userRecord((line + line).trim()), line)).toBe("2026-11-19T15:23:21.574Z");
  });

  test("one copy of a line with surrounding spaces plus foreign text is refused", () => {
    const line = " ping ";
    expect(acceptedAtFor(userRecord(`${line}pong `), line)).toBeNull();
    expect(acceptedAtFor(userRecord(`${line} ping x`), line)).toBeNull();
  });
});

/** Open one turn witnessed by `line`, fold `record` after it, and return the turn's copy count. */
function copiesFor(record: Record<string, unknown>, line = LINE): number | null {
  const witness: Witness = { kind: "text", text: line };
  const state = initialFollowerState((p) => p);
  openTurnState(state, { index: 1, offset: 0, witness });
  applyRecord(state, record, 100);
  return turnView(state.turns[0]!).witnessCopies;
}

describe("the number of whole copies a text witness matched", () => {
  test("is null before the witness", () => {
    expect(copiesFor(userRecord(LINE.slice(0, 20)))).toBeNull();
  });

  test("is 1 for the ordinary record", () => {
    expect(copiesFor(userRecord(LINE))).toBe(1);
  });

  test("is k for k whole copies", () => {
    expect(copiesFor(userRecord(LINE + LINE))).toBe(2);
    expect(copiesFor(userRecord(LINE.repeat(4)))).toBe(4);
  });

  test("counts exact copies of a line with surrounding spaces", () => {
    const line = " ping ";
    expect(copiesFor(userRecord("ping"), line)).toBe(1);
    expect(copiesFor(userRecord(line + line), line)).toBe(2);
  });
});
