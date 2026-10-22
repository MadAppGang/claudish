/**
 * DeepSeekModelDialect — thinking-switch tests.
 *
 * The bug these pin: the dialect deleted `thinking` unconditionally, on the
 * stated grounds that DeepSeek "doesn't support thinking params via API
 * options". Probed 2026-09-01 against api.deepseek.com/chat/completions on
 * deepseek-v4-flash-vision-exp, prompt "Reponds exactement: ok":
 *
 *   thinking absent            → out  31, reasoning 115 chars (thinks by default)
 *   thinking {type:"disabled"} → out   1, reasoning   0 chars — the switch works
 *   reasoning_effort:"none"    → out   1, reasoning   0 chars — equivalent
 *   enable_thinking:false      → out  34, reasoning 128 chars — IGNORED (Qwen's
 *                                spelling; must never be emitted here)
 *
 * On a realistic agentic load (two tools declared, a prompt forcing a tool
 * choice) the switch took output 213 → 92 tokens and latency 2459 → 1336ms,
 * with an identical tool call. DeepSeek PAYG bills on output, and this dialect
 * carries the sonnet cascade's last step.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";

const ORIGINAL = process.env.CLAUDISH_DEEPSEEK_THINKING;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDISH_DEEPSEEK_THINKING;
  else process.env.CLAUDISH_DEEPSEEK_THINKING = ORIGINAL;
});

function dialect() {
  return new DeepSeekModelDialect("deepseek-v4-flash-vision-exp");
}

describe("DeepSeekModelDialect — thinking policy", () => {
  it("defaults to passthrough: strips the client's thinking object, sets no field", () => {
    delete process.env.CLAUDISH_DEEPSEEK_THINKING;
    const payload: any = { model: "deepseek-v4-flash-vision-exp", thinking: { type: "enabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "enabled" } });
    // Historical behavior preserved: no thinking field reaches DeepSeek, which
    // then reasons by default. Changing that default is the operator's call.
    expect(payload.thinking).toBeUndefined();
  });

  it("passthrough forwards an EXPLICIT client off-switch — absent stays absent (GLM #245 rule, hub 22/10)", () => {
    delete process.env.CLAUDISH_DEEPSEEK_THINKING;
    // What #435 makes of `enable_thinking:false` on /v1/chat/completions.
    const off: any = { model: "deepseek-v4-flash", thinking: { type: "disabled" }, reasoning_effort: "high" };
    dialect().prepareRequest(off, { thinking: { type: "disabled" } });
    expect(off.thinking).toEqual({ type: "disabled" });
    // The off-switch never rides next to a contradicting depth knob.
    expect(off.reasoning_effort).toBeUndefined();
    // Control: no client ask ⇒ no field, DeepSeek's default stands.
    const absent: any = { model: "deepseek-v4-flash" };
    dialect().prepareRequest(absent, {});
    expect(absent.thinking).toBeUndefined();
  });

  it("emits {type:'disabled'} when the policy is disabled", () => {
    process.env.CLAUDISH_DEEPSEEK_THINKING = "disabled";
    const payload: any = { model: "deepseek-v4-flash-vision-exp", messages: [] };
    dialect().prepareRequest(payload, {});
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("disables even when the client explicitly asked to think", () => {
    // The operator's cost policy wins over the client's request shape;
    // `passthrough` is the opt-out.
    process.env.CLAUDISH_DEEPSEEK_THINKING = "disabled";
    const payload: any = { thinking: { type: "enabled", budget_tokens: 8000 } };
    dialect().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 8000 } });
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("drops a contradicting reasoning_effort when the policy is disabled (upstream 19cdaa6f)", () => {
    // OpenCode Zen 400s `thinking.type='disabled'` next to a non-'none'
    // `reasoning_effort` for deepseek-v4.1-flash (measured upstream 2026-09-19).
    process.env.CLAUDISH_DEEPSEEK_THINKING = "disabled";
    const payload: any = { reasoning_effort: "high" };
    dialect().prepareRequest(payload, {});
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.reasoning_effort).toBeUndefined();
  });

  it("never emits enable_thinking — DeepSeek ignores that spelling", () => {
    // Measured: enable_thinking:false left reasoning at 128 chars. Emitting it
    // would look like a working switch while changing nothing.
    for (const value of ["disabled", "passthrough"]) {
      process.env.CLAUDISH_DEEPSEEK_THINKING = value;
      const payload: any = { thinking: { type: "enabled" } };
      dialect().prepareRequest(payload, { thinking: { type: "enabled" } });
      expect(payload.enable_thinking).toBeUndefined();
      expect(payload.thinking_budget).toBeUndefined();
    }
  });

  it("accepts the documented aliases and falls back to passthrough on garbage", () => {
    for (const value of ["off", "false", "DISABLED"]) {
      process.env.CLAUDISH_DEEPSEEK_THINKING = value;
      const payload: any = {};
      dialect().prepareRequest(payload, {});
      expect(payload.thinking).toEqual({ type: "disabled" });
    }
    for (const value of ["", "passthrough", "client", "default", "yes-please"]) {
      process.env.CLAUDISH_DEEPSEEK_THINKING = value;
      const payload: any = {};
      dialect().prepareRequest(payload, {});
      expect(payload.thinking).toBeUndefined();
    }
  });

  it("is re-read on every request, never cached", () => {
    // The fleet flips this mid-crunch; a cached value would require restarting
    // the proxy that is at that moment keeping everyone working.
    const d = dialect();
    process.env.CLAUDISH_DEEPSEEK_THINKING = "disabled";
    const a: any = {};
    d.prepareRequest(a, {});
    expect(a.thinking).toEqual({ type: "disabled" });

    process.env.CLAUDISH_DEEPSEEK_THINKING = "passthrough";
    const b: any = {};
    d.prepareRequest(b, {});
    expect(b.thinking).toBeUndefined();
  });

  it("still preserves reasoning_content in history under either policy", () => {
    // Load-bearing (fix 911f426): DeepSeek rejects HTTP 400 "The
    // reasoning_content in the thinking mode must be passed back" when history
    // omits it. Probed 2026-09-01: a history carrying reasoning_content plus
    // thinking:{type:"disabled"} returns HTTP 200, so disabling is safe here.
    for (const value of ["disabled", "passthrough"]) {
      process.env.CLAUDISH_DEEPSEEK_THINKING = value;
      expect(dialect().preserveThinkingInHistory()).toBe(true);
    }
  });
});
