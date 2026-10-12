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
test("without a vendor the existing prompt and include_reasoning rules remain", () => {
  const format = new OpenRouterAPIFormat("grok-reasoning");
  expect(format.convertMessages(request)[0].content).toContain(
    "MUST use the OpenAI tool_calls format with JSON"
  );
  expect(format.buildPayload(request, [], []).include_reasoning).toBe(true);
});
