/**
 * Tests for DeepSeekModelDialect.
 *
 * Validates:
 * 1. Model detection for the deepseek family (incl. cluster bare names)
 * 2. prepareRequest strips the unsupported `thinking` param (DeepSeek thinks automatically)
 * 3. preserveThinkingInHistory()=true — the regression guard for the HTTP 400
 *    "reasoning_content must be passed back" bug (po-2025, 2026-08-11)
 * 4. DialectManager resolves DeepSeekModelDialect, and the capability is opt-in
 *    (GLM/default return false) — proving the history-strip gate is selective
 */

import { describe, test, expect } from "bun:test";
import { DeepSeekModelDialect } from "./adapters/deepseek-model-dialect.js";
import { GLMModelDialect } from "./adapters/glm-model-dialect.js";
import { DialectManager } from "./adapters/dialect-manager.js";
import {
  convertMessagesToOpenAI,
  stripReasoningContent,
} from "./handlers/shared/format/openai-messages.js";

// ─── Group 1: DeepSeekModelDialect model detection ──────────────────────────

describe("DeepSeekModelDialect — Model Detection", () => {
  const adapter = new DeepSeekModelDialect("deepseek-v4-flash");

  test("should handle deepseek-v4-flash", () => {
    expect(adapter.shouldHandle("deepseek-v4-flash")).toBe(true);
  });

  test("should handle deepseek-v4-pro", () => {
    expect(adapter.shouldHandle("deepseek-v4-pro")).toBe(true);
  });

  test("should handle deepseek-r1", () => {
    expect(adapter.shouldHandle("deepseek-r1")).toBe(true);
  });

  test("should handle deepseek/ prefixed models", () => {
    expect(adapter.shouldHandle("deepseek/deepseek-v4-flash")).toBe(true);
  });

  test("should NOT handle non-deepseek models", () => {
    expect(adapter.shouldHandle("glm-5")).toBe(false);
    expect(adapter.shouldHandle("qwen3.8-max")).toBe(false);
    expect(adapter.shouldHandle("gpt-4o")).toBe(false);
    expect(adapter.shouldHandle("kimi-k2.5")).toBe(false);
  });

  test("should return correct adapter name", () => {
    expect(adapter.getName()).toBe("DeepSeekModelDialect");
  });
});

// ─── Group 2: prepareRequest strips unsupported thinking param ──────────────

describe("DeepSeekModelDialect — prepareRequest", () => {
  test("strips thinking param from request (DeepSeek thinks automatically)", () => {
    const adapter = new DeepSeekModelDialect("deepseek-v4-flash");
    const request = { model: "deepseek-v4-flash", thinking: { budget: 10000 }, messages: [] };
    const original = { thinking: { budget: 10000 } };

    adapter.prepareRequest(request, original);

    expect(request.thinking).toBeUndefined();
  });

  test("leaves request unchanged without thinking param", () => {
    const adapter = new DeepSeekModelDialect("deepseek-v4-flash");
    const request = { model: "deepseek-v4-flash", messages: [] };
    const original = {};

    adapter.prepareRequest(request, original);

    expect(request.model).toBe("deepseek-v4-flash");
    expect(request.messages).toEqual([]);
  });
});

// ─── Group 3: preserveThinkingInHistory — the 400 regression guard ─────────
//
// ComposedHandler strips thinking blocks from message history by default to
// protect anthropic-transport providers (GLM/MiniMax) from Anthropic thinking
// signatures. DeepSeek REQUIRES its reasoning echoed back as reasoning_content
// on every assistant turn; stripping the block makes the OpenAI-format converter
// omit reasoning_content → HTTP 400. So DeepSeek opts OUT of the strip.

describe("DeepSeekModelDialect — preserveThinkingInHistory (400 regression)", () => {
  test("DeepSeek opts out of the history thinking-strip", () => {
    const adapter = new DeepSeekModelDialect("deepseek-v4-flash");
    expect(adapter.preserveThinkingInHistory()).toBe(true);
  });

  test("GLM keeps the default strip (capability is opt-in, not blanket)", () => {
    const adapter = new GLMModelDialect("glm-5");
    expect(adapter.preserveThinkingInHistory()).toBe(false);
  });
});

// ─── Group 3b: reasoning_content on every assistant message (v4 roundtrip) ──
//
// DeepSeek rejects a thinking-mode conversation whose RECENT assistant messages
// lack reasoning_content — including tool_use-only turns that never carried a
// thinking block — with HTTP 400 "The reasoning_content in the thinking mode
// must be passed back to the API" (reproduced against api.deepseek.com,
// 2026-08-16, session reqN=5905). The converter must emit the field (empty
// string satisfies the presence check) on every assistant message when the
// target requires reasoning roundtrip.

describe("convertMessagesToOpenAI — reasoningRoundtrip emission", () => {
  const base = {
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "doing" }] },
      { role: "user", content: "result" },
      // tool_use-only turn: no thinking block in source
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  };

  test("off (default): reasoning_content only where thinking block present", () => {
    const out = convertMessagesToOpenAI(base, "deepseek-v4-flash") as any[];
    const asst = out.filter((m) => m.role === "assistant");
    expect(asst[0].reasoning_content).toBe("plan");
    expect(asst[1].reasoning_content).toBeUndefined(); // tool_use-only turn
  });

  test("on (DeepSeek): reasoning_content on every assistant message, empty for no-thinking turns", () => {
    const out = convertMessagesToOpenAI(base, "deepseek-v4-flash", undefined, false, true) as any[];
    const asst = out.filter((m) => m.role === "assistant");
    expect(asst[0].reasoning_content).toBe("plan");
    expect(asst[1].reasoning_content).toBe(""); // tool_use-only turn gets empty field
  });
});

// ─── Group 3b: stripReasoningContent (strict-schema backends) ────────────────
//
// Mirror image of the above. The emission fires on `hasThinking` alone, so ANY
// OpenAI-wire endpoint receives reasoning_content once a thinking block is in
// history — opt-in or not. Mistral validates strictly and answers HTTP 422
// extra_forbidden on body.messages[N].assistant.reasoning_content.
//
// Production incident 2026-08-20: Mistral was promoted to step 0 of the sonnet
// cascade while the GLM nominal was walled. 28 of 32 requests failed (87%), and
// because a 422 is not a quota wall the cascade surfaced it to the client rather
// than routing around it — the fleet stalled until Mistral was pulled.
//
// Measured the same day: Mistral's zai-glm-5-2 emits NO reasoning traces at all
// (0 thinking blocks, 0 reasoning_content in its SSE). So there is no round-trip
// to preserve and the strip costs nothing.

describe("stripReasoningContent", () => {
  test("removes the field from every assistant message, in place", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", content: "doing", reasoning_content: "plan" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1" }], reasoning_content: "" },
    ];
    expect(stripReasoningContent(msgs)).toBe(2);
    expect(msgs[1]).not.toHaveProperty("reasoning_content");
    expect(msgs[2]).not.toHaveProperty("reasoning_content");
    // Everything else survives untouched — this strips one field, not thinking.
    expect(msgs[1].content).toBe("doing");
    expect(msgs[2].tool_calls).toEqual([{ id: "t1" }]);
  });

  test("empty-string reasoning_content is removed, not skipped as falsy", () => {
    // The DeepSeek roundtrip emits "" on tool_use-only turns. A truthiness check
    // would leave those in place and Mistral would still 422.
    const msgs = [{ role: "assistant", content: null, reasoning_content: "" }];
    expect(stripReasoningContent(msgs)).toBe(1);
    expect(msgs[0]).not.toHaveProperty("reasoning_content");
  });

  test("no-op when the field is absent, and safe on a non-array", () => {
    const msgs = [{ role: "user", content: "go" }];
    expect(stripReasoningContent(msgs)).toBe(0);
    expect(stripReasoningContent(undefined as any)).toBe(0);
  });

  test("round-trip: converter emits, strip removes — payload is clean", () => {
    const req = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "doing" }],
        },
        { role: "user", content: "next" },
      ],
    };
    const out = convertMessagesToOpenAI(req, "zai-glm-5-2", undefined, false, true) as any[];
    expect(out.some((m) => "reasoning_content" in m)).toBe(true);
    stripReasoningContent(out);
    expect(out.some((m) => "reasoning_content" in m)).toBe(false);
  });
});

// ─── Group 4: DialectManager resolution ─────────────────────────────────────

describe("DialectManager — DeepSeek routing", () => {
  test("selects DeepSeekModelDialect for deepseek-v4-flash", () => {
    const manager = new DialectManager("deepseek-v4-flash");
    const adapter = manager.getAdapter();
    expect(adapter.getName()).toBe("DeepSeekModelDialect");
    // The capability must survive DialectManager resolution — ComposedHandler
    // reads it off this resolved adapter via this.modelAdapter.
    expect(adapter.preserveThinkingInHistory()).toBe(true);
  });

  test("GLM via DialectManager still strips (false)", () => {
    const manager = new DialectManager("glm-5");
    const adapter = manager.getAdapter();
    expect(adapter.preserveThinkingInHistory()).toBe(false);
  });
});
