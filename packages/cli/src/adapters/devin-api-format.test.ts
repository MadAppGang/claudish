import { describe, expect, test } from "bun:test";
import { DevinAPIFormat } from "./devin-api-format.js";

const format = new DevinAPIFormat("kimi-k3-1-pro-max");
const calls = [0, 1].map((index) => ({
  id: `call_${index}`,
  type: "function",
  function: { name: "Bash", arguments: JSON.stringify({ command: `echo step${index}` }) },
}));
const assistant = {
  role: "assistant",
  content: "I will inventory the repository first.",
  tool_calls: calls,
};
const results = calls.map((call, index) => ({
  role: "tool",
  tool_call_id: call.id,
  content: `step${index}`,
}));

describe("DevinAPIFormat tool-call ordering", () => {
  test("pairs each parallel tool call with its result after the assistant text", () => {
    const payload = format.buildPayload({}, [assistant, ...results], []);

    expect(payload.messages[0]).toEqual({ role: "assistant", text: assistant.content });
    expect(
      payload.messages.map((message) => [
        message.role,
        message.toolCall?.id ?? message.toolCallId ?? null,
      ])
    ).toEqual([
      ["assistant", null],
      ["assistant", "call_0"],
      ["tool_result", "call_0"],
      ["assistant", "call_1"],
      ["tool_result", "call_1"],
    ]);
    expect(payload.messages[2]?.text).toBe("step0");
    expect(payload.messages[4]?.text).toBe("step1");
  });

  test("matches results by id and keeps unmatched results and later user text in order", () => {
    const payload = format.buildPayload(
      {},
      [
        assistant,
        { role: "tool", tool_call_id: "unmatched_0", content: "unmatched first" },
        results[1],
        { role: "tool", tool_call_id: "unmatched_1", content: "unmatched second" },
        results[0],
        { role: "user", content: "Continue." },
      ],
      []
    );

    expect(
      payload.messages.map((message) => [
        message.role,
        message.toolCall?.id ?? message.toolCallId ?? null,
        message.text ?? null,
      ])
    ).toEqual([
      ["assistant", null, assistant.content],
      ["assistant", "call_0", null],
      ["tool_result", "call_0", "step0"],
      ["assistant", "call_1", null],
      ["tool_result", "call_1", "step1"],
      ["tool_result", "unmatched_0", "unmatched first"],
      ["tool_result", "unmatched_1", "unmatched second"],
      ["user", null, "Continue."],
    ]);
  });

  test("keeps a single tool call and its result unchanged", () => {
    const payload = format.buildPayload(
      {},
      [
        { ...assistant, tool_calls: calls.slice(0, 1) },
        results[0],
        { role: "user", content: "Continue." },
      ],
      []
    );

    expect(payload.messages).toEqual([
      { role: "assistant", text: assistant.content },
      {
        role: "assistant",
        toolCall: { id: "call_0", name: "Bash", argumentsJson: calls[0]!.function.arguments },
      },
      { role: "tool_result", toolCallId: "call_0", text: "step0" },
      { role: "user", text: "Continue." },
    ]);
  });

  test("keeps a call with no result before the remaining call-result pair", () => {
    // Malformed-turn encoder output; Devin is not known to accept this order.
    const payload = format.buildPayload({}, [assistant, results[1]], []);

    expect(
      payload.messages.map((message) => [
        message.role,
        message.toolCall?.id ?? message.toolCallId ?? null,
      ])
    ).toEqual([
      ["assistant", null],
      ["assistant", "call_0"],
      ["assistant", "call_1"],
      ["tool_result", "call_1"],
    ]);
  });
});
