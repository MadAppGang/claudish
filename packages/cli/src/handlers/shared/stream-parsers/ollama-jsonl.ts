/**
 * Ollama JSONL → Claude SSE stream parser.
 *
 * Ollama sends line-by-line JSON (NOT SSE):
 *   {"message": {"content": "hello"}, "done": false}
 *   {"message": {"content": " world"}, "done": false}
 *   {"done": true, "prompt_eval_count": N, "eval_count": M}
 *
 * Converts to Claude SSE (message_start, content_block_start/delta/stop, message_stop).
 */

import type { Context } from "hono";
import { log } from "../../../logger.js";

export function createOllamaJsonlStream(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    onTokenUpdate?: (input: number, output: number) => void;
  }
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
      let textStarted = false;
      let promptTokens = 0;
      let completionTokens = 0;
      let lastActivity = Date.now();

      // Send initial message_start
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

      // Keepalive ping
      pingInterval = setInterval(() => {
        if (!isClosed && Date.now() - lastActivity > 1000) {
          send("ping", { type: "ping" });
        }
      }, 1000);

      const finalize = (reason: string, err?: string) => {
        if (isClosed) return;

        if (textStarted) {
          send("content_block_stop", { type: "content_block_stop", index: 0 });
        }

        if (reason === "error") {
          send("error", { type: "error", error: { type: "api_error", message: err } });
        } else {
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: completionTokens },
          });
          send("message_stop", { type: "message_stop" });
        }

        if (opts.onTokenUpdate) {
          opts.onTokenUpdate(promptTokens, completionTokens);
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
            if (!line.trim()) continue;

            try {
              const chunk = JSON.parse(line);

              if (chunk.done) {
                if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
                if (chunk.eval_count) completionTokens = chunk.eval_count;
                log(`[OllamaJSONL] Done: prompt=${promptTokens}, completion=${completionTokens}`);
                finalize("done");
                return;
              }

              const content = chunk.message?.content || "";
              if (content) {
                lastActivity = Date.now();

                if (!textStarted) {
                  send("content_block_start", {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  });
                  textStarted = true;
                }

                send("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: content },
                });
              }
            } catch {
              log(`[OllamaJSONL] Parse error: ${line.slice(0, 100)}`);
            }
          }
        }

        // Stream ended without done=true
        finalize("done");
      } catch (error) {
        log(`[OllamaJSONL] Stream error: ${error}`);
        finalize("error", String(error));
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
