/**
 * Gemini SSE → Claude SSE stream parser.
 *
 * Gemini streams SSE with `data: {"candidates": [{"content": {"parts": [...]}}]}`.
 * Handles: text, thinking (the `thought: true` flag / thoughtText), functionCall with thoughtSignature,
 * usageMetadata, and finishReason. CodeAssist variant wraps response in {response: {...}}.
 */

import type { Context } from "hono";
import type { BaseAPIFormat } from "../../../adapters/base-api-format.js";
import { log } from "../../../logger.js";
import type { MiddlewareManager } from "../../../middleware/manager.js";
import { redactForClient } from "../../../redact.js";
import { messageStartUsage } from "./message-start-usage.js";
import { sseDataPayload } from "./sse-line.js";
import {
  type ParserSource,
  type UpstreamReaderSlot,
  cancelEndsUpstreamWork,
} from "./upstream-cancel.js";

export interface GeminiSseOptions {
  modelName: string;
  adapter?: BaseAPIFormat;
  middlewareManager?: MiddlewareManager;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Store tool call info (id, name, thoughtSignature) for future request context */
  onToolCall?: (toolId: string, name: string, thoughtSignature?: string) => void;
  /**
   * Behavior layer (Layer 4) tool-call repair. Deliberately NOT merged into
   * `onToolCall` above, which is an unrelated pre-existing hook for recording
   * thought signatures.
   *
   * No buffering is needed on this path: Gemini delivers each `functionCall`
   * with its complete `args` object in one part, so the full arguments are
   * always in hand at emit time.
   */
  repairToolArgs?: (name: string, argsJson: string) => string | null | undefined;
  /**
   * Behavior-layer observation (Layer 4). Called with normalized text so rules
   * never have to understand this parser's event shape.
   */
  onAssistantText?: (text: string, kind?: "text" | "reasoning") => void;
  onToolCallObserved?: (name: string) => void;
  onTurnEnd?: () => void;

  /** Last request's context size — seeds message_start.usage (see message-start-usage.ts) */
  priorInputTokens?: number;
  /** CodeAssist wraps chunks in {response: {...}} */
  unwrapResponse?: boolean;
}

export function createGeminiSseStream(
  _c: Context,
  response: Response,
  opts: GeminiSseOptions
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
      /** Upstream finishReason was MAX_TOKENS — the turn was cut off, not completed. */
      let truncated = false;

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

      // Kept out of finalize() so it can run from a `finally`. finalize() guards
      // re-entry on `finalized`, so a throw part-way through (afterStreamComplete
      // is an await on user middleware) used to leave the controller open and the
      // ping interval running forever — the outer catch re-called finalize() and
      // it returned at the guard. Safe to call more than once.
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

      const finalize = async (reason: string, err?: string) => {
        // A repeat call still tears down: the first may have thrown before
        // reaching its own `finally`.
        if (finalized) {
          teardown();
          return;
        }
        finalized = true;

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
            send("error", {
              type: "error",
              error: { type: "api_error", message: err === undefined ? err : redactForClient(err) },
            });
          } else {
            const hasToolCalls = toolCalls.size > 0;
            // Anthropic's contract for a cut-off turn is "max_tokens". Reporting
            // "end_turn" presents a truncated answer — or an empty one, when a
            // thinking model spent the whole budget reasoning — as the model's
            // complete final word.
            const stopReason = truncated ? "max_tokens" : hasToolCalls ? "tool_use" : "end_turn";
            if (truncated) {
              log("[GeminiSSE] finishReason=MAX_TOKENS → stop_reason=max_tokens");
            }
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              // input_tokens rides the delta so the client learns the real context
              // size — without it Claude Code keeps message_start's estimate and
              // auto-compaction never arms. See message-start-usage.ts.
              usage: {
                ...(inputTokens > 0 ? { input_tokens: inputTokens } : {}),
                output_tokens: outputTokens,
              },
            });
            opts.onTurnEnd?.();
            send("message_stop", { type: "message_stop" });
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

                  // Handle thinking/reasoning text.
                  //
                  // `thought` is a BOOLEAN FLAG on the part — the reasoning text
                  // itself rides in `part.text`. Treating the flag as content
                  // emitted the literal `true` into a thinking_delta AND let the
                  // reasoning fall through to the visible-text branch below.
                  // (`thoughtText` is a non-standard variant kept for backends
                  // that send one.)
                  const isThoughtPart = part.thought === true;
                  const thinkingContent = isThoughtPart ? (part.text ?? "") : part.thoughtText;

                  if (thinkingContent) {
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

                  // Handle regular text (a thought part's text was emitted above)
                  if (part.text && !isThoughtPart) {
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
                      // An adapter that consumes ALL the visible text yields a
                      // turn with no content block, which is indistinguishable
                      // downstream from "the model said nothing" — a blank answer
                      // that still reports success. Non-empty in, non-empty out.
                      if (!cleanedText) {
                        log(
                          `[gemini-sse] adapter emptied ${part.text.length} chars of visible text — passing the original through`
                        );
                        cleanedText = part.text;
                      }
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
                    opts.onToolCallObserved?.(part.functionCall.name);
                    let args = JSON.stringify(part.functionCall.args || {});
                    if (opts.repairToolArgs) {
                      try {
                        const repaired = opts.repairToolArgs(part.functionCall.name, args);
                        if (typeof repaired === "string" && repaired !== args) {
                          log(`[GeminiSSE] tool call repaired: ${part.functionCall.name}`);
                          args = repaired;
                        }
                      } catch (err) {
                        // A failing rule must never corrupt the stream.
                        log(
                          `[GeminiSSE] repairToolArgs threw for ${part.functionCall.name}: ${err}`
                        );
                      }
                    }

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

              // Check for finish reason. MAX_TOKENS must stay distinguishable from
              // STOP all the way into finalize() — collapsing both into "done"
              // reported a cut-off turn as a completed one.
              if (candidate?.finishReason) {
                if (candidate.finishReason === "STOP" || candidate.finishReason === "MAX_TOKENS") {
                  truncated = candidate.finishReason === "MAX_TOKENS";
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
