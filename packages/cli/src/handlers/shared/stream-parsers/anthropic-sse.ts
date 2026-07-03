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
import { createResponseCapture } from "../response-capture.js";
import { executeWebFetch } from "../web-search-executor.js";

interface AnthropicPassthroughOpts {
  modelName: string;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Optional adapter — used to check shouldFilterThinking(). */
  adapter?: BaseAPIFormat;
  /**
   * When false, no resp-*.sse is written (default true). Used by the relay
   * nominal forward: the hub captures centrally, so the sidecar must not
   * double-capture nor emit an orphan response file.
   */
  capture?: boolean;
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

  const cap = createResponseCapture("anthropic", opts.modelName, opts.capture !== false);

  return c.body(
    new ReadableStream({
      async start(controller) {
        // Diagnostic tap: mirror every outgoing byte into the response capture.
        const _origEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = ((chunk: any) => {
          cap.tap(chunk);
          return _origEnqueue(chunk);
        }) as typeof controller.enqueue;
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

        // ── Shared content-block index tracking state ──────────────────
        // DECLARED HERE (in start() scope, not inside the inner try block) so that
        // handleServerToolResult's closure and the read loop share the SAME binding.
        // Previously highestSeenIndex was declared inside the inner try{} block while
        // handleServerToolResult (which writes it at line ~109) lived in the outer scope —
        // two different block scopes → ReferenceError: highestSeenIndex is not defined
        // whenever a real server_tool_use block fired the handler, crashing the proxy
        // (observed live: po-2025 "Content block not found" freeze).
        let highestSeenIndex = -1;
        let lastBlockOpen = false;
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

        // Execute a suppressed server_tool_use (webReader) and inject the result
        // as a text block. Non-blocking — errors degrade to a short notice.
        const handleServerToolResult = async (
          toolName: string,
          rawInput: string,
          currentHighestIdx: number,
        ) => {
          const textIdx = currentHighestIdx + 1;
          let resultText: string;
          try {
            const input = JSON.parse(rawInput || "{}");
            const url = input.url;
            if (url && (toolName === "webReader" || toolName === "web_search_preview")) {
              log(`[AnthropicSSE] Executing suppressed server_tool_use webReader for ${url}`);
              const result = await executeWebFetch(url);
              resultText = result.ok
                ? result.text
                : `[Web fetch for ${url} failed: ${result.error}]`;
            } else {
              resultText = `[Server tool "${toolName}" was executed by the provider (result not available locally).]`;
            }
          } catch {
            resultText = `[Server tool "${toolName}" was executed by the provider (result not available locally).]`;
          }
          // Truncate very long results to avoid blowing up the context
          if (resultText.length > 8000) {
            resultText = resultText.slice(0, 8000) + "\n[...truncated]";
          }
          if (!isClosed) {
            controller.enqueue(encoder.encode(
              `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: textIdx, content_block: { type: "text", text: "" } })}\n\n`
            ));
            controller.enqueue(encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: textIdx, delta: { type: "text_delta", text: resultText } })}\n\n`
            ));
            controller.enqueue(encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: textIdx })}\n\n`
            ));
            highestSeenIndex = textIdx;
          }
        };

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
          let sawMessageStart = false;

          // Thinking-block filtering state
          let insideThinkingBlock = false;
          /** How many thinking blocks have been suppressed so far. */
          let thinkingBlocksSuppressed = 0;

          // server_tool_use suppression state.
          // Z.AI built-in tools (webReader, web_search) emit server_tool_use blocks
          // that Claude Code doesn't support — "Unsupported content type: server_tool_use"
          // followed by "Content block not found" (index desync). Suppress them and
          // execute web fetches ourselves, injecting results as text blocks.
          let insideServerToolBlock = false;
          let serverToolName = "";
          let serverToolInput = "";
          let serverToolsSuppressed = 0;

          // (highestSeenIndex / lastBlockOpen / clampIndex / trackIndex declared
          //  earlier in start() scope — shared with handleServerToolResult's closure.)

          // ── Graceful in-stream error finalization ─────────────────────
          // Some anthropic-compat providers (Z.AI, MiniMax, Kimi) return HTTP 200
          // and then inject an SSE error (e.g. Z.AI's [1302] rate limit) with NO
          // valid message envelope. Forwarding a bare `event: error` makes Claude
          // Code report "empty or malformed response (HTTP 200)" and crash the turn.
          // Instead we ALWAYS emit a valid, terminal Claude message so the client
          // ends the turn cleanly (no crash, no corruption):
          //   - before any content → synthetic message_start + short notice + stop
          //   - mid-stream         → close the open block + message_delta + stop
          // ComposedHandler's peek/retry catches most start-of-stream rate limits
          // before they reach here (it retries + falls back to a second provider);
          // this is the last-resort safety net for whatever still slips through.
          const finalizeWithError = (errMsg: string, path: string) => {
            if (!isClosed) {
              if (!sawMessageStart) {
                const isRateLimit =
                  /rate.?limit|\b1302\b|\b429\b|too many requests|overloaded/i.test(errMsg);
                const notice = isRateLimit
                  ? "[The model provider is rate limited right now. The proxy retried and exhausted fallback capacity — please try again in a moment.]"
                  : `[Upstream provider error: ${errMsg}]`;
                const synthId = `msg_${Date.now()}`;
                controller.enqueue(
                  encoder.encode(
                    "event: message_start\n" +
                      `data: {"type":"message_start","message":{"id":"${synthId}","type":"message","role":"assistant","model":"${opts.modelName}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n`
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    "event: content_block_start\n" +
                      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    "event: content_block_delta\n" +
                      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: notice } })}\n\n`
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    "event: content_block_stop\n" + `data: {"type":"content_block_stop","index":0}\n\n`
                  )
                );
              } else if (highestSeenIndex >= 0 && lastBlockOpen) {
                // Mid-stream: close whatever content block was open when the error hit,
                // otherwise the client sees an unterminated block.
                // Only emit if the block is actually still open — if the provider
                // already sent a content_block_stop, a duplicate would cause
                // "Content block not found" on the client.
                controller.enqueue(
                  encoder.encode(
                    "event: content_block_stop\n" +
                      `data: {"type":"content_block_stop","index":${highestSeenIndex}}\n\n`
                  )
                );
              }
              controller.enqueue(
                encoder.encode(
                  "event: message_delta\n" +
                    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode("event: message_stop\n" + `data: {"type":"message_stop"}\n\n`)
              );
            }
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            cap.note(`in-stream-error->graceful: ${errMsg.slice(0, 80)}`);
            cap.done({ closed: true, stop_reason: "error-graceful", path });
            // Surface to stdout (visible without --debug) so a mid-stream burst
            // that bypassed the start-of-stream peek is still observable live.
            log(
              `[RateLimit] safety-net finalized stream gracefully (${path}): ${errMsg.slice(0, 120)}`,
              true
            );
            try {
              controller.close();
            } catch {
              // already closed
            }
          };

          // Wrap the read loop so a mid-stream upstream socket close (Z.AI / GLM
          // Coding connection reset) is caught HERE — where finalizeWithError is
          // in scope — instead of escaping to the outer catch which can only do a
          // bare controller.close() with NO terminal message_stop. Without that
          // terminal event, Claude Code reports "socket connection was closed
          // unexpectedly" and freezes the turn. See never-hang-priority.
          try {
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
                    finalizeWithError(errMsg, "in-stream-error-filtered");
                    return; // stop processing further lines
                  }

                  // Track: entering a thinking block
                  if (
                    data.type === "content_block_start" &&
                    data.content_block?.type === "thinking"
                  ) {
                    insideThinkingBlock = true;
                    thinkingBlocksSuppressed++;
                    // Thinking blocks are suppressed — don't count them as open.
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
                  // After suppressing N thinking blocks + M server_tool_use blocks,
                  // subtract N+M from the index to keep it sequential.
                  const totalSuppressed = thinkingBlocksSuppressed + serverToolsSuppressed;
                  if (typeof data.index === "number" && totalSuppressed > 0) {
                    const reindexed = data.index - totalSuppressed;
                    const clamped = clampIndex(reindexed, `${data.type} (filtered, orig=${data.index})`);
                    trackIndex(clamped);
                    // Track block open/close state for finalizeWithError
                    if (data.type === "content_block_start") lastBlockOpen = true;
                    if (data.type === "content_block_stop") lastBlockOpen = false;
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
                        lastBlockOpen = true;
                      } else {
                        const clamped = clampIndex(data.index, `${data.type} (unfiltered)`);
                        if (data.type === "content_block_stop") lastBlockOpen = false;
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
                      finalizeWithError(errMsg, "in-stream-error");
                      return; // stop processing further lines
                    }

                    // ── server_tool_use suppression ──────────────────────────────
                    // MUST run BEFORE the index-remap/passthrough logic below.
                    // Z.AI built-in tools (webReader, web_search_preview) emit
                    // server_tool_use blocks that Claude Code doesn't understand:
                    //   "Unsupported content type: server_tool_use" + "Content block not found"
                    // We suppress the entire block lifecycle (start → deltas → stop),
                    // execute web fetches ourselves, and inject results as text.
                    // (Ordering matters: without this guard first, the start event
                    //  would already be enqueued by the passthrough below before the
                    //  suppression flag is set — leaking the unsupported block type.)
                    if (
                      data.type === "content_block_start" &&
                      data.content_block?.type === "server_tool_use"
                    ) {
                      insideServerToolBlock = true;
                      serverToolName = data.content_block.name || "(unnamed)";
                      serverToolInput = "";
                      serverToolsSuppressed++;
                      log(`[AnthropicSSE] Suppressing server_tool_use block at index ${data.index}: ${serverToolName}`);
                      continue; // drop this start event
                    }
                    if (insideServerToolBlock) {
                      // Accumulate input_json_delta inside the suppressed block
                      if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
                        serverToolInput += data.delta.partial_json || "";
                      }
                      // On stop: block is complete — execute and inject result
                      if (data.type === "content_block_stop") {
                        insideServerToolBlock = false;
                        log(`[AnthropicSSE] server_tool_use "${serverToolName}" complete, input=${serverToolInput.length} chars`);
                        // Fire-and-forget: execute the web fetch and inject as text
                        handleServerToolResult(serverToolName, serverToolInput, highestSeenIndex);
                        serverToolName = "";
                        serverToolInput = "";
                      }
                      continue; // drop all events inside the suppressed block
                    }

                    // No error — check index bounds before passing through
                    if (typeof data.index === "number") {
                      if (data.type === "content_block_start") {
                        lastBlockOpen = true;
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
                        if (data.type === "content_block_stop") lastBlockOpen = false;
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
                    if (data.type === "message_start") {
                      sawMessageStart = true;
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
                  // Non-data lines (event: lines, blank lines).
                  // Suppress a bare `event: error` line: the matching `data:` line
                  // that follows carries the payload and triggers finalizeWithError().
                  // Forwarding `event: error` verbatim is itself what makes Claude Code
                  // report "empty or malformed response (HTTP 200)" and crash, and it
                  // produced the double `event: error` seen in production captures.
                  if (line.trimStart().startsWith("event: error")) {
                    continue;
                  }
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
                  if (data.type === "message_start") {
                    sawMessageStart = true;
                  }
                  if (data.type === "message_stop") {
                    sawMessageStop = true;
                  }
                } catch {}
              }
            }
          }
          } catch (readErr) {
            // Upstream socket closed mid-stream (Z.AI / GLM Coding connection
            // reset). finalizeWithError() emits the terminal message_stop so the
            // client ends the turn cleanly instead of freezing. In scope here
            // because finalizeWithError is declared above in the same outer try.
            log(
              `[AnthropicSSE] Upstream read error for ${opts.modelName}: ${String(readErr).slice(0, 200)} — finalizing gracefully`,
              true
            );
            finalizeWithError(`upstream read error: ${String(readErr)}`, "reader-exception");
            return; // skip normal finalization — already terminated
          }

          log(
            `[AnthropicSSE] Stream complete for ${opts.modelName}: ${totalLines} lines, ${textChunks} text chunks, ${toolUseBlocks} tool_use blocks, stop_reason=${stopReason}` +
              (filterThinking ? `, filtered ${thinkingBlocksSuppressed} thinking blocks` : "")
          );
          cap.note(`upstream-done sawMessageStop=${sawMessageStop} stop_reason=${stopReason} toolUse=${toolUseBlocks}`);

          if (opts.onTokenUpdate) {
            opts.onTokenUpdate(inputTokens, outputTokens);
          }

          // Finalization: if the upstream stream ended without sending
          // message_stop, emit it ourselves. Claude Code requires
          // message_stop as the terminal event — without it, the client
          // reports "API returned an empty or malformed response (HTTP 200)".
          if (!isClosed && !sawMessageStop) {
            log(`[AnthropicSSE] Stream ended without message_stop (stopReason=${stopReason}) — emitting synthetic finalization`);
            if (!sawMessageStart) {
              const synthId = `msg_${Date.now()}`;
              controller.enqueue(encoder.encode(
                "event: message_start\n" +
                `data: {"type":"message_start","message":{"id":"${synthId}","type":"message","role":"assistant","model":"${opts.modelName}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}}}\n\n`
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_start\n" +
                `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_delta\n" +
                `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[Error: The model returned an empty response. This is usually transient — a momentary provider load or rate limit, NOT a context-size problem. Please retry. If it recurs repeatedly on a very large conversation, then try /compact.]"}}\n\n`
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_stop\n" +
                `data: {"type":"content_block_stop","index":0}\n\n`
              ));
            }
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
            cap.done({ closed: true, stop_reason: stopReason, sawMessageStop, path: "normal" });
            controller.close();
          } else {
            cap.done({ closed: true, stop_reason: stopReason, sawMessageStop, path: "already-closed" });
          }
        } catch (e) {
          log(`[AnthropicSSE] Stream error: ${e}`);
          cap.note(`stream-exception ${String(e)}`);
          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            cap.done({ closed: true, stop_reason: "exception", path: "catch", error: String(e) });
            controller.close();
          } else {
            cap.done({ closed: true, stop_reason: "exception", path: "catch-already-closed", error: String(e) });
          }
        }
      },
      cancel(reason?: unknown) {
        cap.note(`client-cancel ${reason !== undefined ? String(reason) : ""}`);
        cap.done({ closed: false, stop_reason: "client-cancel", path: "cancel" });
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
