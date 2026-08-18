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

interface AnthropicPassthroughOpts {
  modelName: string;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Optional adapter — used to check shouldFilterThinking(). */
  adapter?: BaseAPIFormat;
  /**
   * Behavior layer (Layer 4) tool-call repair.
   *
   * This parser is a byte-level passthrough, so interception here is strictly
   * opt-in per tool: only a tool that `shouldBufferTool` names has its
   * `input_json_delta` frames withheld and rewritten. Every other block — text,
   * thinking, and any tool no rule cares about — is forwarded untouched, so the
   * passthrough contract is preserved for everything the layer is not targeting.
   */
  shouldBufferTool?: (name: string) => boolean;
  repairToolArgs?: (name: string, argsJson: string) => string | null | undefined;
  /** Layer 4 observation — normalized text, not raw frames. */
  onAssistantText?: (text: string, kind?: "text" | "reasoning") => void;
  onToolCallObserved?: (name: string) => void;
  onTurnEnd?: () => void;
}

/**
 * Payload of an SSE `data:` line, or null when the line isn't one.
 *
 * The SSE spec makes the space after the colon OPTIONAL — `data:{...}` and
 * `data: {...}` are both valid, and a conforming parser strips at most ONE
 * leading space. Every anthropic-transport provider we had fixtures for
 * (MiniMax, Z.AI) emits the spaced form, so the older
 * `startsWith("data: ")` gate silently skipped every line from Alibaba Model
 * Studio (qwen-cloud), which emits the bare form. The stream still reached
 * Claude Code verbatim, so sessions worked — but claudish's own inspection
 * (token accounting, in-stream error detection, thinking re-indexing,
 * Layer-4 repairToolArgs) never ran.
 */
function sseDataPayload(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const rest = line.slice(5);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/**
 * Build the tool-repair frame interceptor for one stream.
 *
 * Returns a function that maps a parsed frame to the exact bytes to enqueue
 * (trailing newline included, matching the passthrough's `${line}\n`
 * convention), or null to suppress the frame.
 *
 * Only three frame shapes are ever diverted, and only for tools a rule named
 * via `shouldBufferTool`. Everything else — text, thinking, and any untargeted
 * tool — round-trips byte-for-byte, which is what keeps this a passthrough.
 *
 * Module-level (not nested in the stream closure) so it is independently
 * testable and does not inflate the stream function's complexity.
 */
function createToolRepairInterceptor(
  opts: Pick<AnthropicPassthroughOpts, "shouldBufferTool" | "repairToolArgs">
): (data: any, line: string) => string | null {
  /** Withheld tool blocks, keyed by the content-block index upstream assigned. */
  const heldTools = new Map<number, { name: string; args: string }>();

  const flush = (index: number, stopFrame: string): string => {
    const held = heldTools.get(index);
    if (!held) return stopFrame;
    heldTools.delete(index);

    let finalArgs = held.args;
    try {
      const repaired = opts.repairToolArgs?.(held.name, finalArgs);
      if (typeof repaired === "string" && repaired !== finalArgs) {
        log(`[AnthropicSSE] tool call repaired: ${held.name}`);
        finalArgs = repaired;
      }
    } catch (err) {
      // A failing rule must never corrupt the stream — emit what the model sent.
      log(`[AnthropicSSE] repairToolArgs threw for ${held.name}: ${err}`);
    }

    const deltaFrame = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: finalArgs },
    })}\n\n`;
    return `${deltaFrame}${stopFrame}`;
  };

  /** Start withholding a tool block if a rule named it. */
  const noteToolStart = (data: any): void => {
    if (data.content_block?.type !== "tool_use") return;
    const name = data.content_block.name;
    if (typeof name !== "string") return;
    if (!opts.shouldBufferTool?.(name)) return;
    heldTools.set(data.index, { name, args: "" });
  };

  /** Accumulate a withheld fragment. Returns true if the frame was swallowed. */
  const absorbFragment = (data: any): boolean => {
    if (data.delta?.type !== "input_json_delta") return false;
    const held = heldTools.get(data.index);
    if (!held) return false;
    held.args += data.delta.partial_json ?? "";
    return true;
  };

  return (data: any, line: string): string | null => {
    const asIs = `${line}\n`;
    if (!opts.repairToolArgs || !opts.shouldBufferTool) return asIs;

    switch (data?.type) {
      case "content_block_start":
        noteToolStart(data);
        return asIs; // the start frame itself is always forwarded
      case "content_block_delta":
        return absorbFragment(data) ? null : asIs;
      case "content_block_stop":
        return heldTools.has(data.index) ? flush(data.index, asIs) : asIs;
      default:
        return asIs;
    }
  };
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

  const interceptToolFrame = createToolRepairInterceptor(opts);

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
   * Only ever set on the thinking-filter path, so streams that filter nothing
   * keep byte-identical output.
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

  /** Enqueue a parsed data line through the tool interceptor. */
  const enqueueData = (controller: any, data: any, line: string): void => {
    if (isClosed) return;
    const out = interceptToolFrame(data, line);
    if (out === null) {
      // Frame withheld by the tool interceptor — discard its event line too,
      // for the same reason the thinking filter must.
      pendingEventLine = null;
      return;
    }
    flushPendingEvent(controller);
    controller.enqueue(encoder.encode(out));
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

  return c.body(
    new ReadableStream({
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
                            error: { type: "api_error", message: errMsg },
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
                              error: { type: "api_error", message: errMsg },
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

                    // No error — check index bounds before passing through
                    // (still via the tool interceptor, which is a no-op unless
                    // a rule asked for this tool).
                    emitIndexed(controller, data, line);

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
                      opts.onAssistantText?.(txt, "text");
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
                    // Unparseable data line — pass through
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(`${line}\n`));
                    }
                  }
                } else if (filterThinking) {
                  // Non-data line on the FILTERING path. An `event:` line cannot
                  // be shipped before its `data:` line is adjudicated, and the
                  // blank separator of a dropped frame must go with it —
                  // otherwise the client sees a header with no body.
                  if (line.startsWith("event:")) {
                    pendingEventLine = line;
                  } else if (line.trim() === "" && suppressedFrame) {
                    suppressedFrame = false;
                  } else if (!isClosed) {
                    controller.enqueue(encoder.encode(`${line}\n`));
                  }
                } else {
                  // Non-data lines (event: lines, blank lines) — pass through
                  if (!isClosed) {
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
                    opts.onAssistantText?.(data.delta.text || "", "text");
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

          log(
            `[AnthropicSSE] Stream complete for ${opts.modelName}: ${totalLines} lines, ${textChunks} text chunks, ${toolUseBlocks} tool_use blocks, stop_reason=${stopReason}${filterThinking ? `, filtered ${thinkingBlocksSuppressed} thinking blocks` : ""}`
          );

          opts.onTurnEnd?.();

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
          log(`[AnthropicSSE] Stream error: ${e}`);
          // The upstream socket dropped mid-answer (Z.AI, MiniMax and Kimi all do
          // this under load). Closing the controller here without a terminal event
          // handed Claude Code a stream that stopped but never ended, and the turn
          // hung. Emit the tail first, then close, and still run the turn-end hooks
          // so Layer 4 and the token file see a completed turn rather than nothing.
          finalizeAbandonedStream(controller);
          try {
            opts.onTurnEnd?.();
          } catch {}
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
