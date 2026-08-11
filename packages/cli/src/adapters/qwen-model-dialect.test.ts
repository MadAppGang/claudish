/**
 * QwenModelDialect — thinking-switch tests.
 *
 * The bug these pin: Qwen exposes two different reasoning switches on two
 * different wires, and each endpoint IGNORES the other's form. Measured against
 * Qwen Cloud Token Plan on 2026-08-11 with `max_tokens: 400` on the prompt
 * "Reponds exactement: ok", via the Anthropic-compatible endpoint:
 *
 *   baseline (no thinking field)      → in 67 / out 43, emits a thinking block
 *   enable_thinking: false            → in 67 / out 48, STILL emits thinking
 *   thinking: {type: "disabled"}      → in 31 / out  1, no thinking block
 *
 * So on the Anthropic wire the historical mapping (delete `thinking`, send
 * `enable_thinking`) removed the only switch that works. Output tokens are what
 * the Token Plan deducts credits on, and the ratio here is 43:1.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { QwenModelDialect } from "./qwen-model-dialect.js";

const ORIGINAL = process.env.CLAUDISH_QWEN_THINKING;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDISH_QWEN_THINKING;
  else process.env.CLAUDISH_QWEN_THINKING = ORIGINAL;
});

function dialect() {
  return new QwenModelDialect("qwen3.8-max");
}

const ANTHROPIC = { wireFormat: "anthropic-sse" as const };
const OPENAI = { wireFormat: "openai-sse" as const };

describe("QwenModelDialect — Anthropic wire", () => {
  it("disables thinking by default, in the native form", () => {
    delete process.env.CLAUDISH_QWEN_THINKING;
    const payload: any = { model: "qwen3.8-max", messages: [] };
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
    // The ignored form must never be emitted on this wire.
    expect(payload.enable_thinking).toBeUndefined();
    expect(payload.thinking_budget).toBeUndefined();
  });

  it("disables thinking even when the client explicitly asked for it", () => {
    // Qwen is a budget failover target; the operator's cost policy wins over the
    // client's default request shape. `passthrough` is the opt-out.
    delete process.env.CLAUDISH_QWEN_THINKING;
    const payload: any = { thinking: { type: "enabled", budget_tokens: 8000 } };
    dialect().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 8000 } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("passthrough preserves exactly what the client sent", () => {
    process.env.CLAUDISH_QWEN_THINKING = "passthrough";
    const original = { thinking: { type: "enabled", budget_tokens: 4096 } };
    const payload: any = {};
    dialect().prepareRequest(payload, original, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(payload.enable_thinking).toBeUndefined();
  });

  it("passthrough with no client thinking sends no thinking field", () => {
    process.env.CLAUDISH_QWEN_THINKING = "passthrough";
    const payload: any = {};
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.thinking).toBeUndefined();
  });

  it("budget:<n> enables thinking with a cap, in the native form", () => {
    process.env.CLAUDISH_QWEN_THINKING = "budget:2000";
    const payload: any = {};
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 2000 });
    expect(payload.enable_thinking).toBeUndefined();
  });

  it("scrubs a stale enable_thinking left by an earlier layer", () => {
    delete process.env.CLAUDISH_QWEN_THINKING;
    const payload: any = { enable_thinking: true, thinking_budget: 8000 };
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.enable_thinking).toBeUndefined();
    expect(payload.thinking_budget).toBeUndefined();
    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});

describe("QwenModelDialect — OpenAI-compatible wire", () => {
  it("disables thinking with the OpenAI-side switch by default", () => {
    delete process.env.CLAUDISH_QWEN_THINKING;
    const payload: any = {};
    dialect().prepareRequest(payload, {}, OPENAI);
    expect(payload.enable_thinking).toBe(false);
    // The Anthropic-native object is meaningless here and must not leak through.
    expect(payload.thinking).toBeUndefined();
  });

  it("budget:<n> maps to enable_thinking + thinking_budget", () => {
    process.env.CLAUDISH_QWEN_THINKING = "budget:1500";
    const payload: any = {};
    dialect().prepareRequest(payload, {}, OPENAI);
    expect(payload.enable_thinking).toBe(true);
    expect(payload.thinking_budget).toBe(1500);
    expect(payload.thinking).toBeUndefined();
  });

  it("passthrough keeps the historical budget mapping", () => {
    process.env.CLAUDISH_QWEN_THINKING = "passthrough";
    const payload: any = {};
    dialect().prepareRequest(payload, { thinking: { budget_tokens: 6000 } }, OPENAI);
    expect(payload.enable_thinking).toBe(true);
    expect(payload.thinking_budget).toBe(6000);
    expect(payload.thinking).toBeUndefined();
  });
});

describe("QwenModelDialect — policy parsing", () => {
  it("falls back to 'disabled' on an unrecognized value", () => {
    process.env.CLAUDISH_QWEN_THINKING = "yes-please";
    const payload: any = {};
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("rejects a zero or negative budget rather than sending it", () => {
    process.env.CLAUDISH_QWEN_THINKING = "budget:0";
    const payload: any = {};
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("with no wire hint at all, behaves like the OpenAI wire (historical default)", () => {
    // Callers that predate PrepareRequestContext must not change behavior.
    process.env.CLAUDISH_QWEN_THINKING = "passthrough";
    const payload: any = {};
    dialect().prepareRequest(payload, { thinking: { budget_tokens: 100 } });
    expect(payload.enable_thinking).toBe(true);
    expect(payload.thinking_budget).toBe(100);
  });
});
