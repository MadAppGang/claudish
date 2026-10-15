/**
 * Gemini SSE → Claude SSE stream parser.
 *
 * Gemini streams SSE with `data: {"candidates": [{"content": {"parts": [...]}}]}`.
 * Handles: text, thinking (thought/thoughtText), functionCall with thoughtSignature,
 * usageMetadata, and finishReason. CodeAssist variant wraps response in {response: {...}}.
 */

import type { Context } from "hono";
import type { BaseAPIFormat } from "../../../adapters/base-api-format.js";
import type { MiddlewareManager } from "../../../middleware/manager.js";
import { log } from "../../../logger.js";
import { createResponseCapture } from "../response-capture.js";
import { requestNumberFor } from "../../../fork/middleware/request-logger.js";
import { messageStartUsage } from "./message-start-usage.js";
import { sseDataPayload } from "./sse-line.js";
import { toAnthropicUsage } from "./usage-cache-split.js";

export interface GeminiSseOptions {
  modelName: string;
  adapter?: BaseAPIFormat;
  middlewareManager?: MiddlewareManager;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Previous turn's input-token count, seeding message_start (#179/#444). */
  priorInputTokens?: number;
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
  // Diagnostic capture (no-op unless CLAUDISH_CAPTURE_DIR is set). This lane
  // streamed with NO capture at all — the same blind spot the responses lane
  // had before bb170b97: a lane that emits and captures nothing is invisible to
  // every capture analysis, and its absence reads as "no traffic on this lane"
  // rather than "this lane is not instrumented". Mandate: capture every lane.
  const reqN = requestNumberFor(c.req);
  const cap = createResponseCapture("gemini", opts.modelName, true, reqN);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let isClosed = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // Tap the CLIENT-bound SSE, mirroring the openai/anthropic lanes: wired at
      // enqueue rather than on the upstream bytes, so a capture is the exact
      // translated stream the client received and is replayable as a fixture.
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
      // The stop_reason of the terminal message_delta the client actually
      // received — same contract as the openai lane (#220): stays undefined when
      // no message_delta went out, and the [resp] marker then reads `stop=?`,
      // which is a meaning ("the stream ended without one"), never a bug.
      let sentStopReason: string | undefined;

      // #444 — Gemini's usageMetadata is camelCase (promptTokenCount /
      // candidatesTokenCount / cachedContentTokenCount), spellings the shared
      // shaper deliberately does not know: splitPromptTokens reads the openai /
      // DeepSeek spellings, and widening it with Gemini's dialect would make one
      // provider's naming everyone's. Map to the openai shape HERE, at the only
      // call site, so the three input counters ship together and sum back to
      // promptTokenCount (#179). cachedContentTokenCount is the cache-READ share
      // of the prompt — the same subset relation openai's cached_tokens holds.
      const shapedUsage = () =>
        toAnthropicUsage({
          prompt_tokens: usage?.promptTokenCount || 0,
          completion_tokens: usage?.candidatesTokenCount || 0,
          prompt_tokens_details:
            usage?.cachedContentTokenCount > 0
              ? { cached_tokens: usage.cachedContentTokenCount }
              : undefined,
        });

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

      pingInterval = setInterval(() => {
        if (!isClosed && Date.now() - lastActivity > 1000) {
          send("ping", { type: "ping" });
        }
      }, 1000);

      const finalize = async (reason: string, err?: string) => {
        if (finalized) return;
        finalized = true;

        // HARD never-hang invariant: the cleanup in `finally` (clearInterval +
        // controller.close) MUST run on every exit path, including a throw mid-body
        // (e.g. middleware afterStreamComplete rejecting). A re-entrancy guard alone
        // is not enough: the outer catch re-calls finalize(), which no-ops because
        // `finalized` is already true — leaving the first call's cleanup undone and
        // the ping interval leaking forever (= hung stream). See never-hang-priority.
        try {
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
            try {
              await opts.middlewareManager.afterStreamComplete(opts.modelName, new Map());
            } catch (mwErr) {
              log(`[GeminiSSE] afterStreamComplete threw (ignored): ${mwErr}`);
            }
          }

          const inputTokens = usage?.promptTokenCount || 0;
          const outputTokens = usage?.candidatesTokenCount || 0;

          if (usage) {
            log(`[GeminiSSE] Usage: prompt=${inputTokens}, completion=${outputTokens}`);
          }

          if (opts.onTokenUpdate) {
            try {
              opts.onTokenUpdate(inputTokens, outputTokens);
            } catch {}
          }

          if (reason === "error") {
            log(`[GeminiSSE] Stream error: ${err}`);
            send("error", { type: "error", error: { type: "api_error", message: err } });
          } else {
            const hasToolCalls = toolCalls.size > 0;
            sentStopReason = hasToolCalls ? "tool_use" : "end_turn";
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: hasToolCalls ? "tool_use" : "end_turn", stop_sequence: null },
              usage: shapedUsage(),
            });
            send("message_stop", { type: "message_stop" });
          }
        } catch (finalizeErr) {
          // Last-ditch terminal pair so the client never hangs waiting for the end.
          log(`[GeminiSSE] finalize() body threw: ${finalizeErr}`);
          try {
            sentStopReason = "end_turn";
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              // Same shaping as the happy path (openai-lane convention): the
              // last-ditch delta carries the four-key shape too — with usage
              // still null this degrades to explicit zeros, which the client's
              // merge falls back over the seed.
              usage: shapedUsage(),
            });
            send("message_stop", { type: "message_stop" });
          } catch {}
        } finally {
          // Mirrors the anthropic lane's convention: `closed: true` on every path
          // that reached finalize (the controller always closes there), with the
          // stop reason of the terminal event the client got. done() is
          // idempotent and swallows its own errors — it can never break the stream.
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
            const dataStr = line.trim() ? sseDataPayload(line) : null;
            if (dataStr === null) continue;
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
      // A client abort never reaches finalize, so it closes the capture here —
      // closed=false is what distinguishes it from a clean close (#220).
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
