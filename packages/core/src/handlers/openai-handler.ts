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
   */
  private updateTokenTracking(inputTokens: number, outputTokens: number): void {
    this.sessionInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;

    const pricing = this.getPricing();
    const cost =
      (inputTokens / 1_000_000) * pricing.inputCostPer1M +
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
   * - User messages: type "text" -> "input_text"
   * - Assistant messages: type "text" -> "output_text"
   * - Images: type "image_url" -> "input_image"
   * - System messages are filtered out (go to instructions field)
   */
  private convertMessagesToResponsesAPI(messages: any[]): any[] {
    return messages
      .filter((msg) => msg.role !== "system") // System messages go to instructions
      .map((msg) => {
        // Handle tool role messages
        if (msg.role === "tool") {
          return {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[Tool Result for ${msg.tool_call_id}]: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`,
              },
            ],
          };
        }

        // Handle assistant messages with tool_calls
        if (msg.role === "assistant" && msg.tool_calls) {
          const content: any[] = [];

          // Add any text content first
          if (msg.content) {
            const textContent =
              typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            if (textContent) {
              content.push({ type: "output_text", text: textContent });
            }
          }

          // Add function calls
          for (const toolCall of msg.tool_calls) {
            if (toolCall.type === "function") {
              content.push({
                type: "function_call",
                id: toolCall.id,
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              });
            }
          }

          return { role: "assistant", content };
        }

        // Handle string content (simple messages)
        if (typeof msg.content === "string") {
          return {
            role: msg.role,
            content: [
              {
                type: msg.role === "user" ? "input_text" : "output_text",
                text: msg.content,
              },
            ],
          };
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

            // Convert image blocks
            if (block.type === "image_url") {
              return {
                type: "input_image",
                image_url: block.image_url,
              };
            }

            // Keep other types as-is
            return block;
          });

          return {
            role: msg.role,
            content: convertedContent,
          };
        }

        // Fallback for any other format
        return msg;
      });
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
    let contentIndex = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = new ReadableStream({
      start: async (controller) => {
        // Send initial message_start event
        const messageStart = {
          type: "message_start",
          message: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [],
            model: this.modelName,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`));

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

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

                // Handle different Responses API events
                if (event.type === "response.output_text.delta") {
                  // Convert to Claude content_block_delta
                  if (contentIndex === 0) {
                    // Send content_block_start first
                    const blockStart = {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "text", text: "" },
                    };
                    controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`));
                    contentIndex = 1;
                  }

                  const delta = {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: event.delta || "" },
                  };
                  controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`));
                } else if (event.type === "response.completed") {
                  // Extract usage from completed event
                  if (event.response?.usage) {
                    inputTokens = event.response.usage.input_tokens || 0;
                    outputTokens = event.response.usage.output_tokens || 0;
                  }
                } else if (event.type === "response.function_call_arguments.delta") {
                  // Handle tool call streaming
                  // TODO: Implement tool call conversion
                }
              } catch (parseError) {
                log(`[OpenAIHandler] Error parsing Responses event: ${parseError}`);
              }
            }
          }

          // Send content_block_stop
          if (contentIndex > 0) {
            const blockStop = { type: "content_block_stop", index: 0 };
            controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`));
          }

          // Send message_delta with usage
          const messageDelta = {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens },
          };
          controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`));

          // Send message_stop
          const messageStop = { type: "message_stop" };
          controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`));

          // Update token tracking
          this.updateTokenTracking(inputTokens, outputTokens);

          controller.close();
        } catch (error) {
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
