/**
 * Anthropic SSE passthrough stream parser.
 *
 * For providers that speak native Anthropic format (MiniMax, Kimi, Z.AI),
 * this is a near-identity transform — the response is already in Claude SSE format.
 * Only light fixups are needed (e.g., ensuring message IDs, merging usage data).
 *
 * When `filterThinking` is enabled (via adapter.shouldFilterThinking()), thinking
 * blocks are stripped from the stream and content block indices are re-numbered.
 */

import type { Context } from "hono";
import { log } from "../../../logger.js";
import type { BaseAPIFormat } from "../../../adapters/base-api-format.js";

interface AnthropicPassthroughOpts {
  modelName: string;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Optional adapter — used to check shouldFilterThinking(). */
  adapter?: BaseAPIFormat;
}

/**
 * Pass through an Anthropic-format SSE stream with minimal fixups.
 * The response body is already Claude-compatible SSE events.
 *
 * When adapter.shouldFilterThinking() returns true, thinking blocks are
 * stripped and content block indices are re-numbered so downstream consumers
 * see a contiguous sequence (0, 1, 2, ...).
 */
export function createAnthropicPassthroughStream(
  c: Context,
  response: Response,
  opts: AnthropicPassthroughOpts
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let isClosed = false;
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const filterThinking = opts.adapter?.shouldFilterThinking() ?? false;

  return c.body(
    new ReadableStream({
      async start(controller) {
        const sendPing = () => {
          if (!isClosed) {
            controller.enqueue(encoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n"));
          }
        };

        sendPing();

        pingInterval = setInterval(() => {
          if (!isClosed && Date.now() - lastActivity > 1000) {
            sendPing();
          }
        }, 1000);

        try {
          const reader = response.body!.getReader();
          let buffer = "";
          let inputTokens = 0;
          let outputTokens = 0;

          let totalLines = 0;
          let textChunks = 0;
          let toolUseBlocks = 0;
          let stopReason: string | null = null;
          let sawMessageStop = false;

          // Thinking-block filtering state
          let insideThinkingBlock = false;
          /** How many thinking blocks have been suppressed so far. */
          let thinkingBlocksSuppressed = 0;

          // Content block index tracking — detect out-of-range indices
          // that would cause "Content block not found" on the client side.
          let highestSeenIndex = -1;
          const clampIndex = (idx: number, context: string): number => {
            if (idx > highestSeenIndex + 1) {
              log(
                `[AnthropicSSE] Index jump detected: ${idx} but expected <=${highestSeenIndex + 1} (${context}) — clamping to ${highestSeenIndex + 1}`
              );
              return highestSeenIndex + 1;
            }
            return idx;
          };
          const trackIndex = (idx: number) => {
            if (idx > highestSeenIndex) highestSeenIndex = idx;
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            lastActivity = Date.now();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              totalLines++;

              // ── Thinking-block filtering ──────────────────────────────
              if (filterThinking && line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));

                  // ── In-stream error detection (GitHub #106) ──
                  // Some anthropic-compat providers (Z.AI, MiniMax, Kimi) return
                  // HTTP 200 with {"error":{...}} embedded in the SSE payload.
                  // Detect and surface as a proper error event.
                  if (data.error) {
                    const errMsg = data.error.message || JSON.stringify(data.error);
                    log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(
                        `event: error\ndata: ${JSON.stringify({
                          type: "error",
                          error: { type: "api_error", message: errMsg },
                        })}\n\n`
                      ));
                      isClosed = true;
                      if (pingInterval) {
                        clearInterval(pingInterval);
                        pingInterval = null;
                      }
                      controller.close();
                    }
                    return; // stop processing further lines
                  }

                  // Track: entering a thinking block
                  if (
                    data.type === "content_block_start" &&
                    data.content_block?.type === "thinking"
                  ) {
                    insideThinkingBlock = true;
                    thinkingBlocksSuppressed++;
                    log(`[AnthropicSSE] Filtering thinking block at index ${data.index}`);
                    continue; // suppress this line
                  }

                  // Track: exiting a thinking block
                  if (insideThinkingBlock && data.type === "content_block_stop") {
                    insideThinkingBlock = false;
                    continue; // suppress this line
                  }

                  // Suppress all deltas while inside a thinking block
                  // (thinking_delta, signature_delta)
                  if (insideThinkingBlock) {
                    continue;
                  }

                  // Re-index non-thinking content blocks
                  // After suppressing N thinking blocks, subtract N from the index
                  if (typeof data.index === "number" && thinkingBlocksSuppressed > 0) {
                    const reindexed = data.index - thinkingBlocksSuppressed;
                    const clamped = clampIndex(reindexed, `${data.type} (filtered, orig=${data.index})`);
                    trackIndex(clamped);
                    const modifiedLine =
                      "data: " + JSON.stringify({ ...data, index: clamped });

                    if (!isClosed) {
                      controller.enqueue(encoder.encode(modifiedLine + "\n"));
                    }

                    // Still do usage tracking below with the ORIGINAL data
                  } else {
                    // No filtering needed — track and pass through
                    if (typeof data.index === "number") {
                      if (data.type === "content_block_start") {
                        trackIndex(data.index);
                      } else {
                        const clamped = clampIndex(data.index, `${data.type} (unfiltered)`);
                        if (clamped !== data.index) {
                          const modifiedLine =
                            "data: " + JSON.stringify({ ...data, index: clamped });
                          if (!isClosed) {
                            controller.enqueue(encoder.encode(modifiedLine + "\n"));
                          }
                          // Skip original enqueue below
                          continue;
                        }
                      }
                    }
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(line + "\n"));
                    }
                  }
                } catch {
                  // Unparseable — pass through
                  if (!isClosed) {
                    controller.enqueue(encoder.encode(line + "\n"));
                  }
                }
              } else {
                // Non-data lines (event: lines, blank lines) or no filtering
                if (!filterThinking && line.startsWith("data: ")) {
                  // Parse data lines BEFORE enqueuing to detect in-stream errors
                  try {
                    const data = JSON.parse(line.slice(6));

                    // ── In-stream error detection (GitHub #106) ──
                    if (data.error) {
                      const errMsg = data.error.message || JSON.stringify(data.error);
                      log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
                      if (!isClosed) {
                        controller.enqueue(encoder.encode(
                          `event: error\ndata: ${JSON.stringify({
                            type: "error",
                            error: { type: "api_error", message: errMsg },
                          })}\n\n`
                        ));
                        isClosed = true;
                        if (pingInterval) {
                          clearInterval(pingInterval);
                          pingInterval = null;
                        }
                        controller.close();
                      }
                      return; // stop processing further lines
                    }

                    // No error — check index bounds before passing through
                    if (typeof data.index === "number") {
                      if (data.type === "content_block_start") {
                        // z.ai sometimes sends content_block_start with an index
                        // that jumps (e.g., 0 → 2, skipping 1). This causes
                        // "Content block not found" on the client. Remap to
                        // sequential indices to keep the client happy.
                        const expected = highestSeenIndex + 1;
                        if (data.index !== expected) {
                          log(
                            `[AnthropicSSE] content_block_start index ${data.index} remapped to ${expected} (model=${opts.modelName})`
                          );
                          const remapped = { ...data, index: expected };
                          if (!isClosed) {
                            controller.enqueue(encoder.encode("data: " + JSON.stringify(remapped) + "\n"));
                          }
                        } else {
                          if (!isClosed) {
                            controller.enqueue(encoder.encode(line + "\n"));
                          }
                        }
                        trackIndex(expected);
                      } else {
                        // delta / stop — clamp to highestSeenIndex
                        const clamped = clampIndex(data.index, `${data.type} (passthrough)`);
                        if (clamped !== data.index) {
                          const modified = { ...data, index: clamped };
                          if (!isClosed) {
                            controller.enqueue(encoder.encode("data: " + JSON.stringify(modified) + "\n"));
                          }
                        } else {
                          if (!isClosed) {
                            controller.enqueue(encoder.encode(line + "\n"));
                          }
                        }
                      }
                    } else {
                      // No index field — pass through as-is
                      if (!isClosed) {
                        controller.enqueue(encoder.encode(line + "\n"));
                      }
                    }

                    // Usage/debug tracking
                    if (data.message?.usage) {
                      inputTokens = data.message.usage.input_tokens || inputTokens;
                      outputTokens = data.message.usage.output_tokens || outputTokens;
                    }
                    if (data.usage) {
                      inputTokens = data.usage.input_tokens || inputTokens;
                      outputTokens = data.usage.output_tokens || outputTokens;
                    }
                    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                      const txt = data.delta.text || "";
                      textChunks++;
                      log(
                        `[AnthropicSSE] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                      );
                    }
                    if (
                      data.type === "content_block_start" &&
                      data.content_block?.type === "tool_use"
                    ) {
                      toolUseBlocks++;
                      log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                    }
                    if (data.type === "message_delta" && data.delta?.stop_reason) {
                      stopReason = data.delta.stop_reason;
                    }
                    if (data.type === "message_stop") {
                      sawMessageStop = true;
                    }
                  } catch {
                    // Unparseable data line — pass through
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(line + "\n"));
                    }
                  }
                } else {
                  // Non-data lines (event: lines, blank lines) — pass through
                  if (!isClosed) {
                    controller.enqueue(encoder.encode(line + "\n"));
                  }
                }
              }

              // ── Usage/debug tracking for filtered path ────────────────
              // We need this even when filtering, but the data was already parsed
              // above in the filterThinking branch. Re-parse for tracking only.
              if (filterThinking && line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.message?.usage) {
                    inputTokens = data.message.usage.input_tokens || inputTokens;
                    outputTokens = data.message.usage.output_tokens || outputTokens;
                  }
                  if (data.usage) {
                    inputTokens = data.usage.input_tokens || inputTokens;
                    outputTokens = data.usage.output_tokens || outputTokens;
                  }
                  if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                    textChunks++;
                  }
                  if (
                    data.type === "content_block_start" &&
                    data.content_block?.type === "tool_use"
                  ) {
                    toolUseBlocks++;
                    log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                  }
                  if (data.type === "message_delta" && data.delta?.stop_reason) {
                    stopReason = data.delta.stop_reason;
                  }
                  if (data.type === "message_stop") {
                    sawMessageStop = true;
                  }
                } catch {}
              }
            }
          }

          log(
            `[AnthropicSSE] Stream complete for ${opts.modelName}: ${totalLines} lines, ${textChunks} text chunks, ${toolUseBlocks} tool_use blocks, stop_reason=${stopReason}` +
              (filterThinking ? `, filtered ${thinkingBlocksSuppressed} thinking blocks` : "")
          );

          if (opts.onTokenUpdate) {
            opts.onTokenUpdate(inputTokens, outputTokens);
          }

          // Finalization: if the upstream stream ended without sending
          // message_stop, emit it ourselves. Claude Code requires
          // message_stop as the terminal event — without it, the client
          // reports "API returned an empty or malformed response (HTTP 200)".
          if (!isClosed && !sawMessageStop) {
            log(`[AnthropicSSE] Stream ended without message_stop (stopReason=${stopReason}) — emitting synthetic finalization`);
            if (!stopReason) {
              controller.enqueue(encoder.encode(
                "event: message_delta\n" +
                `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${outputTokens}}}\n\n`
              ));
            }
            controller.enqueue(encoder.encode(
              "event: message_stop\n" +
              `data: {"type":"message_stop"}\n\n`
            ));
          }

          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            controller.close();
          }
        } catch (e) {
          log(`[AnthropicSSE] Stream error: ${e}`);
          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            controller.close();
          }
        }
      },
      cancel() {
        isClosed = true;
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}
