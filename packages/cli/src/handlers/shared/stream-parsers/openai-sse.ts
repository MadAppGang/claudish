/**
 * OpenAI SSE → Claude SSE stream parser.
 *
 * Converts OpenAI-compatible Server-Sent Events to Claude SSE format.
 * Used by ComposedHandler to translate streaming responses from
 * OpenAI-compatible providers (OpenRouter, LiteLLM, local models, etc.)
 * into the format Claude Code expects.
 */

import type { Context } from "hono";
import { log, logStderr } from "../../../logger.js";

const SEARXNG_AVAILABLE = !!process.env.SEARXNG_URL;
import {
  validateAndRepairToolCall,
  inferMissingParameters,
  extractToolCallsFromText,
  type ToolSchema,
} from "../tool-call-recovery.js";
import { isWebSearchToolCall } from "../web-search-detector.js";
import { executeWebSearch, extractSearchQuery } from "../web-search-executor.js";

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
}

export interface ToolState {
  id: string;
  name: string;
  blockIndex: number;
  started: boolean; // Whether content_block_start has been sent
  closed: boolean;
  suppressed: boolean; // Web search tools — drop from stream, replace with text
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
  toolNameMap?: Map<string, string> // Truncated → original tool name mapping
): Response {
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
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        send("ping", { type: "ping" });

        ping = setInterval(() => {
          if (!isClosed && Date.now() - state.lastActivity > 1000) {
            send("ping", { type: "ping" });
          }
        }, 1000);

        const finalize = async (reason: string, err?: string) => {
          if (state.finalized) return;
          state.finalized = true;
          const toolCount = Array.from(state.tools.values()).filter(t => t.started && !t.suppressed).length;
          log(`[Stream] reason=${reason} model=${opts.modelName} text=${state.textStarted} tools=${toolCount} text_len=${state.accumulatedText.length} err=${err ?? "none"}`);
          logStderr(`[Stream] ${opts.modelName} ${reason} text_len=${state.accumulatedText.length} tools=${toolCount}`);

          // Debug: Log accumulated text for analysis
          if (state.accumulatedText.length > 0) {
            const preview = state.accumulatedText.slice(0, 500).replace(/\n/g, "\\n");
            log(
              `[Streaming] Accumulated text (${state.accumulatedText.length} chars): ${preview}...`
            );
          }

          // Check for text-based web search tags (GLM emits <searchWeb><query>...</query></searchWeb>)
          // These must be intercepted before text-based tool call extraction, since we want to
          // execute SearXNG and replace the search tags with results, not pass them through.
          let searchWebResults: string | null = null;
          let cleanedText = state.accumulatedText;
          const searchWebMatch = state.accumulatedText.match(/<searchWeb>\s*<query>([\s\S]*?)<\/query>\s*<\/searchWeb>/i);
          if (searchWebMatch) {
            const searchQuery = searchWebMatch[1].trim();
            log(`[Stream] GLM searchWeb detected: "${searchQuery}" — intercepting via SearXNG`);
            if (searchQuery && SEARXNG_AVAILABLE) {
              searchWebResults = await executeWebSearch(searchQuery);
            } else {
              searchWebResults = searchQuery
                ? `[Web search for "${searchQuery}" could not be executed. SearXNG is not configured.]`
                : `[Web search was requested but no query was provided.]`;
            }
            // Remove the search tags from accumulated text so they don't appear in output
            cleanedText = state.accumulatedText.replace(/<searchWeb>[\s\S]*?<\/searchWeb>/i, "").trim();
            state.accumulatedText = cleanedText;
          }

          // Check for text-based tool calls before finalizing
          // Some models (like Qwen) output tool calls as text instead of structured tool_calls
          const textToolCalls = extractToolCallsFromText(state.accumulatedText);
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
                delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.arguments) },
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

          // Inject SearXNG results if we intercepted GLM <searchWeb> tags.
          // Sent as a separate text block after the (now-cleaned) model output.
          if (searchWebResults) {
            const srchIdx = state.curIdx++;
            send("content_block_start", {
              type: "content_block_start",
              index: srchIdx,
              content_block: { type: "text", text: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: srchIdx,
              delta: { type: "text_delta", text: searchWebResults },
            });
            send("content_block_stop", { type: "content_block_stop", index: srchIdx });
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
                  const argsJson = JSON.stringify(
                    validation.repaired ? validation.repairedArgs : validation.parsedArgs
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
                const argsJson = t.arguments || "{}";
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
            // Ensure at least one content block exists — some providers (z.ai, GLM)
            // return empty responses (finish_reason without content). The Anthropic
            // SDK treats messages with content:[] as malformed.
            const hasStructuredTools = Array.from(state.tools.values()).some((t) => t.started && !t.suppressed);
            const hasContent = state.textStarted || state.reasoningStarted || hasStructuredTools || textToolCalls.length > 0;
            if (!hasContent) {
              // Send a proper Anthropic error event so the SDK triggers its retry logic.
              // Injecting fake text would be silently accepted but not trigger recovery.
              const emptyMsg = `The model returned an empty response. This usually happens when the conversation context is too large. Try compacting the conversation or reducing the context size.`;
              send("error", {
                type: "error",
                error: {
                  type: "api_error",
                  message: emptyMsg,
                },
              });
              logStderr(`[Stream] EMPTY RESPONSE from ${opts.modelName} — sent api_error to client (context overflow?)`);
              log(`[Stream] Empty response from provider (context overflow?) — sent api_error event`);
            }

            // Set stop_reason based on whether we sent ANY tool calls (text-based or structured)
            const stopReason =
              textToolCalls.length > 0 || hasStructuredTools ? "tool_use" : "end_turn";
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: {
                input_tokens: state.usage?.prompt_tokens || 0,
                output_tokens: state.usage?.completion_tokens || 0,
              },
            });
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
              onTokenUpdate(0, estimatedOutputTokens);
            }
          }

          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n\n"));
            } catch (e) {}
            controller.close();
            isClosed = true;
            if (ping) clearInterval(ping);
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

                  // Handle reasoning_content (Kimi, DeepSeek thinking models via LiteLLM)
                  if (delta.reasoning_content) {
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
                      delta: { type: "thinking_delta", thinking: delta.reasoning_content },
                    });
                  }

                  // Handle text content
                  const txt = delta.content || "";
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

                    // Debug: Log text processing
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
                        // Qwen XML-style: <function=ToolName>
                        /<function=[^>]+>/.test(state.accumulatedText) ||
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
                          const isWebSearch = isWebSearchToolCall(restoredName);
                          if (isWebSearch) {
                            log(`[Stream] Web search tool call detected: "${restoredName}" — intercepting via SearXNG (available=${SEARXNG_AVAILABLE})`);
                          }
                          t = {
                            id: tc.id || `tool_${Date.now()}_${idx}`,
                            name: restoredName,
                            blockIndex: state.curIdx++,
                            started: false,
                            closed: false,
                            suppressed: isWebSearch,
                            arguments: "", // Initialize arguments accumulator
                            buffered: !!toolSchemas && toolSchemas.length > 0 && !isWebSearch,
                          };
                          state.tools.set(idx, t);
                        }
                        // Skip suppressed tools entirely
                        if (t.suppressed) continue;
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
                      if (tc.function?.arguments && t && !t.suppressed) {
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
                    if (t.suppressed) {
                      // Execute web search via SearXNG and inject results
                      if (!t.closed) {
                        const query = extractSearchQuery(t.arguments);
                        let resultText: string;
                        if (query && SEARXNG_AVAILABLE) {
                          resultText = await executeWebSearch(query);
                        } else {
                          resultText = query
                            ? `[Web search for "${query}" could not be executed. The search service (SearXNG) is not configured. Set SEARXNG_URL env var to enable.]`
                            : `[Web search was requested but no query was provided.]`;
                        }
                        send("content_block_start", {
                          type: "content_block_start",
                          index: t.blockIndex,
                          content_block: { type: "text", text: "" },
                        });
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: t.blockIndex,
                          delta: { type: "text_delta", text: resultText },
                        });
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: t.blockIndex,
                        });
                        t.closed = true;
                      }
                      continue;
                    }
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
                          const repairedJson = JSON.stringify(validation.repairedArgs);
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
                          const argsJson = JSON.stringify(validation.parsedArgs);
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
