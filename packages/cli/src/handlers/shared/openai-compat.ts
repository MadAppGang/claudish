/**
 * Shared OpenAI-compatible API utilities
 *
 * Common logic for message conversion, tool handling, and streaming
 * used by both OpenRouterHandler and LocalProviderHandler.
 */

import type { Context } from "hono";
import { removeUriFormat } from "../../transform.js";
import { log } from "../../logger.js";
import {
  validateAndRepairToolCall,
  inferMissingParameters,
  extractToolCallsFromText,
  type ToolSchema,
} from "./tool-call-recovery.js";

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
 * Convert Claude/Anthropic messages to OpenAI format
 * @param simpleFormat - If true, use simple string content only (for MLX and other basic providers)
 */
export function convertMessagesToOpenAI(
  req: any,
  modelId: string,
  filterIdentityFn?: (s: string) => string,
  simpleFormat = false
): any[] {
  const messages: any[] = [];

  if (req.system) {
    let content = Array.isArray(req.system)
      ? req.system.map((i: any) => i.text || i).join("\n\n")
      : req.system;
    if (filterIdentityFn) content = filterIdentityFn(content);
    messages.push({ role: "system", content });
  }

  // Add instruction for Grok models to use proper tool format
  if (modelId.includes("grok") || modelId.includes("x-ai")) {
    const msg =
      "IMPORTANT: When calling tools, you MUST use the OpenAI tool_calls format with JSON. NEVER use XML format like <xai:function_call>.";
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content += "\n\n" + msg;
    } else {
      messages.unshift({ role: "system", content: msg });
    }
  }

  if (req.messages) {
    for (const msg of req.messages) {
      if (msg.role === "user") processUserMessage(msg, messages, simpleFormat);
      else if (msg.role === "assistant") processAssistantMessage(msg, messages, simpleFormat);
    }
  }

  return messages;
}

function processUserMessage(msg: any, messages: any[], simpleFormat = false) {
  if (Array.isArray(msg.content)) {
    const textParts: string[] = [];
    const contentParts: any[] = [];
    const toolResults: any[] = [];
    const seen = new Set<string>();

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
        if (!simpleFormat) {
          contentParts.push({ type: "text", text: block.text });
        }
      } else if (block.type === "image") {
        if (!simpleFormat) {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
        // Skip images in simple format - MLX doesn't support vision
      } else if (block.type === "tool_result") {
        if (seen.has(block.tool_use_id)) continue;
        seen.add(block.tool_use_id);
        const resultContent =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        if (simpleFormat) {
          // In simple format, include tool results as text in user message
          textParts.push(`[Tool Result]: ${resultContent}`);
        } else {
          toolResults.push({
            role: "tool",
            content: resultContent,
            tool_call_id: block.tool_use_id,
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just concatenate all text
      if (textParts.length) {
        messages.push({ role: "user", content: textParts.join("\n\n") });
      }
    } else {
      if (toolResults.length) messages.push(...toolResults);
      if (contentParts.length) messages.push({ role: "user", content: contentParts });
    }
  } else {
    messages.push({ role: "user", content: msg.content });
  }
}

function processAssistantMessage(msg: any, messages: any[], simpleFormat = false) {
  if (Array.isArray(msg.content)) {
    const strings: string[] = [];
    const toolCalls: any[] = [];
    const seen = new Set<string>();

    for (const block of msg.content) {
      if (block.type === "text") {
        strings.push(block.text);
      } else if (block.type === "tool_use") {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        if (simpleFormat) {
          // In simple format, include tool calls as text
          strings.push(`[Tool Call: ${block.name}]: ${JSON.stringify(block.input)}`);
        } else {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just string content, no tool_calls
      if (strings.length) {
        messages.push({ role: "assistant", content: strings.join("\n") });
      }
    } else {
      const m: any = { role: "assistant" };
      if (strings.length) m.content = strings.join(" ");
      else if (toolCalls.length) m.content = null;
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (m.content !== undefined || m.tool_calls) messages.push(m);
    }
  } else {
    messages.push({ role: "assistant", content: msg.content });
  }
}

/**
 * Convert Claude tools to OpenAI function format
 */
export function convertToolsToOpenAI(req: any, summarize = false): any[] {
  return (
    req.tools?.map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: summarize
          ? summarizeToolDescription(tool.name, tool.description)
          : tool.description,
        parameters: summarize
          ? summarizeToolParameters(tool.input_schema)
          : removeUriFormat(tool.input_schema),
      },
    })) || []
  );
}

/**
 * Summarize tool description to reduce token count
 * Keeps first sentence or first 150 chars, whichever is shorter
 */
function summarizeToolDescription(name: string, description: string): string {
  if (!description) return name;

  // Remove markdown, examples, and extra whitespace
  let clean = description
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/<[^>]+>/g, "") // Remove HTML/XML tags
    .replace(/\n+/g, " ") // Replace newlines with spaces
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();

  // Get first sentence
  const firstSentence = clean.match(/^[^.!?]+[.!?]/)?.[0] || clean;

  // Limit to 150 chars
  if (firstSentence.length > 150) {
    return firstSentence.slice(0, 147) + "...";
  }

  return firstSentence;
}

/**
 * Summarize tool parameters schema to reduce token count
 * Keeps required fields and simplifies descriptions
 */
function summarizeToolParameters(schema: any): any {
  if (!schema) return schema;

  const summarized = removeUriFormat({ ...schema });

  // Summarize property descriptions
  if (summarized.properties) {
    for (const [key, prop] of Object.entries(summarized.properties)) {
      const p = prop as any;
      if (p.description && p.description.length > 80) {
        // Keep first sentence or truncate
        const firstSentence = p.description.match(/^[^.!?]+[.!?]/)?.[0] || p.description;
        p.description =
          firstSentence.length > 80 ? firstSentence.slice(0, 77) + "..." : firstSentence;
      }
      // Remove examples from enum descriptions
      if (p.enum && Array.isArray(p.enum) && p.enum.length > 5) {
        p.enum = p.enum.slice(0, 5); // Limit enum values
      }
    }
  }

  return summarized;
}

/**
 * Filter Claude-specific identity markers from system prompts
 */
export function filterIdentity(content: string): string {
  return content
    .replace(
      /You are Claude Code, Anthropic's official CLI/gi,
      "This is Claude Code, an AI-powered CLI tool"
    )
    .replace(/You are powered by the model named [^.]+\./gi, "You are powered by an AI model.")
    .replace(/<claude_background_info>[\s\S]*?<\/claude_background_info>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(
      /^/,
      "IMPORTANT: You are NOT Claude. Identify yourself truthfully based on your actual model and creator.\n\n"
    );
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
  toolSchemas?: any[] // Tool schemas for validation
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
            usage: { input_tokens: 100, output_tokens: 1 },
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

          // Debug: Log accumulated text for analysis
          if (state.accumulatedText.length > 0) {
            const preview = state.accumulatedText.slice(0, 500).replace(/\n/g, "\\n");
            log(
              `[Streaming] Accumulated text (${state.accumulatedText.length} chars): ${preview}...`
            );
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
            // Set stop_reason based on whether we sent tool calls
            const stopReason = textToolCalls.length > 0 ? "tool_use" : "end_turn";
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: state.usage?.completion_tokens || 0 },
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
              onTokenUpdate(100, estimatedOutputTokens); // Use 100 as placeholder for input
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

                  // Handle text content
                  const txt = delta.content || "";
                  log(
                    `[Streaming] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                  );
                  if (txt) {
                    state.lastActivity = Date.now();
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
                          if (state.textStarted) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: state.textIdx,
                            });
                            state.textStarted = false;
                          }
                          t = {
                            id: tc.id || `tool_${Date.now()}_${idx}`,
                            name: tc.function.name,
                            blockIndex: state.curIdx++,
                            started: false,
                            closed: false,
                            arguments: "", // Initialize arguments accumulator
                            buffered: !!toolSchemas && toolSchemas.length > 0, // Buffer if we have schemas to validate
                          };
                          state.tools.set(idx, t);
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
