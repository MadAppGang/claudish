import { describe, expect, test } from "bun:test";
import { RECENT_STEP_LIMIT, STEP_SUMMARY_MAX, oneLine, stepOf } from "./slot-steps.js";

const AT = "2026-10-06T01:16:08.448Z";
const TOKEN = `ghp_${"a".repeat(36)}`;

describe("SlotStep summaries", () => {
  test("exports the contract limits", () => {
    expect(RECENT_STEP_LIMIT).toBe(20);
    expect(STEP_SUMMARY_MAX).toBe(100);
  });

  test.each([
    ["text", { type: "text", text: "\n  First line  \nSecond line" }, "text", null, "First line"],
    [
      "thinking",
      { type: "thinking", thinking: "\r\n  Think first  \r\nNot this line" },
      "thinking",
      null,
      "Think first",
    ],
    [
      "question",
      {
        type: "tool_use",
        name: "AskUserQuestion",
        input: {
          questions: [
            { question: "" },
            { question: "  Which fruit?  \nNot this line" },
            { question: "Not this question" },
          ],
        },
      },
      "ask",
      "AskUserQuestion",
      "Which fruit?",
    ],
  ] as const)("%s uses its first non-empty line", (_label, block, kind, tool, summary) => {
    expect(stepOf(block, AT)).toEqual({ at: AT, kind, tool, summary });
  });

  test.each([
    ["Read", "file_path", "/Users/example/work/read.ts"],
    ["Edit", "file_path", "/Users/example/work/edit.ts"],
    ["Write", "file_path", "/home/example/work/write.ts"],
    ["Bash", "command", "printf first"],
    ["Grep", "pattern", "TODO.*recent"],
    ["Glob", "pattern", "**/*.test.ts"],
    ["WebSearch", "query", "transcript timestamps"],
    ["WebFetch", "url", "https://example.com/transcript"],
    ["Task", "description", "Inspect transcript"],
    ["Agent", "description", "Review transcript"],
  ])("%s uses only input.%s, not other input fields", (name, field, summary) => {
    const input = {
      file_path: "wrong path",
      command: "wrong command",
      pattern: "wrong pattern",
      query: "wrong query",
      url: "wrong url",
      description: "wrong description",
      content: "never include tool content",
      [field]: `\n  ${summary}  \nNot this line`,
    };
    expect(stepOf({ type: "tool_use", name, input }, AT)).toEqual({
      at: AT,
      kind: "tool",
      tool: name,
      summary,
    });
  });

  test("an unknown tool has an empty summary even when familiar fields are present", () => {
    expect(
      stepOf(
        {
          type: "tool_use",
          name: "CustomTool",
          input: { command: "private", description: "private", file_path: "/private" },
        },
        AT
      )
    ).toEqual({
      at: AT,
      kind: "tool",
      tool: "CustomTool",
      summary: "",
    });
  });

  test.each([undefined, null, 1, {}, "", " \n\t\r\n"])("oneLine(%j) is empty", (value) => {
    expect(oneLine(value)).toBe("");
  });

  test.each([
    null,
    "not a block",
    {},
    { type: "text", text: " \n\t" },
    { type: "text" },
    { type: "thinking", thinking: "\r\n  " },
    { type: "redacted_thinking", data: "never show this" },
    { type: "image", source: { data: "never show this" } },
    { type: "tool_use", name: "" },
    { type: "tool_use" },
    { type: "tool_result", content: `result-only ${TOKEN}` },
  ])("non-step block %j produces no step", (block) => {
    expect(stepOf(block, AT)).toBeNull();
  });

  test.each(["Read", "Bash", "AskUserQuestion"])(
    "%s without its target has an empty summary",
    (name) => {
      expect(stepOf({ type: "tool_use", name }, AT)?.summary).toBe("");
    }
  );

  test.each([99, 100, 101, 200])("oneLine bounds a %i-character summary", (length) => {
    const summary = oneLine("x".repeat(length));
    expect(summary.length).toBe(Math.min(length, 100));
    expect(summary).toBe(length > 100 ? `${"x".repeat(99)}…` : "x".repeat(length));
  });

  test.each([
    { type: "text", text: "x".repeat(101) },
    { type: "thinking", thinking: "x".repeat(101) },
    { type: "tool_use", name: "Bash", input: { command: "x".repeat(101) } },
    {
      type: "tool_use",
      name: "AskUserQuestion",
      input: { questions: [{ question: "x".repeat(101) }] },
    },
  ])("every step kind truncates to exactly 100 characters with an ellipsis", (block) => {
    expect(stepOf(block, AT)?.summary).toBe(`${"x".repeat(99)}…`);
  });

  test("redacts a Bash Authorization credential without dropping the command or URL", () => {
    const command = `curl -H "Authorization: Bearer ${TOKEN}" https://x\nprintf hidden`;
    const step = stepOf({ type: "tool_use", name: "Bash", input: { command } }, AT)!;
    expect(step.summary).not.toContain(TOKEN);
    expect(step.summary).toContain("curl -H");
    expect(step.summary).toContain("https://x");
    expect(step.summary).not.toContain("printf hidden");
  });

  test.each([
    { type: "text", text: `credential ${TOKEN}` },
    { type: "thinking", thinking: `credential ${TOKEN}` },
    { type: "tool_use", name: "WebFetch", input: { url: `https://x/?token=${TOKEN}` } },
    {
      type: "tool_use",
      name: "AskUserQuestion",
      input: { questions: [{ question: `Use ${TOKEN}?` }] },
    },
  ])("redacts credentials in every summary kind", (block) => {
    const step = stepOf(block, AT)!;
    expect(step.summary).not.toContain(TOKEN);
    expect(step.summary.length).toBeGreaterThan(0);
  });

  test("redacts before truncation and keeps home-directory paths", () => {
    const line = `/Users/example/${TOKEN}/${"z".repeat(110)}`;
    const summary = oneLine(line);
    expect(summary).not.toContain(TOKEN);
    expect(summary.startsWith("/Users/example/")).toBe(true);
    expect(summary).toHaveLength(100);
    expect(summary.endsWith("…")).toBe(true);
    expect(oneLine(" /Users/example/src/index.ts ")).toBe("/Users/example/src/index.ts");
    expect(oneLine(" /home/example/src/index.ts ")).toBe("/home/example/src/index.ts");
  });

  test("AskUserQuestion skips whitespace-only questions before choosing the first non-empty question", () => {
    expect(
      stepOf(
        {
          type: "tool_use",
          name: "AskUserQuestion",
          input: {
            questions: [{ question: " \r\n\t " }, { question: "\n  Which fruit?\nMore detail" }],
          },
        },
        AT
      )
    ).toEqual({ at: AT, kind: "ask", tool: "AskUserQuestion", summary: "Which fruit?" });
  });
});
