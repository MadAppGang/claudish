import { describe, expect, test } from "bun:test";
import { HARNESS_COMPACTED_START, isHarnessCompactedRequest } from "./harness-compaction.js";

const SUMMARY = `${HARNESS_COMPACTED_START} that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. ...`;
const reminder = (text: string) => ({
  type: "text",
  text: `<system-reminder>\n${text}\n</system-reminder>`,
});

/**
 * The compacted requests of one live session on Claude Code 2.1.329. After
 * a precomputed compaction the summary is block 2 of message 0. After a
 * reactive one, Claude Code first re-attaches the files it read, as their own
 * user message, and the summary is the last of 9 blocks of message 1,
 * followed by an inline system message.
 */
describe("isHarnessCompactedRequest", () => {
  test("a precomputed compaction: the summary in message 0", () => {
    const messages = [
      {
        role: "user",
        content: [reminder("context"), reminder("output style"), { type: "text", text: SUMMARY }],
      },
      { role: "system", content: "Note: a file was read before the summary." },
      { role: "assistant", content: [{ type: "text", text: "Continuing." }] },
    ];
    expect(isHarnessCompactedRequest(messages)).toBe(true);
  });

  test("a reactive compaction: re-attached reads first, the summary in message 1", () => {
    const messages = [
      { role: "user", content: [reminder("Called the Read tool with the following input")] },
      {
        role: "user",
        content: [
          reminder("Result of calling the Read tool"),
          reminder("Called the Read tool with the following input"),
          reminder("Result of calling the Read tool"),
          reminder("Called the Read tool with the following input"),
          reminder("Result of calling the Read tool"),
          reminder("Codebase and user instructions are shown below."),
          reminder("As you answer the user's questions"),
          reminder("The output style"),
          { type: "text", text: SUMMARY },
        ],
      },
      { role: "system", content: "Note: a file was read before the summary." },
    ];
    expect(isHarnessCompactedRequest(messages)).toBe(true);
  });

  test("a conversation's opening prompt is not a compacted request", () => {
    const messages = [
      { role: "user", content: [reminder("context"), { type: "text", text: "Fix the parser." }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "Go on." },
    ];
    expect(isHarnessCompactedRequest(messages)).toBe(false);
  });

  test("the sentence after the first assistant message does not count", () => {
    const messages = [
      { role: "user", content: "Fix the parser." },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: SUMMARY },
    ];
    expect(isHarnessCompactedRequest(messages)).toBe(false);
  });

  test("the sentence inside a block, not at its start, does not count", () => {
    const messages = [{ role: "user", content: `Quote: ${SUMMARY}` }];
    expect(isHarnessCompactedRequest(messages)).toBe(false);
  });
});
