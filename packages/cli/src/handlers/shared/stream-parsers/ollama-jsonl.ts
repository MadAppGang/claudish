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
import { redactForClient } from "../../../redact.js";
import { messageStartUsage } from "./message-start-usage.js";
import {
  type ParserSource,
  type UpstreamReaderSlot,
  cancelEndsUpstreamWork,
} from "./upstream-cancel.js";

export function createOllamaJsonlStream(
  _c: Context,
  response: Response,
  opts: {
    modelName: string;
    onTokenUpdate?: (input: number, output: number) => void;
    /** Last request's context size — seeds message_start.usage (see message-start-usage.ts) */
    priorInputTokens?: number;
  }
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let isClosed = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const upstream: UpstreamReaderSlot = {};
  const source: ParserSource<Uint8Array> = {
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
          usage: messageStartUsage(opts.priorInputTokens),
        },
      });
      send("ping", { type: "ping" });

      // Keepalive ping
      pingInterval = setInterval(() => {
        if (!isClosed && Date.now() - lastActivity > 1000) {
          send("ping", { type: "ping" });
        }
      }, 1000);

      // `isClosed` used to double as the re-entry guard, which made a throw
      // part-way through finalize() worse than a leak: isClosed was still false,
      // so the catch at the bottom re-ran the WHOLE body and emitted a second
      // message_delta / message_stop. A dedicated `finalized` flag separates
      // "already emitted the terminal events" from "controller is shut", and
      // teardown runs from a `finally` so the ping interval always clears.
      let finalized = false;

      const teardown = () => {
        if (!isClosed) {
          isClosed = true;
          try {
            controller.close();
          } catch {}
        }
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
      };

      const finalize = (reason: string, err?: string) => {
        if (finalized) {
          teardown();
          return;
        }
        finalized = true;

        try {
          if (textStarted) {
            send("content_block_stop", { type: "content_block_stop", index: 0 });
          }

          if (reason === "error") {
            send("error", {
              type: "error",
              error: { type: "api_error", message: err === undefined ? err : redactForClient(err) },
            });
          } else {
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              // Ollama reports the FULL context each turn in prompt_eval_count;
              // forwarding it lets Claude Code arm auto-compaction instead of
              // holding message_start's estimate. See message-start-usage.ts.
              usage: {
                ...(promptTokens > 0 ? { input_tokens: promptTokens } : {}),
                output_tokens: completionTokens,
              },
            });
            send("message_stop", { type: "message_stop" });
          }

          if (opts.onTokenUpdate) {
            opts.onTokenUpdate(promptTokens, completionTokens);
          }
        } finally {
          teardown();
        }
      };

      try {
        const reader = response.body!.getReader();
        upstream.reader = reader;
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
    // Downstream went away: cancelEndsUpstreamWork cancels the upstream reader
    // after this and resolves only once the read loop above has settled.
    cancel() {
      isClosed = true;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    },
  };
  const stream = new ReadableStream(cancelEndsUpstreamWork(upstream, source));

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
