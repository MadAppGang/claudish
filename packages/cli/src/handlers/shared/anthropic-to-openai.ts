/**
 * Anthropic → OpenAI response translation.
 *
 * The mirror of the ingress request converter (`openai-request-to-anthropic.ts`).
 * The proxy's pipeline always returns an Anthropic-shaped response to the route
 * (SSE for streaming, a `message` JSON for non-streaming). For an OpenAI client
 * hitting `/v1/chat/completions`, we translate that output back to the OpenAI
 * wire shape: `chat.completion.chunk` SSE (streaming) or a `chat.completion`
 * object (non-streaming).
 *
 * No such writer existed before — every existing stream parser converts some
 * *upstream* provider format INTO Anthropic SSE; this is the first direction out
 * of Anthropic shape toward an OpenAI client.
 *
 * Never-hang priority holds: a malformed or empty Anthropic stream degrades to
 * a single chunk with `finish_reason:"stop"` followed by `[DONE]`, never a hang
 * or a throw.
 */

/** Map Anthropic stop_reason → OpenAI finish_reason. */
function finishReason(stopReason: string | null | undefined): string | null {
  if (!stopReason) return null;
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

/** Anthropic usage {input_tokens,output_tokens} → OpenAI usage (+total_tokens). */
function mapUsage(usage: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

/**
 * Convert a collected Anthropic `message` object to an OpenAI `chat.completion`.
 * Used on the non-streaming path (the route buffered the SSE into a message via
 * `collectAnthropicSseToMessage`).
 */
export function anthropicMessageToChatCompletion(message: any, fallbackModel?: string): any {
  const content: string[] = [];
  const toolCalls: any[] = [];
  let reasoningContent = "";
  let toolIdx = 0;

  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block.type === "text") {
      content.push(typeof block.text === "string" ? block.text : "");
    } else if (block.type === "tool_use") {
      toolCalls.push({
        index: toolIdx++,
        id: block.id ?? `call_${toolIdx}`,
        type: "function",
        function: {
          name: block.name ?? "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    } else if (block.type === "thinking") {
      reasoningContent += block.thinking ?? "";
    }
  }

  const msg: any = { role: "assistant", content: content.join("") || null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (reasoningContent) msg.reasoning_content = reasoningContent;

  return {
    id: message?.id ?? `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: message?.model ?? fallbackModel ?? "unknown",
    choices: [
      {
        index: 0,
        message: msg,
        finish_reason: finishReason(message?.stop_reason) ?? "stop",
        logprobs: null,
      },
    ],
    usage: mapUsage(message?.usage),
  };
}

/** Encode one OpenAI streaming chunk as SSE bytes. */
function encodeChunk(payload: any): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const DONE_BYTES = new TextEncoder().encode("data: [DONE]\n\n");

/**
 * Wrap an Anthropic-SSE `Response` into an OpenAI `chat.completion.chunk` SSE
 * `Response`. Reads the upstream body, parses Anthropic SSE events, and emits
 * OpenAI chunks. Never throws; degrades to a clean terminal chunk on any error.
 */
export function createOpenAIChatStreamFromAnthropic(
  response: Response,
  fallbackModel?: string
): Response {
  const upstream = response.body;
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };

  if (!upstream) {
    // No body to translate — emit a single terminal chunk + [DONE].
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encodeChunk({
            id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: fallbackModel ?? "unknown",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })
        );
        controller.enqueue(DONE_BYTES);
        controller.close();
      },
    });
    return new Response(stream, { headers });
  }

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Stream state
  let id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  let model = fallbackModel ?? "unknown";
  let created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let stopReason: string | null | undefined = undefined;
  let usage: any = undefined;
  // Anthropic content_block index → OpenAI tool_calls index.
  const blockIndexToToolIndex = new Map<number, number>();
  let nextToolIndex = 0;

  const baseChunk = () => ({ id, object: "chat.completion.chunk" as const, created, model });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendChunk = (choice: any, extra?: any) => {
        const payload: any = { ...baseChunk(), choices: [{ index: 0, delta: choice.delta, finish_reason: choice.finish_reason ?? null }] };
        if (extra?.usage) payload.usage = extra.usage;
        controller.enqueue(encodeChunk(payload));
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by a blank line. Process complete events.
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            processEvent(rawEvent);
          }
        }
        // Flush any trailing partial event (defensive; well-formed streams end cleanly).
        if (buffer.trim()) processEvent(buffer);
      } catch {
        // Swallow — we finalize below regardless.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
        // Terminal chunk (if message_stop didn't already emit one) + [DONE].
        sendChunk({ delta: {}, finish_reason: finishReason(stopReason) ?? "stop" }, usage ? { usage: mapUsage(usage) } : undefined);
        controller.enqueue(DONE_BYTES);
        controller.close();
      }

      /** Parse one raw SSE event (the block between blank lines) and emit chunks. */
      function processEvent(raw: string) {
        let eventType = "message";
        let dataLine = "";
        for (const line of raw.split("\n")) {
          const trimmed = line.replace(/\r$/, "");
          if (trimmed.startsWith("event:")) eventType = trimmed.slice(6).trim();
          else if (trimmed.startsWith("data:")) dataLine += trimmed.slice(5).trim();
        }
        if (!dataLine) return;
        let data: any;
        try {
          data = JSON.parse(dataLine);
        } catch {
          return; // not a JSON event we understand (e.g. a stray line)
        }

        switch (data.type || eventType) {
          case "message_start": {
            const m = data.message ?? {};
            if (m.id) id = m.id;
            if (m.model) model = m.model;
            if (m.usage) usage = m.usage; // initial placeholder {input_tokens:0,output_tokens:0}
            if (!sentRole) {
              sentRole = true;
              sendChunk({ delta: { role: "assistant", content: "" } });
            }
            break;
          }
          case "content_block_start": {
            const block = data.content_block ?? {};
            if (block.type === "tool_use") {
              const idx = typeof data.index === "number" ? data.index : nextToolIndex;
              blockIndexToToolIndex.set(idx, nextToolIndex);
              sendChunk({
                delta: {
                  tool_calls: [
                    {
                      index: nextToolIndex,
                      id: block.id ?? `call_${nextToolIndex}`,
                      type: "function",
                      function: { name: block.name ?? "", arguments: "" },
                    },
                  ],
                },
              });
              nextToolIndex++;
            }
            // text/thinking blocks need no opener; their deltas carry the payload.
            break;
          }
          case "content_block_delta": {
            const delta = data.delta ?? {};
            if (delta.type === "text_delta" && delta.text) {
              if (!sentRole) {
                sentRole = true;
                sendChunk({ delta: { role: "assistant", content: "" } });
              }
              sendChunk({ delta: { content: delta.text } });
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              if (!sentRole) {
                sentRole = true;
                sendChunk({ delta: { role: "assistant", content: "" } });
              }
              sendChunk({ delta: { reasoning_content: delta.thinking } });
            } else if (delta.type === "input_json_delta" && delta.partial_json != null) {
              const toolIdx = blockIndexToToolIndex.get(data.index);
              if (toolIdx !== undefined) {
                sendChunk({
                  delta: {
                    tool_calls: [{ index: toolIdx, function: { arguments: delta.partial_json } }],
                  },
                });
              }
            } else if (delta.type === "signature_delta") {
              // OpenAI has no signature equivalent — drop.
            }
            break;
          }
          case "content_block_stop":
            // No OpenAI equivalent; nothing to emit.
            break;
          case "message_delta": {
            if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
            if (data.usage) {
              // message_delta.usage carries the FINAL output count; merge over placeholder.
              usage = { ...(usage ?? {}), ...data.usage };
            }
            break;
          }
          case "message_stop":
            // Final chunk emitted in `finally` to guarantee termination.
            break;
          case "ping":
          default:
            // Ignore pings and unknown events.
            break;
        }
      }
    },
  });

  return new Response(stream, { headers });
}
