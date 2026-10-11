/**
 * OpenAIAPIFormat — outbound-body thinking contract (#399 exoneration).
 *
 * #399 measured (07/10, hub + vLLM `myia_vllm-mini-frognano-4b` :5003) that
 * frognano-4b requests served via the hub produced reasoning from the first
 * token while the same prompt direct on :5003 never thinks. The suspected
 * locus was "an untested field of the hub's outbound body flips the model's
 * thinking template". These pins hold the claudish side of that answer:
 *
 * - The outbound body for a thinking-less request on a non-o1/o3 model carries
 *   NO thinking-shaped field of any spelling. Measured 2026-10-11 by capturing
 *   the real pipeline's body through an echo endpoint, byte-identical at
 *   6f732eb9 (main on 07/10, the incident's era) and af52be5f (current): 198
 *   bytes = model, messages, temperature, stream, stream_options, max_tokens.
 * - `frognano-4b` matches neither `qwen` nor `alibaba`
 *   (`matchesModelFamily` = startsWith | "/fam"), so QwenModelDialect — the
 *   adapter whose passthrough could emit `enable_thinking` — never ran for it.
 * - The flip no longer reproduces via the hub (2026-10-11): the exact captured
 *   request (req-1-11725, minimal) AND a 26-tools consumer body (req-1-6396)
 *   both answer immediately with no reasoning — same body both eras ⇒ the
 *   change was server-side (:5003 deployment, refs vllm#70/#71).
 *
 * The o1/o3 branch (`isReasoningModel`) is the ONLY site allowed to emit
 * `reasoning_effort`; if a future change starts emitting thinking controls for
 * every model, these pins fire.
 */

import { describe, expect, test } from "bun:test";
import { OpenAIAPIFormat } from "./openai-api-format.js";

/** The exact inbound body of capture req-1-11725 (07/10 19:39:33Z) — minimal. */
const R11725 = {
  model: "frognano-4b",
  max_tokens: 16,
  messages: [{ role: "user", content: [{ type: "text", text: "Reponds exactement: ok" }] }],
};

const THINKING_FIELDS = [
  "enable_thinking",
  "reasoning_effort",
  "thinking",
  "thinking_budget",
  "chat_template_kwargs",
];

function builtPayload(modelId: string, claudeRequest: any): any {
  const adapter = new OpenAIAPIFormat(modelId);
  // Mirror ComposedHandler's sequence: buildPayload, then the adapter's
  // prepareRequest post-pass (tool-name encoding — where a dialect hook could
  // otherwise inject fields after the build).
  const messages = [{ role: "user", content: "Reponds exactement: ok" }];
  const payload = adapter.buildPayload(claudeRequest, messages, []);
  adapter.prepareRequest(payload, claudeRequest, { wireFormat: "openai-sse" as const });
  return payload;
}

describe("OpenAIAPIFormat — #399: no thinking field leaves for a non-o1/o3 model", () => {
  test("the r11725 body builds to exactly the six neutral fields (the 198-byte capture)", () => {
    const payload = builtPayload("frognano-4b", R11725);
    expect(Object.keys(payload).sort()).toEqual(
      ["max_tokens", "messages", "model", "stream", "stream_options", "temperature"].sort()
    );
    for (const field of THINKING_FIELDS) {
      expect(`${field}: ${field in payload}`).toBe(`${field}: false`);
    }
  });

  test("an inbound `thinking` block does NOT become reasoning_effort off the o1/o3 lane", () => {
    // Claude Code routinely sends an enabled thinking block; for frognano the
    // body must still carry no thinking control — `isReasoningModel()` is the
    // only gate that may map it, and it must stay o1/o3-only.
    const payload = builtPayload("frognano-4b", {
      ...R11725,
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    for (const field of THINKING_FIELDS) {
      expect(`${field}: ${field in payload}`).toBe(`${field}: false`);
    }
  });

  test("o1 keeps the budget→reasoning_effort mapping (the only emission site stays open)", () => {
    const payload = builtPayload("o1-mini", {
      ...R11725,
      model: "o1-mini",
      thinking: { type: "enabled", budget_tokens: 8000 },
    });
    expect(payload.reasoning_effort).toBe("low");
  });
});
