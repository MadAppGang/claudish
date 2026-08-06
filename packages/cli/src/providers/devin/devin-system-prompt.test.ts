import { describe, expect, test } from "bun:test";
import {
  DEVIN_MINIMAL_SYSTEM,
  DEVIN_RELOCATION_NOTE,
  DevinAPIFormat,
} from "../../adapters/devin-api-format.js";

const SYSTEM_PROMPT = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "IMPORTANT: Refuse to write code that may be used maliciously.",
  "You MUST use the TodoWrite tool to plan tasks.",
].join("\n");

const WRAPPED_SYSTEM_PROMPT = `<system_instructions>\n${SYSTEM_PROMPT}\n</system_instructions>`;
const format = new DevinAPIFormat("claude-sonnet-5");

describe("DevinAPIFormat system prompt placement and fidelity", () => {
  test("carries the system prompt as a leading user message with a field 2 relocation note", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "hello" },
      ],
      []
    );

    expect(payload.system).toBe(DEVIN_RELOCATION_NOTE);
    expect(payload.messages[0]?.role).toBe("user");
    expect(payload.messages[0]?.text).toContain(SYSTEM_PROMPT);
  });

  test("passes the system prompt through verbatim inside <system_instructions> tags", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "hello" },
      ],
      []
    );
    const text = payload.messages[0]?.text;

    expect(text).toBe(WRAPPED_SYSTEM_PROMPT);
    // These assertions ensure rewriting, paraphrasing, or truncation breaks the test.
    expect(text).toContain("IMPORTANT: Refuse to write code that may be used maliciously.");
    expect(text).toContain("You MUST use the TodoWrite tool to plan tasks.");
  });

  test("preserves the original message order after the injected instructions message", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
      []
    );

    expect(payload.messages).toHaveLength(4);
    expect(payload.messages).toEqual([
      { role: "user", text: WRAPPED_SYSTEM_PROMPT },
      { role: "user", text: "first" },
      { role: "assistant", text: "second" },
      { role: "user", text: "third" },
    ]);
  });

  test("flattens array content in the system prompt before wrapping it", () => {
    const payload = format.buildPayload(
      {},
      [
        {
          role: "system",
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
        { role: "user", content: "hi" },
      ],
      []
    );

    expect(payload.messages[0]?.text).toBe(
      "<system_instructions>\npart one\npart two\n</system_instructions>"
    );
  });
});

describe("DevinAPIFormat optional and multiple system prompts", () => {
  test("injects nothing when there is no system prompt", () => {
    const payload = format.buildPayload({}, [{ role: "user", content: "hello" }], []);

    expect(payload.system).toBeUndefined();
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toEqual({ role: "user", text: "hello" });
    expect(
      payload.messages.some((message) => message.text?.includes("<system_instructions>"))
    ).toBe(false);
  });

  test("joins multiple system messages into one instructions message", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "system", content: "alpha" },
        { role: "system", content: "beta" },
        { role: "user", content: "hi" },
      ],
      []
    );
    const instructionIndexes = payload.messages.flatMap((message, index) =>
      message.text?.includes("<system_instructions>") ? [index] : []
    );

    expect(instructionIndexes).toEqual([0]);
    expect(payload.messages[0]?.text).toBe(
      "<system_instructions>\nalpha\n\nbeta\n</system_instructions>"
    );
    expect(payload.system).toBe(DEVIN_RELOCATION_NOTE);
  });
});

describe("DevinAPIFormat field 2 requirements", () => {
  const tool = {
    type: "function",
    function: {
      name: "Bash",
      description: "Run a shell command.",
      parameters: { type: "object", properties: {} },
    },
  };

  test("uses the relocation note when a system prompt and tools are present", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "hello" },
      ],
      [tool]
    );

    expect(payload.system).toBe(DEVIN_RELOCATION_NOTE);
  });

  test("uses the relocation note when a system prompt is present without tools", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "hello" },
      ],
      []
    );

    expect(payload.system).toBe(DEVIN_RELOCATION_NOTE);
  });

  test("uses the minimal system prompt when tools are present without a system prompt", () => {
    const payload = format.buildPayload({}, [{ role: "user", content: "hello" }], [tool]);

    expect(payload.system).toBe(DEVIN_MINIMAL_SYSTEM);
  });

  test("leaves field 2 unset when neither a system prompt nor tools are present", () => {
    const payload = format.buildPayload({}, [{ role: "user", content: "hello" }], []);

    expect(payload.system).toBeUndefined();
  });

  test("keeps field 2 non-blank for every payload that includes tools", () => {
    const combinations = [
      { messages: [{ role: "system", content: SYSTEM_PROMPT }], tools: [tool] },
      { messages: [{ role: "system", content: SYSTEM_PROMPT }], tools: [] },
      { messages: [{ role: "user", content: "hello" }], tools: [tool] },
      { messages: [{ role: "user", content: "hello" }], tools: [] },
    ];

    for (const combination of combinations) {
      const payload = format.buildPayload({}, combination.messages, combination.tools);

      // A blank field 2 is invalid_argument on the Claude family whenever tools are present.
      if ((payload.tools?.length ?? 0) > 0) {
        expect(payload.system?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("keeps the user's system text verbatim in the leading message", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "hello" },
      ],
      [tool]
    );
    const text = payload.messages[0]?.text;

    expect(text).toBe(WRAPPED_SYSTEM_PROMPT);
    expect(text).toContain(SYSTEM_PROMPT);
    expect(text).not.toContain(DEVIN_RELOCATION_NOTE);
  });
});

describe("DevinAPIFormat tool messages with system instructions", () => {
  test("keeps tool calls and tool results intact alongside the injected instructions", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              function: { name: "Read", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "file body" },
      ],
      []
    );

    expect(payload.messages[0]).toEqual({ role: "user", text: WRAPPED_SYSTEM_PROMPT });
    expect(payload.messages[2]).toEqual({
      role: "assistant",
      toolCall: {
        id: "call-1",
        name: "Read",
        argumentsJson: '{"path":"a.txt"}',
      },
    });
    expect(payload.messages[3]).toEqual({
      role: "tool_result",
      toolCallId: "call-1",
      text: "file body",
    });
  });
});
