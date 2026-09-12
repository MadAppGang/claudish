/**
 * Context-overflow interception regression tests (issue #79).
 *
 * The incident (2026-09-10/11): GLM Coding pre-stream 400 `{"code":"1261","message":
 * "Prompt exceeds max length"}` relayed with no `usage` → the client gauge never moved,
 * auto-compact never fired, `/continue` looped all night. These pin the three properties
 * that break that loop: the strict matcher (no false positives on quota/auth errors),
 * the learned cap (pre-flight short-circuit), and the emitted turn (HTTP 200 with a
 * `usage.input_tokens` at or above the compaction floor and a terminal `message_stop`).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  classifyContextOverflow,
  estimatePayloadTokens,
  rememberOverflowCap,
  getOverflowCap,
  resetOverflowCapsForTests,
  overflowReportFloor,
  overflowReportedTokens,
  overflowRecoveryText,
  buildOverflowRecoveryStream,
  buildOverflowRecoveryMessage,
} from "./context-overflow.js";

const GLM_1261 = JSON.stringify({
  error: { code: "1261", message: "Prompt exceeds max length" },
});

describe("classifyContextOverflow", () => {
  it("matches the GLM Coding 1261 incident body verbatim", () => {
    const r = classifyContextOverflow(400, GLM_1261);
    expect(r.matched).toBe(true);
    expect(r.used).toBeUndefined(); // no counts in the body → estimate path
    expect(r.limit).toBeUndefined();
  });

  it("matches Anthropic context_length_exceeded with stated counts", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message:
          "input length and `max_tokens` exceed context limit: input of 310000 tokens, context window of 1000000 tokens, max_tokens 32000 → please reduce input",
      },
    });
    const r = classifyContextOverflow(400, body);
    expect(r.matched).toBe(true);
  });

  it("matches OpenAI 'maximum context length' wording", () => {
    const body = JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 128000 tokens. However, you requested 250000 tokens.",
        type: "invalid_request_error",
      },
    });
    const r = classifyContextOverflow(400, body);
    expect(r.matched).toBe(true);
  });

  it("matches Anthropic native 'prompt is too long'", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long: 250001 tokens > 200000 maximum" },
    });
    const r = classifyContextOverflow(400, body);
    expect(r.matched).toBe(true);
  });

  it("matches a non-JSON body with a known wording", () => {
    expect(classifyContextOverflow(400, "Input exceeds the context window of this model.").matched).toBe(true);
  });

  it("does NOT match the GLM quota wall (1308, 429) — that arms failover, not this", () => {
    const body = JSON.stringify({
      error: {
        code: "1308",
        message: "Usage limit reached for 5 hour. Your limit will reset at 2026-09-11 20:04:03",
      },
    });
    expect(classifyContextOverflow(429, body).matched).toBe(false);
  });

  it("does NOT match a moderation invalid_prompt flag (Responses-lane concern)", () => {
    const body = JSON.stringify({ error: { code: "invalid_prompt", message: "content policy" } });
    expect(classifyContextOverflow(400, body).matched).toBe(false);
  });

  it("does NOT match auth/wiring errors even when the word token appears", () => {
    expect(classifyContextOverflow(400, JSON.stringify({ error: { message: "invalid token" } })).matched).toBe(false);
    expect(classifyContextOverflow(401, JSON.stringify({ error: { message: "bad api token" } })).matched).toBe(false);
    expect(classifyContextOverflow(404, JSON.stringify({ error: { message: "model not found" } })).matched).toBe(false);
  });

  it("does NOT match success or server errors", () => {
    expect(classifyContextOverflow(200, GLM_1261).matched).toBe(false);
    expect(classifyContextOverflow(500, GLM_1261).matched).toBe(false);
    expect(classifyContextOverflow(529, GLM_1261).matched).toBe(false);
  });
});

describe("estimatePayloadTokens", () => {
  it("follows the len/4 convention of the count_tokens estimation route", () => {
    // 400 chars of pure ASCII → 100 tokens
    expect(estimatePayloadTokens({ messages: [{ content: "a".repeat(400 - 40) }] })).toBeGreaterThan(90);
    // JSON.stringify adds the surrounding quotes: 1002 chars → 251 tokens
    expect(estimatePayloadTokens("x".repeat(1000))).toBe(251);
  });

  it("degrades to 0 on non-serializable input rather than throwing", () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(estimatePayloadTokens(cyclic)).toBe(0);
    expect(estimatePayloadTokens(undefined)).toBe(0);
  });
});

describe("learned cap", () => {
  beforeEach(() => resetOverflowCapsForTests());
  afterEach(() => resetOverflowCapsForTests());

  it("is keyed per (provider, model) and returns the last rejected estimate", () => {
    expect(getOverflowCap("GLM Coding", "gc@glm-5.3")).toBeUndefined();
    rememberOverflowCap("GLM Coding", "gc@glm-5.3", 210_000);
    expect(getOverflowCap("GLM Coding", "gc@glm-5.3")).toBe(210_000);
    expect(getOverflowCap("GLM Coding", "gc@glm-5.2")).toBeUndefined();
    rememberOverflowCap("GLM Coding", "gc@glm-5.3", 190_000);
    expect(getOverflowCap("GLM Coding", "gc@glm-5.3")).toBe(190_000);
  });

  it("ignores non-positive or non-finite values", () => {
    rememberOverflowCap("p", "m", 0);
    rememberOverflowCap("p", "m", -5);
    rememberOverflowCap("p", "m", Number.NaN);
    expect(getOverflowCap("p", "m")).toBeUndefined();
  });
});

describe("overflowReportFloor / overflowReportedTokens", () => {
  const KEY = "CLAUDISH_OVERFLOW_REPORT_FLOOR";
  afterEach(() => delete process.env[KEY]);

  it("defaults to the fleet compaction threshold (280k)", () => {
    expect(overflowReportFloor()).toBe(280_000);
  });

  it("honors an explicit override and disables with 0", () => {
    process.env[KEY] = "150000";
    expect(overflowReportFloor()).toBe(150_000);
    process.env[KEY] = "0";
    expect(overflowReportFloor()).toBe(0);
    process.env[KEY] = "not-a-number";
    expect(overflowReportFloor()).toBe(280_000);
  });

  it("reports the max of body-used, estimate and floor", () => {
    expect(overflowReportedTokens(310_000, 200_000, 280_000)).toBe(310_000);
    expect(overflowReportedTokens(undefined, 150_000, 280_000)).toBe(280_000);
    expect(overflowReportedTokens(50_000, 30_000, 0)).toBe(50_000);
    expect(overflowReportedTokens(undefined, 405_000, 280_000)).toBe(405_000);
  });
});

describe("recoverable-turn constructors", () => {
  it("message: single JSON with usage ≥ floor and end_turn", async () => {
    const text = overflowRecoveryText("GLM Coding", "gc@glm-5.3", 205_000);
    const msg = buildOverflowRecoveryMessage(text, 280_000, "claude-sonnet-5") as any;
    expect(msg.type).toBe("message");
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[0].text).toContain("maximum prompt size");
    expect(msg.usage.input_tokens).toBeGreaterThanOrEqual(280_000);
    // No posture instruction — factual notice only (failover-notice doctrine).
    expect(msg.content[0].text).not.toMatch(/risk|apolog|undo/i);
  });

  it("stream: full SSE with terminal message_stop and gauge-advancing usage", async () => {
    const text = overflowRecoveryText("GLM Coding", "gc@glm-5.3", 205_000);
    const res = buildOverflowRecoveryStream(text, 405_000, "claude-sonnet-5");
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const body = await res.text();
    const types = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const delta = body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)))
      .find((e: any) => e.type === "message_delta") as any;
    expect(delta.usage.input_tokens).toBe(405_000);
    expect(delta.delta.stop_reason).toBe("end_turn");

    const start = body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)))
      .find((e: any) => e.type === "message_start") as any;
    expect(start.message.usage.input_tokens).toBe(405_000);
    expect(start.message.model).toBe("claude-sonnet-5");
  });
});
