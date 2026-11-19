import { expect, test } from "bun:test";
import {
  HARNESS_COMPACTION_PROMPT_START,
  isHarnessCompactionRequest,
} from "./harness-compaction.js";

/** The reminder Claude Code 2.1.328 adds after every tool_result when an output style is set. */
const STYLE_REMINDER = {
  role: "system",
  content: [
    {
      type: "text",
      text: "composed output style is active. Remember to follow the specific guidelines for this style.",
    },
  ],
};

test("a compaction instruction followed by an inline system message is Claude Code's compaction request", () => {
  const messages = [
    { role: "user", content: "Fix the parser" },
    { role: "system", content: [{ type: "text", text: "session context" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t-1", name: "Read", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t-1", content: "file text" },
        { type: "text", text: `${HARNESS_COMPACTION_PROMPT_START}\n\nSummarise.` },
      ],
    },
    STYLE_REMINDER,
  ];
  expect(isHarnessCompactionRequest(messages)).toBe(true);
});
