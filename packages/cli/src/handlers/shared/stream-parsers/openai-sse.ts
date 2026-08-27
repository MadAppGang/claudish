/**
 * OpenAI SSE → Claude SSE stream parser.
 *
 * Converts OpenAI-compatible Server-Sent Events to Claude SSE format.
 * Used by ComposedHandler to translate streaming responses from
 * OpenAI-compatible providers (OpenRouter, LiteLLM, local models, etc.)
 * into the format Claude Code expects.
 */

import type { Context } from "hono";
import { log } from "../../../logger.js";
import {
  type ToolSchema,
  extractToolCallsFromText,
  hasExtractableFunctionTag,
  validateAndRepairToolCall,
} from "../tool-call-recovery.js";
import { isWebSearchToolCall, warnWebSearchUnsupported } from "../web-search-detector.js";
import { messageStartUsage } from "./message-start-usage.js";

export interface StreamingState {
  usage: any;
  finalized: boolean;
  textStarted: boolean;
  textIdx: number;
  reasoningStarted: boolean;
  reasoningIdx: number;
  curIdx: number;
  tools: Map<number, ToolState>;
  toolIds: Set<string>;
  lastActivity: number;
  accumulatedText: string; // Accumulated text for potential tool call extraction
  /**
   * Upstream `finish_reason` from the last chunk that carried one. Needed at
   * finalize() so a turn the provider CUT OFF is not reported as a turn the
   * model chose to end — see the stop_reason mapping in finalize().
   */
  finishReason: string | null;
}

export interface ToolState {
  id: string;
  name: string;
  blockIndex: number;
  started: boolean; // Whether content_block_start has been sent
  closed: boolean;
  arguments: string; // Accumulated JSON arguments string
  buffered: boolean; // Whether we're buffering args until tool call completes
}

/**
 * Validate tool call arguments against the tool schema
 * Now includes automatic repair of missing parameters
 */
export function validateToolArguments(
  toolName: string,
  argsStr: string,
  toolSchemas: any[],
  textContent?: string
): {
  valid: boolean;
  missingParams: string[];
  parsedArgs: any;
  repaired: boolean;
  repairedArgs?: any;
} {
  const result = validateAndRepairToolCall(
    toolName,
    argsStr,
    toolSchemas as ToolSchema[],
    textContent
  );

  if (result.repaired) {
    log(`[ToolValidation] Repaired tool call ${toolName} - inferred missing parameters`);
  }

  return {
    valid: result.valid,
    missingParams: result.missingParams,
    parsedArgs: result.args,
    repaired: result.repaired,
    repairedArgs: result.repaired ? result.args : undefined,
  };
}

/**
 * Create initial streaming state
 */
export function createStreamingState(): StreamingState {
  return {
    usage: null,
    finalized: false,
    textStarted: false,
    textIdx: -1,
    reasoningStarted: false,
    reasoningIdx: -1,
    curIdx: 0,
    tools: new Map(),
    toolIds: new Set(),
    lastActivity: Date.now(),
    accumulatedText: "",
    finishReason: null,
  };
}

/**
 * Handle streaming response conversion from OpenAI SSE to Claude SSE format
 */
export function createStreamingResponseHandler(
  c: Context,
  response: Response,
  adapter: any,
  target: string,
  middlewareManager: any,
  onTokenUpdate?: (input: number, output: number) => void,
  toolSchemas?: any[], // Tool schemas for validation
  toolNameMap?: Map<string, string>, // Truncated → original tool name mapping
  priorInputTokens?: number, // Last request's context size — seeds message_start.usage
  /**
   * Behavior layer (Layer 4) tool-call interception. Grouped into one object
   * rather than two more positional parameters — this signature already carries
   * nine.
   *
   * Unlike the Responses parser, this path already buffers tool arguments
   * whenever the request carries tools (see `buffered` below), so hooking repair
   * in costs nothing extra: the complete argument object is assembled here
   * regardless. `shouldBufferTool` only matters for the rare case of a rule
   * wanting a tool the schema-validation path would not have buffered.
   */
  behavior?: {
    shouldBufferTool?: (name: string) => boolean;
    onToolCall?: (name: string, argsJson: string) => string | null | undefined;
    /**
     * Layer 4 observation. Normalized text, so rules never parse this parser's
     * event shape.
     */
    onAssistantText?: (text: string, kind?: "text" | "reasoning") => void;
    onToolCallObserved?: (name: string) => void;
    onTurnEnd?: () => void;
  }
): Response {
  /**
   * Offer a COMPLETE argument object to the behavior layer.
   *
   * Only ever called where the full object is in hand. The incremental
   * `partial_json` fragment path must never route through here — repairing a
   * fragment would emit malformed JSON.
   */
  const repairArgs = (toolName: string, argsJson: string): string => {
    if (!behavior?.onToolCall) return argsJson;
    try {
      const repaired = behavior.onToolCall(toolName, argsJson);
      if (typeof repaired === "string" && repaired !== argsJson) {
        log(`[Streaming] tool call repaired by behavior layer: ${toolName}`);
        return repaired;
      }
    } catch (err) {
      // A failing rule must never corrupt the stream.
      log(`[Streaming] behavior onToolCall threw for ${toolName}: ${err}`);
    }
    return argsJson;
  };
  log(`[Streaming] ===== HANDLER STARTED for ${target} =====`);
  let isClosed = false;
  let ping: NodeJS.Timeout | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const streamMetadata = new Map<string, any>();

  return c.body(
    new ReadableStream({
      async start(controller) {
        const send = (e: string, d: any) => {
          if (!isClosed) {
            // Observe every tool call HERE, at the single frame writer, rather than at
            // each of the seven `content_block_start` sites below.
            //
            // This parser declared `onToolCallObserved` and never called it — so on the
            // busiest wire in claudish (GLM, Kimi, Grok, DeepSeek, Qwen, OpenRouter,
            // LiteLLM) the behaviour layer's tool-name list was always empty and the
            // session summary would have reported zero tools. Hooking the writer instead
            // of the emission sites makes that class of omission impossible: a new
            // tool_use path cannot forget to opt in, and because exactly one
            // `content_block_start` is emitted per tool call, it cannot double count
            // either. The `input_json_delta` frames deliberately do not match.
            if (e === "content_block_start" && d?.content_block?.type === "tool_use") {
              try {
                behavior?.onToolCallObserved?.(String(d.content_block.name ?? ""));
              } catch (err) {
                log(`[Streaming] onToolCallObserved threw: ${err}`);
              }
            }
            controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
          }
        };

        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const state = createStreamingState();

        send("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: target,
            stop_reason: null,
            stop_sequence: null,
            usage: messageStartUsage(priorInputTokens),
          },
        });
        send("ping", { type: "ping" });

        ping = setInterval(() => {
          if (!isClosed && Date.now() - state.lastActivity > 1000) {
            send("ping", { type: "ping" });
          }
        }, 1000);

        // Teardown is separated from finalize() on purpose. finalize() guards
        // re-entry on state.finalized, so once it has started, a throw part-way
        // through used to mean the stream was never closed and the ping interval
        // was never cleared: the outer catch re-called finalize(), which returned
        // immediately at the guard. The client then sat on an open HTTP 200
        // forever. Teardown therefore runs from a `finally`, and stays safe to
        // call twice.
        const teardown = () => {
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n\n"));
            } catch {}
            try {
              controller.close();
            } catch {}
            isClosed = true;
          }
          if (ping) {
            clearInterval(ping);
            ping = null;
          }
        };

        const finalize = async (reason: string, err?: string) => {
          // A second call still has to tear down: the first may have thrown
          // before reaching its own `finally`.
          if (state.finalized) {
            teardown();
            return;
          }
          state.finalized = true;

          try {
            // Debug: Log accumulated text for analysis
            if (state.accumulatedText.length > 0) {
              const preview = state.accumulatedText.slice(0, 500).replace(/\n/g, "\\n");
              log(
                `[Streaming] Accumulated text (${state.accumulatedText.length} chars): ${preview}...`
              );
            }

            // Check for text-based tool calls before finalizing
            // Some models (like Qwen) output tool calls as text instead of structured tool_calls
            //
            // Only when the model produced NO structured call. Recovery exists for
            // models that cannot emit `tool_calls` at all; against a model that
            // just did, it can only ADD calls, never repair one. Ungated, a turn
            // holding one real call plus prose mentioning a function tag dispatched
            // two tool_use blocks, and both were recorded.
            const textToolCalls =
              state.tools.size > 0
                ? []
                : extractToolCallsFromText(
                    state.accumulatedText,
                    toolSchemas?.map((t: any) => t?.name).filter((n: any): n is string => !!n)
                  );
            if (state.tools.size > 0 && state.accumulatedText.length > 0) {
              log(
                `[Streaming] Skipping text-based tool extraction: ${state.tools.size} structured tool call(s) already present`
              );
            }
            log(`[Streaming] Text-based tool calls found: ${textToolCalls.length}`);
            if (textToolCalls.length > 0) {
              log(
                `[Streaming] Found ${textToolCalls.length} text-based tool call(s), converting to structured format`
              );

              // Close any open text block first
              if (state.textStarted) {
                send("content_block_stop", { type: "content_block_stop", index: state.textIdx });
                state.textStarted = false;
              }

              // Send each extracted tool call as a proper tool_use block
              for (const tc of textToolCalls) {
                const toolIdx = state.curIdx++;
                const toolId = `tool_${Date.now()}_${toolIdx}`;

                send("content_block_start", {
                  type: "content_block_start",
                  index: toolIdx,
                  content_block: { type: "tool_use", id: toolId, name: tc.name },
                });
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: toolIdx,
                  delta: {
                    type: "input_json_delta",
                    partial_json: repairArgs(tc.name, JSON.stringify(tc.arguments)),
                  },
                });
                send("content_block_stop", { type: "content_block_stop", index: toolIdx });
              }
            }

            if (state.reasoningStarted) {
              send("content_block_stop", { type: "content_block_stop", index: state.reasoningIdx });
            }
            if (state.textStarted) {
              send("content_block_stop", { type: "content_block_stop", index: state.textIdx });
            }

            // Handle buffered-but-unsent structured tool calls.
            // Some models (e.g., Gemini via LiteLLM) send tool calls with finish_reason="stop"
            // instead of "tool_calls", so the normal validation path (line ~695) is never reached.
            // We must send these buffered tools here so Claude Code can execute them.
            for (const t of Array.from(state.tools.values())) {
              if (!t.closed && t.buffered && !t.started) {
                if (toolSchemas && toolSchemas.length > 0) {
                  const validation = validateToolArguments(
                    t.name,
                    t.arguments,
                    toolSchemas,
                    state.accumulatedText
                  );

                  if (validation.valid || (validation.repaired && validation.repairedArgs)) {
                    const argsJson = repairArgs(
                      t.name,
                      JSON.stringify(
                        validation.repaired ? validation.repairedArgs : validation.parsedArgs
                      )
                    );
                    log(
                      `[Streaming] Sending buffered tool call (finish_reason!=tool_calls): ${t.name} with args: ${argsJson}`
                    );
                    send("content_block_start", {
                      type: "content_block_start",
                      index: t.blockIndex,
                      content_block: { type: "tool_use", id: t.id, name: t.name },
                    });
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: t.blockIndex,
                      delta: { type: "input_json_delta", partial_json: argsJson },
                    });
                    send("content_block_stop", {
                      type: "content_block_stop",
                      index: t.blockIndex,
                    });
                    t.started = true;
                    t.closed = true;
                  } else {
                    log(
                      `[Streaming] Buffered tool call ${t.name} failed validation, skipping: ${validation.missingParams.join(", ")}`
                    );
                    t.closed = true;
                  }
                } else {
                  // No schemas to validate against — send as-is
                  const argsJson = repairArgs(t.name, t.arguments || "{}");
                  log(
                    `[Streaming] Sending buffered tool call (no validation): ${t.name} with args: ${argsJson}`
                  );
                  send("content_block_start", {
                    type: "content_block_start",
                    index: t.blockIndex,
                    content_block: { type: "tool_use", id: t.id, name: t.name },
                  });
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: t.blockIndex,
                    delta: { type: "input_json_delta", partial_json: argsJson },
                  });
                  send("content_block_stop", {
                    type: "content_block_stop",
                    index: t.blockIndex,
                  });
                  t.started = true;
                  t.closed = true;
                }
              }
            }

            // Close any remaining started-but-unclosed tool calls
            for (const t of Array.from(state.tools.values())) {
              if (t.started && !t.closed) {
                send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
                t.closed = true;
              }
            }

            if (middlewareManager) {
              await middlewareManager.afterStreamComplete(target, streamMetadata);
            }

            if (reason === "error") {
              send("error", { type: "error", error: { type: "api_error", message: err } });
            } else {
              // Set stop_reason based on whether we sent ANY tool calls (text-based or structured)
              const hasStructuredTools = Array.from(state.tools.values()).some((t) => t.started);
              // A turn the PROVIDER cut off must not be reported as a turn the model
              // chose to end. Anthropic's contract for a cut-off turn is "max_tokens";
              // reporting "end_turn" presents a truncated (or, when reasoning consumed
              // the whole budget, an EMPTY) answer as the model's complete final word.
              // Mirrors openai-responses-sse.ts, which already does this.
              // `content_filter` is the same class: the provider refused, which is
              // Anthropic's "refusal", not a turn the model chose to end.
              // openai-responses-sse.ts already maps both this way.
              const truncated = state.finishReason === "length";
              const refused = state.finishReason === "content_filter";
              const stopReason = refused
                ? "refusal"
                : truncated
                  ? "max_tokens"
                  : textToolCalls.length > 0 || hasStructuredTools
                    ? "tool_use"
                    : "end_turn";
              if (truncated || refused) {
                log(
                  `[Streaming] Upstream finish_reason=${state.finishReason} → stop_reason=${stopReason} (${state.accumulatedText.length} chars produced)`
                );
              }
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                // input_tokens must ride the delta too: Claude Code takes the
                // context size from the last assistant message, and message_start
                // could only carry an estimate. Omitting it left the client
                // believing every conversation was 100 tokens, which silently
                // disabled auto-compaction on every openai-sse provider.
                usage: {
                  ...(state.usage?.prompt_tokens
                    ? { input_tokens: state.usage.prompt_tokens }
                    : {}),
                  output_tokens: state.usage?.completion_tokens || 0,
                },
              });
              behavior?.onTurnEnd?.();
              send("message_stop", { type: "message_stop" });
            }

            // Update token counts - use actual usage if available, otherwise estimate
            if (onTokenUpdate) {
              if (state.usage) {
                log(
                  `[Streaming] Final usage: prompt=${state.usage.prompt_tokens || 0}, completion=${state.usage.completion_tokens || 0}`
                );
                onTokenUpdate(state.usage.prompt_tokens || 0, state.usage.completion_tokens || 0);
              } else {
                // Estimate tokens for local models that don't return usage data
                // Rough estimate: ~4 characters per token
                const estimatedOutputTokens = Math.ceil(state.accumulatedText.length / 4);
                log(
                  `[Streaming] No usage data from provider, estimating: ~${estimatedOutputTokens} output tokens`
                );
                // Carry the previous context size forward rather than a literal
                // 100 — the status line reads this value, and 100 would make the
                // bar collapse to "empty" on any turn the provider skips usage.
                onTokenUpdate(priorInputTokens || 100, estimatedOutputTokens);
              }
            }
          } finally {
            teardown();
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
              log(`[SSE:openai] ${dataStr.substring(0, 300)}`);
              if (dataStr === "[DONE]") {
                await finalize("done");
                return;
              }

              try {
                const chunk = JSON.parse(dataStr);
                if (chunk.usage) {
                  state.usage = chunk.usage;
                  log(
                    `[Streaming] Usage data received: prompt=${chunk.usage.prompt_tokens}, completion=${chunk.usage.completion_tokens}, total=${chunk.usage.total_tokens}`
                  );
                }

                const delta = chunk.choices?.[0]?.delta;
                const finishReason = chunk.choices?.[0]?.finish_reason;
                if (finishReason) state.finishReason = finishReason;

                // Debug: Log chunk details for troubleshooting early termination
                if (delta?.content || finishReason) {
                  log(
                    `[Streaming] Chunk: content=${delta?.content?.length || 0} chars, finish_reason=${finishReason || "null"}`
                  );
                }

                if (delta) {
                  if (middlewareManager) {
                    await middlewareManager.afterStreamChunk({
                      modelId: target,
                      chunk,
                      delta,
                      metadata: streamMetadata,
                    });
                  }

                  // Reasoning arrives under two different field names on this one
                  // wire format: `reasoning_content` (Kimi, DeepSeek via LiteLLM)
                  // and `reasoning` (OpenRouter). Reading only the former silently
                  // dropped every OpenRouter thinking model's reasoning.
                  const reasoningText = delta.reasoning_content || delta.reasoning;
                  if (reasoningText) {
                    behavior?.onAssistantText?.(reasoningText, "reasoning");
                    state.lastActivity = Date.now();
                    if (!state.reasoningStarted) {
                      state.reasoningIdx = state.curIdx++;
                      send("content_block_start", {
                        type: "content_block_start",
                        index: state.reasoningIdx,
                        content_block: { type: "thinking", thinking: "" },
                      });
                      state.reasoningStarted = true;
                    }
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: state.reasoningIdx,
                      delta: { type: "thinking_delta", thinking: reasoningText },
                    });
                  }

                  // Handle text content
                  const txt = delta.content || "";
                  if (txt) behavior?.onAssistantText?.(txt, "text");
                  log(
                    `[Streaming] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                  );
                  if (txt) {
                    state.lastActivity = Date.now();
                    // Close thinking block before starting text
                    if (state.reasoningStarted) {
                      send("content_block_stop", {
                        type: "content_block_stop",
                        index: state.reasoningIdx,
                      });
                      state.reasoningStarted = false;
                    }
                    const res = adapter.processTextContent(txt, "");
                    log(
                      `[Streaming] After adapter: "${res.cleanedText.substring(0, 30).replace(/\n/g, "\\n")}" (${res.cleanedText.length} chars, transformed=${res.wasTransformed})`
                    );

                    // An adapter emptying a chunk is LEGITIMATE on this path, so
                    // there is deliberately no "non-empty in, non-empty out" guard
                    // here — unlike gemini-sse.ts, which has one. Two adapters
                    // return "" by design:
                    //   • QwenModelDialect — the chunk was entirely chat-template
                    //     special tokens (`<|im_start|>` &c.); passing the original
                    //     through would leak them to the user.
                    //   • GrokModelDialect — it is buffering a `<xai:function_call>`
                    //     XML block split across chunks; passing the original
                    //     through would emit half a tool call as visible text.
                    // Per-chunk emptiness is therefore not evidence of loss here.
                    // What WOULD be a bug is a whole turn arriving empty; that is
                    // caught at the turn level by the probe and by stop_reason.
                    if (txt.length > 0 && res.cleanedText.length === 0) {
                      log(`[Streaming] Text filtered out by adapter: "${txt.substring(0, 50)}"`);
                    }

                    if (res.cleanedText) {
                      // Accumulate text for potential tool call extraction
                      state.accumulatedText += res.cleanedText;

                      // Check if text contains STRUCTURED tool call patterns that we should hold back
                      // Only hold back for patterns we can actually parse (XML, JSON), not natural language
                      // Natural language patterns are extracted at finalization, not held back
                      const hasStructuredToolPattern =
                        // Qwen XML-style: <function=ToolName>. Same shape the
                        // extractor accepts, so text held back here is always text
                        // the extractor can act on. A looser test here withheld
                        // text that nothing later emitted.
                        hasExtractableFunctionTag(state.accumulatedText) ||
                        // JSON tool call in text: {"name": "Task", "arguments":
                        /\{\s*"(?:name|tool)"\s*:\s*"(?:Task|Read|Write|Edit|Bash|Grep|Glob)"/i.test(
                          state.accumulatedText
                        ) ||
                        // XML tool_call tags: <tool_call>
                        /<tool_call>/.test(state.accumulatedText);

                      // Only hold back if we have a structured pattern AND haven't accumulated too much
                      // (if we've accumulated > 1000 chars without a complete pattern, release the text)
                      const shouldHoldBack =
                        hasStructuredToolPattern && state.accumulatedText.length < 1000;

                      if (shouldHoldBack) {
                        log(
                          `[Streaming] Text held back (structured tool pattern): ${state.accumulatedText.length} chars accumulated`
                        );
                      }

                      if (!shouldHoldBack) {
                        if (!state.textStarted) {
                          state.textIdx = state.curIdx++;
                          send("content_block_start", {
                            type: "content_block_start",
                            index: state.textIdx,
                            content_block: { type: "text", text: "" },
                          });
                          state.textStarted = true;
                          log(`[Streaming] Started text block at index ${state.textIdx}`);
                        }
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: state.textIdx,
                          delta: { type: "text_delta", text: res.cleanedText },
                        });
                      }
                    }
                  }

                  // Handle tool calls
                  if (delta.tool_calls) {
                    log(
                      `[Streaming] Received ${delta.tool_calls.length} structured tool call(s) from model`
                    );
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index;
                      let t = state.tools.get(idx);
                      if (tc.function?.name) {
                        if (!t) {
                          // Close thinking and text blocks before starting tool
                          if (state.reasoningStarted) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: state.reasoningIdx,
                            });
                            state.reasoningStarted = false;
                          }
                          if (state.textStarted) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: state.textIdx,
                            });
                            state.textStarted = false;
                          }
                          // Restore truncated tool name to original if mapping exists
                          const rawName = tc.function.name;
                          const restoredName = toolNameMap?.get(rawName) || rawName;
                          t = {
                            id: tc.id || `tool_${Date.now()}_${idx}`,
                            name: restoredName,
                            blockIndex: state.curIdx++,
                            started: false,
                            closed: false,
                            arguments: "", // Initialize arguments accumulator
                            // Buffer if we have schemas to validate, OR if a behavior
                            // rule wants to rewrite this call — repair is only
                            // possible while the arguments are still withheld.
                            buffered:
                              (!!toolSchemas && toolSchemas.length > 0) ||
                              behavior?.shouldBufferTool?.(restoredName) === true,
                          };
                          state.tools.set(idx, t);
                          if (isWebSearchToolCall(restoredName)) {
                            warnWebSearchUnsupported(restoredName, target);
                          }
                        }
                        // Only send content_block_start immediately if NOT buffering
                        if (!t.started && !t.buffered) {
                          send("content_block_start", {
                            type: "content_block_start",
                            index: t.blockIndex,
                            content_block: { type: "tool_use", id: t.id, name: t.name },
                          });
                          t.started = true;
                        }
                      }
                      if (tc.function?.arguments && t) {
                        // Always accumulate arguments
                        t.arguments += tc.function.arguments;
                        // Only stream immediately if NOT buffering
                        if (!t.buffered) {
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: t.blockIndex,
                            delta: {
                              type: "input_json_delta",
                              partial_json: tc.function.arguments,
                            },
                          });
                        }
                      }
                    }
                  }
                }

                if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
                  for (const t of Array.from(state.tools.values())) {
                    if (!t.closed) {
                      // Validate and potentially repair tool arguments
                      if (toolSchemas && toolSchemas.length > 0) {
                        const validation = validateToolArguments(
                          t.name,
                          t.arguments,
                          toolSchemas,
                          state.accumulatedText
                        );

                        if (validation.repaired && validation.repairedArgs) {
                          // Tool call was repaired - send the complete repaired arguments
                          log(
                            `[Streaming] Tool call ${t.name} was repaired with inferred parameters`
                          );
                          const repairedJson = repairArgs(
                            t.name,
                            JSON.stringify(validation.repairedArgs)
                          );
                          log(
                            `[Streaming] Sending repaired tool call: ${t.name} with args: ${repairedJson}`
                          );

                          // If buffered, this is the first time we're sending this tool call
                          // Send the complete repaired tool call as a single block
                          if (t.buffered && !t.started) {
                            send("content_block_start", {
                              type: "content_block_start",
                              index: t.blockIndex,
                              content_block: { type: "tool_use", id: t.id, name: t.name },
                            });
                            send("content_block_delta", {
                              type: "content_block_delta",
                              index: t.blockIndex,
                              delta: { type: "input_json_delta", partial_json: repairedJson },
                            });
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: t.blockIndex,
                            });
                            t.started = true;
                            t.closed = true;
                            continue;
                          }

                          // If already started (non-buffered), close old and send new
                          if (t.started) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: t.blockIndex,
                            });
                            const repairedIdx = state.curIdx++;
                            const repairedId = `tool_repaired_${Date.now()}_${repairedIdx}`;
                            send("content_block_start", {
                              type: "content_block_start",
                              index: repairedIdx,
                              content_block: { type: "tool_use", id: repairedId, name: t.name },
                            });
                            send("content_block_delta", {
                              type: "content_block_delta",
                              index: repairedIdx,
                              delta: { type: "input_json_delta", partial_json: repairedJson },
                            });
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: repairedIdx,
                            });
                            t.closed = true;
                            continue;
                          }
                        }

                        if (!validation.valid) {
                          // Repair failed - send error message instead of invalid tool call
                          log(
                            `[Streaming] Tool call ${t.name} validation failed: ${validation.missingParams.join(", ")}`
                          );
                          const errorIdx = t.buffered ? t.blockIndex : state.curIdx++;
                          const errorMsg = `\n\n⚠️ Tool call "${t.name}" failed: missing required parameters: ${validation.missingParams.join(", ")}. Local models sometimes generate incomplete tool calls. Please try again or use a model with better tool support.`;
                          send("content_block_start", {
                            type: "content_block_start",
                            index: errorIdx,
                            content_block: { type: "text", text: "" },
                          });
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: errorIdx,
                            delta: { type: "text_delta", text: errorMsg },
                          });
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: errorIdx,
                          });
                          // Close the invalid tool if it was already started
                          if (t.started && !t.buffered) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: t.blockIndex,
                            });
                          }
                          t.closed = true;
                          continue;
                        }

                        // Valid tool call - send if buffered, close if not
                        if (t.buffered && !t.started) {
                          const argsJson = repairArgs(
                            t.name,
                            JSON.stringify(validation.parsedArgs)
                          );
                          send("content_block_start", {
                            type: "content_block_start",
                            index: t.blockIndex,
                            content_block: { type: "tool_use", id: t.id, name: t.name },
                          });
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: t.blockIndex,
                            delta: { type: "input_json_delta", partial_json: argsJson },
                          });
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: t.blockIndex,
                          });
                          t.started = true;
                          t.closed = true;
                          continue;
                        }
                      }

                      // Non-buffered valid tool call or no validation - just close
                      if (t.started && !t.closed) {
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: t.blockIndex,
                        });
                        t.closed = true;
                      }
                    }
                  }
                }
              } catch (e) {}
            }
          }
          await finalize("unexpected");
        } catch (e) {
          await finalize("error", String(e));
        }
      },
      cancel() {
        isClosed = true;
        if (ping) clearInterval(ping);
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

/**
 * Estimate token count from text (rough approximation)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
