/**
 * OpenAI API Handler
 *
 * Handles direct communication with OpenAI's API.
 * Supports streaming, tool calling, and reasoning (o1/o3 models).
 *
 * Uses the same OpenAI-compatible streaming format as OpenRouter,
 * so we can reuse the shared streaming utilities.
 */

import type { Context } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../middleware/index.js";
import { transformOpenAIToClaude } from "../transform.js";
import { log, logStructured, getLogLevel, truncateContent } from "../logger.js";
import {
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  filterIdentity,
  createStreamingResponseHandler,
} from "./shared/openai-compat.js";
import {
  getModelPricing,
  type ModelPricing,
  type RemoteProvider,
} from "./shared/remote-provider-types.js";

/**
 * OpenAI API Handler
 *
 * Uses OpenAI's native API format which is the same as what OpenRouter uses.
 * This allows us to reuse the shared streaming handler.
 */
export class OpenAIHandler implements ModelHandler {
  private provider: RemoteProvider;
  private modelName: string;
  private apiKey: string;
  private port: number;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private sessionTotalCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private contextWindow = 128000; // GPT-4o default, varies by model

  constructor(provider: RemoteProvider, modelName: string, apiKey: string, port: number) {
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.port = port;
    this.adapterManager = new AdapterManager(`openai/${modelName}`);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[OpenAIHandler:${modelName}] Middleware init error: ${err}`));

    // Set context window based on model
    this.setContextWindow();
  }

  /**
   * Set context window based on model name
   */
  private setContextWindow(): void {
    const model = this.modelName.toLowerCase();
    if (model.includes("gpt-4o") || model.includes("gpt-4-turbo")) {
      this.contextWindow = 128000;
    } else if (model.includes("gpt-5")) {
      this.contextWindow = 256000; // GPT-5 has larger context
    } else if (model.includes("o1") || model.includes("o3")) {
      this.contextWindow = 200000; // Reasoning models have large context
    } else if (model.includes("gpt-3.5")) {
      this.contextWindow = 16385;
    } else {
      this.contextWindow = 128000; // Default
    }
  }

  /**
   * Get pricing for the current model
   */
  private getPricing(): ModelPricing {
    return getModelPricing("openai", this.modelName);
  }

  /**
   * Get the API endpoint URL
   * Codex models use /v1/responses, others use /v1/chat/completions
   */
  private getApiEndpoint(): string {
    if (this.isCodexModel()) {
      return `${this.provider.baseUrl}/v1/responses`;
    }
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  /**
   * Write token tracking file
   */
  private writeTokenFile(input: number, output: number): void {
    try {
      const total = input + output;
      const leftPct =
        this.contextWindow > 0
          ? Math.max(
              0,
              Math.min(100, Math.round(((this.contextWindow - total) / this.contextWindow) * 100))
            )
          : 100;

      const data = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: this.contextWindow,
        context_left_percent: leftPct,
        updated_at: Date.now(),
      };

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[OpenAIHandler] Error writing token file: ${e}`);
    }
  }

  /**
   * Update token tracking
   * Note: inputTokens is the FULL context each request (not incremental)
   * We only charge for the DELTA (new tokens) to avoid overcounting
   */
  private updateTokenTracking(inputTokens: number, outputTokens: number): void {
    // Calculate incremental input tokens (delta from previous request)
    const incrementalInputTokens = Math.max(0, inputTokens - this.sessionInputTokens);

    // Update session totals
    this.sessionInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;

    // Calculate cost for INCREMENTAL tokens only
    const pricing = this.getPricing();
    const cost =
      (incrementalInputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M;
    this.sessionTotalCost += cost;

    this.writeTokenFile(inputTokens, this.sessionOutputTokens);
  }

  /**
   * Convert Claude messages to OpenAI format
   */
  private convertMessages(claudeRequest: any): any[] {
    return convertMessagesToOpenAI(claudeRequest, `openai/${this.modelName}`, filterIdentity);
  }

  /**
   * Convert Claude tools to OpenAI format
   */
  private convertTools(claudeRequest: any): any[] {
    return convertToolsToOpenAI(claudeRequest);
  }

  /**
   * Check if model supports reasoning
   */
  private supportsReasoning(): boolean {
    const model = this.modelName.toLowerCase();
    return model.includes("o1") || model.includes("o3");
  }

  /**
   * Check if model is a Codex model that requires the Responses API
   * Codex models use /v1/responses instead of /v1/chat/completions
   */
  private isCodexModel(): boolean {
    const model = this.modelName.toLowerCase();
    return model.includes("codex");
  }

  /**
   * Check if model uses max_completion_tokens instead of max_tokens
   * Newer OpenAI models (GPT-5.x, o1, o3) require this parameter
   */
  private usesMaxCompletionTokens(): boolean {
    const model = this.modelName.toLowerCase();
    return (
      model.includes("gpt-5") ||
      model.includes("o1") ||
      model.includes("o3") ||
      model.includes("o4")
    );
  }

  /**
   * Build the OpenAI API request payload
   */
  private buildOpenAIPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelName,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
    };

    // Use max_completion_tokens for newer models (GPT-5.x, o1, o3, o4)
    // Older models use max_tokens
    if (this.usesMaxCompletionTokens()) {
      payload.max_completion_tokens = claudeRequest.max_tokens;
    } else {
      payload.max_tokens = claudeRequest.max_tokens;
    }

    if (tools.length > 0) {
      payload.tools = tools;
    }

    // Handle tool choice
    if (claudeRequest.tool_choice) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        payload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        payload.tool_choice = type;
      }
    }

    // Handle thinking/reasoning for o1/o3 models
    if (claudeRequest.thinking && this.supportsReasoning()) {
      const { budget_tokens } = claudeRequest.thinking;

      // Map budget to reasoning_effort
      let effort = "medium";
      if (budget_tokens < 4000) effort = "minimal";
      else if (budget_tokens < 16000) effort = "low";
      else if (budget_tokens >= 32000) effort = "high";

      payload.reasoning_effort = effort;
      log(
        `[OpenAIHandler] Mapped thinking.budget_tokens ${budget_tokens} -> reasoning_effort: ${effort}`
      );
    }

    return payload;
  }

  /**
   * Convert messages from Chat Completions format to Responses API format
   * Key differences:
   * - User text: "text" -> "input_text"
   * - Assistant text: "text" -> "output_text"
   * - Images: "image_url" -> "input_image" (URL as string, not object)
   * - Tool results: "tool" role -> "function_call_output" item (top-level, not in content)
   * - Tool calls: use "call_id" not "id"
   */
  private convertMessagesToResponsesAPI(messages: any[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      // Skip system messages (they go to instructions field)
      if (msg.role === "system") continue;

      // Handle tool role messages -> function_call_output items
      // These are NOT wrapped in role/content, they're top-level items
      if (msg.role === "tool") {
        result.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output:
            typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        });
        continue;
      }

      // Handle assistant messages with tool_calls
      // In Responses API, function_call is a TOP-LEVEL item, NOT a content block type
      if (msg.role === "assistant" && msg.tool_calls) {
        // Add any text content as a message first
        if (msg.content) {
          const textContent =
            typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          if (textContent) {
            result.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: textContent }],
            });
          }
        }

        // Add function calls as TOP-LEVEL items (NOT inside message content)
        for (const toolCall of msg.tool_calls) {
          if (toolCall.type === "function") {
            result.push({
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
              status: "completed",
            });
          }
        }
        continue;
      }

      // Handle string content (simple messages)
      if (typeof msg.content === "string") {
        result.push({
          type: "message",
          role: msg.role,
          content: [
            {
              type: msg.role === "user" ? "input_text" : "output_text",
              text: msg.content,
            },
          ],
        });
        continue;
      }

      // Handle array content (structured messages)
      if (Array.isArray(msg.content)) {
        const convertedContent = msg.content.map((block: any) => {
          // Convert text blocks
          if (block.type === "text") {
            return {
              type: msg.role === "user" ? "input_text" : "output_text",
              text: block.text,
            };
          }

          // Convert image blocks - extract URL from nested object
          // Chat Completions: {type: "image_url", image_url: {url: "..."}}
          // Responses API: {type: "input_image", image_url: "..."}
          if (block.type === "image_url") {
            const imageUrl =
              typeof block.image_url === "string"
                ? block.image_url
                : block.image_url?.url || block.image_url;
            return {
              type: "input_image",
              image_url: imageUrl,
            };
          }

          // Keep other types as-is
          return block;
        });

        result.push({
          type: "message",
          role: msg.role,
          content: convertedContent,
        });
        continue;
      }

      // Fallback for any other format - add type: "message" if it has role
      if (msg.role) {
        result.push({ type: "message", ...msg });
      } else {
        result.push(msg);
      }
    }

    return result;
  }

  /**
   * Build the OpenAI Responses API payload for Codex models
   * Responses API uses 'input' instead of 'messages' and different content types
   */
  private buildResponsesPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    // Convert messages to Responses API format (input_text, output_text, etc.)
    const convertedMessages = this.convertMessagesToResponsesAPI(messages);

    const payload: any = {
      model: this.modelName,
      input: convertedMessages,
      stream: true,
    };

    // Add system instructions if present
    if (claudeRequest.system) {
      payload.instructions = claudeRequest.system;
    }

    // Add max_output_tokens for Responses API
    if (claudeRequest.max_tokens) {
      payload.max_output_tokens = claudeRequest.max_tokens;
    }

    // Convert tools to Responses API format (flatter structure)
    if (tools.length > 0) {
      payload.tools = tools.map((tool: any) => {
        if (tool.type === "function" && tool.function) {
          // Flatten function tools for Responses API
          return {
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          };
        }
        return tool;
      });
    }

    return payload;
  }

  /**
   * Handle streaming response from Responses API
   * Converts Responses API events to Claude-compatible format
   */
  private async handleResponsesStreaming(
    c: Context,
    response: Response,
    _adapter: any,
    _claudeRequest: any
  ): Promise<Response> {
    const reader = response.body?.getReader();
    if (!reader) {
      return c.json({ error: "No response body" }, 500);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let buffer = "";
    let blockIndex = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let hasTextContent = false;
    let hasToolUse = false;
    let lastActivity = Date.now();
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let isClosed = false;

    // Track function calls being streamed
    const functionCalls: Map<string, { name: string; arguments: string; index: number }> =
      new Map();

    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: string, data: any) => {
          if (!isClosed) {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          }
        };

        // Send initial message_start event
        // Use placeholder for input_tokens since Responses API only reports usage at the end
        log(`[OpenAIHandler] Sending message_start with placeholder tokens`);
        send("message_start", {
          type: "message_start",
          message: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [],
            model: this.modelName,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 1 },
          },
        });

        // Send ping after message_start
        send("ping", { type: "ping" });

        // Set up periodic ping to keep connection alive (like OpenRouter handler)
        pingInterval = setInterval(() => {
          if (!isClosed && Date.now() - lastActivity > 1000) {
            send("ping", { type: "ping" });
          }
        }, 1000);

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            lastActivity = Date.now();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                // Store event type for next data line
                continue;
              }

              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6);
              if (data === "[DONE]") continue;

              try {
                const event = JSON.parse(data);

                // Log event types for debugging (only in debug mode)
                if (getLogLevel() === "debug" && event.type) {
                  log(`[OpenAIHandler] Responses event: ${event.type}`);
                  // Log full event for completed/done to debug token tracking
                  if (
                    event.type === "response.completed" ||
                    event.type === "response.done" ||
                    event.type === "response.created"
                  ) {
                    log(`[OpenAIHandler] Event data: ${JSON.stringify(event).slice(0, 500)}`);
                  }
                }

                // Handle different Responses API events
                if (event.type === "response.output_text.delta") {
                  // Convert to Claude content_block_delta
                  if (!hasTextContent) {
                    // Send content_block_start first
                    send("content_block_start", {
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: { type: "text", text: "" },
                    });
                    hasTextContent = true;
                  }

                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "text_delta", text: event.delta || "" },
                  });
                } else if (event.type === "response.output_item.added") {
                  // New item added - could be function_call
                  if (event.item?.type === "function_call") {
                    const callId = event.item.call_id || event.item.id;
                    const fnIndex = blockIndex + functionCalls.size + (hasTextContent ? 1 : 0);
                    functionCalls.set(callId, {
                      name: event.item.name || "",
                      arguments: "",
                      index: fnIndex,
                    });

                    // Close text block if open
                    if (hasTextContent && !hasToolUse) {
                      send("content_block_stop", { type: "content_block_stop", index: blockIndex });
                      blockIndex++;
                    }

                    // Send tool_use block start
                    send("content_block_start", {
                      type: "content_block_start",
                      index: fnIndex,
                      content_block: {
                        type: "tool_use",
                        id: callId,
                        name: event.item.name || "",
                        input: {},
                      },
                    });
                    hasToolUse = true;
                  }
                } else if (event.type === "response.function_call_arguments.delta") {
                  // Streaming function call arguments
                  const callId = event.call_id || event.item_id;
                  const fnCall = functionCalls.get(callId);
                  if (fnCall) {
                    fnCall.arguments += event.delta || "";

                    // Send input_json_delta
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: fnCall.index,
                      delta: { type: "input_json_delta", partial_json: event.delta || "" },
                    });
                  }
                } else if (event.type === "response.output_item.done") {
                  // Item complete - close the tool_use block
                  if (event.item?.type === "function_call") {
                    const callId = event.item.call_id || event.item.id;
                    const fnCall = functionCalls.get(callId);
                    if (fnCall) {
                      send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
                    }
                  }
                } else if (
                  event.type === "response.completed" ||
                  event.type === "response.done"
                ) {
                  // Extract usage from completed/done event
                  if (event.response?.usage) {
                    inputTokens = event.response.usage.input_tokens || 0;
                    outputTokens = event.response.usage.output_tokens || 0;
                    log(
                      `[OpenAIHandler] Responses API usage: input=${inputTokens}, output=${outputTokens}`
                    );
                  } else if (event.usage) {
                    // Alternative location for usage data
                    inputTokens = event.usage.input_tokens || 0;
                    outputTokens = event.usage.output_tokens || 0;
                    log(
                      `[OpenAIHandler] Responses API usage (alt): input=${inputTokens}, output=${outputTokens}`
                    );
                  }
                }
              } catch (parseError) {
                log(`[OpenAIHandler] Error parsing Responses event: ${parseError}`);
              }
            }
          }

          // Clear ping interval before closing
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          isClosed = true;

          // Send content_block_stop for text if not already closed
          if (hasTextContent && !hasToolUse) {
            send("content_block_stop", { type: "content_block_stop", index: blockIndex });
          }

          // Determine stop reason
          const stopReason = hasToolUse ? "tool_use" : "end_turn";

          // Send message_delta with usage
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });

          // Send message_stop
          send("message_stop", { type: "message_stop" });

          // Update token tracking
          this.updateTokenTracking(inputTokens, outputTokens);

          controller.close();
        } catch (error) {
          // Clean up ping interval on error
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          isClosed = true;
          log(`[OpenAIHandler] Responses streaming error: ${error}`);
          controller.error(error);
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

  /**
   * Main request handler
   */
  async handle(c: Context, payload: any): Promise<Response> {
    // Transform Claude request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

    // Convert messages and tools
    const messages = this.convertMessages(claudeRequest);
    const tools = this.convertTools(claudeRequest);

    // Log request summary
    const systemPromptLength =
      typeof claudeRequest.system === "string" ? claudeRequest.system.length : 0;
    logStructured("OpenAI Request", {
      targetModel: `openai/${this.modelName}`,
      originalModel: payload.model,
      messageCount: messages.length,
      toolCount: tools.length,
      systemPromptLength,
      maxTokens: claudeRequest.max_tokens,
    });

    // Debug logging
    if (getLogLevel() === "debug") {
      const lastUserMsg = messages.filter((m: any) => m.role === "user").pop();
      if (lastUserMsg) {
        const content =
          typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg.content);
        log(`[OpenAI] Last user message: ${truncateContent(content, 500)}`);
      }
      if (tools.length > 0) {
        const toolNames = tools.map((t: any) => t.function?.name || t.name).join(", ");
        log(`[OpenAI] Tools: ${toolNames}`);
      }
    }

    // Build request payload - use Responses API format for Codex models
    const isCodex = this.isCodexModel();
    const apiPayload = isCodex
      ? this.buildResponsesPayload(claudeRequest, messages, tools)
      : this.buildOpenAIPayload(claudeRequest, messages, tools);

    // Get adapter and prepare request
    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();
    adapter.prepareRequest(apiPayload, claudeRequest);

    // Call middleware
    await this.middlewareManager.beforeRequest({
      modelId: `openai/${this.modelName}`,
      messages,
      tools,
      stream: true,
    });

    // Make API call with timeout
    const endpoint = this.getApiEndpoint();
    log(`[OpenAIHandler] Calling API: ${endpoint}`);

    // Use AbortController for timeout (30 seconds for connection + response)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(apiPayload),
        signal: controller.signal,
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      // Provide helpful error message for common issues
      if (fetchError.name === "AbortError") {
        log(`[OpenAIHandler] Request timed out after 30s`);
        return c.json(
          {
            error: {
              type: "timeout_error",
              message: "Request to OpenAI API timed out. Check your network connection to api.openai.com",
            },
          },
          504
        );
      }
      if (fetchError.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
        log(`[OpenAIHandler] Connection timeout: ${fetchError.message}`);
        return c.json(
          {
            error: {
              type: "connection_error",
              message: `Cannot connect to OpenAI API (api.openai.com). This may be due to: network/firewall blocking, VPN interference, or regional restrictions. Error: ${fetchError.cause?.code}`,
            },
          },
          503
        );
      }
      log(`[OpenAIHandler] Fetch error: ${fetchError.message}`);
      return c.json(
        {
          error: {
            type: "network_error",
            message: `Failed to connect to OpenAI API: ${fetchError.message}`,
          },
        },
        503
      );
    } finally {
      clearTimeout(timeoutId);
    }

    log(`[OpenAIHandler] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      log(`[OpenAIHandler] Error: ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
    }

    if (droppedParams.length > 0) {
      c.header("X-Dropped-Params", droppedParams.join(", "));
    }

    // Use different streaming handler for Codex (Responses API) vs Chat Completions
    if (isCodex) {
      log(`[OpenAIHandler] Using Responses API streaming handler for Codex model`);
      return this.handleResponsesStreaming(c, response, adapter, claudeRequest);
    }

    // Use the shared streaming handler for Chat Completions API
    return createStreamingResponseHandler(
      c,
      response,
      adapter,
      `openai/${this.modelName}`,
      this.middlewareManager,
      (input, output) => this.updateTokenTracking(input, output),
      claudeRequest.tools
    );
  }

  async shutdown(): Promise<void> {
    // Cleanup if needed
  }
}
