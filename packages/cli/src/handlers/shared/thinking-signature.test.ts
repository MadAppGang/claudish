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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripUnsignedThinkingBlocks } from "./thinking-signature.js";

const here = dirname(fileURLToPath(import.meta.url));

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

  test("strips the exact CoursIA whitespace-only block without losing sibling content", () => {
    const messages = Array.from({ length: 41 }, (_, i) => ({
      role: i % 2 === 0 ? "assistant" : "user",
      content: [{ type: "text", text: `m${i}` }],
    }));
    messages[40] = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "  ", signature: "" } as any,
        { type: "text", text: "I will use the tool." },
        { type: "tool_use", id: "tool-1", name: "Artifact", input: { action: "read" } },
      ],
    };

    const removed = stripUnsignedThinkingBlocks(messages);

    expect(removed).toBe(1);
    expect(messages[40].content).toEqual([
      { type: "text", text: "I will use the tool." },
      { type: "tool_use", id: "tool-1", name: "Artifact", input: { action: "read" } },
    ]);
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

  test("strips a thinking-shaped block on a user message too (no role filter)", () => {
    // Reconciled with upstream 0e8f3b05: a `thinking` block is invalid on the
    // Anthropic wire wherever it sits, so leaving one on a user message only
    // guarantees the request 400s. The fork used to pin the opposite
    // ("never touches user messages"); that narrowing bought nothing.
    const messages = [
      { role: "user", content: [{ type: "thinking", thinking: "x", signature: "" }] },
    ];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(1);
    expect(messages[0].content).toEqual([]);
  });

  test("strips a thinking block whose signature is null", () => {
    const messages = [
      { role: "assistant", content: [{ type: "thinking", thinking: "unsigned", signature: null }] },
    ];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(1);
    expect(messages[0].content).toEqual([]);
  });

  test("DEFAULT (non-native) call keeps a 64-hex signature — the foreign strip is opt-in per wire", () => {
    // A non-empty signature is preserved unless the CALLER says it is on the
    // native wire: on the MiniMax path these 64-hex blocks ARE the model's own
    // thinking (the dialect re-sends them via preserveThinkingBlock()), so a
    // shape-only strip here would delete real reasoning. They do reach the
    // client under the `forced` policy (composed-handler-minimax-thinking
    // .test.ts:131) — the reason to keep them is what they mean on that wire.
    // The native opt-in is pinned separately below (#597).
    const minimaxSignature = "7caa0d3cc2a449ac1cc68507504693f566245c7b5db3558f6041585e15a848f8";
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "MiniMax reasoning", signature: minimaxSignature }],
      },
    ];
    const removed = stripUnsignedThinkingBlocks(messages);
    expect(removed).toBe(0);
    expect(messages[0].content[0].signature).toBe(minimaxSignature);
  });

  test("NATIVE path (#597): a 64-hex foreign signature is stripped", () => {
    // MiniMax's real digest, from the m25 production fixture. Anthropic never
    // signed it and rejects the request with
    // "messages.N.content.M: Invalid signature in thinking block" — which the
    // empty-signature test alone can never catch, because the signature is
    // non-empty. The native handler opts in explicitly.
    const minimaxSignature = "7caa0d3cc2a449ac1cc68507504693f566245c7b5db3558f6041585e15a848f8";
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "MiniMax reasoning", signature: minimaxSignature },
          { type: "text", text: "kept" },
        ],
      },
    ];
    const removed = stripUnsignedThinkingBlocks(messages, { stripForeignHexSignature: true });
    expect(removed).toBe(1);
    expect(messages[0].content).toEqual([{ type: "text", text: "kept" }]);
  });

  test("NATIVE path (#597): a genuine base64 Anthropic signature is KEPT", () => {
    // The opt-in must not degenerate into "strip every non-empty signature" —
    // that would break interleaved-thinking / tool-use continuity on real
    // Anthropic sessions, which is the whole reason the blocks are forwarded.
    const anthropicSignature =
      "ErUBCkYIBRgCKkBc3Q9nJ+7fWLx0mZr2VbT4pYs1uHk6NqR8aXe5dCg0fJm2oDl3vYw7Zt1PkQ9rS6uM4bN8xL2aE5hT0cI";
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "real reasoning", signature: anthropicSignature }],
      },
    ];
    const removed = stripUnsignedThinkingBlocks(messages, { stripForeignHexSignature: true });
    expect(removed).toBe(0);
    expect(messages[0].content[0].signature).toBe(anthropicSignature);
  });

  test("WIRING (#597): the native handler is the caller that opts in", () => {
    // The predicate can be perfect and never called. Static pin on the one call
    // site: it must carry the opt-in, and it must live in the native handler
    // (the wire), not in a shared path a MiniMax lane could reach.
    const source = readFileSync(join(here, "..", "native-handler.ts"), "utf8");
    const call = source.match(/stripUnsignedThinkingBlocks\([^)]*\)/s);
    expect(call).not.toBeNull();
    expect(call![0]).toContain("stripForeignHexSignature: true");
  });

  test("leaves an untouched message's content array identity intact", () => {
    const content = [{ type: "text", text: "u" }];
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content },
    ];
    expect(stripUnsignedThinkingBlocks(messages)).toBe(0);
    expect(messages[1].content).toBe(content);
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
