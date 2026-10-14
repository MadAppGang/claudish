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
import { createResponseCapture } from "../response-capture.js";
import { requestNumberFor } from "../../../fork/middleware/request-logger.js";
import { messageStartUsage } from "./message-start-usage.js";
import { toAnthropicUsage } from "./usage-cache-split.js";

export function createOllamaJsonlStream(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    onTokenUpdate?: (input: number, output: number) => void;
    /** Previous turn's input-token count, seeding message_start (#179/#444). */
    priorInputTokens?: number;
  }
): Response {
  // Diagnostic capture (no-op unless CLAUDISH_CAPTURE_DIR is set) — this lane
  // emitted with no capture at all, the same asymmetry the responses lane
  // carried before bb170b97: an uninstrumented lane is indistinguishable from
  // a silent one. Mandate: capture every lane, no exception.
  const reqN = requestNumberFor(c.req);
  const cap = createResponseCapture("ollama", opts.modelName, true, reqN);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let isClosed = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // Tap the CLIENT-bound SSE (the translated stream), same seam as the
      // openai/anthropic lanes — the capture is then replayable as a fixture.
      const _origEnqueue = controller.enqueue.bind(controller);
      controller.enqueue = ((chunk: any) => {
        cap.tap(chunk);
        return _origEnqueue(chunk);
      }) as any;

      const send = (event: string, data: any) => {
        if (!isClosed) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };

      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let textStarted = false;
      let finalized = false;
      let promptTokens = 0;
      let completionTokens = 0;
      let lastActivity = Date.now();
      // The stop_reason of the terminal message_delta the client actually
      // received; undefined means the [resp] marker reads `stop=?` ("ended
      // without one"), never a bug. Same contract as the openai lane (#220).
      let sentStopReason: string | undefined;

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

      const finalize = (reason: string, err?: string) => {
        if (finalized) return;
        finalized = true;

        // HARD never-hang invariant: cleanup in `finally` (clearInterval +
        // controller.close) MUST run on every exit path, including a throw from a
        // send() mid-body. The previous guard set isClosed only AFTER the sends, so
        // a throw before that line left isClosed=false; the outer catch re-called
        // finalize() and could throw again, leaving the ping interval leaking
        // forever (= hung stream). See never-hang-priority.
        try {
          if (textStarted) {
            send("content_block_stop", { type: "content_block_stop", index: 0 });
          }

          if (reason === "error") {
            send("error", { type: "error", error: { type: "api_error", message: err } });
          } else {
            sentStopReason = "end_turn";
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              // #444 — the shared shaper (no cache fields on this wire → all
              // ordinary input) so the three input keys ship together and sum
              // back to prompt_eval_count (#179).
              usage: toAnthropicUsage({ prompt_tokens: promptTokens, completion_tokens: completionTokens }),
            });
            send("message_stop", { type: "message_stop" });
          }

          if (opts.onTokenUpdate) {
            try {
              opts.onTokenUpdate(promptTokens, completionTokens);
            } catch {}
          }
        } catch (finalizeErr) {
          // Last-ditch terminal pair so the client never hangs waiting for the end.
          log(`[OllamaJSONL] finalize() body threw: ${finalizeErr}`);
          try {
            sentStopReason = "end_turn";
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              // Same shaping as the happy path: explicit zeros in the four-key
              // shape, which the client's merge falls back over the seed.
              usage: toAnthropicUsage({ prompt_tokens: promptTokens, completion_tokens: completionTokens }),
            });
            send("message_stop", { type: "message_stop" });
          } catch {}
        } finally {
          // Anthropic-lane convention: `closed: true` on every path that reached
          // finalize, with the terminal stop reason the client received. done()
          // is idempotent and swallows its own errors — never breaks the stream.
          cap.done({
            closed: true,
            stop_reason: reason === "error" ? "exception" : sentStopReason,
            reason,
            path: "finalize",
          });
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
      // A client abort never reaches finalize; closed=false marks it (#220).
      cap.note("client-cancel");
      cap.done({ closed: false, stop_reason: "client-cancel", path: "cancel" });
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
