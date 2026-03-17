/**
 * OpenAI Responses API SSE → Claude SSE stream parser.
 *
 * Handles Codex models that use /v1/responses instead of /v1/chat/completions.
 * The Responses API has different event types:
 *   response.output_text.delta → content text
 *   response.output_item.added → new item (function_call, reasoning)
 *   response.function_call_arguments.delta → tool argument streaming
 *   response.reasoning_summary_text.delta → thinking output
 *   response.output_item.done → close tool_use block
 *   response.completed / response.done → final usage
 */

import type { Context } from "hono";
import { log, getLogLevel } from "../../../logger.js";

export function createResponsesStreamHandler(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    onTokenUpdate?: (input: number, output: number) => void;
    toolNameMap?: Map<string, string>;
  }
): Response {
  const reader = response.body?.getReader();
  if (!reader) {
    return c.json({ error: "No response body" }, 500) as any;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let buffer = "";
  let blockIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasTextContent = false;
  let hasToolUse = false;
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;

  // Track function calls being streamed
  const functionCalls: Map<
    string,
    { name: string; arguments: string; index: number; claudeId?: string }
  > = new Map();

  const stream = new ReadableStream({
    start: async (controller) => {
      const send = (event: string, data: any) => {
        if (!isClosed) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [],
          model: opts.modelName,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      });
      send("ping", { type: "ping" });

      pingInterval = setInterval(() => {
        if (!isClosed && Date.now() - lastActivity > 1000) {
          send("ping", { type: "ping" });
        }
      }, 1000);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivity = Date.now();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) continue;
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const event = JSON.parse(data);

              if (getLogLevel() === "debug" && event.type) {
                log(`[ResponsesSSE] Event: ${event.type}`);
              }

              if (event.type === "response.output_text.delta") {
                if (!hasTextContent) {
                  send("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "text", text: "" },
                  });
                  hasTextContent = true;
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: event.delta || "" },
                });
              } else if (event.type === "response.output_item.added") {
                if (event.item?.type === "function_call") {
                  const itemId = event.item.id;
                  const openaiCallId = event.item.call_id || itemId;
                  const callId = openaiCallId.startsWith("toolu_")
                    ? openaiCallId
                    : `toolu_${openaiCallId.replace(/^fc_/, "")}`;
                  const rawFnName = event.item.name || "";
                  const fnName = opts.toolNameMap?.get(rawFnName) || rawFnName;
                  const fnIndex = blockIndex + functionCalls.size + (hasTextContent ? 1 : 0);

                  const fnCallData = {
                    name: fnName,
                    arguments: "",
                    index: fnIndex,
                    claudeId: callId,
                  };

                  functionCalls.set(openaiCallId, fnCallData);
                  if (itemId && itemId !== openaiCallId) {
                    functionCalls.set(itemId, fnCallData);
                  }

                  if (hasTextContent && !hasToolUse) {
                    send("content_block_stop", { type: "content_block_stop", index: blockIndex });
                    blockIndex++;
                  }

                  send("content_block_start", {
                    type: "content_block_start",
                    index: fnIndex,
                    content_block: { type: "tool_use", id: callId, name: fnName, input: {} },
                  });
                  hasToolUse = true;
                }
              } else if (event.type === "response.reasoning_summary_text.delta") {
                if (!hasTextContent) {
                  send("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "text", text: "" },
                  });
                  hasTextContent = true;
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: event.delta || "" },
                });
              } else if (event.type === "response.function_call_arguments.delta") {
                const callId = event.call_id || event.item_id;
                const fnCall = functionCalls.get(callId);
                if (fnCall) {
                  fnCall.arguments += event.delta || "";
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: fnCall.index,
                    delta: { type: "input_json_delta", partial_json: event.delta || "" },
                  });
                }
              } else if (event.type === "response.output_item.done") {
                if (event.item?.type === "function_call") {
                  const callId = event.item.call_id || event.item.id;
                  const fnCall = functionCalls.get(callId) || functionCalls.get(event.item.id);
                  if (fnCall) {
                    send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
                  }
                }
              } else if (event.type === "response.incomplete") {
                log(`[ResponsesSSE] Response incomplete: ${event.reason || "unknown"}`);
                if (event.response?.usage) {
                  inputTokens = event.response.usage.input_tokens || inputTokens;
                  outputTokens = event.response.usage.output_tokens || outputTokens;
                }
              } else if (event.type === "response.completed" || event.type === "response.done") {
                if (event.response?.usage) {
                  inputTokens = event.response.usage.input_tokens || 0;
                  outputTokens = event.response.usage.output_tokens || 0;
                } else if (event.usage) {
                  inputTokens = event.usage.input_tokens || 0;
                  outputTokens = event.usage.output_tokens || 0;
                }
              } else if (event.type === "error" || event.type === "response.failed") {
                const err = event.error || event.response?.error || {};
                const errMsg = err.message || event.message || "Unknown API error";
                const errCode = err.code || event.code || "";
                log(`[ResponsesSSE] API error: ${errCode} - ${errMsg}`);

                if (hasTextContent) {
                  send("content_block_stop", { type: "content_block_stop", index: blockIndex });
                  hasTextContent = false;
                }
                for (const [, fnCall] of functionCalls) {
                  send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
                }

                const errorIdx = blockIndex + functionCalls.size + (hasToolUse ? 1 : 0);
                send("content_block_start", {
                  type: "content_block_start",
                  index: errorIdx,
                  content_block: { type: "text", text: "" },
                });
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: errorIdx,
                  delta: { type: "text_delta", text: `\n\n[API Error: ${errCode} ${errMsg}]` },
                });
                send("content_block_stop", { type: "content_block_stop", index: errorIdx });

                send("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                });
                send("message_stop", { type: "message_stop" });
                isClosed = true;
                if (pingInterval) {
                  clearInterval(pingInterval);
                  pingInterval = null;
                }
                if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
                controller.close();
                return;
              }
            } catch (parseError) {
              log(`[ResponsesSSE] Parse error: ${parseError}`);
            }
          }
        }

        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }

        if (hasTextContent) {
          send("content_block_stop", { type: "content_block_stop", index: blockIndex });
        }

        const stopReason = hasToolUse ? "tool_use" : "end_turn";
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });

        isClosed = true;
        if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
        controller.close();
      } catch (error) {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        log(`[ResponsesSSE] Stream error: ${error}`);

        if (!isClosed) {
          try {
            if (hasTextContent) {
              send("content_block_stop", { type: "content_block_stop", index: blockIndex });
            }
            for (const [, fnCall] of functionCalls) {
              send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
            }

            const errorIdx = blockIndex + functionCalls.size + (hasToolUse ? 1 : 0);
            send("content_block_start", {
              type: "content_block_start",
              index: errorIdx,
              content_block: { type: "text", text: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: errorIdx,
              delta: { type: "text_delta", text: `\n\n[Stream error: ${error}]` },
            });
            send("content_block_stop", { type: "content_block_stop", index: errorIdx });

            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            });
            send("message_stop", { type: "message_stop" });
          } catch {}

          isClosed = true;
          if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
          try {
            controller.close();
          } catch {}
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
