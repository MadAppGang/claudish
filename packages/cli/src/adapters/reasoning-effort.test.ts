import { expect, test } from "bun:test";
import { resolveConnection } from "../providers/connection-resolver.js";
import { shapeRequestFromWire, wireChoicesFromClaudeRequest } from "../providers/wire-request.js";
import { CodexAPIFormat } from "./codex-api-format.js";
import { resolveModelDialect } from "./dialect-manager.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";

const cachePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;

test.each(["gpt-5.5", "o3-mini", "o1-mini", "gpt-4-turbo", "fugu-ultra", "gpt-5-codex"])(
  "OpenAI format uses max_tokens without reasoning or name selection for %s",
  (id) => {
    const format = new OpenAIAPIFormat(id);
    const request = {
      max_tokens: 100,
      thinking: { budget_tokens: 40000 },
      output_config: { effort: "high" },
    };
    const payload = format.buildPayload(request, [], []);
    expect(payload.max_tokens).toBe(100);
    for (const key of [
      "reasoning_effort",
      "reasoning",
      "max_completion_tokens",
      "max_output_tokens",
    ])
      expect(payload).not.toHaveProperty(key);
    expect(format.shouldHandle(id)).toBe(false);
    const prepared = format.prepareRequest({ thinking: request.thinking, keep: "yes" }, request);
    expect(prepared).not.toHaveProperty("thinking");
    expect(prepared.keep).toBe("yes");
    expect(prepared).not.toHaveProperty("reasoning_effort");
  }
);

test.each(["gpt-5.5", "o3-mini", "gpt-5-codex", "gpt-5.1-codex-max"])(
  "%s does not select an OpenAI or Codex dialect",
  (id) => {
    expect(resolveModelDialect(id).getName()).toBe("DefaultAPIFormat");
    expect(new CodexAPIFormat(id).shouldHandle(id)).toBe(false);
  }
);

test.each([undefined, "low", "medium", "high", "xhigh", "max"])(
  "Codex format does not invent reasoning or verbosity for effort %s",
  (effort) => {
    const payload = new CodexAPIFormat("gpt-5.1-codex-max").buildPayload(
      { max_tokens: 100, output_config: { effort } },
      [],
      []
    );
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("text");
    expect(payload).not.toHaveProperty("reasoning_effort");
  }
);
test("Codex extras alone enable model normalization, store and include", () => {
  const id = "vendor/exact-model";
  const generic = new CodexAPIFormat(id, undefined, { codexExtras: false }).buildPayload(
    {},
    [],
    []
  );
  expect(generic.model).toBe(id);
  expect(generic).not.toHaveProperty("store");
  expect(generic).not.toHaveProperty("include");
  const codex = new CodexAPIFormat(id).buildPayload({}, [], []);
  expect(codex.model).toBe("exact-model");
  expect(codex.store).toBe(false);
  expect(codex.include).toEqual(["reasoning.encrypted_content"]);
});

test.each([
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["minimal", "low"],
  ["max", "max"],
])("published OpenAI Responses wire maps %s to %s", (effort, expected) => {
  const result = resolveConnection("openai", "gpt-6.1-sol", cachePath);
  if (!result.ok || result.connection.wire.status !== "known")
    throw new Error("missing fixture wire");
  const body: Record<string, unknown> = {};
  shapeRequestFromWire(body, result.connection.wire, {
    ...wireChoicesFromClaudeRequest({ max_tokens: 100, output_config: { effort } }),
    hasTools: false,
  });
  expect(body).toHaveProperty("reasoning.effort", expected);
  expect(body).toHaveProperty("max_output_tokens", 100);
  expect(body).not.toHaveProperty("reasoning_effort");
});
