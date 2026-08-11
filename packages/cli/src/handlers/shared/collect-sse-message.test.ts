import { describe, it, expect } from "bun:test";
import { collectAnthropicSseToMessage } from "./collect-sse-message.js";

/** Build a Response whose body streams the given Claude-format SSE events. */
function sseResponse(events: any[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(
          encoder.encode(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`)
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Build a Response whose body streams SSE events in the Qwen Cloud / Alibaba
 * MaaS wire format: `event:TYPE\ndata:{...}` — NO space after the colon.
 * (Anthropic's canonical format, used by sseResponse above, is `data: {...}`
 * with a space.) Regression: the anthropic-sse parser used to require the
 * space, so every Qwen data line was skipped, sawMessageStop stayed false,
 * and finalizeWithError injected a spurious "[empty response]".
 */
function qwenSseResponse(events: any[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(
          encoder.encode(`event:${evt.type}\ndata:${JSON.stringify(evt)}\n\n`)
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("collectAnthropicSseToMessage", () => {
  it("reconstructs a plain text message from SSE", async () => {
    const res = sseResponse([
      { type: "message_start", message: { id: "msg_abc", model: "glm-5.1", role: "assistant", usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);

    const msg = await collectAnthropicSseToMessage(res, "fallback-model");

    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.id).toBe("msg_abc");
    expect(msg.model).toBe("glm-5.1");
    expect(msg.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage.input_tokens).toBe(10);
    expect(msg.usage.output_tokens).toBe(5);
  });

  it("reconstructs a tool_use message with accumulated JSON input", async () => {
    const res = sseResponse([
      { type: "message_start", message: { id: "msg_t", model: "glm-5.1", role: "assistant" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"ls -la"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);

    const msg = await collectAnthropicSseToMessage(res, "fallback-model");

    expect(msg.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
    ]);
    expect(msg.stop_reason).toBe("tool_use");
  });

  it("infers stop_reason=tool_use when a tool block is present but no message_delta", async () => {
    const res = sseResponse([
      { type: "message_start", message: { id: "msg_x", model: "m", role: "assistant" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Read" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 },
    ]);

    const msg = await collectAnthropicSseToMessage(res, "m");
    expect(msg.stop_reason).toBe("tool_use");
  });

  it("preserves block order across mixed thinking + text + tool blocks", async () => {
    const res = sseResponse([
      { type: "message_start", message: { id: "msg_m", model: "m", role: "assistant" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]);

    const msg = await collectAnthropicSseToMessage(res, "m");
    expect(msg.content[0]).toEqual({ type: "thinking", thinking: "reasoning" });
    expect(msg.content[1]).toEqual({ type: "text", text: "answer" });
  });

  it("never throws on an empty body and yields a well-formed empty text message", async () => {
    const res = new Response(null, { status: 200 });
    const msg = await collectAnthropicSseToMessage(res, "fallback-model");

    expect(msg.type).toBe("message");
    expect(msg.model).toBe("fallback-model");
    expect(msg.content).toEqual([{ type: "text", text: "" }]);
    expect(msg.stop_reason).toBe("end_turn");
  });

  it("never throws on malformed SSE lines and skips them", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {not json}\n\n"));
        controller.enqueue(encoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n"));
        controller.enqueue(
          encoder.encode(
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'
          )
        );
        controller.close();
      },
    });
    const res = new Response(body, { status: 200 });

    const msg = await collectAnthropicSseToMessage(res, "m");
    expect(msg.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("parses Qwen-style SSE with NO space after data: (regression: empty-response bug)", async () => {
    // Qwen Cloud Token Plan / Alibaba MaaS emit `data:{...}` without the space
    // after the colon. Before the normalization fix, the anthropic-sse parser
    // never matched any data line (every check used startsWith("data: ")),
    // sawMessageStop stayed false, and finalizeWithError injected a spurious
    // "[empty response]" error — even though the upstream stream was complete
    // and valid. This test feeds the exact Qwen wire shape (thinking + text +
    // tool_use + message_stop, no spaces) and asserts correct reconstruction.
    const res = qwenSseResponse([
      { type: "message_start", message: { id: "msg_qwen", model: "qwen3.8-max", role: "assistant", usage: { input_tokens: 87215, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user asked" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello from Qwen" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 87215, output_tokens: 4 } },
      { type: "message_stop" },
    ]);

    const msg = await collectAnthropicSseToMessage(res, "qwen3.8-max");

    // Before the fix: content would be the injected error text
    // "[Error: The model returned an empty response...]" with stop_reason end_turn
    // but output_tokens 0. After the fix: the real text is reconstructed.
    expect(msg.id).toBe("msg_qwen");
    expect(msg.model).toBe("qwen3.8-max");
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "The user asked" },
      { type: "text", text: "Hello from Qwen" },
    ]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage.output_tokens).toBe(4);
  });

  it("parses Qwen-style SSE ending in tool_use with NO space after data:", async () => {
    // The production failure (capture resp-1-r1815) was a tool_use turn: Qwen
    // returned thinking + text + tool_use + message_stop with stop_reason
    // tool_use, all in no-space format. claudish reported sawMessageStop=false
    // and toolUse=0 — the parser extracted nothing. Assert the tool_use is now
    // reconstructed and stop_reason detected.
    const res = qwenSseResponse([
      { type: "message_start", message: { id: "msg_t", model: "qwen3.8-max", role: "assistant", usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "planning" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "running a tool" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_q", name: "Bash" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 100, output_tokens: 10 } },
      { type: "message_stop" },
    ]);

    const msg = await collectAnthropicSseToMessage(res, "qwen3.8-max");

    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content.some((c: any) => c.type === "tool_use" && c.name === "Bash")).toBe(true);
    const toolBlock = msg.content.find((c: any) => c.type === "tool_use");
    expect(toolBlock.input).toEqual({ command: "echo hi" });
  });

  it("falls back to {} for unparseable tool input JSON without throwing", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "X" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{broken" } },
      { type: "content_block_stop", index: 0 },
    ]);
    const msg = await collectAnthropicSseToMessage(res, "m");
    expect(msg.content).toEqual([{ type: "tool_use", id: "t", name: "X", input: {} }]);
  });
});
