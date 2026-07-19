import { describe, expect, test } from "bun:test";
import {
  CLASSIFIER_SYSTEM_MARKER,
  DEFAULT_CLASSIFIER_MODEL,
  classifierPassthroughEnabled,
  isAutoModeClassifierRequest,
  resolveClassifierConfig,
  rewriteClassifierForNative,
} from "./classifier-passthrough.js";

// The auto-mode classifier's system prompt is a full block that STARTS with the marker.
const CLASSIFIER_SYSTEM_BLOCK = `${CLASSIFIER_SYSTEM_MARKER} Evaluate the following tool call and decide whether it is safe to run automatically.`;
// The classifier request's system[0] is a separate billing-header block; the marker
// block comes LATER — the real wire shape, which detection must scan past.
const BILLING_BLOCK = "x-anthropic-billing-header: some-opaque-token-value-here";

describe("isAutoModeClassifierRequest", () => {
  test("matches system as a plain string", () => {
    expect(isAutoModeClassifierRequest({ system: CLASSIFIER_SYSTEM_BLOCK })).toBe(true);
  });

  test("matches the marker in a LATER block (billing header is system[0]) — the real shape", () => {
    const body = {
      model: "claude-opus-4-8",
      system: [
        { type: "text", text: BILLING_BLOCK },
        { type: "text", text: CLASSIFIER_SYSTEM_BLOCK },
      ],
    };
    expect(isAutoModeClassifierRequest(body)).toBe(true);
  });

  test("matches even with leading whitespace before the marker", () => {
    const body = { system: [{ type: "text", text: `\n  ${CLASSIFIER_SYSTEM_BLOCK}` }] };
    expect(isAutoModeClassifierRequest(body)).toBe(true);
  });

  test("does NOT match the main Claude Code prompt", () => {
    const body = {
      model: "claude-opus-4-8",
      system: [
        { type: "text", text: BILLING_BLOCK },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
    };
    expect(isAutoModeClassifierRequest(body)).toBe(false);
  });

  test("does NOT match when the marker appears mid-text (not at the start of a block)", () => {
    const body = { system: `Preamble. ${CLASSIFIER_SYSTEM_MARKER}` };
    expect(isAutoModeClassifierRequest(body)).toBe(false);
  });

  test("returns false for empty / missing / malformed system", () => {
    expect(isAutoModeClassifierRequest({})).toBe(false);
    expect(isAutoModeClassifierRequest({ system: [] })).toBe(false);
    expect(isAutoModeClassifierRequest({ system: [{ type: "image", source: {} }] })).toBe(false);
    expect(isAutoModeClassifierRequest(null)).toBe(false);
    expect(isAutoModeClassifierRequest("not an object")).toBe(false);
    expect(isAutoModeClassifierRequest({ system: 42 })).toBe(false);
  });
});

describe("rewriteClassifierForNative", () => {
  test("forces the model and strips thinking, leaving other fields intact", () => {
    const body: Record<string, unknown> = {
      model: "claude-opus-4-8",
      thinking: { type: "enabled", budget_tokens: 1024 },
      temperature: 0,
      system: [{ type: "text", text: CLASSIFIER_SYSTEM_BLOCK }],
    };
    rewriteClassifierForNative(body, "claude-sonnet-5");
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0);
    expect(body.system).toBeDefined();
  });

  test("is a no-op on thinking when absent", () => {
    const body: Record<string, unknown> = { model: "claude-opus-4-8" };
    rewriteClassifierForNative(body, "claude-sonnet-5");
    expect(body.model).toBe("claude-sonnet-5");
    expect("thinking" in body).toBe(false);
  });
});

describe("resolveClassifierConfig", () => {
  const emptyEnv: NodeJS.ProcessEnv = {};

  test("default OFF when nothing is set", () => {
    const r = resolveClassifierConfig({}, emptyEnv);
    expect(r.enabled).toBe(false);
    expect(r.model).toBe(DEFAULT_CLASSIFIER_MODEL);
  });

  test("--classifier-provider anthropic enables with the default model", () => {
    const r = resolveClassifierConfig({ classifierProvider: "anthropic" }, emptyEnv);
    expect(r).toEqual({ enabled: true, model: DEFAULT_CLASSIFIER_MODEL });
  });

  test("--classifier-model enables and sets the model", () => {
    const r = resolveClassifierConfig({ classifierModel: "claude-3-5-haiku" }, emptyEnv);
    expect(r).toEqual({ enabled: true, model: "claude-3-5-haiku" });
  });

  test("CLAUDISH_CLASSIFIER_PROVIDER=anthropic enables via env", () => {
    const r = resolveClassifierConfig({}, { CLAUDISH_CLASSIFIER_PROVIDER: "anthropic" });
    expect(r).toEqual({ enabled: true, model: DEFAULT_CLASSIFIER_MODEL });
  });

  test("CLAUDISH_CLASSIFIER_MODEL enables via env and sets the model", () => {
    const r = resolveClassifierConfig({}, { CLAUDISH_CLASSIFIER_MODEL: "claude-sonnet-5-env" });
    expect(r).toEqual({ enabled: true, model: "claude-sonnet-5-env" });
  });

  test("flag model wins over env model", () => {
    const r = resolveClassifierConfig(
      { classifierModel: "flag-model" },
      { CLAUDISH_CLASSIFIER_MODEL: "env-model", CLAUDISH_CLASSIFIER_PROVIDER: "anthropic" }
    );
    expect(r).toEqual({ enabled: true, model: "flag-model" });
  });

  test("a non-anthropic provider value does not enable on its own", () => {
    const r = resolveClassifierConfig({ classifierProvider: "openai" }, emptyEnv);
    expect(r.enabled).toBe(false);
  });

  test("provider matching is case-insensitive and whitespace-tolerant", () => {
    expect(resolveClassifierConfig({ classifierProvider: "  Anthropic " }, emptyEnv).enabled).toBe(
      true
    );
    expect(resolveClassifierConfig({}, { CLAUDISH_CLASSIFIER_PROVIDER: "ANTHROPIC" }).enabled).toBe(
      true
    );
  });
});

describe("classifierPassthroughEnabled", () => {
  test("mirrors resolveClassifierConfig().enabled", () => {
    expect(classifierPassthroughEnabled({}, {})).toBe(false);
    expect(classifierPassthroughEnabled({ classifierProvider: "anthropic" }, {})).toBe(true);
    expect(classifierPassthroughEnabled({}, { CLAUDISH_CLASSIFIER_MODEL: "m" })).toBe(true);
  });
});
