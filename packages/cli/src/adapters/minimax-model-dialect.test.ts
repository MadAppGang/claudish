/**
 * MiniMaxModelDialect — thinking-policy tests.
 *
 * The behavior these pin (measured 2026-09-23 on the hub's haiku lane,
 * mmc@MiniMax-M3): unlike Qwen/GLM/DeepSeek, MiniMax does NOT think by
 * default — it honors the client's `thinking` value exactly. Claude Code
 * sends `{"type":"disabled"}` for every haiku-role/subagent request, the
 * proxy forwarded it verbatim, and 388/388 captured responses carried zero
 * `thinking_delta`: the model never reasoned. `forced` rewrites the outbound
 * request so it does — the response-side filter (parser
 * clientRequestedThinking) keeps the blocks out of a client that did not
 * ask for them.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { MiniMaxModelDialect } from "./minimax-model-dialect.js";

const ORIGINAL = process.env.CLAUDISH_MINIMAX_THINKING;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDISH_MINIMAX_THINKING;
  else process.env.CLAUDISH_MINIMAX_THINKING = ORIGINAL;
});

function dialect() {
  return new MiniMaxModelDialect("MiniMax-M3");
}

const ANTHROPIC = { wireFormat: "anthropic-sse" as const };
const OPENAI = { wireFormat: "openai-sse" as const };

describe("MiniMaxModelDialect — thinking policy (anthropic wire)", () => {
  it("defaults to passthrough: the client's disabled stays disabled", () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("forced rewrites a client-disabled request to enabled with the default budget", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });

  it("forced rewrites an absent thinking field too", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000 };
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });

  it("forced:<n> carries the configured budget", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced:8000";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  });

  it("forced leaves a client that already asked for thinking untouched", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced:8000";
    const payload: any = {
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    };
    dialect().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 4096 } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("forced leaves an ADAPTIVE client untouched (a request, not an opt-out)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, thinking: { type: "adaptive" } };
    dialect().prepareRequest(payload, { thinking: { type: "adaptive" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "adaptive" });
  });

  it("forced skips when the budget would not fit under max_tokens", () => {
    // Mirrors the Qwen constraint: an endpoint rejecting
    // max_tokens <= budget_tokens must not see the forced value — the request
    // goes out with the client's value rather than failing.
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 8000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("disabled forces the off switch even when the client asked", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "disabled";
    const payload: any = {
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    };
    dialect().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 4096 } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});

describe("MiniMaxModelDialect — policy scope guards", () => {
  it("forced is inert on the OpenAI wire (the `thinking` object is not that wire's switch)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, OPENAI);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("forced is inert without a wire context (unit-test call shape)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } });
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("an unrecognized value falls back to passthrough", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "budget:4096";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});

describe("MiniMaxModelDialect — temperature clamp still applies", () => {
  it("clamps 0 → 0.01 regardless of thinking policy", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, temperature: 0 };
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.temperature).toBe(0.01);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });
});

// #324 B1 — the inbound half of the #295 chain. Signature shapes below are
// the PRODUCTION ones, not invented: M3's implicit signature is the SHA-256
// of the empty string (fixtures minimax-m3-anthropic-implicit-signature
// r10324/r10416), M2.5's varies but stays a 64-hex digest (m25-turn1), and
// m25-turn2/3 carry no signature at all. An Anthropic signature is a long
// opaque base64 blob and never 64-hex.
const M3_SIG = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const M25_SIG = "7caa0d3cc2a449ac1cc68507504693f566245c7b5db3558f6041585e15a848f8";
const ANTHROPIC_BLOB =
  "Eo8BCpoKBgcKBWRvbGxhEgxPcmljZSB0b2tlbjKgAZf2hkh6gH0S2kJDZm9vYmFyYmF6cXV1eDNjdmJubWw4cHl0enIxOXF3dHFvcnN0dXYzeHl6MjBzdHJpbmdfZm9vYmFy";

// effort:<level> — the DOCUMENTED M3.1-Flash thinking-depth knob
// (output_config.effort, low..max, defaults to MAX when omitted — Anthropic-
// compat doc, 2026-10-19). budget_tokens is not in the doc; whether Flash
// honors it is unmeasured (forced never rewrites a client-requested budget,
// and production clients send 31999 — the 4000 cap reached 2 of 3 303
// requests): effort is the first lever reaching the client-enabled requests,
// Flash-gated, sharing `forced`'s filter semantics because Flash always thinks.
describe("MiniMaxModelDialect — effort policy (M3.1-Flash thinking depth)", () => {
  const flash = () => new MiniMaxModelDialect("MiniMax-M3.1-Flash");

  it("effort:medium injects output_config.effort on the anthropic wire", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:medium";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    flash().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.output_config).toEqual({ effort: "medium" });
  });

  it("effort never rewrites a thinking VALUE — but the Flash 2013 guard below rewrites disabled (see dedicated describe)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:low";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    flash().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "adaptive" }); // 400/2013 guard, not the effort policy
    expect(payload.output_config).toEqual({ effort: "low" });
  });

  it("effort applies even when the client already asked for thinking (unlike forced)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:xhigh";
    const payload: any = {
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    };
    flash().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 4096 } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(payload.output_config).toEqual({ effort: "xhigh" });
  });

  it("effort preserves other output_config fields the client may carry", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:medium";
    const payload: any = { max_tokens: 32000, output_config: { service_tier: "standard" } };
    flash().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.output_config).toEqual({ service_tier: "standard", effort: "medium" });
  });

  it("effort is IGNORED for non-Flash models (the field is M3.1-Flash-only in the doc)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:medium";
    const payload: any = { max_tokens: 32000 };
    dialect().prepareRequest(payload, {}, ANTHROPIC); // MiniMax-M3
    expect(payload.output_config).toBeUndefined();
    expect(payload.thinking).toBeUndefined();
  });

  it("effort is inert on the OpenAI wire (same scope guard as forced)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:medium";
    const payload: any = { max_tokens: 32000 };
    flash().prepareRequest(payload, {}, OPENAI);
    expect(payload.output_config).toBeUndefined();
  });

  it("an invalid level (effort:ultra) falls back to passthrough — no output_config", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:ultra";
    const payload: any = { max_tokens: 32000 };
    flash().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.output_config).toBeUndefined();
  });

  it("effort shares forced's filter semantics: shouldFilterThinking false, own-digest blocks preserved", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:medium";
    expect(flash().shouldFilterThinking()).toBe(false);
    expect(flash().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: M3_SIG })).toBe(true);
    expect(
      flash().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: ANTHROPIC_BLOB })
    ).toBe(false);
  });
});

// default:<level> (#669) — the fill-only form of effort:<level>. Flash
// defaults to MAX effort when the field is absent; an operator who wants that
// bounded cannot use effort: (it would also overwrite clients that picked
// their own depth — the measured over-write is what #669 exists to avoid).
// default: applies the level ONLY to requests carrying no output_config.effort
// of their own; a client-sent value is kept byte-identical.
describe("MiniMaxModelDialect — default-effort policy (#669: fill only an absent effort)", () => {
  const flash = () => new MiniMaxModelDialect("MiniMax-M3.1-Flash");

  it("default:medium injects effort when the client sent none (AC1)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "default:medium";
    const payload: any = { max_tokens: 32000 };
    flash().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.output_config).toEqual({ effort: "medium" });
  });

  it("keeps a client-sent effort untouched — the policy only fills a gap (AC2)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "default:low";
    const payload: any = { max_tokens: 32000, output_config: { effort: "high" } };
    flash().prepareRequest(payload, { output_config: { effort: "high" } }, ANTHROPIC);
    expect(payload.output_config).toEqual({ effort: "high" });
  });

  it("sibling output_config fields survive when the level is injected", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "default:xhigh";
    const payload: any = { max_tokens: 32000, output_config: { service_tier: "flex" } };
    flash().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.output_config).toEqual({ service_tier: "flex", effort: "xhigh" });
  });

  it("same Flash gate as effort: — inert for non-Flash models", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "default:medium";
    const payload: any = { max_tokens: 32000 };
    dialect().prepareRequest(payload, {}, ANTHROPIC); // MiniMax-M3
    expect(payload.output_config).toBeUndefined();
  });

  it("same OpenAI-wire gate — inert outside anthropic-sse", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "default:medium";
    const payload: any = { max_tokens: 32000 };
    flash().prepareRequest(payload, {}, OPENAI);
    expect(payload.output_config).toBeUndefined();
  });

  it("an invalid level (default:ultra) falls back to passthrough — no output_config (AC4)", () => {
    // The unrecognized-value path is shared: default:ultra matches neither
    // regex, so it lands on the existing marker + passthrough fall-through.
    process.env.CLAUDISH_MINIMAX_THINKING = "default:ultra";
    const payload: any = { max_tokens: 32000 };
    flash().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.output_config).toBeUndefined();
    expect(payload.thinking).toBeUndefined();
  });

  it("a bare 'default' (no level) stays passthrough", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "default";
    const payload: any = { max_tokens: 32000 };
    flash().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.output_config).toBeUndefined();
  });

  it("does not enter the forced/disabled thinking block — client thinking is not rewritten", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "default:medium";
    const payload: any = { max_tokens: 32000 };
    flash().prepareRequest(payload, {}, ANTHROPIC);
    // thinking stays absent (no forced injection); only the Flash 2013 guard
    // would touch a client-disabled request, which is a model constraint.
    expect(payload.thinking).toBeUndefined();
  });

  it("shares effort's filter semantics — Flash always thinks, blocks preserved", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "default:low";
    expect(flash().shouldFilterThinking()).toBe(false);
    expect(flash().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: M3_SIG })).toBe(true);
    expect(
      flash().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: ANTHROPIC_BLOB })
    ).toBe(false);
  });
});

describe("MiniMaxModelDialect — M3.1-Flash disabled guard (400/2013)", () => {
  /**
   * Flash cannot think less than adaptive: `thinking.type:"disabled"` on the
   * wire is a 400/2013 ("requires adaptive thinking; thinking.type='disabled'
   * … is not allowed"). Claude Code's WebFetch one-shots (msgs=1, haiku role)
   * send disabled; under the deployed effort:medium policy nothing rewrote it
   * (effort deliberately never touches `thinking`), and the client took the
   * 400 straight back (measured 2026-10-21 20:47Z, 9 requests 16:21Z→).
   * The guard is a MODEL constraint: every policy, after the policy block.
   */
  const flash = () => new MiniMaxModelDialect("MiniMax-M3.1-Flash");

  it("passthrough: a client-disabled request is rewritten to adaptive", () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    flash().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "adaptive" });
  });

  it("operator disabled on Flash is caught too — the guard runs AFTER the policy block", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "disabled";
    const payload: any = { max_tokens: 32000 };
    flash().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "adaptive" });
  });

  it("M3 (non-Flash) keeps disabled — it accepts the off switch", () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("inert on the OpenAI wire — `thinking` is not the switch that endpoint reads", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "effort:medium";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    flash().prepareRequest(payload, { thinking: { type: "disabled" } }, OPENAI);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("client adaptive and enabled pass through untouched", () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const adaptive: any = { max_tokens: 32000, thinking: { type: "adaptive" } };
    flash().prepareRequest(adaptive, { thinking: { type: "adaptive" } }, ANTHROPIC);
    expect(adaptive.thinking).toEqual({ type: "adaptive" });
    const enabled: any = { max_tokens: 32000, thinking: { type: "enabled", budget_tokens: 4096 } };
    flash().prepareRequest(enabled, { thinking: { type: "enabled", budget_tokens: 4096 } }, ANTHROPIC);
    expect(enabled.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("no ctx — the guard stays inert (same scope guard as the policy blocks)", () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    flash().prepareRequest(payload, { thinking: { type: "disabled" } });
    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});

describe("MiniMaxModelDialect — preserveThinkingBlock (#324 B1 discriminant)", () => {
  it("forced: M3's own digest signature (SHA-256 of the empty string) is preserved", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: M3_SIG })).toBe(true);
  });

  it("forced: M2.5's varying 64-hex digest is preserved", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: M25_SIG })).toBe(true);
  });

  it("forced: an unsigned block (m25 turns 2-3 shape) is preserved — Anthropic never emits unsigned thinking", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…" })).toBe(true);
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: "" })).toBe(true);
  });

  it("forced: a foreign Anthropic blob signature is NOT preserved (cascade-switch shape: Opus session fell to a MiniMax step)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    expect(
      dialect().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: ANTHROPIC_BLOB })
    ).toBe(false);
  });

  it("forced: any other non-digest signature shape is NOT preserved", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: "sig-abc123" })).toBe(false);
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: "A".repeat(64) })).toBe(false);
  });

  it("passthrough: nothing is preserved — the strip-everything default stands", () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: M3_SIG })).toBe(false);
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…" })).toBe(false);
  });

  it("disabled: nothing is preserved (the model emits no block, nothing to round-trip)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "disabled";
    expect(dialect().preserveThinkingBlock({ type: "thinking", thinking: "…", signature: M3_SIG })).toBe(false);
  });

  // Review #324 point 3 — pin WHY the fix is a per-block hook and not the
  // boolean: preserveThinkingInHistory() ALSO feeds reasoningRoundtrip in
  // ComposedHandler.convertMessages (OpenAI wire, reasoning_content
  // echo-back). Flipping it true for MiniMax would emit reasoning_content on
  // OpenAI-shaped routings the policy was never measured on. MiniMax lanes
  // run anthropic-sse, where the per-block hook is the only consulted seam.
  it("preserveThinkingInHistory() stays false — MiniMax must not opt into the OpenAI reasoning_content round-trip", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    expect(dialect().preserveThinkingInHistory()).toBe(false);
  });
});
