import { describe, test, expect } from "bun:test";
import { convertOpenAIRequestToAnthropic } from "./openai-request-to-anthropic.js";

describe("convertOpenAIRequestToAnthropic", () => {
  test("passes model + stream through and defaults max_tokens", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.model).toBe("glm-5.2");
    expect(out.stream).toBeUndefined();
    expect(out.max_tokens).toBe(4096); // Anthropic requires it; OpenAI doesn't send it
  });

  test("preserves stream:true", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "glm-5.2",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.stream).toBe(true);
  });

  test("maps max_completion_tokens (o1+) when max_tokens absent", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "o1",
      max_completion_tokens: 2048,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.max_tokens).toBe(2048);
  });

  test("system + developer messages collapse into top-level system string", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: "Use metric." },
        { role: "user", content: "hi" },
      ],
    });
    expect(out.system).toBe("Be brief.\n\nUse metric.");
    expect(out.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });

  test("user string content → text block", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "hello world" }],
    });
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    });
  });

  test("user multimodal parts → text + image blocks", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          ],
        },
      ],
    });
    const block = out.messages[0].content;
    expect(block[0]).toEqual({ type: "text", text: "what is this?" });
    expect(block[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
  });

  test("image_url http URL → url source", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
        },
      ],
    });
    expect(out.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://x/y.png" },
    });
  });

  test("assistant tool_calls → tool_use blocks with parsed input", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: "Running it.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "list", arguments: '{"path": "/tmp"}' },
            },
          ],
        },
      ],
    });
    const asst = out.messages[1];
    expect(asst.role).toBe("assistant");
    // text block first, then tool_use
    expect(asst.content[0]).toEqual({ type: "text", text: "Running it." });
    expect(asst.content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "list",
      input: { path: "/tmp" },
    });
  });

  test("assistant reasoning_content round-trips as a thinking block", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", reasoning_content: "deducing...", content: "done" },
      ],
    });
    const asst = out.messages[1].content;
    expect(asst[0]).toEqual({ type: "thinking", thinking: "deducing..." });
    expect(asst[1]).toEqual({ type: "text", text: "done" });
  });

  test("tool role → user/tool_result keyed by tool_call_id", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [
        { role: "user", content: "x" },
        { role: "tool", tool_call_id: "call_1", content: "[\"a\",\"b\"]" },
      ],
    });
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: '["a","b"]' }],
    });
  });

  test("malformed tool arguments parse to {} (never throws)", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{broken" } }],
        },
      ],
    });
    expect(out.messages[1].content[0]).toEqual({ type: "tool_use", id: "c1", name: "f", input: {} });
  });

  test("function tools → Anthropic tool definitions (input_schema)", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    });
    expect(out.tools[0]).toEqual({
      name: "get_weather",
      description: "Get weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    });
  });

  test("strict tool sets additionalProperties:false", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          type: "function",
          strict: true,
          function: { name: "f", parameters: { type: "object", properties: {} } },
        },
      ],
    });
    expect(out.tools[0].input_schema.additionalProperties).toBe(false);
  });

  test("tool_choice variants map correctly", () => {
    const cases: [any, any][] = [
      ["auto", { type: "auto" }],
      ["none", { type: "none" }],
      ["required", { type: "any" }],
      [{ type: "function", function: { name: "f" } }, { type: "tool", name: "f" }],
    ];
    for (const [input, expected] of cases) {
      const out = convertOpenAIRequestToAnthropic({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tool_choice: input,
      });
      expect(out.tool_choice).toEqual(expected);
    }
  });

  test("stop + user + sampling params map", () => {
    const out = convertOpenAIRequestToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      temperature: 0.5,
      top_p: 0.9,
      stop: ["END", "STOP"],
      user: "u123",
    });
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.stop_sequences).toEqual(["END", "STOP"]);
    expect(out.metadata).toEqual({ user_id: "u123" });
  });

  test("does not mutate the input", () => {
    const input = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    convertOpenAIRequestToAnthropic(input);
    expect(input).toEqual(snapshot);
  });

  test("handles empty/degenerate input without throwing", () => {
    expect(() => convertOpenAIRequestToAnthropic({})).not.toThrow();
    expect(() => convertOpenAIRequestToAnthropic(null)).not.toThrow();
    expect(() => convertOpenAIRequestToAnthropic(undefined)).not.toThrow();
    const out = convertOpenAIRequestToAnthropic({});
    expect(out.messages).toEqual([]);
    expect(out.max_tokens).toBe(4096);
  });
});
