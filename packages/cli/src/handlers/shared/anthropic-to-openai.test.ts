import { describe, test, expect } from "bun:test";
import {
  anthropicMessageToChatCompletion,
  createOpenAIChatStreamFromAnthropic,
} from "./anthropic-to-openai.js";

/** Build a Response carrying an Anthropic SSE byte stream from a string. */
function sseResponse(sse: string): Response {
  const bytes = new TextEncoder().encode(sse);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

/** Drain an OpenAI-chunk stream to an array of parsed chunk objects + whether [DONE] terminated. */
async function drainOpenAIStream(resp: Response): Promise<{ chunks: any[]; done: boolean; raw: string }> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  const chunks: any[] = [];
  let sawDone = false;
  for (const part of text.split("\n\n")) {
    const line = part.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      sawDone = true;
    } else {
      try {
        chunks.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    }
  }
  return { chunks, done: sawDone, raw: text };
}

// ── Non-streaming: message → chat.completion ────────────────────────────────

describe("anthropicMessageToChatCompletion", () => {
  test("text message → chat.completion with total_tokens", () => {
    const cc = anthropicMessageToChatCompletion(
      {
        id: "msg_1",
        model: "glm-5.2",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Paris" }],
        usage: { input_tokens: 10, output_tokens: 3 },
      },
      "glm-5.2"
    );
    expect(cc.object).toBe("chat.completion");
    expect(cc.id).toBe("msg_1");
    expect(cc.model).toBe("glm-5.2");
    expect(cc.choices[0].message).toEqual({ role: "assistant", content: "Paris" });
    expect(cc.choices[0].finish_reason).toBe("stop");
    expect(cc.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  });

  test("tool_use blocks → tool_calls with stringified arguments", () => {
    const cc = anthropicMessageToChatCompletion({
      id: "m",
      model: "m",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "t1", name: "list", input: { path: "/x" } },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    expect(cc.choices[0].message.tool_calls[0]).toEqual({
      index: 0,
      id: "t1",
      type: "function",
      function: { name: "list", arguments: '{"path":"/x"}' },
    });
    expect(cc.choices[0].finish_reason).toBe("tool_calls");
  });

  test("thinking blocks → reasoning_content", () => {
    const cc = anthropicMessageToChatCompletion({
      id: "m",
      model: "m",
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "ok" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(cc.choices[0].message.reasoning_content).toBe("hmm");
  });

  test("empty content → null content, stop finish_reason default", () => {
    const cc = anthropicMessageToChatCompletion({ id: "m", model: "m", content: [], usage: {} });
    expect(cc.choices[0].message.content).toBeNull();
    expect(cc.choices[0].finish_reason).toBe("stop");
    expect(cc.usage.total_tokens).toBe(0);
  });
});

// ── Streaming: Anthropic SSE → OpenAI chunk SSE ─────────────────────────────

describe("createOpenAIChatStreamFromAnthropic", () => {
  const TEXT_SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_42","model":"glm-5.2","usage":{"input_tokens":7,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join("\n");

  test("emits role chunk, text deltas, terminal finish_reason, and [DONE]", async () => {
    const out = await drainOpenAIStream(createOpenAIChatStreamFromAnthropic(sseResponse(TEXT_SSE)));
    expect(out.done).toBe(true);
    const deltas = out.chunks.map((c) => c.choices[0].delta);
    expect(deltas[0]).toEqual({ role: "assistant", content: "" });
    const content = deltas.map((d) => d.content ?? "").join("");
    expect(content).toBe("Hello world");
    const terminal = out.chunks[out.chunks.length - 1];
    expect(terminal.choices[0].finish_reason).toBe("stop");
    expect(terminal.model).toBe("glm-5.2");
    expect(terminal.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  });

  const TOOL_SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m","model":"glm-5.2","usage":{"input_tokens":3,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"list"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"/tmp\\"}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join("\n");

  test("tool_use stream → tool_calls opener + argument fragments + finish tool_calls", async () => {
    const out = await drainOpenAIStream(createOpenAIChatStreamFromAnthropic(sseResponse(TOOL_SSE)));
    const toolOpener = out.chunks.find((c) => c.choices[0].delta.tool_calls?.length);
    expect(toolOpener.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "list", arguments: "" },
    });
    const argFragments = out.chunks
      .filter((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments)
      .map((c) => c.choices[0].delta.tool_calls[0].function.arguments)
      .join("");
    expect(argFragments).toBe('{"path":"/tmp"}');
    const terminal = out.chunks[out.chunks.length - 1];
    expect(terminal.choices[0].finish_reason).toBe("tool_calls");
  });

  const THINKING_SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m","model":"m","usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"deducing"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join("\n");

  test("thinking_delta → reasoning_content in chunk delta", async () => {
    const out = await drainOpenAIStream(createOpenAIChatStreamFromAnthropic(sseResponse(THINKING_SSE)));
    const reasoning = out.chunks
      .map((c) => c.choices[0].delta.reasoning_content ?? "")
      .join("");
    expect(reasoning).toBe("deducing");
    const text = out.chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    expect(text).toBe("answer");
  });

  test("degrades cleanly on an empty/missing body (never hangs)", async () => {
    const resp = new Response(null);
    const out = await drainOpenAIStream(createOpenAIChatStreamFromAnthropic(resp, "glm-5.2"));
    expect(out.done).toBe(true);
    expect(out.chunks.length).toBeGreaterThanOrEqual(1);
    expect(out.chunks[out.chunks.length - 1].choices[0].finish_reason).toBe("stop");
  });

  test("malformed stream still terminates with [DONE]", async () => {
    const resp = sseResponse("not valid sse at all {{{");
    const out = await drainOpenAIStream(createOpenAIChatStreamFromAnthropic(resp, "m"));
    expect(out.done).toBe(true);
  });
});
