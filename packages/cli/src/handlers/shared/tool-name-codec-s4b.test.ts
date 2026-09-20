/**
 * S4-b lot B3 — the reversible 64-char tool-name codec on every OpenAI wire
 * (2e18042, item 7), adapter-side half.
 *
 * Anchors (each pinned by a test that goes red if mutated out):
 *  (a) COLLISIONS AT ANY LENGTH — charset-mapping makes `a.b` and `a_b` the
 *      same string; the hash suffix applies on any collision, and identity
 *      encodings are recorded too (an identity CLAIMS the name).
 *  (c) EVERY PATH — the encode is a post-pass over the BUILT payload, in
 *      prepareRequest's TEMPLATE, so every adapter gets it exactly once and
 *      no subclass loses it by overriding the hook. tools[] (both shapes),
 *      history (messages[] tool_calls), tool_choice. The composed wire wins
 *      over a dialect's self-selection (Qwen Plan's Anthropic wire must NOT
 *      encode).
 *  (d) THE SHARED MAP RACE — bindings are per request and REPLACED, never
 *      cleared: clearing the map request A's parser still decodes with,
 *      because request B started on the same cached handler, turns A's calls
 *      into names nothing recognises.
 *
 * The composed-handler capture-before-await half of (d) is deliberately NOT in
 * this lot — composed-handler.ts is po-2023's file this cycle (#155), and
 * PR #162 already touches it via ae8c07f pending ai-01's arbitration.
 *
 * Non-vacuity: written before the implementation.
 */

import { describe, expect, test } from "bun:test";
import {
  encodeToolName,
  newToolNameBindings,
  type ToolNameBindings,
} from "../../adapters/tool-name-utils.js";
import { OpenAIAPIFormat } from "../../adapters/openai-api-format.js";

const LONG_MCP_NAME =
  "mcp__plugin_browser-use_browser-use__retry_with_browser_use_agent"; // 65 chars, the live incident

describe("S4-b lot B3: encodeToolName codec (2e18042)", () => {
  test("a name that fits the charset and length passes through, bound to itself", () => {
    const b = newToolNameBindings();
    expect(encodeToolName("Read", 64, b)).toBe("Read");
    expect(b.byEncoded.get("Read")).toBe("Read"); // identity CLAIMS the name
  });

  test("unwirable characters map to '_' and the way back is recorded", () => {
    const b = newToolNameBindings();
    expect(encodeToolName("my.tool", 64, b)).toBe("my_tool");
    expect(b.byEncoded.get("my_tool")).toBe("my.tool");
  });

  test("(a) collisions at any length: a.b and a_b are different tools, both survivable", () => {
    const b = newToolNameBindings();
    const dotted = encodeToolName("a.b", 64, b);
    const underscored = encodeToolName("a_b", 64, b);
    expect(dotted).not.toBe(underscored);
    expect(b.byEncoded.get(dotted)).toBe("a.b");
    expect(b.byEncoded.get(underscored)).toBe("a_b");
  });

  test("(a) an identity encoding claims its name — a.b cannot win a_b from the real a_b", () => {
    const b = newToolNameBindings();
    expect(encodeToolName("a_b", 64, b)).toBe("a_b"); // identity, recorded
    const dotted = encodeToolName("a.b", 64, b);
    expect(dotted).not.toBe("a_b"); // must hash out of the claimed name
    expect(b.byEncoded.get("a_b")).toBe("a_b");
    expect(b.byEncoded.get(dotted)).toBe("a.b");
  });

  test("a 65-char MCP name hashes under 64 and decodes back", () => {
    const b = newToolNameBindings();
    expect(LONG_MCP_NAME.length).toBeGreaterThan(64);
    const encoded = encodeToolName(LONG_MCP_NAME, 64, b);
    expect(encoded.length).toBe(64);
    expect(b.byEncoded.get(encoded)).toBe(LONG_MCP_NAME);
  });

  test("encoding is stable within a request (same original → same encoded)", () => {
    const b = newToolNameBindings();
    const first = encodeToolName(LONG_MCP_NAME, 64, b);
    expect(encodeToolName(LONG_MCP_NAME, 64, b)).toBe(first);
  });
});

describe("S4-b lot B3: adapter-side coverage (2e18042 c/d)", () => {
  function makeAdapter() {
    return new OpenAIAPIFormat("gpt-5");
  }

  test("(c) the encode is a template post-pass: tools[] (both shapes), history, tool_choice", () => {
    const adapter = makeAdapter();
    const request: any = {
      tools: [
        { type: "function", function: { name: LONG_MCP_NAME } },
        { type: "function", name: "flat.tool" }, // Responses shape
      ],
      messages: [
        {
          role: "assistant",
          tool_calls: [{ function: { name: LONG_MCP_NAME } }],
        },
      ],
      tool_choice: { type: "function", function: { name: "flat.tool" } },
    };
    const prepared = adapter.prepareRequest(request, {});
    const encodedLong = prepared.tools[0].function.name;
    expect(encodedLong.length).toBe(64);
    expect(prepared.messages[0].tool_calls[0].function.name).toBe(encodedLong); // history agrees
    expect(prepared.tools[1].name).toBe("flat_tool");
    expect(prepared.tool_choice.function.name).toBe("flat_tool"); // choice agrees
    // and every name decodes back
    const map = adapter.getToolNameMap();
    expect(map.get(encodedLong)).toBe(LONG_MCP_NAME);
    expect(map.get("flat_tool")).toBe("flat.tool");
  });

  test("(c) the composed wire wins: an anthropic-wire composition encodes nothing", () => {
    // A dialect self-selects by model name and answers "openai-sse" for
    // itself; composed under Qwen Plan's Anthropic wire it must not encode —
    // that parser has no map to decode with.
    const adapter = makeAdapter();
    (adapter as any).wireFormat = "anthropic-sse";
    const request: any = { tools: [{ type: "function", function: { name: LONG_MCP_NAME } }] };
    const prepared = adapter.prepareRequest(request, {});
    expect(prepared.tools[0].function.name).toBe(LONG_MCP_NAME);
  });

  test("(d) reset() REPLACES the bindings — a parser holding the old map still decodes", () => {
    const adapter = makeAdapter();
    adapter.prepareRequest(
      { tools: [{ type: "function", function: { name: LONG_MCP_NAME } }] },
      {}
    );
    const requestAMap = adapter.getToolNameMap();
    adapter.reset(); // request B starts on the same cached handler
    // The map request A captured is intact…
    expect(requestAMap.get(requestAMap.keys().next().value as string)).toBe(LONG_MCP_NAME);
    // …and the adapter's is fresh.
    expect(adapter.getToolNameMap().size).toBe(0);
  });

  test("a plain short-name request encodes nothing (control)", () => {
    const adapter = makeAdapter();
    const request: any = { tools: [{ type: "function", function: { name: "Bash" } }] };
    const prepared = adapter.prepareRequest(request, {});
    expect(prepared.tools[0].function.name).toBe("Bash");
  });
});
