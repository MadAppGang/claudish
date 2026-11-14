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
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// The adapter does not filter identity: `ComposedHandler` step 2a owns that
// decision, because only the handler knows whether the upstream model is Claude.
// `composed-handler-identity.test.ts` covers both outcomes on this adapter.
describe("T5 Codex instructions carry the system text unchanged", () => {
  test("REQ-8 TEST-9 string instructions are the system text, identity sentence included", () => {
    const original = capture.instructions
      .split(/\n{2,}/)
      .slice(0, 3)
      .join("\n\n");
    expect(original).toContain(SDK_IDENTITY);
    const payload = new CodexAPIFormat(capture.model).buildPayload(
      { system: original, max_tokens: capture.max_output_tokens, messages },
      messages,
      []
    );

    expect(payload.instructions).toBe(original);
  });

  test("REQ-8 TEST-10 block-array instructions join the text with two newlines", () => {
    const parts: string[] = capture.instructions.split(/\n{2,}/).slice(1, 4);
    expect(parts).toHaveLength(3);
    const system = parts.map((text) => ({ type: "text", text }));
    const payload = new CodexAPIFormat(capture.model).buildPayload(
      { system, max_tokens: capture.max_output_tokens, messages },
      messages,
      []
    );

    expect(payload.instructions).toBe(parts.join("\n\n"));
    expect(payload.instructions).not.toContain("[object Object]");
  });
});
