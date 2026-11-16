// Claude Code can split the results of one parallel tool round across two user
// messages: `tool_result a`, a notification, `tool_result b`. Gemini pairs the
// function calls of a model turn with the function responses of the turn that
// follows it, so every response of the round must be in that ONE user content.
import { describe, expect, test } from "bun:test";
import { GeminiAPIFormat } from "./gemini-api-format.js";

function splitRound() {
  return {
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_A", name: "Read", input: { file_path: "/a" } },
          { type: "tool_use", id: "toolu_B", name: "Grep", input: { pattern: "x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "RESULT-A" }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_B", content: "RESULT-B" },
          { type: "text", text: "NOTICE" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  };
}

describe("GeminiAPIFormat: one tool round's responses go out in one user content", () => {
  test("results split across two user messages become one user content", () => {
    const contents = new GeminiAPIFormat("gemini-4-carbon").convertMessages(splitRound());
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user", "model"]);
    expect(contents[2].parts).toEqual([
      { functionResponse: { name: "Read", response: { content: "RESULT-A" } } },
      { functionResponse: { name: "Grep", response: { content: "RESULT-B" } } },
      { text: "NOTICE" },
    ]);
  });

  // Gemini's function responses carry no call id: a response pairs with the
  // call at its position. Results that arrive in another order than the calls
  // (two Read calls, B answered first) must be put back in the calls' order.
  test("responses follow the order of their calls, not the order they arrived in", () => {
    const contents = new GeminiAPIFormat("gemini-4-carbon").convertMessages({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_A", name: "Read", input: { file_path: "/a" } },
            { type: "tool_use", id: "toolu_B", name: "Read", input: { file_path: "/b" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_B", content: "CONTENT-OF-B" }],
        },
        { role: "user", content: [{ type: "text", text: "NOTICE" }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_A",
              content: [
                { type: "text", text: "CONTENT-OF-A" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "QQ==" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(contents[1].parts.map((p: any) => p.functionCall.args.file_path)).toEqual(["/a", "/b"]);
    expect(contents[2].parts).toEqual([
      { functionResponse: { name: "Read", response: { content: "CONTENT-OF-A" } } },
      { inlineData: { mimeType: "image/png", data: "QQ==" } },
      { functionResponse: { name: "Read", response: { content: "CONTENT-OF-B" } } },
      { text: "NOTICE" },
    ]);
  });

  test("a model turn is never merged into another one", () => {
    const contents = new GeminiAPIFormat("gemini-4-carbon").convertMessages({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "assistant", content: "c" },
      ],
    });
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "model"]);
  });
});
