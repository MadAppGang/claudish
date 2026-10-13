/**
 * Item 11 — `stop_sequences` → `stop`, and `top_p`, on every OpenAI-shaped
 * payload builder.
 *
 * ## Provenance of the inputs
 *
 * These are REQUEST-side assertions, and the repo's fixture rule ("fixtures come
 * from real debug logs") covers RESPONSE captures — `test-fixtures/sse-responses/`
 * holds streams, not inbound bodies, so no capture in the tree can reach a
 * payload builder. The inputs below are therefore constructed Anthropic request
 * bodies written inline, in the same style as the sibling adapter tests, and they
 * assert only this tree's own conversion contract. Nothing here claims a provider
 * accepts or rejects any particular field.
 */

import { expect, test } from "bun:test";
import { DefaultAPIFormat } from "./base-api-format.js";
import { LiteLLMAPIFormat } from "./litellm-api-format.js";
import { LocalModelAdapter } from "./local-adapter.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";
import { OpenRouterAPIFormat } from "./openrouter-api-format.js";
import { rejectedOptionalParams } from "./optional-param-rejection.js";

/** Every OpenAI-shaped payload builder in the tree, by the name it ships under. */
const BUILDERS: [string, () => { buildPayload: (r: any, m: any[], t: any[]) => any }][] = [
  ["BaseAPIFormat", () => new DefaultAPIFormat("some-model")],
  ["OpenAIAPIFormat", () => new OpenAIAPIFormat("gpt-4o")],
  ["LiteLLMAPIFormat", () => new LiteLLMAPIFormat("gpt-4o", "http://localhost:4000")],
  ["OpenRouterAPIFormat", () => new OpenRouterAPIFormat("openai/gpt-4o", { vendor: "openai" })],
  ["LocalModelAdapter", () => new LocalModelAdapter("qwen2.5-coder", "ollama")],
];

const MESSAGES = [{ role: "user", content: "hi" }];

test("every OpenAI-shaped builder forwards stop_sequences as stop, and top_p", () => {
  const request = {
    model: "whatever",
    max_tokens: 100,
    stop_sequences: ["</result>", "\n\nHuman:"],
    top_p: 0.4,
    messages: MESSAGES,
  };

  for (const [name, make] of BUILDERS) {
    const payload = make().buildPayload(request, MESSAGES, []);
    expect(`${name}: ${JSON.stringify(payload.stop)}`).toBe(
      `${name}: ["</result>","\\n\\nHuman:"]`
    );
    expect(`${name}: ${payload.top_p}`).toBe(`${name}: 0.4`);
  }
});

test("a request with neither field adds neither key", () => {
  for (const [name, make] of BUILDERS) {
    const payload = make().buildPayload({ max_tokens: 100, messages: MESSAGES }, MESSAGES, []);
    expect(`${name}: ${"stop" in payload}`).toBe(`${name}: false`);
    // LocalModelAdapter carries its own family top_p default; every other
    // builder must add no key at all.
    if (name !== "LocalModelAdapter") {
      expect(`${name}: ${"top_p" in payload}`).toBe(`${name}: false`);
    }
  }
});

test("an explicit top_p overrides the local adapter's family default", () => {
  const local = new LocalModelAdapter("qwen2.5-coder", "ollama");
  const withoutIt = local.buildPayload({ max_tokens: 100, messages: MESSAGES }, MESSAGES, []);
  const withIt = local.buildPayload(
    { max_tokens: 100, top_p: 0.05, messages: MESSAGES },
    MESSAGES,
    []
  );

  expect(typeof withoutIt.top_p).toBe("number");
  expect(withIt.top_p).toBe(0.05);
  expect(withIt.top_p).not.toBe(withoutIt.top_p);
});

test("empty stop sequences are dropped, and an all-empty list adds no key", () => {
  const fmt = new OpenAIAPIFormat("gpt-4o");
  expect(
    fmt.buildPayload({ max_tokens: 10, stop_sequences: ["", "STOP", ""] }, MESSAGES, []).stop
  ).toEqual(["STOP"]);
  expect("stop" in fmt.buildPayload({ max_tokens: 10, stop_sequences: [] }, MESSAGES, [])).toBe(
    false
  );
  expect("stop" in fmt.buildPayload({ max_tokens: 10, stop_sequences: [""] }, MESSAGES, [])).toBe(
    false
  );
});

test("top_p: 0 is forwarded — it is a value, not an absence", () => {
  const payload = new OpenAIAPIFormat("gpt-4o").buildPayload(
    { max_tokens: 10, top_p: 0 },
    MESSAGES,
    []
  );
  expect(payload.top_p).toBe(0);
});

// ─── The recovery half ──────────────────────────────────────────────────────
//
// Both fields are sent speculatively, so a strict relay's 4xx must be repairable
// in one retry. The error wordings below are the documented shapes of
// OpenAI-compatible relays, written here — not captured from a live 4xx.

test("a rejection naming a field drops exactly that field", () => {
  const fmt = new OpenAIAPIFormat("gpt-4o");
  const payload = { model: "gpt-4o", stop: ["X"], top_p: 0.4, temperature: 1 };

  const dropped = fmt.recoverFromRejection(payload, "Unrecognized request argument supplied: stop");
  expect(dropped?.payload).toEqual({ model: "gpt-4o", top_p: 0.4, temperature: 1 });
  expect(dropped?.note).toContain("stop");

  const quoted = fmt.recoverFromRejection(payload, "Unexpected keyword argument 'top_p'");
  expect(quoted?.payload).toEqual({ model: "gpt-4o", stop: ["X"], temperature: 1 });

  const leading = fmt.recoverFromRejection(
    payload,
    '{"error":{"message":"stop: Extra inputs are not permitted"}}'
  );
  expect("stop" in (leading?.payload ?? {})).toBe(false);

  const both = fmt.recoverFromRejection(
    payload,
    "Model gpt-4o does not support parameter stop, parameter top_p"
  );
  expect(both?.payload).toEqual({ model: "gpt-4o", temperature: 1 });
});

test("an unrelated 4xx recovers nothing, and prose using the word does not count", () => {
  const fmt = new OpenAIAPIFormat("gpt-4o");
  const payload = { model: "gpt-4o", stop: ["X"], top_p: 0.4 };

  expect(fmt.recoverFromRejection(payload, "Rate limit exceeded")).toBeNull();
  expect(fmt.recoverFromRejection(payload, "invalid_api_key")).toBeNull();
  // A complaint that names a DIFFERENT field must not strip ours.
  expect(fmt.recoverFromRejection(payload, "Unknown parameter: 'reasoning_effort'")).toBeNull();
  // The complaint gate plus a prose use of the word "stop".
  expect(
    fmt.recoverFromRejection(payload, "Invalid request: the model would not stop generating")
  ).toBeNull();
  // Nothing to drop ⇒ nothing returned, even on a naming rejection.
  expect(fmt.recoverFromRejection({ model: "gpt-4o" }, "Unknown parameter: 'stop'")).toBeNull();
});

test("the grok dialect still recovers stop/top_p after its own cases miss", async () => {
  const { GrokModelDialect } = await import("./grok-model-dialect.js");
  const grok = new GrokModelDialect("grok-4.6");
  const recovered = grok.recoverFromRejection(
    { model: "grok-4.6", stop: ["X"] },
    "Unknown parameter: 'stop'"
  );
  expect(recovered?.payload).toEqual({ model: "grok-4.6" });
});

test("rejectedOptionalParams needs both gates", () => {
  // Gate 1 alone: a field name with no complaint.
  expect(rejectedOptionalParams("the stop parameter was applied", ["stop"])).toEqual([]);
  // Gate 2 alone: a complaint naming nothing of ours.
  expect(rejectedOptionalParams("Invalid request", ["stop", "top_p"])).toEqual([]);
  // Both.
  expect(rejectedOptionalParams("Unknown parameter: 'stop'", ["stop", "top_p"])).toEqual(["stop"]);
});
