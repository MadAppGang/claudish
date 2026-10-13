/**
 * Item 10 — `tool_choice: {type:"any"}` reaches the wire, from ONE mapper.
 *
 * Four adapters carried a verbatim copy of a three-branch mapping that handled
 * `tool`, `auto` and `none` and silently dropped `any`. This pins both halves:
 * that `any` now maps (to `required`, `ANY`, or the Responses spelling), and
 * that there is one definition rather than four.
 *
 * ## Provenance of the inputs
 *
 * REQUEST-side, so no capture in this tree can reach it —
 * `test-fixtures/sse-responses/` holds response streams, not inbound bodies.
 * The inputs are constructed Anthropic request bodies written inline, asserting
 * only this tree's own conversion contract. No `.sse` fixture was invented.
 */

import { expect, test } from "bun:test";
import {
  mapToolChoiceToGemini,
  mapToolChoiceToOpenAI,
  mapToolChoiceToResponsesAPI,
} from "../handlers/shared/format/openai-tools.js";
import { DefaultAPIFormat } from "./base-api-format.js";
import { CodexAPIFormat } from "./codex-api-format.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { LiteLLMAPIFormat } from "./litellm-api-format.js";
import { LocalModelAdapter } from "./local-adapter.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";
import { OpenRouterAPIFormat } from "./openrouter-api-format.js";

const MESSAGES = [{ role: "user", content: "hi" }];
const TOOLS = [
  {
    type: "function",
    function: { name: "Read", description: "d", parameters: { type: "object" } },
  },
];

/** Every OpenAI Chat-Completions-shaped builder. */
const CHAT_BUILDERS: [string, () => { buildPayload: (r: any, m: any[], t: any[]) => any }][] = [
  ["BaseAPIFormat", () => new DefaultAPIFormat("some-model")],
  ["OpenAIAPIFormat", () => new OpenAIAPIFormat("gpt-4o")],
  ["LiteLLMAPIFormat", () => new LiteLLMAPIFormat("gpt-4o", "http://localhost:4000")],
  ["OpenRouterAPIFormat", () => new OpenRouterAPIFormat("openai/gpt-4o", { vendor: "openai" })],
  ["LocalModelAdapter", () => new LocalModelAdapter("qwen2.5-coder", "ollama")],
];

test('every OpenAI-shaped builder maps tool_choice "any" to "required"', () => {
  for (const [name, make] of CHAT_BUILDERS) {
    const payload = make().buildPayload(
      { max_tokens: 100, tool_choice: { type: "any" } },
      MESSAGES,
      TOOLS
    );
    expect(`${name}: ${payload.tool_choice}`).toBe(`${name}: required`);
  }
});

test("the other three Claude tool_choice types are unchanged", () => {
  for (const [name, make] of CHAT_BUILDERS) {
    const build = (tool_choice: any) =>
      make().buildPayload({ max_tokens: 100, tool_choice }, MESSAGES, TOOLS).tool_choice;

    expect(`${name}: ${build({ type: "auto" })}`).toBe(`${name}: auto`);
    expect(`${name}: ${build({ type: "none" })}`).toBe(`${name}: none`);
    expect(build({ type: "tool", name: "Read" })).toEqual({
      type: "function",
      function: { name: "Read" },
    });
    // A `tool` choice naming no tool, and an unknown type, send nothing.
    expect(`${name}: ${build({ type: "tool" })}`).toBe(`${name}: undefined`);
    expect(`${name}: ${build({ type: "frobnicate" })}`).toBe(`${name}: undefined`);
    expect(`${name}: ${build(undefined)}`).toBe(`${name}: undefined`);
  }
});

test("Gemini gets a toolConfig, which it had no handling for at all", () => {
  const gemini = new GeminiAPIFormat("gemini-3-pro");
  const geminiTools = [
    { functionDeclarations: [{ name: "Read", parameters: { type: "object" } }] },
  ];
  const build = (tool_choice: any) =>
    gemini.buildPayload({ max_tokens: 100, tool_choice }, MESSAGES, geminiTools).toolConfig;

  expect(build({ type: "any" })).toEqual({ functionCallingConfig: { mode: "ANY" } });
  expect(build({ type: "auto" })).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  expect(build({ type: "none" })).toEqual({ functionCallingConfig: { mode: "NONE" } });
  expect(build({ type: "tool", name: "Read" })).toEqual({
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Read"] },
  });
  expect(build(undefined)).toBeUndefined();

  // No tools ⇒ no toolConfig: a functionCallingConfig with nothing to call is a
  // request-level 400.
  expect(
    gemini.buildPayload({ max_tokens: 100, tool_choice: { type: "any" } }, MESSAGES, []).toolConfig
  ).toBeUndefined();
});

test("Codex gets the Responses spelling, where the function form is flat", () => {
  const codex = new CodexAPIFormat("gpt-5.1-codex");
  const build = (tool_choice: any) =>
    codex.buildPayload({ max_tokens: 100, tool_choice }, MESSAGES, TOOLS).tool_choice;

  expect(build({ type: "any" })).toBe("required");
  expect(build({ type: "tool", name: "Read" })).toEqual({ type: "function", name: "Read" });
  expect(build(undefined)).toBeUndefined();
  expect(
    codex.buildPayload({ max_tokens: 100, tool_choice: { type: "any" } }, MESSAGES, []).tool_choice
  ).toBeUndefined();
});

test("the mapper takes an encodeName, so tool_choice can name the wire's own name", () => {
  const upper = (n: string) => n.toUpperCase();
  expect(mapToolChoiceToOpenAI({ type: "tool", name: "Read" }, upper)).toEqual({
    type: "function",
    function: { name: "READ" },
  });
  expect(mapToolChoiceToResponsesAPI({ type: "tool", name: "Read" }, upper)).toEqual({
    type: "function",
    name: "READ",
  });
  expect(mapToolChoiceToGemini({ type: "tool", name: "Read" }, upper)).toEqual({
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["READ"] },
  });
  // encodeName applies to the NAME only — the string forms have no name to encode.
  expect(mapToolChoiceToOpenAI({ type: "any" }, upper)).toBe("required");
});

test("there is ONE tool_choice mapping, not one per adapter", async () => {
  // A structural guard: the four-branch literal that used to live in each
  // builder must not come back. Anything assigning `payload.tool_choice` from a
  // destructured `{ type, name }` is a second definition of this mapping.
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url).pathname;
  const offenders: string[] = [];
  const mapperUsers: string[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    // The Anthropic wire forwards tool_choice verbatim — no mapping to share.
    if (file === "anthropic-api-format.ts") continue;
    const src = readFileSync(dir + file, "utf8");
    if (/const \{ type, name \} = \w+\.tool_choice/.test(src)) offenders.push(file);
    if (/mapToolChoiceTo(OpenAI|Gemini|ResponsesAPI)\(/.test(src)) mapperUsers.push(file);
  }

  expect(offenders).toEqual([]);
  // Not vacuous: the walk really did read the adapters, and all six builders
  // reach the shared mapper.
  expect(mapperUsers.sort()).toEqual([
    "base-api-format.ts",
    "codex-api-format.ts",
    "gemini-api-format.ts",
    "litellm-api-format.ts",
    "local-adapter.ts",
    "openai-api-format.ts",
    "openrouter-api-format.ts",
  ]);
});
