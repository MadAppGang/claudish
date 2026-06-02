/**
 * Regression tests for unsigned thinking-block stripping on the native path.
 *
 * Anchored to the real incident: a mixed-provider Claude Code session
 * accumulated GLM reasoning surfaced as `{ type: "thinking", signature: "" }`
 * blocks, then routed a turn to a native Anthropic model. The Anthropic API
 * rejected the request with
 * `messages.19.content.0: Invalid signature in thinking block` (400).
 *
 * stripUnsignedThinkingBlocks() must remove the unsigned (empty/missing
 * signature) thinking blocks while preserving genuine signed Anthropic thinking
 * and every other block type.
 */

import { describe, test, expect } from "bun:test";
import { stripUnsignedThinkingBlocks } from "./thinking-signature.js";

describe("stripUnsignedThinkingBlocks", () => {
  test("strips a thinking block with an empty-string signature (the GLM poison)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "GLM reasoning", signature: "" },
          { type: "text", text: "hello" },
        ],
      },
    ];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(1);
    expect(messages[0].content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("strips a thinking block with no signature field at all", () => {
    const messages = [
      { role: "assistant", content: [{ type: "thinking", thinking: "no sig" }] },
    ];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(1);
    expect(messages[0].content).toEqual([]);
  });

  test("preserves a genuine Anthropic thinking block with a non-empty signature", () => {
    const signed = {
      type: "thinking",
      thinking: "real Opus reasoning",
      signature: "ErcBCkgIBRABGAIiQ...valid-signature",
    };
    const messages = [{ role: "assistant", content: [signed, { type: "text", text: "ok" }] }];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(0);
    expect(messages[0].content).toContainEqual(signed);
  });

  test("reproduces the incident shape: content[0] unsigned thinking is removed", () => {
    // messages.19.content.0 in the real 400. Index here is illustrative.
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `m${i}` }],
    }));
    messages[19] = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "poisoned", signature: "" } as any,
        { type: "text", text: "answer" },
      ],
    };
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(1);
    expect(messages[19].content[0]).toEqual({ type: "text", text: "answer" });
  });

  test("leaves text, tool_use, tool_result and redacted_thinking blocks untouched", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "encrypted-blob" },
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] },
    ];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(0);
    expect(messages[0].content).toHaveLength(3);
  });

  test("never touches user messages, even if they carry a thinking-shaped block", () => {
    const messages = [
      { role: "user", content: [{ type: "thinking", thinking: "x", signature: "" }] },
    ];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(0);
    expect(messages[0].content).toHaveLength(1);
  });

  test("counts across multiple assistant turns and keeps signed ones", () => {
    const messages = [
      { role: "assistant", content: [{ type: "thinking", thinking: "a", signature: "" }] },
      { role: "user", content: [{ type: "text", text: "u" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "b", signature: "sig-ok" },
          { type: "thinking", thinking: "c", signature: "" },
        ],
      },
    ];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(2);
    expect(messages[2].content).toEqual([{ type: "thinking", thinking: "b", signature: "sig-ok" }]);
  });

  test("tolerates non-array / malformed inputs", () => {
    expect(stripUnsignedThinkingBlocks(undefined)).toBe(0);
    expect(stripUnsignedThinkingBlocks(null)).toBe(0);
    expect(stripUnsignedThinkingBlocks("not-an-array" as any)).toBe(0);
    expect(stripUnsignedThinkingBlocks([{ role: "assistant", content: "string-content" }])).toBe(0);
  });
});
