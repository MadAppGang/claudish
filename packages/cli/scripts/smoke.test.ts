/**
 * Black-box unit tests for the claudish smoke test framework.
 *
 * Tests are based on expected behavior (requirements + API contracts),
 * not implementation internals.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildSummary } from "./smoke/reporter.js";
import type { ProviderResult, ProbeResult } from "./smoke/types.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeProbe(
  capability: ProbeResult["capability"],
  status: ProbeResult["status"]
): ProbeResult {
  return { capability, status, durationMs: 10 };
}

function makeProviderResult(probeStatuses: ProbeResult["status"][]): ProviderResult {
  const caps: ProbeResult["capability"][] = ["tool_calling", "reasoning", "vision"];
  return {
    provider: "test",
    model: "test-model",
    wireFormat: "openai-compat",
    timestamp: new Date().toISOString(),
    probes: probeStatuses.map((s, i) => makeProbe(caps[i % caps.length], s)),
  };
}

// ─────────────────────────────────────────────────────────────
// buildSummary
// ─────────────────────────────────────────────────────────────

describe("buildSummary", () => {
  it("counts total as number of providers, not probes", () => {
    const results = [makeProviderResult(["pass", "pass", "pass"])];
    const summary = buildSummary(results);
    expect(summary.total).toBe(1); // 1 provider
    expect(summary.passed).toBe(3); // 3 probes passed
  });

  it("returns all zeros for empty results", () => {
    const summary = buildSummary([]);
    expect(summary).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
  });

  it("counts passed, failed, skipped probes across multiple providers", () => {
    const results = [
      makeProviderResult(["pass", "fail", "skip"]),
      makeProviderResult(["pass", "pass", "fail"]),
    ];
    const summary = buildSummary(results);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(2);
    expect(summary.skipped).toBe(1);
  });

  it("handles all-fail scenario correctly", () => {
    const results = [
      makeProviderResult(["fail", "fail", "fail"]),
      makeProviderResult(["fail", "fail", "fail"]),
    ];
    const summary = buildSummary(results);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(6);
    expect(summary.skipped).toBe(0);
  });

  it("handles providers with different probe counts", () => {
    const results: ProviderResult[] = [
      {
        provider: "p1",
        model: "m1",
        wireFormat: "anthropic-compat",
        timestamp: new Date().toISOString(),
        probes: [makeProbe("tool_calling", "pass")],
      },
      {
        provider: "p2",
        model: "m2",
        wireFormat: "openai-compat",
        timestamp: new Date().toISOString(),
        probes: [makeProbe("reasoning", "pass"), makeProbe("vision", "skip")],
      },
    ];
    const summary = buildSummary(results);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.skipped).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Auth header construction (callProvider indirectly via headers)
// ─────────────────────────────────────────────────────────────

// Import buildHeaders indirectly by testing callProvider behavior
// We test the PUBLIC behavior: given authScheme, correct headers must be set.
// We use the exported callProvider and mock fetch.

import { callProvider } from "./smoke/probes.js";
import type { SmokeProviderConfig } from "./smoke/types.js";

function makeConfig(authScheme: SmokeProviderConfig["authScheme"]): SmokeProviderConfig {
  return {
    name: "test",
    baseUrl: "https://api.example.com",
    apiPath: "/v1/messages",
    apiKey: "test-key-xyz",
    authScheme,
    extraHeaders: {},
    wireFormat: "openai-compat",
    representativeModel: "test-model",
    capabilities: { supportsTools: true, supportsVision: true, supportsReasoning: false },
  };
}

describe("callProvider auth headers", () => {
  let capturedHeaders: Headers | null = null;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    capturedHeaders = null;
    originalFetch = globalThis.fetch;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    globalThis.fetch = async (url: any, init?: any) => {
      capturedHeaders = new Headers(init?.headers ?? {});
      return new Response(JSON.stringify({ id: "r1", choices: [] }), { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("x-api-key scheme: sets x-api-key + anthropic-version, no Authorization", async () => {
    const config = makeConfig("x-api-key");
    const signal = new AbortController().signal;
    await callProvider(config, { model: "test", messages: [] }, signal);

    expect(capturedHeaders?.get("x-api-key")).toBe("test-key-xyz");
    expect(capturedHeaders?.get("anthropic-version")).toBe("2023-06-01");
    expect(capturedHeaders?.get("Authorization")).toBeNull();
  });

  it("bearer scheme: sets Authorization Bearer + anthropic-version, no x-api-key", async () => {
    const config = makeConfig("bearer");
    const signal = new AbortController().signal;
    await callProvider(config, { model: "test", messages: [] }, signal);

    expect(capturedHeaders?.get("Authorization")).toBe("Bearer test-key-xyz");
    expect(capturedHeaders?.get("anthropic-version")).toBe("2023-06-01");
    expect(capturedHeaders?.get("x-api-key")).toBeNull();
  });

  it("openai scheme: sets Authorization Bearer, no x-api-key, no anthropic-version", async () => {
    const config = makeConfig("openai");
    const signal = new AbortController().signal;
    await callProvider(config, { model: "test", messages: [] }, signal);

    expect(capturedHeaders?.get("Authorization")).toBe("Bearer test-key-xyz");
    expect(capturedHeaders?.get("x-api-key")).toBeNull();
    expect(capturedHeaders?.get("anthropic-version")).toBeNull();
  });

  it("extraHeaders are included in request", async () => {
    const config = {
      ...makeConfig("openai"),
      extraHeaders: { "X-Custom-Header": "custom-value" },
    };
    const signal = new AbortController().signal;
    await callProvider(config, { model: "test", messages: [] }, signal);

    expect(capturedHeaders?.get("X-Custom-Header")).toBe("custom-value");
  });

  it("throws on non-2xx HTTP status", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const config = makeConfig("openai");
    const signal = new AbortController().signal;

    await expect(callProvider(config, {}, signal)).rejects.toThrow("HTTP 401");
  });
});

// ─────────────────────────────────────────────────────────────
// runProbe: timeout behavior
// ─────────────────────────────────────────────────────────────

import { runProbe } from "./smoke/probes.js";
import type { ProbeFn } from "./smoke/types.js";

describe("runProbe", () => {
  it("returns probe result on success", async () => {
    const fn: ProbeFn = async (config, _signal) => ({
      capability: "tool_calling",
      status: "pass",
      durationMs: 5,
    });

    const result = await runProbe("tool_calling", fn, makeConfig("openai"), 5000);
    expect(result.status).toBe("pass");
    expect(result.capability).toBe("tool_calling");
  });

  it("returns fail with timeout message including actual timeout value", async () => {
    const fn: ProbeFn = async (_config, signal) => {
      // Simulate a fn that respects the abort signal
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    };

    const result = await runProbe("reasoning", fn, makeConfig("openai"), 50); // 50ms timeout
    expect(result.status).toBe("fail");
    expect(result.capability).toBe("reasoning");
    expect(result.reason).toMatch(/50ms/); // must include actual timeout, not hardcoded "30s"
  });

  it("returns fail with error message on thrown error", async () => {
    const fn: ProbeFn = async () => {
      throw new Error("connection refused");
    };

    const result = await runProbe("vision", fn, makeConfig("openai"), 5000);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("connection refused");
  });

  it("returns skip result unchanged when probe returns skip", async () => {
    const fn: ProbeFn = async () => ({
      capability: "tool_calling",
      status: "skip",
      durationMs: 0,
      reason: "provider does not support tools",
    });

    const result = await runProbe("tool_calling", fn, makeConfig("openai"), 5000);
    expect(result.status).toBe("skip");
    expect(result.reason).toBe("provider does not support tools");
  });
});

// ─────────────────────────────────────────────────────────────
// isReasoningModel regex (tested via runReasoningProbe behavior)
// We test the exported regex behavior indirectly via known model IDs.
// ─────────────────────────────────────────────────────────────

// Since isReasoningModel is not exported, we verify the PUBLIC CONTRACT:
// providers with representative models like "deepseek-r1" should be treated
// as reasoning models, while "gpt-4o-mini" should not.
// We test this by checking that the reasoning probe for a non-reasoning model
// accepts any text response (vs requiring thinking tokens).

import { runReasoningProbe } from "./smoke/probes.js";

describe("runReasoningProbe — reasoning model detection", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("non-reasoning model passes with any text content", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "391" } }],
        }),
        { status: 200 }
      );

    const config: SmokeProviderConfig = {
      ...makeConfig("openai"),
      representativeModel: "gpt-4o-mini", // not a reasoning model
    };
    const result = await runReasoningProbe(config, new AbortController().signal);
    expect(result.status).toBe("pass");
  });

  it("model with 'r1' in name is treated as reasoning model (needs thinking or content)", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "391", reasoning_content: "17*23 = 391" },
            },
          ],
        }),
        { status: 200 }
      );

    const config: SmokeProviderConfig = {
      ...makeConfig("openai"),
      representativeModel: "deepseek-r1",
    };
    const result = await runReasoningProbe(config, new AbortController().signal);
    expect(result.status).toBe("pass");
    expect(result.reason).toContain("reasoning_content");
  });

  it("model name containing 'gr1d' should NOT be treated as reasoning model", async () => {
    // 'gr1d' contains r1 but not as a word boundary — should NOT match after our fix
    // (it's an unlikely model name but validates the regex word boundary fix)
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "391" } }],
        }),
        { status: 200 }
      );

    // Non-reasoning model that happens to contain 'r1' in a weird substring
    // "grid-model-1" — 'r1' not at word boundary → should pass as non-reasoning
    const config: SmokeProviderConfig = {
      ...makeConfig("openai"),
      representativeModel: "gr1d-model", // contains 'r1' but not at word boundary
    };
    const result = await runReasoningProbe(config, new AbortController().signal);
    // After word-boundary fix, 'gr1d-model' is NOT a reasoning model → passes with any text
    expect(result.status).toBe("pass");
  });
});

// ─────────────────────────────────────────────────────────────
// Vision error phrase detection
// ─────────────────────────────────────────────────────────────

import { runVisionProbe } from "./smoke/probes.js";

describe("runVisionProbe — error phrase detection", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeVisionConfig(): SmokeProviderConfig {
    return {
      ...makeConfig("openai"),
      capabilities: { supportsTools: true, supportsVision: true, supportsReasoning: false },
    };
  }

  it("passes when model describes image normally", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "This is a small red pixel image." },
            },
          ],
        }),
        { status: 200 }
      );

    const result = await runVisionProbe(makeVisionConfig(), new AbortController().signal);
    expect(result.status).toBe("pass");
  });

  it("fails when model says it cannot process image", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Sorry, I cannot process image inputs in this configuration.",
              },
            },
          ],
        }),
        { status: 200 }
      );

    const result = await runVisionProbe(makeVisionConfig(), new AbortController().signal);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("cannot process");
  });

  it("does NOT falsely fail on 'unsupported' in a normal description", async () => {
    // After removing "unsupported" from VISION_ERROR_PHRASES, this should pass
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content:
                  "The image shows a minimal PNG with an unsupported-looking plain background.",
              },
            },
          ],
        }),
        { status: 200 }
      );

    const result = await runVisionProbe(makeVisionConfig(), new AbortController().signal);
    // Should pass — "unsupported" alone is no longer a VISION_ERROR_PHRASE after our fix
    expect(result.status).toBe("pass");
  });

  it("skips when provider does not support vision", async () => {
    const config: SmokeProviderConfig = {
      ...makeVisionConfig(),
      capabilities: { supportsTools: false, supportsVision: false, supportsReasoning: false },
    };
    const result = await runVisionProbe(config, new AbortController().signal);
    expect(result.status).toBe("skip");
    expect(result.reason).toContain("does not support vision");
  });

  it("fails on empty response", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }],
        }),
        { status: 200 }
      );

    const result = await runVisionProbe(makeVisionConfig(), new AbortController().signal);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("empty response");
  });
});
