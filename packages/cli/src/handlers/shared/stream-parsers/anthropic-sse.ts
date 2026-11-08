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
import type { BaseAPIFormat } from "../../../adapters/base-api-format.js";
import { log } from "../../../logger.js";
import { redactForClient } from "../../../redact.js";
import { sseDataPayload } from "./sse-line.js";
import { type UpstreamReaderSlot, cancelEndsUpstreamWork } from "./upstream-cancel.js";

interface AnthropicPassthroughOpts {
  modelName: string;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Optional adapter — used to check shouldFilterThinking(). */
  adapter?: BaseAPIFormat;
  /**
   * Called once per `tool_use` block start, for the token tracker's tool count.
   * Tool-argument interception is not this parser's job: it happens at the hook
   * response seam, above every parser.
   */
  onToolCallObserved?: (name: string) => void;
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
  // Set by `cancel()` only: the client went away (see `endCancelled`).
  let cancelled = false;
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const filterThinking = opts.adapter?.shouldFilterThinking() ?? false;

  /**
   * An `event:` line held back until we know whether its `data:` line survives.
   *
   * An SSE frame is `event: X\ndata: {...}\n\n`, and the event line arrives
   * FIRST. Any filter that drops a data line must therefore drop the event line
   * that introduced it, or the client receives an event with no data. Claude
   * Code rejects that outright — the whole turn dies with
   * `Could not parse message into JSON: From chunk: [ "event:content_block_start" ]`.
   * Since the verdict isn't known until the data line is read, the event line is
   * buffered for exactly one line rather than emitted eagerly.
   *
   * Set on BOTH paths. It used to be filter-only, on the reasoning that only
   * the thinking filter ever dropped a frame — which stopped being true once
   * the index layer began dropping orphans, something it does on the unfiltered
   * path as well. Surviving frames are unaffected: `flushPendingEvent` runs
   * immediately before every enqueue, so the bytes leave in the same order they
   * always did. Verified by diffing the whole wire for both production fixtures
   * across both paths: the only difference is the removal of headerless
   * `event:` lines and the stray blank separators of dropped frames.
   */
  let pendingEventLine: string | null = null;

  // ── terminal-event bookkeeping ────────────────────────────────────────────
  // Scoped here rather than inside start()'s try block, because the catch has to
  // be able to FINISH a turn the upstream abandoned, and everything it needs to
  // do that used to live where it could not reach it. One instance per request:
  // createAnthropicPassthroughStream is called per request.
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;
  /** Upstream opened the message. If not, a synthetic close needs its own message_start. */
  let sawMessageStart = false;
  /** Upstream already closed the message — never emit a second terminal pair. */
  let sawMessageStop = false;
  /** EMITTED index (post thinking-block renumbering) of an open content block, else null. */
  let openBlockIndex: number | null = null;

  /**
   * Record just enough of the message lifecycle to close the turn honestly.
   *
   * Called from every site that emits a data frame — there are three, because the
   * thinking filter's renumbering path enqueues directly rather than through
   * `enqueueData`. `emittedIndex` is the index as the CLIENT sees it, which is why
   * it is passed in rather than read off `data`.
   */
  const noteLifecycle = (data: any, emittedIndex: number | null): void => {
    switch (data?.type) {
      case "message_start":
        sawMessageStart = true;
        break;
      case "message_stop":
        sawMessageStop = true;
        break;
      case "content_block_start":
        if (emittedIndex !== null) openBlockIndex = emittedIndex;
        break;
      case "content_block_stop":
        openBlockIndex = null;
        break;
      default:
        break;
    }
  };

  /** Emit a held `event:` line. Call immediately before emitting its data line. */
  const flushPendingEvent = (controller: any): void => {
    if (pendingEventLine !== null && !isClosed) {
      controller.enqueue(encoder.encode(`${pendingEventLine}\n`));
    }
    pendingEventLine = null;
  };

  /** Enqueue a parsed data line, preceded by its held `event:` line. */
  const enqueueData = (controller: any, data: any, line: string): void => {
    if (isClosed) return;
    flushPendingEvent(controller);
    controller.enqueue(encoder.encode(`${line}\n`));
    noteLifecycle(data, typeof data?.index === "number" ? data.index : null);
  };

  /**
   * Close a turn the upstream abandoned.
   *
   * Anthropic's contract is that a message ends with `message_delta` + `message_stop`.
   * When the socket drops mid-answer the proxy used to just close the controller, so
   * Claude Code received a stream that stopped without ever ending and sat on the turn
   * forever. This emits the missing tail.
   *
   * Everything is built with JSON.stringify rather than string interpolation: custom
   * endpoints allow arbitrary model names, and one quote or backslash in a hand-built
   * literal produces JSON the client cannot parse — which would turn a recoverable
   * truncation into a hard failure.
   *
   * `stopReason` is the value upstream actually reported, falling back to a DERIVED one
   * rather than a hardcoded "end_turn": a turn that lost only its terminal frames may
   * still have delivered a complete tool_use block, and reporting "end_turn" there makes
   * the client discard the tool call.
   */
  const finalizeAbandonedStream = (controller: any): void => {
    if (isClosed || sawMessageStop) return;
    const send = (event: string, data: unknown): void => {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };
    try {
      if (!sawMessageStart) {
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
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          },
        });
      }
      if (openBlockIndex !== null) {
        send("content_block_stop", { type: "content_block_stop", index: openBlockIndex });
        openBlockIndex = null;
      }
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
        usage: {
          ...(inputTokens > 0 ? { input_tokens: inputTokens } : {}),
          output_tokens: outputTokens,
        },
      });
      send("message_stop", { type: "message_stop" });
      sawMessageStop = true;
    } catch {
      // The controller may already be errored by whatever aborted the stream.
      // Failing to emit the tail must not mask the original error.
    }
  };

  /**
   * The end of a stream the CLIENT cancelled: the upstream reader was cancelled
   * under the loop, so its read ended (or threw) without upstream ending the
   * turn. No turn-end hook, no stream-error log; usage only when upstream sent
   * some (message_start carries input_tokens, so a started turn usually has it).
   */
  const endCancelled = (): void => {
    const sawUsage = inputTokens > 0 || outputTokens > 0;
    log(
      `[AnthropicSSE] Client cancelled the stream for ${opts.modelName}; usage ${sawUsage ? "reported" : "not received, not recorded"}`
    );
    if (sawUsage) opts.onTokenUpdate?.(inputTokens, outputTokens);
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  };

  const upstream: UpstreamReaderSlot = {};
  return c.body(
    new ReadableStream(
      cancelEndsUpstreamWork<Uint8Array>(upstream, {
        async start(controller) {
          const sendPing = () => {
            if (!isClosed) {
              controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
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
            upstream.reader = reader;
            let buffer = "";

            let totalLines = 0;
            let textChunks = 0;
            let toolUseBlocks = 0;

            // Thinking-block filtering state
            let insideThinkingBlock = false;
            /** How many thinking blocks have been suppressed so far. */
            let thinkingBlocksSuppressed = 0;
            /** A frame was just dropped — swallow its trailing blank separator too. */
            let suppressedFrame = false;

            // Content block index tracking — detect out-of-range indices
            // that would cause "Content block not found" on the client side.
            let highestSeenIndex = -1;
            /**
             * Original → remapped index for blocks whose content_block_start
             * index jumped (e.g. z.ai 0 → 2). Every later frame of that block
             * (deltas, stop) still carries the original index, so the remap
             * must follow the block until it closes.
             */
            const remappedBlocks = new Map<number, number>();
            const trackIndex = (idx: number) => {
              if (idx > highestSeenIndex) highestSeenIndex = idx;
            };

            /**
             * THE single index-mapping layer. Every indexed content_block frame
             * goes through here, on both the thinking-filtered and unfiltered
             * paths, because Claude Code's rule is the same either way: a delta
             * or stop may only name an index some `content_block_start` already
             * opened, and the opened indices must run 0,1,2,… with no gaps.
             *
             * Three upstream shapes it repairs:
             *   - a start whose index jumps (z.ai sends 0 then 2) is remapped to
             *     the next sequential slot, and the mapping is remembered so the
             *     block's own deltas and stop follow it;
             *   - a delta or stop naming a block that was never opened (MiniMax
             *     emits an implicit signature block with no start) is DROPPED
             *     whole rather than clamped, since re-attaching it to another
             *     block would corrupt that block's content;
             *   - a suppressed thinking block simply never calls `trackIndex`,
             *     so the next real block lands on the slot the suppressed one
             *     would have taken. That is why no "subtract the suppressed
             *     count" arithmetic is needed: the renumbering falls out of
             *     `highestSeenIndex` instead of being counted separately.
             *
             * Emitting through `enqueueData` with the REWRITTEN object matters:
             * it records lifecycle against the index the client actually saw,
             * which is what `finalizeAbandonedStream` later closes.
             */
            const emitIndexed = (controller: any, data: any, line: string): void => {
              if (typeof data.index !== "number") {
                enqueueData(controller, data, line);
                return;
              }

              if (data.type === "content_block_start") {
                const expected = highestSeenIndex + 1;
                if (data.index !== expected) {
                  log(
                    `[AnthropicSSE] content_block_start index ${data.index} remapped to ${expected} (model=${opts.modelName})`
                  );
                  remappedBlocks.set(data.index, expected);
                  const remapped = { ...data, index: expected };
                  enqueueData(controller, remapped, `data: ${JSON.stringify(remapped)}`);
                } else {
                  enqueueData(controller, data, line);
                }
                trackIndex(expected);
                return;
              }

              const remapped = remappedBlocks.get(data.index);
              if (data.type === "content_block_stop") remappedBlocks.delete(data.index);
              if (remapped !== undefined) {
                const modified = { ...data, index: remapped };
                enqueueData(controller, modified, `data: ${JSON.stringify(modified)}`);
              } else if (data.index > highestSeenIndex) {
                log(
                  `[AnthropicSSE] Dropping orphan ${data.type} at index ${data.index} (no open block — model=${opts.modelName})`
                );
                pendingEventLine = null; // swallow the event: line too
                suppressedFrame = true; // ...and the blank separator that follows it
              } else {
                enqueueData(controller, data, line);
              }
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

                // Tolerates both `data: {...}` and the bare `data:{...}` form.
                const payload = sseDataPayload(line);

                // ── Thinking-block filtering ──────────────────────────────
                if (filterThinking && payload !== null) {
                  try {
                    const data = JSON.parse(payload);

                    // ── In-stream error detection (GitHub #106) ──
                    // Some anthropic-compat providers (Z.AI, MiniMax, Kimi) return
                    // HTTP 200 with {"error":{...}} embedded in the SSE payload.
                    // Detect and surface as a proper error event.
                    if (data.error) {
                      const errMsg = data.error.message || JSON.stringify(data.error);
                      log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
                      if (!isClosed) {
                        controller.enqueue(
                          encoder.encode(
                            `event: error\ndata: ${JSON.stringify({
                              type: "error",
                              error: { type: "api_error", message: redactForClient(errMsg) },
                            })}\n\n`
                          )
                        );
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
                      pendingEventLine = null;
                      suppressedFrame = true;
                      continue; // suppress this line
                    }

                    // Track: exiting a thinking block
                    if (insideThinkingBlock && data.type === "content_block_stop") {
                      insideThinkingBlock = false;
                      pendingEventLine = null;
                      suppressedFrame = true;
                      continue; // suppress this line
                    }

                    // Suppress all deltas while inside a thinking block
                    // (thinking_delta, signature_delta)
                    if (insideThinkingBlock) {
                      pendingEventLine = null;
                      suppressedFrame = true;
                      continue;
                    }

                    // Renumber whatever survived the thinking filter through the
                    // SAME index-mapping layer the unfiltered path uses. No
                    // `continue` here: frames must fall through to the
                    // usage/text tracking below, which still reads the ORIGINAL
                    // data rather than the rewritten frame.
                    emitIndexed(controller, data, line);
                  } catch {
                    // Unparseable — pass through
                    if (!isClosed) {
                      flushPendingEvent(controller);
                      controller.enqueue(encoder.encode(`${line}\n`));
                    }
                  }
                } else {
                  // Non-data lines (event: lines, blank lines) or no filtering
                  if (!filterThinking && payload !== null) {
                    // Parse data lines BEFORE enqueuing to detect in-stream errors
                    try {
                      const data = JSON.parse(payload);

                      // ── In-stream error detection (GitHub #106) ──
                      if (data.error) {
                        const errMsg = data.error.message || JSON.stringify(data.error);
                        log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
                        if (!isClosed) {
                          controller.enqueue(
                            encoder.encode(
                              `event: error\ndata: ${JSON.stringify({
                                type: "error",
                                error: { type: "api_error", message: redactForClient(errMsg) },
                              })}\n\n`
                            )
                          );
                          isClosed = true;
                          if (pingInterval) {
                            clearInterval(pingInterval);
                            pingInterval = null;
                          }
                          controller.close();
                        }
                        return; // stop processing further lines
                      }

                      // No error — check index bounds before passing through.
                      emitIndexed(controller, data, line);

                      // Usage/debug tracking, in its OWN try. The outer catch
                      // re-enqueues the raw line, which is right for a data line
                      // that would not parse — but by this point the frame has
                      // already been emitted, rewritten, or deliberately dropped.
                      // Letting a tracking throw reach that catch emits it a
                      // second time: a double frame, or a resurrected orphan
                      // carrying the very index the layer just removed. The
                      // filtered path already isolates its tracking this way.
                      try {
                        if (data.message?.usage) {
                          inputTokens = data.message.usage.input_tokens || inputTokens;
                          outputTokens = data.message.usage.output_tokens || outputTokens;
                        }
                        if (data.usage) {
                          inputTokens = data.usage.input_tokens || inputTokens;
                          outputTokens = data.usage.output_tokens || outputTokens;
                        }
                        if (
                          data.type === "content_block_delta" &&
                          data.delta?.type === "text_delta"
                        ) {
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
                          opts.onToolCallObserved?.(data.content_block.name);
                          log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                        }
                        if (data.type === "message_delta" && data.delta?.stop_reason) {
                          stopReason = data.delta.stop_reason;
                        }
                      } catch {
                        // Observation must never change the wire.
                      }
                    } catch {
                      // Unparseable data line — pass through
                      if (!isClosed) {
                        controller.enqueue(encoder.encode(`${line}\n`));
                      }
                    }
                  } else {
                    // Non-data line — an `event:` header or the blank separator —
                    // on EITHER path.
                    //
                    // The header is held for exactly one line because its `data:`
                    // line may still be dropped, and a header already on the wire
                    // cannot be recalled. Claude Code rejects a header with no
                    // body outright: `Could not parse message into JSON: From
                    // chunk: [ "event:content_block_start" ]` kills the whole turn.
                    //
                    // This used to be conditional on `filterThinking`, on the
                    // reasoning that only the thinking filter ever dropped a
                    // frame. That stopped being true when the index layer began
                    // dropping orphans, which it does on BOTH paths — and the
                    // unfiltered one is the common case for z.ai, Kimi and qwen,
                    // i.e. exactly the providers whose jumped indices the layer
                    // exists to repair. Measured before this change: an orphaned
                    // delta+stop pair left two bare `event:` lines on the wire.
                    if (line.startsWith("event:")) {
                      pendingEventLine = line;
                    } else if (line.trim() === "" && suppressedFrame) {
                      suppressedFrame = false; // swallow the dropped frame's separator
                    } else if (!isClosed) {
                      controller.enqueue(encoder.encode(`${line}\n`));
                    }
                  }
                }

                // ── Usage/debug tracking for filtered path ────────────────
                // We need this even when filtering, but the data was already parsed
                // above in the filterThinking branch. Re-parse for tracking only.
                if (filterThinking && payload !== null) {
                  try {
                    const data = JSON.parse(payload);
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
                      opts.onToolCallObserved?.(data.content_block.name);
                      log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                    }
                    if (data.type === "message_delta" && data.delta?.stop_reason) {
                      stopReason = data.delta.stop_reason;
                    }
                  } catch {}
                }
              }
            }

            if (cancelled) {
              endCancelled();
              return;
            }

            log(
              `[AnthropicSSE] Stream complete for ${opts.modelName}: ${totalLines} lines, ${textChunks} text chunks, ${toolUseBlocks} tool_use blocks, stop_reason=${stopReason}${filterThinking ? `, filtered ${thinkingBlocksSuppressed} thinking blocks` : ""}`
            );

            if (opts.onTokenUpdate) {
              opts.onTokenUpdate(inputTokens, outputTokens);
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
            if (cancelled) {
              endCancelled();
              return;
            }
            log(`[AnthropicSSE] Stream error: ${e}`);
            // The upstream socket dropped mid-answer (Z.AI, MiniMax and Kimi all do
            // this under load). Closing the controller here without a terminal event
            // handed Claude Code a stream that stopped but never ended, and the turn
            // hung. Emit the tail first, then close, and still report the tokens so
            // the token file sees a completed turn rather than nothing.
            finalizeAbandonedStream(controller);
            try {
              opts.onTokenUpdate?.(inputTokens, outputTokens);
            } catch {}
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
        // Downstream went away: cancelEndsUpstreamWork cancels the upstream reader
        // after this and resolves only once the read loop above has settled.
        cancel() {
          cancelled = true;
          isClosed = true;
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
        },
      })
    ),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}
