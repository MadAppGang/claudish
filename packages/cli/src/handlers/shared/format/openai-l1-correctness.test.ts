/**
 * S3 lot 1 — L1 tool-correctness série (issue #27).
 *
 * Ports the upstream série on openai-messages.ts / openai-tools.ts:
 * 7016311 (never-undefined `parameters`), 0997da5 (portable patterns),
 * 84578c9 (url image source), 9f4488d (per-result image marker),
 * b9e2163 (merge adjacent users + close orphan tool round),
 * a981d13 (order tool results by their calls, name a missing one),
 * d170a3f (shared tool_choice mapper, L1 hunk — adapter wiring is the next grain).
 *
 * Request-side behaviour: constructed Anthropic bodies in the inline style —
 * no SSE capture covers these converters, and no fixture was invented.
 */

import { describe, expect, test } from "bun:test";
import { convertMessagesToOpenAI } from "./openai-messages.js";
import {
  convertToolsToOpenAI,
  isPortablePattern,
  mapToolChoiceToOpenAI,
  mapToolChoiceToResponsesAPI,
  mapToolChoiceToGemini,
} from "./openai-tools.js";

// ─── 7016311: `parameters` must serialize even for a tool with no schema ────

describe("convertToolsToOpenAI — never-undefined parameters (7016311)", () => {
  test("a tool with no input_schema still serializes a `parameters` object", () => {
    const tools = convertToolsToOpenAI({ tools: [{ name: "get_time", description: "tells time" }] });
    // Assert on the SERIALIZED form: the bug is precisely that JSON.stringify
    // drops an undefined-valued key, so an object-level assertion passes even
    // when the code is broken.
    expect(JSON.stringify(tools[0])).toContain('"parameters"');
    expect(tools[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  test("the summarize path has the same guarantee", () => {
    const tools = convertToolsToOpenAI(
      { tools: [{ name: "get_time" }] },
      true
    );
    expect(JSON.stringify(tools[0])).toContain('"parameters"');
    expect(tools[0].function.parameters).toEqual({ type: "object", properties: {} });
  });
});

// ─── 0997da5: drop only unportable patterns ─────────────────────────────────

describe("pattern portability (0997da5)", () => {
  test("isPortablePattern accepts Python-safe escapes and rejects Unicode property escapes", () => {
    expect(isPortablePattern("^(?!__.*__$)[a-z_]{1,200}$")).toBe(true); // negative lookahead
    expect(isPortablePattern("^\\d{4}-\\d{2}-\\d{2}$")).toBe(true); // digit class
    expect(isPortablePattern("a\\.b\\\\c")).toBe(true); // non-letter escapes
    expect(isPortablePattern("(?<=a)b")).toBe(true); // lookbehind
    expect(isPortablePattern("[^\\p{Cc}]")).toBe(false); // the Artifact-tool killer
    expect(isPortablePattern("\\p{L}+")).toBe(false); // Unicode property escape
    expect(isPortablePattern("(?<name>x)")).toBe(false); // bare named group
  });

  test("a portable `pattern` survives conversion; an unportable one is dropped", () => {
    const tools = convertToolsToOpenAI({
      tools: [
        {
          name: "t",
          input_schema: {
            type: "object",
            properties: {
              ok: { type: "string", pattern: "^[a-z]+$" },
              bad: { type: "string", pattern: "[^\\p{Cc}\\p{Cf}]" },
            },
          },
        },
      ],
    });
    const props = tools[0].function.parameters.properties;
    expect(props.ok.pattern).toBe("^[a-z]+$");
    expect(props.bad.pattern).toBeUndefined();
    expect(props.bad.type).toBe("string"); // the property itself survives
  });

  test("a property NAMED pattern is a name, not a keyword — never touched", () => {
    const tools = convertToolsToOpenAI({
      tools: [
        {
          name: "t",
          input_schema: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "a user field called pattern" },
            },
          },
        },
      ],
    });
    expect(tools[0].function.parameters.properties.pattern).toEqual({
      type: "string",
      description: "a user field called pattern",
    });
  });
});

// ─── 84578c9 + 9f4488d: image sources and per-result markers ────────────────

/** Both calls in ONE assistant message — two turns would open two rounds. */
function toolUseRound(calls: Array<[string, string]>): any {
  return {
    role: "assistant",
    content: calls.map(([id, name]) => ({ type: "tool_use", id, name, input: {} })),
  };
}

describe("image source forwarding (84578c9)", () => {
  test("a url source is forwarded as that url, not data:undefined;base64,undefined", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", source: { type: "url", url: "https://example.test/x.png" } },
            ],
          },
        ],
      },
      "gpt-4o"
    );
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example.test/x.png" } },
        ],
      },
    ]);
  });

  test("a base64 source missing media_type is dropped, not forwarded broken", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", data: "AAAA" } },
            ],
          },
        ],
      },
      "gpt-4o"
    );
    // Content with no expressible part: nothing forwarded, no data:undefined.
    expect(JSON.stringify(out)).not.toContain("undefined");
  });
});

describe("per-result image marker (9f4488d)", () => {
  const twoResultTurn = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "a",
        content: [{ type: "image", source: { type: "url", url: "https://x.test/a.png" } }],
      },
      {
        type: "tool_result",
        tool_use_id: "b",
        // unforwardable: url source with no url
        content: [{ type: "image", source: { type: "url" } }],
      },
    ],
  };

  test("result B names the omission; result A points at the following message; exactly one image forwarded", () => {
    const out = convertMessagesToOpenAI(
      { messages: [toolUseRound([["a", "screenshot"], ["b", "chart"]]), twoResultTurn] },
      "gpt-4o"
    );
    const toolA = out.find((m: any) => m.tool_call_id === "a");
    const toolB = out.find((m: any) => m.tool_call_id === "b");
    expect(toolA?.content).toBe("[image returned; see following message]");
    expect(toolB?.content).toBe("[image returned, but its source could not be forwarded]");
    const imageMsg = out.find(
      (m: any) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "image_url"
    );
    expect(imageMsg?.content).toHaveLength(1); // only A's image rides along
  });

  test("non-regression: both results forwardable → BOTH point at the following message", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          toolUseRound([["a", "screenshot"], ["b", "chart"]]),
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "a",
                content: [{ type: "image", source: { type: "url", url: "https://x.test/a.png" } }],
              },
              {
                type: "tool_result",
                tool_use_id: "b",
                content: [{ type: "image", source: { type: "url", url: "https://x.test/b.png" } }],
              },
            ],
          },
        ],
      },
      "gpt-4o"
    );
    expect(out.find((m: any) => m.tool_call_id === "a")?.content).toBe(
      "[image returned; see following message]"
    );
    expect(out.find((m: any) => m.tool_call_id === "b")?.content).toBe(
      "[image returned; see following message]"
    );
  });
});

// ─── b9e2163 + a981d13: sequence normalization ──────────────────────────────

describe("normalizeMessageSequence (b9e2163 + a981d13)", () => {
  test("adjacent user messages merge; a string pair stays a string", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      },
      "gpt-4o"
    );
    expect(out).toEqual([{ role: "user", content: "first\n\nsecond" }]);
  });

  test("a mixed pair is lifted to content parts", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          { role: "user", content: "plain" },
          { role: "user", content: [{ type: "text", text: "blocked" }] },
        ],
      },
      "gpt-4o"
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([
      { type: "text", text: "plain" },
      { type: "text", text: "blocked" },
    ]);
  });

  test("an orphan tool result is re-emitted as a user message, content survives", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "ghost", content: "orphan output" },
            ],
          },
        ],
      },
      "gpt-4o"
    );
    expect(out).toEqual([{ role: "user", content: "[Tool Result]: orphan output" }]);
  });

  test("out-of-order results are reordered to their tool_calls order", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "first", input: {} },
              { type: "tool_use", id: "call_2", name: "second", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_2", content: "output of second" },
              { type: "tool_result", tool_use_id: "call_1", content: "output of first" },
            ],
          },
        ],
      },
      "gpt-4o"
    );
    const toolIds = out.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
    expect(toolIds).toEqual(["call_1", "call_2"]); // the calls' own order
    expect(out.find((m: any) => m.tool_call_id === "call_1")?.content).toBe("output of first");
  });

  test("a call with no result gets a synthetic tool message naming the omission", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "ran", input: {} },
              { type: "tool_use", id: "call_2", name: "lost", input: {} },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
          },
        ],
      },
      "gpt-4o"
    );
    const missing = out.find((m: any) => m.tool_call_id === "call_2");
    expect(missing?.role).toBe("tool");
    expect(missing?.content).toContain("No tool result was provided");
    expect(missing?.content).toContain("`lost`");
  });

  test("a result matching no call of its round is dropped", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "ran", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "ok" },
              { type: "tool_result", tool_use_id: "stray", content: "no call" },
            ],
          },
        ],
      },
      "gpt-4o"
    );
    expect(out.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id)).toEqual([
      "call_1",
    ]);
  });

  test("a trailing round left fully open (a continuation) is NOT synthetically answered", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "prefill", input: {} }],
          },
        ],
      },
      "gpt-4o"
    );
    expect(out).toHaveLength(1);
    expect(out[0].tool_calls).toHaveLength(1); // untouched — no synthetic results
  });
});

// ─── d170a3f: shared tool_choice mapper ─────────────────────────────────────

describe("mapToolChoice — the shared mapper (d170a3f)", () => {
  test('Claude "any" maps to OpenAI "required" — the branch every builder forgot', () => {
    expect(mapToolChoiceToOpenAI({ type: "any" })).toBe("required");
  });

  test('"tool" maps to the function form; encodeName applies', () => {
    expect(mapToolChoiceToOpenAI({ type: "tool", name: "Bash" })).toEqual({
      type: "function",
      function: { name: "Bash" },
    });
    expect(mapToolChoiceToOpenAI({ type: "tool", name: "Bash" }, (n) => `t_${n}`)).toEqual({
      type: "function",
      function: { name: "t_Bash" },
    });
  });

  test('"auto" and "none" pass through; junk and toolless `tool` send nothing', () => {
    expect(mapToolChoiceToOpenAI({ type: "auto" })).toBe("auto");
    expect(mapToolChoiceToOpenAI({ type: "none" })).toBe("none");
    expect(mapToolChoiceToOpenAI({ type: "weird" })).toBeUndefined();
    expect(mapToolChoiceToOpenAI({ type: "tool" })).toBeUndefined(); // names no tool
    expect(mapToolChoiceToOpenAI(undefined)).toBeUndefined();
  });

  test("the Responses spelling is flat", () => {
    expect(mapToolChoiceToResponsesAPI({ type: "tool", name: "Bash" })).toEqual({
      type: "function",
      name: "Bash",
    });
    expect(mapToolChoiceToResponsesAPI({ type: "any" })).toBe("required");
  });

  test("Gemini gets the protobuf enum spellings", () => {
    expect(mapToolChoiceToGemini({ type: "any" })).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });
    expect(mapToolChoiceToGemini({ type: "auto" })).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(mapToolChoiceToGemini({ type: "tool", name: "Bash" })).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Bash"] },
    });
  });
});

// ─── Fork regressions: what this tree adds that the série must not break ────

describe("fork invariants preserved through the série", () => {
  test("reasoningRoundtrip still stamps reasoning_content on every assistant message", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "r" }] },
        ],
      },
      "deepseek-v4-flash",
      undefined,
      false,
      true
    );
    const assistant = out.find((m: any) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBe(""); // present, empty — DeepSeek's presence check
  });

  test("an inline system message still lands in place as a user message (merge-safe)", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          { role: "user", content: "question" },
          { role: "system", content: "The user sent a new message while you were working" },
        ],
      },
      "glm-5.3"
    );
    // In-place emission + the post-pass merge = one user message carrying both,
    // position preserved (not hoisted into the system prompt).
    expect(out).toEqual([
      { role: "user", content: "question\n\nThe user sent a new message while you were working" },
    ]);
  });

  test("a steer between the calls and their results never splits the tool round (2026-08-28 shape)", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
          },
          { role: "system", content: "The user sent a new message while you were working" },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        ],
      },
      "glm-5.3"
    );
    // The round is whole: assistant(tool_calls) → tool(t1) — then the steer as
    // the user turn that rode with the result. No synthetic "no result", no
    // orphan degradation of t1.
    const roles = out.map((m: any) => (m.role === "tool" ? "tool:" + m.tool_call_id : m.role));
    expect(roles).toEqual(["user", "assistant", "tool:t1", "user"]);
    expect(JSON.stringify(out)).not.toContain("No tool result was provided");
    expect(JSON.stringify(out[3])).toContain("new message while you were working");
  });
});
