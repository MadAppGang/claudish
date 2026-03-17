/**
 * Gemini SSE → Claude SSE stream parser.
 *
 * Gemini streams SSE with `data: {"candidates": [{"content": {"parts": [...]}}]}`.
 * Handles: text, thinking (thought/thoughtText), functionCall with thoughtSignature,
 * usageMetadata, and finishReason. CodeAssist variant wraps response in {response: {...}}.
 */

import type { Context } from "hono";
import type { BaseModelAdapter } from "../../../adapters/base-adapter.js";
import type { MiddlewareManager } from "../../../middleware/manager.js";
import { log } from "../../../logger.js";

export interface GeminiSseOptions {
  modelName: string;
  adapter?: BaseModelAdapter;
  middlewareManager?: MiddlewareManager;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Store tool call info (id, name, thoughtSignature) for future request context */
  onToolCall?: (toolId: string, name: string, thoughtSignature?: string) => void;
  /** CodeAssist wraps chunks in {response: {...}} */
  unwrapResponse?: boolean;
}

export function createGeminiSseStream(
  c: Context,
  response: Response,
  opts: GeminiSseOptions
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let isClosed = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        if (!isClosed) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };

      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let usage: any = null;
      let finalized = false;
      let textStarted = false;
      let textIdx = -1;
      let thinkingStarted = false;
      let thinkingIdx = -1;
      let curIdx = 0;
      const toolCalls = new Map<number, any>();
      let accumulatedText = "";
      let lastActivity = Date.now();

      send("message_start", {
        type: "message_start",
        message: {
          id: msgId,
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

      const finalize = async (reason: string, err?: string) => {
        if (finalized) return;
        finalized = true;

        if (thinkingStarted) {
          send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
        }
        if (textStarted) {
          send("content_block_stop", { type: "content_block_stop", index: textIdx });
        }
        for (const t of toolCalls.values()) {
          if (t.started && !t.closed) {
            send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
            t.closed = true;
          }
        }

        if (opts.middlewareManager) {
          await opts.middlewareManager.afterStreamComplete(opts.modelName, new Map());
        }

        const inputTokens = usage?.promptTokenCount || 0;
        const outputTokens = usage?.candidatesTokenCount || 0;

        if (usage) {
          log(`[GeminiSSE] Usage: prompt=${inputTokens}, completion=${outputTokens}`);
        }

        if (opts.onTokenUpdate) {
          opts.onTokenUpdate(inputTokens, outputTokens);
        }

        if (reason === "error") {
          log(`[GeminiSSE] Stream error: ${err}`);
          send("error", { type: "error", error: { type: "api_error", message: err } });
        } else {
          const hasToolCalls = toolCalls.size > 0;
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: hasToolCalls ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });
          send("message_stop", { type: "message_stop" });
        }

        if (!isClosed) {
          isClosed = true;
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          try {
            controller.close();
          } catch {}
        }
      };

      try {
        const reader = response.body!.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim() || !line.startsWith("data: ")) continue;
            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") {
              await finalize("done");
              return;
            }

            try {
              const chunk = JSON.parse(dataStr);

              // CodeAssist wraps in {response: {...}}, standard Gemini doesn't
              const responseData = opts.unwrapResponse ? chunk.response || chunk : chunk;

              if (responseData.usageMetadata) {
                usage = responseData.usageMetadata;
              }

              const candidate = responseData.candidates?.[0];
              if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                  lastActivity = Date.now();

                  // Handle thinking/reasoning text
                  if (part.thought || part.thoughtText) {
                    const thinkingContent = part.thought || part.thoughtText;
                    if (!thinkingStarted) {
                      thinkingIdx = curIdx++;
                      send("content_block_start", {
                        type: "content_block_start",
                        index: thinkingIdx,
                        content_block: { type: "thinking", thinking: "" },
                      });
                      thinkingStarted = true;
                    }
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: thinkingIdx,
                      delta: { type: "thinking_delta", thinking: thinkingContent },
                    });
                  }

                  // Handle regular text
                  if (part.text) {
                    // Close thinking block before text
                    if (thinkingStarted) {
                      send("content_block_stop", {
                        type: "content_block_stop",
                        index: thinkingIdx,
                      });
                      thinkingStarted = false;
                    }

                    let cleanedText = part.text;
                    if (opts.adapter) {
                      const res = opts.adapter.processTextContent(part.text, accumulatedText);
                      cleanedText = res.cleanedText || "";
                      accumulatedText += cleanedText;
                    } else {
                      accumulatedText += cleanedText;
                    }

                    if (cleanedText) {
                      if (!textStarted) {
                        textIdx = curIdx++;
                        send("content_block_start", {
                          type: "content_block_start",
                          index: textIdx,
                          content_block: { type: "text", text: "" },
                        });
                        textStarted = true;
                      }
                      send("content_block_delta", {
                        type: "content_block_delta",
                        index: textIdx,
                        delta: { type: "text_delta", text: cleanedText },
                      });
                    }
                  }

                  // Handle function calls
                  if (part.functionCall) {
                    if (thinkingStarted) {
                      send("content_block_stop", {
                        type: "content_block_stop",
                        index: thinkingIdx,
                      });
                      thinkingStarted = false;
                    }
                    if (textStarted) {
                      send("content_block_stop", { type: "content_block_stop", index: textIdx });
                      textStarted = false;
                    }

                    const toolIdx = toolCalls.size;
                    const toolId = `toolu_${Date.now()}_${toolIdx}`;
                    const blockIndex = curIdx++;
                    const args = JSON.stringify(part.functionCall.args || {});

                    const t = {
                      id: toolId,
                      name: part.functionCall.name,
                      blockIndex,
                      started: true,
                      closed: false,
                    };
                    toolCalls.set(toolIdx, t);

                    // Store tool call info + thoughtSignature for future requests
                    if (opts.onToolCall) {
                      opts.onToolCall(toolId, part.functionCall.name, part.thoughtSignature);
                    }

                    send("content_block_start", {
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: { type: "tool_use", id: toolId, name: part.functionCall.name },
                    });
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: blockIndex,
                      delta: { type: "input_json_delta", partial_json: args },
                    });
                    send("content_block_stop", { type: "content_block_stop", index: blockIndex });
                    t.closed = true;
                  }
                }
              }

              // Check for finish reason
              if (candidate?.finishReason) {
                if (candidate.finishReason === "STOP" || candidate.finishReason === "MAX_TOKENS") {
                  await finalize("done");
                  return;
                }
              }
            } catch (e) {
              log(`[GeminiSSE] Parse error: ${e}`);
            }
          }
        }

        await finalize("done");
      } catch (e) {
        await finalize("error", String(e));
      }
    },
    cancel() {
      isClosed = true;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
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
