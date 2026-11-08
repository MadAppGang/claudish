import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CodexAPIFormat } from "./codex-api-format.js";

const capture: {
  model: string;
  instructions: string;
  max_output_tokens: number;
  input: Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>;
} = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/code-mode/claude-code-request-body.json", import.meta.url),
    "utf8"
  )
);
// Derived structural Claude Code inputs from the captured outbound request:
// instructions become system text; input_text becomes a Claude Code text block.
const messages = capture.input
  .filter((item) => item.type === "message" && item.role === "user")
  .slice(0, 1)
  .map((item) => ({
    role: item.role,
    content: item.content
      .filter((block) => block.type === "input_text")
      .map((block) => ({ type: "text", text: block.text })),
  }));
const notice = "IMPORTANT: You are NOT Claude."; // Contract: implementation-log.md C1 identity notice.

describe("T5 Codex instructions identity filtering", () => {
  test("REQ-8 TEST-9 string instructions contain the identity notice and the original captured text", () => {
    // Use captured prose paragraphs, not the full persona's identity claim or
    // its three-newline formatting (whitespace normalization is not specified).
    const original = capture.instructions
      .split(/\n{2,}/)
      .slice(1, 3)
      .join("\n\n");
    const payload = new CodexAPIFormat(capture.model).buildPayload(
      { system: original, max_tokens: capture.max_output_tokens, messages },
      messages,
      []
    );

    expect(typeof payload.instructions).toBe("string");
    expect(payload.instructions).toContain(notice);
    expect(payload.instructions).toContain(original);
    expect(payload.instructions.indexOf(notice)).toBeLessThan(
      payload.instructions.indexOf(original)
    );
  });

  test("REQ-8 TEST-10 block-array instructions join the original text with two newlines after the notice", () => {
    const parts: string[] = capture.instructions.split(/\n{2,}/).slice(1, 4);
    expect(parts).toHaveLength(3);
    const system = parts.map((text) => ({ type: "text", text }));
    const payload = new CodexAPIFormat(capture.model).buildPayload(
      { system, max_tokens: capture.max_output_tokens, messages },
      messages,
      []
    );

    expect(typeof payload.instructions).toBe("string");
    expect(payload.instructions).toContain(notice);
    expect(payload.instructions).toContain(parts.join("\n\n"));
    expect(payload.instructions).not.toContain("[object Object]");
  });
});
