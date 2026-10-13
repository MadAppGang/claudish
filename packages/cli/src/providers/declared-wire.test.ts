import { expect, test } from "bun:test";
import { declaredConnection, declaredWire } from "./declared-wire.js";
import { shapeRequestFromWire } from "./wire-request.js";

test.each([
  ["chat-completions", "max_tokens"],
  ["anthropic-messages", "max_tokens"],
  ["responses", "max_output_tokens"],
] as const)("%s defaults to %s without reasoning", (api, tokenParam) => {
  const wire = declaredWire(api, undefined);
  expect(wire).toMatchObject({
    status: "known",
    api,
    tokenParam,
    reasoning: { status: "unknown" },
  });
  const body = {};
  shapeRequestFromWire(body, wire, { maxTokens: 512, hasTools: false });
  expect(body).toEqual({ [tokenParam]: 512 });
});

test("declared API overrides the transport and selects its token default", () => {
  expect(declaredWire("chat-completions", { api: "responses" })).toMatchObject({
    api: "responses",
    tokenParam: "max_output_tokens",
  });
});
test("explicit token field is honored and none removes the limit", () => {
  expect(declaredWire("chat-completions", { tokenParam: "max_completion_tokens" }).tokenParam).toBe(
    "max_completion_tokens"
  );
  const wire = declaredWire("responses", { tokenParam: "none" });
  expect(wire.tokenParam).toEqual({ status: "not_applicable" });
  const body: Record<string, unknown> = { max_tokens: 42 };
  shapeRequestFromWire(body, wire, { maxTokens: 512, hasTools: false });
  expect(body).toEqual({});
});
test("declared effort uses identity values and its default", () => {
  const wire = declaredWire("chat-completions", {
    reasoning: { effort: { path: "/reasoning_effort", default: "medium" } },
  });
  expect(wire.reasoning).toMatchObject({
    status: "supported",
    effort: {
      path: "/reasoning_effort",
      default: "medium",
      values: {
        none: "none",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    },
  });
  const body = {};
  shapeRequestFromWire(body, wire, { hasTools: false });
  expect(body).toEqual({ reasoning_effort: "medium" });
});
test("enable and disable declarations are retained without inventing effort", () => {
  const reasoning = {
    enable: [{ path: "/thinking", value: true }],
    disable: [{ path: "/thinking", value: false }],
  };
  expect(declaredWire("chat-completions", { reasoning }).reasoning).toEqual({
    status: "supported",
    ...reasoning,
    effort: { status: "unknown" },
    mode: { status: "unknown" },
  });
});
test("declared connection identifies its endpoint and generation", () => {
  const wire = declaredWire("responses", undefined);
  expect(
    declaredConnection("custom", "qwen3-thinking", "https://example.invalid/v1", wire)
  ).toMatchObject({
    provider: "custom",
    modelId: "qwen3-thinking",
    externalModelId: "qwen3-thinking",
    generationId: "declared",
    wire,
    profile: { apis: { responses: { baseUrl: "https://example.invalid/v1" } } },
  });
});
