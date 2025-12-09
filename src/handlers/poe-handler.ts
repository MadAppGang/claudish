import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { ModelHandler } from "../types.js";
import { log, logStructured, shouldDebug, maskCredential } from "../logger.js";

// Type definitions for OpenAI chunks
interface OpenAIChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
    function_call?: any;
    tool_calls?: any[];
  };
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter";
}

interface OpenAIChunk {
  id?: string;
  object: "chat.completion.chunk" | "chat.completion";
  created?: number;
  model?: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface ContentBlock {
  type: string;
  started: boolean;
  stopped: boolean;
}

interface ToolBlock extends ContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  arguments: string;
}

/**
 * Enhanced SSE parser for robust handling of Server-Sent Events
 */
class SSEParser {
  private buffer: string = "";
  private readonly maxBufferSize = 64 * 1024; // 64KB limit

  /**
   * Parse SSE data and extract complete JSON objects
   */
  parse(chunk: string): string[] {
    this.buffer += chunk;

    // Prevent buffer from growing too large
    if (this.buffer.length > this.maxBufferSize) {
      // Keep only the last half of the buffer
      this.buffer = this.buffer.slice(-Math.floor(this.maxBufferSize / 2));
    }

    const events: string[] = [];
    const lines = this.buffer.split('\n');

    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() || "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();

        if (data === '[DONE]') {
          events.push('[DONE]');
        } else if (data) {
          events.push(data);
        }
      }
    }

    return events;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = "";
  }
}

/**
 * Elegant XML tool call parser for Poe models
 */
export class XMLToolCallParser {
  private static readonly FUNCTION_CALLS_START = '<function_calls>';
  private static readonly FUNCTION_CALLS_END = '</function_calls>';
  private static readonly INVOKE_START = '<invoke name="';
  private static readonly INVOKE_END = '</invoke>';
  private static readonly PARAMETER_START = '<parameter name="';
  private static readonly PARAMETER_END = '</parameter>';

  /**
   * Detect if text contains XML tool calls
   */
  static containsToolCalls(text: string): boolean {
    return text.includes(this.FUNCTION_CALLS_START);
  }

  /**
   * Extract and convert XML tool calls to OpenAI format
   */
  static parseToolCalls(text: string, toolIndex: number = 0): any[] | null {
    if (!this.containsToolCalls(text)) {
      return null;
    }

    const toolCalls: any[] = [];

    // Extract the function_calls block
    const startIdx = text.indexOf(this.FUNCTION_CALLS_START);
    const endIdx = text.indexOf(this.FUNCTION_CALLS_END);

    if (startIdx === -1 || endIdx === -1) {
      return null;
    }

    const functionCallsBlock = text.substring(
      startIdx + this.FUNCTION_CALLS_START.length,
      endIdx
    );

    // Find all invoke blocks
    const invokeBlocks = this.extractInvokeBlocks(functionCallsBlock);

    for (let i = 0; i < invokeBlocks.length; i++) {
      const toolCall = this.parseInvokeBlock(invokeBlocks[i], toolIndex + i);
      if (toolCall) {
        toolCalls.push(toolCall);
      }
    }

    return toolCalls.length > 0 ? toolCalls : null;
  }

  /**
   * Extract individual invoke blocks from function_calls content
   */
  private static extractInvokeBlocks(functionCallsContent: string): string[] {
    const blocks: string[] = [];
    let currentIdx = 0;

    while (currentIdx < functionCallsContent.length) {
      const startIdx = functionCallsContent.indexOf(this.INVOKE_START, currentIdx);
      if (startIdx === -1) break;

      const endIdx = functionCallsContent.indexOf(this.INVOKE_END, startIdx);
      if (endIdx === -1) break;

      blocks.push(functionCallsContent.substring(startIdx, endIdx + this.INVOKE_END.length));
      currentIdx = endIdx + this.INVOKE_END.length;
    }

    return blocks;
  }

  /**
   * Parse a single invoke block into OpenAI tool call format
   */
  private static parseInvokeBlock(invokeBlock: string, index: number): any | null {
    // Extract function name
    const nameStart = invokeBlock.indexOf(this.INVOKE_START);
    if (nameStart === -1) return null;

    const nameEnd = invokeBlock.indexOf('"', nameStart + this.INVOKE_START.length);
    if (nameEnd === -1) return null;

    const functionName = invokeBlock.substring(
      nameStart + this.INVOKE_START.length,
      nameEnd
    );

    // Extract all parameters
    const parameters: Record<string, string> = {};
    let currentIdx = nameEnd;

    while (currentIdx < invokeBlock.length) {
      const paramStart = invokeBlock.indexOf(this.PARAMETER_START, currentIdx);
      if (paramStart === -1) break;

      const paramNameEnd = invokeBlock.indexOf('"', paramStart + this.PARAMETER_START.length);
      if (paramNameEnd === -1) break;

      const paramName = invokeBlock.substring(
        paramStart + this.PARAMETER_START.length,
        paramNameEnd
      );

      const paramValueStart = invokeBlock.indexOf('>', paramNameEnd);
      if (paramValueStart === -1) break;

      const paramEndTag = invokeBlock.indexOf(this.PARAMETER_END, paramValueStart);
      if (paramEndTag === -1) break;

      const paramValue = invokeBlock.substring(paramValueStart + 1, paramEndTag);

      parameters[paramName] = paramValue.trim();
      currentIdx = paramEndTag + this.PARAMETER_END.length;
    }

    // Generate unique ID with timestamp and random component
    const toolId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${index}`;

    return {
      index,
      id: toolId,
      function: {
        name: functionName,
        arguments: JSON.stringify(parameters)
      }
    };
  }

  /**
   * Remove XML tool calls from text (for clean text extraction)
   */
  static removeToolCalls(text: string): string {
    if (!this.containsToolCalls(text)) {
      return text;
    }

    const startIdx = text.indexOf(this.FUNCTION_CALLS_START);
    const endIdx = text.indexOf(this.FUNCTION_CALLS_END);

    if (startIdx !== -1 && endIdx !== -1) {
      return text.substring(0, startIdx) + text.substring(endIdx + this.FUNCTION_CALLS_END.length);
    }

    return text;
  }
}

/**
 * Content block tracker for managing Claude-compatible content blocks
 */
class ContentBlockTracker {
  private blocks: Map<number, ContentBlock> = new Map();
  private tools: Map<number, ToolBlock> = new Map();
  private toolIndexToBlockIndex: Map<number, number> = new Map();
  private nextIndex: number = 0;

  /**
   * Start a new text block and return its index
   */
  startTextBlock(): number {
    const index = this.nextIndex++;
    this.blocks.set(index, {
      type: "text",
      started: true,
      stopped: false
    });
    return index;
  }

  /**
   * Start a new tool block and return its index
   */
  startToolBlock(toolIndex: number, id: string, name: string): number {
    const blockIndex = this.nextIndex++;
    const toolBlock: ToolBlock = {
      type: "tool_use",
      id,
      name,
      arguments: "",
      started: true,
      stopped: false
    };
    this.tools.set(blockIndex, toolBlock);
    this.toolIndexToBlockIndex.set(toolIndex, blockIndex);
    return blockIndex;
  }

  /**
   * Add text delta to a block
   */
  addTextDelta(index: number, text: string): void {
    const block = this.blocks.get(index);
    if (block && block.started && !block.stopped && block.type === "text") {
      // Block exists and is active
      return;
    }
  }

  /**
   * Add arguments delta to a tool block
   */
  addToolArguments(toolIndex: number, args: string): void {
    const blockIndex = this.toolIndexToBlockIndex.get(toolIndex);
    if (blockIndex !== undefined) {
      const tool = this.tools.get(blockIndex);
      if (tool && tool.started && !tool.stopped) {
        tool.arguments += args;
      }
    }
  }

  /**
   * Stop a specific block
   */
  stopBlock(index: number): void {
    const block = this.blocks.get(index);
    if (block && block.started && !block.stopped) {
      block.stopped = true;
    }

    const tool = this.tools.get(index);
    if (tool && tool.started && !tool.stopped) {
      tool.stopped = true;
    }
  }

  /**
   * Get the block index for a tool index
   */
  getToolBlockIndex(toolIndex: number): number | undefined {
    return this.toolIndexToBlockIndex.get(toolIndex);
  }

  /**
   * Ensure all blocks are stopped (called at stream end)
   */
  ensureAllBlocksStopped(): number[] {
    const stoppedIndices: number[] = [];

    for (const [index, block] of this.blocks) {
      if (block.started && !block.stopped) {
        block.stopped = true;
        stoppedIndices.push(index);
      }
    }

    for (const [index, tool] of this.tools) {
      if (tool.started && !tool.stopped) {
        tool.stopped = true;
        stoppedIndices.push(index);
      }
    }

    return stoppedIndices;
  }
}

/**
 * Enhanced error handler for categorized error management
 */
class ErrorHandler {
  constructor(private model: string) {}

  /**
   * Handle errors with proper categorization and logging
   */
  handle(error: any, context: any): void {
    const errorInfo = {
      name: error?.name || 'UnknownError',
      message: error?.message || String(error),
      stack: error?.stack,
      model: this.model,
      timestamp: new Date().toISOString(),
      ...context
    };

    // Categorize errors for appropriate handling
    if (error instanceof SyntaxError) {
      // JSON parsing errors are common and not critical
      logStructured('POE_SSE_PARSE_ERROR', errorInfo);
    } else if (error instanceof TypeError) {
      // Type errors might indicate data structure issues
      logStructured('POE_SSE_TYPE_ERROR', errorInfo);
    } else {
      // Other errors are more serious
      console.error('❌ [POE] HANDLER_ERROR', errorInfo.message);
      logStructured('POE_STREAM_ERROR', errorInfo);
    }
  }
}

// Export classes for testing
export { SSEParser, ContentBlockTracker, ErrorHandler };

/**
 * Clean, elegant Poe handler using OpenAI-compatible HTTP API
 * No Python bridge, no processes, no race conditions - just direct HTTP calls
 *
 * Based on Poe's OpenAI-compatible API documentation:
 * https://api.poe.com/v1/chat/completions
 * Model format: @poe/model-name (instead of poe/model-name)
 */
export class PoeHandler implements ModelHandler {
  private readonly apiKey: string;
  private readonly apiKeySha: string;
  private readonly apiUrl = "https://api.poe.com/v1/chat/completions";
  private readonly headers: Record<string, string>;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.apiKeySha = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
    this.headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };
  }

  async handle(c: Context, payload: any): Promise<Response> {
    try {
      const model = this.transformModelId(payload.model);

      // Debug level: detailed request lifecycle (like log.debug())
      if (shouldDebug('process')) {
        logStructured('POE_HANDLER_REQUEST_STARTED', {
          model: payload.model,
          transformedModel: model,
          hasApiKey: !!this.apiKey,
          apiKeySha256: this.apiKeySha,
          stream: true,
          timestamp: new Date().toISOString()
        });
      }

      const openAIRequest = this.transformRequest(payload);

      // Debug level: API request details (like log.debug())
      if (shouldDebug('process')) {
        logStructured('POE_API_REQUEST', {
          url: this.apiUrl,
          method: 'POST',
          headers: {
            'Content-Type': this.headers['Content-Type'],
            'Authorization': `Bearer ${maskCredential(this.apiKey)}`
          },
          timestamp: new Date().toISOString()
        });
      }

      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(openAIRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();

        // Error level: API errors (like log.error())
        console.error(`Poe API Error: ${response.status} - ${errorText}`);
        console.error(`API Key SHA256 (first 16 hex): ${this.apiKeySha}`);

        // Debug level: API error context (like log.debug())
        logStructured('POE_API_ERROR', {
          status: response.status,
          errorText: errorText.substring(0, 500) + (errorText.length > 500 ? '...' : ''),
          apiKeySha256: this.apiKeySha,
          timestamp: new Date().toISOString()
        });

        return c.json(
          {
            error: {
              message: `Poe API error: ${response.status} (API Key SHA256: ${this.apiKeySha})`,
              type: "api_error"
            }
          },
          { status: response.status }
        );
      }

      // Debug level: API response details (like log.debug())
      if (shouldDebug('process')) {
        logStructured('POE_API_RESPONSE', {
          status: response.status,
          statusText: response.statusText,
          timestamp: new Date().toISOString()
        });
      }

      return this.createStreamingResponse(c, response, model);
    } catch (error) {
      console.error("Poe handler error:", error);
      return c.json(
        {
          error: {
            message: error instanceof Error ? error.message : "Unknown error",
            type: "handler_error"
          }
        },
        { status: 500 }
      );
    }
  }

  /**
   * Transform Claude format to OpenAI format
   *
   * Key transformations:
   * - Model ID: poe/grok-4 → grok-4
   * - Messages: Claude rich content → OpenAI simple content
   * - Add thinking budget if present
   */
  private transformRequest(payload: any): any {
    // Transform model ID: poe/grok-4 → grok-4
    const model = this.transformModelId(payload.model);

    const openAIRequest: any = {
      model,
      messages: this.transformMessages(payload.messages || []),
      stream: true,
      max_tokens: payload.max_tokens || 4096,
    };

    // Add thinking budget if present (for reasoning models)
    if (payload.thinking?.budget_tokens) {
      openAIRequest.thinking_budget = payload.thinking.budget_tokens;
    }

    // Add temperature if present
    if (payload.temperature !== undefined) {
      openAIRequest.temperature = payload.temperature;
    }

    return openAIRequest;
  }

  /**
   * Transform model ID: poe:grok-4 → grok-4
   */
  private transformModelId(model: string): string {
    // Remove poe: prefix only
    return model.replace(/^poe:/, "");
  }

  /**
   * Transform Claude messages to OpenAI format
   *
   * Claude supports rich content objects, OpenAI expects simple strings
   */
  private transformMessages(messages: any[]): any[] {
    return messages.map(msg => {
      // Handle message content transformations
      if (msg.content && Array.isArray(msg.content)) {
        // Claude format with rich content (text, image, etc.)
        const textContent = msg.content
          .filter((item: any) => item.type === "text")
          .map((item: any) => item.text)
          .join("");

        return {
          role: msg.role,
          content: textContent
        };
      } else if (typeof msg.content === "object" && msg.content?.text) {
        // Handle Claude text objects
        return {
          role: msg.role,
          content: msg.content.text
        };
      }
      return msg;
    });
  }

  /**
   * Transform OpenAI chunk to Claude-compatible format
   *
   * Enhanced version that handles all valid OpenAI chunk types gracefully
   */
  private transformChunk(chunk: OpenAIChunk): any {
    // Validate chunk structure more leniently
    if (!chunk || typeof chunk !== 'object') {
      return null;
    }

    // Handle missing choices array - this is valid for some chunk types
    if (!chunk.choices || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
      return null;
    }

    const choice = chunk.choices[0];
    if (!choice) {
      return null;
    }

    // Handle chat completion chunks (both .chunk and .completion)
    if (chunk.object === "chat.completion.chunk" || chunk.object === "chat.completion") {
      const delta = choice.delta || {};

      // Handle tool_calls deltas first (critical for tool call processing)
      if (delta.tool_calls) {
        return {
          type: "tool_calls",
          tool_calls: delta.tool_calls
        };
      }

      // Handle content deltas (the main text content)
      if (delta.content && typeof delta.content === 'string' && delta.content.length > 0) {
        // Check if content contains XML tool calls (Poe format)
        if (XMLToolCallParser.containsToolCalls(delta.content)) {
          const toolCalls = XMLToolCallParser.parseToolCalls(delta.content);
          const cleanText = XMLToolCallParser.removeToolCalls(delta.content);

          // If we have both tool calls AND text, return both
          if (toolCalls && toolCalls.length > 0 && cleanText.length > 0) {
            // Store both for separate processing
            (delta as any)._cachedToolCalls = toolCalls;
            (delta as any)._cachedCleanText = cleanText;

            // Return tool calls first, text will be processed in next iteration
            return {
              type: "tool_calls",
              tool_calls: toolCalls
            };
          } else if (toolCalls && toolCalls.length > 0) {
            // Only tool calls, no text
            return {
              type: "tool_calls",
              tool_calls: toolCalls
            };
          }
        }

        return {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: XMLToolCallParser.removeToolCalls(delta.content)
          }
        };
      }

      // Handle role deltas (valid OpenAI chunks, but ignore for Claude)
      if (delta.role) {
        // Silently ignore role deltas - they're valid but don't produce output
        return null;
      }

      // Handle function_call deltas (if supported)
      if (delta.function_call) {
        // For now, ignore function_call chunks but don't log as error
        return null;
      }

      // Handle finish reason (but only if no tool calls)
      if (choice.finish_reason) {
        return {
          type: "content_block_stop",
          index: 0
        };
      }

      // Handle empty deltas (valid OpenAI chunks that contain no content)
      if (Object.keys(delta).length === 0) {
        // Silently ignore empty deltas - they're valid but don't produce output
        return null;
      }
    }

    // Return null for unhandled chunk types (silently ignore)
    return null;
  }

  /**
   * Create streaming response from OpenAI SSE format
   *
   * Enhanced version with robust SSE parsing, content block management, and error handling
   */
  private createStreamingResponse(c: Context, response: Response, model: string): Response {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    return c.body(
      new ReadableStream({
        start: async (controller) => {
          const reader = response.body?.getReader();
          if (!reader) {
            controller.error(new Error("No response body"));
            return;
          }

          // Initialize new components
          const sseParser = new SSEParser();
          const blockTracker = new ContentBlockTracker();
          const errorHandler = new ErrorHandler(model);

          let isClosed = false;
          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          // State tracking for proper Claude event flow
          let messageStarted = false;
          let currentBlockIndex: number | null = null;
          let ping: NodeJS.Timeout | null = null;
          let lastActivity = Date.now();

          // Helper function to send properly formatted SSE events with debugging
          const send = (e: string, d: any) => {
            if (!isClosed) {
              const eventData = JSON.stringify(d);

              // Debug level: SSE event details (like log.debug())
              if (shouldDebug('sse')) {
                logStructured('POE_SSE_SENDING_EVENT', {
                  eventType: e,
                  eventData: d,
                  eventDataRaw: eventData.substring(0, 100) + (eventData.length > 100 ? '...' : ''),
                  timestamp: new Date().toISOString(),
                  messageStarted,
                  currentBlockIndex,
                  isClosed
                });
              }

              // Use triple newline format like OpenRouterHandler
              controller.enqueue(encoder.encode(`event: ${e}\ndata: ${eventData}\n\n\n`));
            }
          };

          // Start ping interval like OpenRouterHandler
          ping = setInterval(() => {
            if (!isClosed && Date.now() - lastActivity > 1000) {
              send("ping", { type: "ping" });
            }
          }, 1000);

          // Send message_start immediately (critical fix - don't wait for content)
          send("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: model,
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 0,
                output_tokens: 0
              }
            }
          });
          send("ping", { type: "ping" });
          messageStarted = true;

          try {
            while (!isClosed) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              lastActivity = Date.now();

              // Use enhanced SSE parser
              const events = sseParser.parse(chunk);

              for (const data of events) {
                if (data === '[DONE]') {
                  // Ensure all content blocks are properly stopped
                  const stoppedBlocks = blockTracker.ensureAllBlocksStopped();
                  for (const blockIndex of stoppedBlocks) {
                    send("content_block_stop", {
                      type: "content_block_stop",
                      index: blockIndex
                    });
                  }

                  // Send message_stop event
                  send("message_stop", {
                    type: "message_stop"
                  });

                  // Send final [DONE] marker with proper SSE format (triple newlines)
                  try {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n\n"));
                  } catch (e) {
                    // Ignore errors during stream termination
                  }

                  isClosed = true;
                  break;
                }

                try {
                  const openaiChunk: OpenAIChunk = JSON.parse(data);

                  // Transform and send content delta
                  const claudeChunk = this.transformChunk(openaiChunk);

                  // Check if we need to start a text block (but NOT if we have tool calls)
                  if (currentBlockIndex === null &&
                      openaiChunk.choices?.[0]?.delta?.content &&
                      claudeChunk?.type !== "tool_calls") {
                    currentBlockIndex = blockTracker.startTextBlock();
                    send("content_block_start", {
                      type: "content_block_start",
                      index: currentBlockIndex,
                      content_block: {
                        type: "text",
                        text: ""
                      }
                    });
                  }

                  if (claudeChunk) {
                    if (claudeChunk.type === "content_block_delta" && currentBlockIndex !== null) {
                      blockTracker.addTextDelta(currentBlockIndex, claudeChunk.delta.text);
                      send("content_block_delta", {
                        ...claudeChunk,
                        index: currentBlockIndex
                      });
                    } else if (claudeChunk.type === "content_block_stop" && currentBlockIndex !== null) {
                      blockTracker.stopBlock(currentBlockIndex);
                      send("content_block_stop", {
                        type: "content_block_stop",
                        index: currentBlockIndex
                      });
                      currentBlockIndex = null;
                    } else if (claudeChunk.type === "tool_calls" && claudeChunk.tool_calls) {
                      // Handle tool_calls with elegant Claude-compatible conversion
                      for (const toolCall of claudeChunk.tool_calls) {
                        const toolIndex = toolCall.index;

                        // Start tool block if we have a function name
                        if (toolCall.function?.name) {
                          const existingBlockIndex = blockTracker.getToolBlockIndex(toolIndex);

                          if (!existingBlockIndex) {
                            // Stop any current text block before starting tool block
                            if (currentBlockIndex !== null) {
                              send("content_block_stop", {
                                type: "content_block_stop",
                                index: currentBlockIndex
                              });
                              blockTracker.stopBlock(currentBlockIndex);
                              currentBlockIndex = null;
                            }

                            // Start new tool block with elegant ID generation
                            const toolId = toolCall.id || `tool_${Date.now()}_${toolIndex}`;
                            const toolBlockIndex = blockTracker.startToolBlock(
                              toolIndex,
                              toolId,
                              toolCall.function.name
                            );

                            send("content_block_start", {
                              type: "content_block_start",
                              index: toolBlockIndex,
                              content_block: {
                                type: "tool_use",
                                id: toolId,
                                name: toolCall.function.name
                              }
                            });
                          }
                        }

                        // Add function arguments if present
                        if (toolCall.function?.arguments) {
                          blockTracker.addToolArguments(toolIndex, toolCall.function.arguments);

                          const toolBlockIndex = blockTracker.getToolBlockIndex(toolIndex);
                          if (toolBlockIndex !== undefined) {
                            send("content_block_delta", {
                              type: "content_block_delta",
                              index: toolBlockIndex,
                              delta: {
                                type: "input_json_delta",
                                partial_json: toolCall.function.arguments
                              }
                            });
                          }
                        }
                      }
                    }

                    // After processing tool calls, check for cached text content
                    if (delta._cachedCleanText && delta._cachedCleanText.length > 0) {
                      // Start a text block if needed
                      if (currentBlockIndex === null) {
                        currentBlockIndex = blockTracker.startTextBlock();
                        send("content_block_start", {
                          type: "content_block_start",
                          index: currentBlockIndex,
                          content_block: {
                            type: "text",
                            text: ""
                          }
                        });
                      }

                      // Send the cached text content
                      send("content_block_delta", {
                        type: "content_block_delta",
                        index: currentBlockIndex,
                        delta: {
                          type: "text_delta",
                          text: delta._cachedCleanText
                        }
                      });

                      // Clear the cached text to avoid duplicate processing
                      delete (delta as any)._cachedCleanText;
                    }
                  }

                  // Handle tool_calls finish reason
                  if (openaiChunk.choices?.[0]?.finish_reason === "tool_calls") {
                    // Stop all tool blocks elegantly
                    const stoppedBlocks = blockTracker.ensureAllBlocksStopped();
                    for (const blockIndex of stoppedBlocks) {
                      try {
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: blockIndex
                        });
                      } catch (e) {
                        // Ignore errors during tool block cleanup
                      }
                    }
                  }
                } catch (e) {
                  // Use enhanced error handling
                  errorHandler.handle(e, {
                    data: data.substring(0, 200) + (data.length > 200 ? '...' : ''),
                    eventCount: events.length,
                    currentBlockIndex
                  });
                }
              }
            }
          } catch (error) {
            // Use enhanced error handling
            errorHandler.handle(error, {
              messageStarted,
              currentBlockIndex,
              isClosed
            });

            controller.error(error);
          } finally {
            // Clear ping interval
            if (ping) {
              clearInterval(ping);
              ping = null;
            }

            // Ensure proper cleanup
            if (!isClosed) {
              const stoppedBlocks = blockTracker.ensureAllBlocksStopped();
              for (const blockIndex of stoppedBlocks) {
                try {
                  send("content_block_stop", {
                    type: "content_block_stop",
                    index: blockIndex
                  });
                } catch (e) {
                  // Ignore errors during cleanup
                }
              }
            }

            controller.close();
          }
        }
      })
    );
  }

  
  /**
   * No cleanup needed - we're HTTP-only
   */
  async shutdown(): Promise<void> {
    // Nothing to clean up
  }

  // Helper methods for testing
  createContentBlockTracker(): ContentBlockTracker {
    return new ContentBlockTracker();
  }

  createErrorHandler(model: string): ErrorHandler {
    return new ErrorHandler(model);
  }

  createSSEParser(): SSEParser {
    return new SSEParser();
  }
}