import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../providers/catalog-client.js";
import { OpenRouterAPIFormat } from "./openrouter-api-format.js";

beforeEach(() => _setCatalogEntriesForTest(null));
afterEach(() => _resetCatalogClient());
const request = { messages: [{ role: "user", content: "hello" }], max_tokens: 100 };

test("x-ai vendor adds the Grok tool-format prompt to an opaque id", () => {
  const messages = new OpenRouterAPIFormat("opaque-model", { vendor: "x-ai" }).convertMessages(
    request
  );
  expect(messages[0].role).toBe("system");
  expect(messages[0].content).toContain("MUST use the OpenAI tool_calls format with JSON");
});
test("openai vendor suppresses Grok and Gemini name-picked prompts", () => {
  const format = new OpenRouterAPIFormat("grok-gemini-reasoning", { vendor: "openai" });
  expect(format.convertMessages(request)).toEqual(request.messages);
  expect(format.getName()).toBe("OpenRouterAPIFormat(DefaultAPIFormat)");
});
test.each(["x-ai", "openai", "google"])("vendor %s does not emit include_reasoning", (vendor) => {
  const format = new OpenRouterAPIFormat("o3-reasoning", { vendor });
  expect(format.buildPayload(request, [], [])).not.toHaveProperty("include_reasoning");
});
test("google vendor selects Gemini behavior for an opaque id", () => {
  const format = new OpenRouterAPIFormat("opaque-model", { vendor: "google" });
  expect(format.getName()).toBe("OpenRouterAPIFormat(GeminiAPIFormat)");
  expect(format.convertMessages(request)[0].content).toContain(
    "Keep ALL internal reasoning INTERNAL"
  );
  expect(
    format.extractThoughtSignaturesFromReasoningDetails([
      { type: "reasoning.encrypted", id: "call_1", data: "signed-thought" },
    ])
  ).toEqual(new Map([["call_1", "signed-thought"]]));
});
test("unknown vendor does not infer prompts or reasoning from the name", () => {
  const format = new OpenRouterAPIFormat("grok-gemini-o3-reasoning", { vendor: "" });
  expect(format.convertMessages(request)).toEqual(request.messages);
  const body = format.buildPayload({ ...request, thinking: { type: "enabled" } }, [], []);
  expect(body).not.toHaveProperty("include_reasoning");
  expect(body).not.toHaveProperty("thinking");
});
