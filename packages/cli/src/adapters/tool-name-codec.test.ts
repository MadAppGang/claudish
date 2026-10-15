/**
 * Item 7 — the reversible 64-char tool-name codec, and the one pass that
 * applies it.
 *
 * ## Provenance of the inputs
 *
 * REQUEST-side. `test-fixtures/sse-responses/` holds response streams, not
 * inbound bodies, so no capture in the tree can reach a payload builder or
 * `prepareRequest`. The payloads below are constructed inline and assert only
 * this tree's own contract. No `.sse` fixture was invented. The decode half,
 * which IS response-side, is exercised in
 * `handlers/shared/stream-parsers/tool-name-mangling.test.ts`.
 */

import { expect, test } from "bun:test";
import { AnthropicAPIFormat } from "./anthropic-api-format.js";
import { DefaultAPIFormat } from "./base-api-format.js";
import { CodexAPIFormat } from "./codex-api-format.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";
import { TOOL_NAME_SHAPE, encodeToolName, newToolNameBindings } from "./tool-name-utils.js";

/** A real one, from the magus browser-use MCP server. 65 characters. */
const REAL_LONG_NAME = "mcp__plugin_browser-use_browser-use__retry_with_browser_use_agent";

const WIRE_CHARSET = /^[A-Za-z0-9_-]{1,64}$/;

test("the motivating name is genuinely over the limit", () => {
  expect(REAL_LONG_NAME.length).toBeGreaterThan(64);
});

test("a name that already fits the wire is returned untouched", () => {
  const b = newToolNameBindings();
  expect(encodeToolName("Read", 64, b)).toBe("Read");
  expect(encodeToolName("mcp__magus__team", 64, b)).toBe("mcp__magus__team");
});

test("an over-long name becomes exactly 64 wire-legal characters, and decodes", () => {
  const b = newToolNameBindings();
  const encoded = encodeToolName(REAL_LONG_NAME, 64, b);

  expect(encoded.length).toBe(64);
  expect(encoded).toMatch(WIRE_CHARSET);
  // It must also satisfy the ONE definition of a tool name's shape, or the
  // recovery path and the stats recorder will reject what we ourselves sent.
  expect(TOOL_NAME_SHAPE.test(encoded)).toBe(true);
  expect(b.byEncoded.get(encoded)).toBe(REAL_LONG_NAME);
});

test("characters the wire refuses are mapped out", () => {
  const b = newToolNameBindings();
  const encoded = encodeToolName("server.tool:v2", 64, b);
  expect(encoded).toBe("server_tool_v2");
  expect(encoded).toMatch(WIRE_CHARSET);
  expect(b.byEncoded.get(encoded)).toBe("server.tool:v2");
});

test("SHORT names that transform onto each other do not collide", () => {
  // The defect this closes: `a.b` and `a_b` both charset-map to `a_b`, at a
  // length no truncation rule would ever look at. Whichever registered last
  // used to own the name, so the model's call went to the wrong tool.
  const b = newToolNameBindings();
  const first = encodeToolName("a_b", 64, b);
  const second = encodeToolName("a.b", 64, b);

  expect(first).toBe("a_b");
  expect(second).not.toBe(first);
  expect(second).toMatch(WIRE_CHARSET);
  expect(b.byEncoded.get(first)).toBe("a_b");
  expect(b.byEncoded.get(second)).toBe("a.b");
});

test("an identity encoding still CLAIMS the name, whichever order they arrive in", () => {
  const b = newToolNameBindings();
  // Reverse order of the previous test: the dotted one goes first and takes
  // `a_b`; the literal `a_b` must then be moved, not silently overwritten.
  const dotted = encodeToolName("a.b", 64, b);
  const literal = encodeToolName("a_b", 64, b);

  expect(dotted).toBe("a_b");
  expect(literal).not.toBe(dotted);
  expect(b.byEncoded.get(dotted)).toBe("a.b");
  expect(b.byEncoded.get(literal)).toBe("a_b");
});

test("encoding is stable within a request", () => {
  const b = newToolNameBindings();
  const once = encodeToolName(REAL_LONG_NAME, 64, b);
  const twice = encodeToolName(REAL_LONG_NAME, 64, b);
  expect(twice).toBe(once);
  // …and deterministic across requests, so a name in HISTORY encodes to the
  // same thing as the same name in `tools[]`.
  expect(encodeToolName(REAL_LONG_NAME, 64, newToolNameBindings())).toBe(once);
});

test("encoding an already-encoded name is the identity — the pass is idempotent", () => {
  const first = newToolNameBindings();
  const encoded = encodeToolName(REAL_LONG_NAME, 64, first);
  const second = newToolNameBindings();
  expect(encodeToolName(encoded, 64, second)).toBe(encoded);
});

// ─── The limit is a rule about the wire ─────────────────────────────────────

test("64 on OpenAI-shaped wires, null on every other", () => {
  expect(new OpenAIAPIFormat("gpt-4o").getToolNameLimit()).toBe(64);
  expect(new CodexAPIFormat("gpt-5.1-codex").getToolNameLimit()).toBe(64);
  expect(new DefaultAPIFormat("anything").getToolNameLimit()).toBe(64);

  expect(new GeminiAPIFormat("gemini-3-pro").getToolNameLimit()).toBeNull();
  expect(new AnthropicAPIFormat("claude-x").getToolNameLimit()).toBeNull();
});

test("the COMPOSED wire wins over a dialect's own default", () => {
  // A dialect self-selects by model name and always answers "openai-sse" for
  // itself. Under a wire whose parser holds no map, it must not encode.
  expect(new DefaultAPIFormat("anything", "anthropic-sse").getToolNameLimit()).toBeNull();
  expect(new DefaultAPIFormat("anything", "ollama-jsonl").getToolNameLimit()).toBeNull();
  expect(new DefaultAPIFormat("anything", "gemini-sse").getToolNameLimit()).toBeNull();
  expect(new DefaultAPIFormat("anything", "openai-sse").getToolNameLimit()).toBe(64);
});

// ─── One pass, all three places a name lives ────────────────────────────────

test("tools, history and tool_choice are encoded, and they agree", () => {
  const fmt = new OpenAIAPIFormat("gpt-4o");
  fmt.reset();
  const payload = {
    model: "gpt-4o",
    tools: [{ type: "function", function: { name: REAL_LONG_NAME } }],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: REAL_LONG_NAME } }],
      },
      { role: "tool", tool_call_id: "c1", content: "done" },
    ],
    tool_choice: { type: "function", function: { name: REAL_LONG_NAME } },
  };

  fmt.prepareRequest(payload, { messages: [] });

  const onTheWire = payload.tools[0].function.name;
  expect(onTheWire.length).toBe(64);
  expect(onTheWire).not.toBe(REAL_LONG_NAME);
  // All three agree — a history or a tool_choice naming something absent from
  // tools[] is a 400 on strict endpoints and confusion everywhere else.
  expect((payload.messages[1] as any).tool_calls[0].function.name).toBe(onTheWire);
  expect(payload.tool_choice.function.name).toBe(onTheWire);
  expect(fmt.getToolNameMap().get(onTheWire)).toBe(REAL_LONG_NAME);
  expect(fmt.restoreToolName(onTheWire)).toBe(REAL_LONG_NAME);
});

test("the Responses API's own two shapes are encoded too", () => {
  const fmt = new CodexAPIFormat("gpt-5.1-codex");
  fmt.reset();
  const payload = {
    model: "gpt-5.1-codex",
    // Flat tools, and history as `input` items rather than assistant messages.
    tools: [{ type: "function", name: REAL_LONG_NAME }],
    input: [
      { type: "function_call", call_id: "c1", name: REAL_LONG_NAME, arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ],
    tool_choice: { type: "function", name: REAL_LONG_NAME },
  };

  fmt.prepareRequest(payload, { messages: [] });

  const onTheWire = payload.tools[0].name;
  expect(onTheWire.length).toBe(64);
  expect(payload.input[0].name).toBe(onTheWire);
  expect(payload.tool_choice.name).toBe(onTheWire);
  expect(fmt.getToolNameMap().get(onTheWire)).toBe(REAL_LONG_NAME);
});

test("a wire with no limit leaves every name alone", () => {
  const fmt = new GeminiAPIFormat("gemini-3-pro");
  fmt.reset();
  const payload = {
    tools: [{ function: { name: REAL_LONG_NAME } }],
    tool_choice: { type: "function", function: { name: REAL_LONG_NAME } },
  };
  fmt.prepareRequest(payload, { messages: [] });
  expect(payload.tools[0].function.name).toBe(REAL_LONG_NAME);
  expect(payload.tool_choice.function.name).toBe(REAL_LONG_NAME);
});

// ─── The map is per request ─────────────────────────────────────────────────

test("reset() mints a new map instead of clearing the one already handed out", () => {
  const fmt = new OpenAIAPIFormat("gpt-4o");
  fmt.reset();
  fmt.prepareRequest({ tools: [{ type: "function", function: { name: REAL_LONG_NAME } }] }, {});

  // What request A's parser is holding.
  const mapA = fmt.getToolNameMap();
  const encodedA = [...mapA.keys()][0];
  expect(mapA.get(encodedA)).toBe(REAL_LONG_NAME);

  // Request B starts on the same cached handler.
  fmt.reset();
  fmt.prepareRequest({ tools: [{ type: "function", function: { name: "Read" } }] }, {});

  // A's map still decodes. Clearing it here would have turned A's tool calls
  // into names nothing recognises, and the allowlist drops those in silence.
  expect(mapA.get(encodedA)).toBe(REAL_LONG_NAME);
  expect(fmt.getToolNameMap()).not.toBe(mapA);
});
