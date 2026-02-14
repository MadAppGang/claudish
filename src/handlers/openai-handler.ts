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

    // xAI Grok models (context windows from xAI docs/OpenRouter)
    if (model.includes("grok-4.1-fast") || model.includes("grok-4-1-fast")) {
      this.contextWindow = 2000000; // 2M context
    } else if (model.includes("grok-4-fast")) {
      this.contextWindow = 2000000; // 2M context
    } else if (model.includes("grok-code-fast")) {
      this.contextWindow = 256000; // 256K context
    } else if (model.includes("grok-4")) {
      this.contextWindow = 256000; // 256K context
    } else if (model.includes("grok-3")) {
      this.contextWindow = 131072; // 131K context
    } else if (model.includes("grok-2")) {
      this.contextWindow = 131072; // 131K context
    } else if (model.includes("grok")) {
      this.contextWindow = 131072; // Default for other grok models
    }
    // Kimi models (from OpenCode Zen / models.dev)
    else if (model.includes("kimi-k2.5") || model.includes("kimi-k2-5")) {
      this.contextWindow = 262144; // 256K context (from models.dev)
    } else if (model.includes("kimi-k2")) {
      this.contextWindow = 262144; // 256K context
    } else if (model.includes("kimi")) {
      this.contextWindow = 131072; // 128K default for older kimi
    }
    // GLM/Zhipu models (context windows from models.dev)
    else if (model.includes("glm-5")) {
      this.contextWindow = 204800; // 200K context
    } else if (model.includes("glm-4.7-flash")) {
      this.contextWindow = 200000; // ~195K context
    } else if (model.includes("glm-4.7")) {
      this.contextWindow = 204800; // 200K context
    } else if (model.includes("glm-4.6v")) {
      this.contextWindow = 128000; // 128K context
    } else if (model.includes("glm-4.6")) {
      this.contextWindow = 204800; // 200K context
    } else if (model.includes("glm-4.5v")) {
      this.contextWindow = 64000; // 64K context
    } else if (model.includes("glm-4.5-flash")) {
      this.contextWindow = 131072; // 128K context
    } else if (model.includes("glm-4.5-air")) {
      this.contextWindow = 131072; // 128K context
    } else if (model.includes("glm-4.5")) {
      this.contextWindow = 131072; // 128K context
    } else if (model.includes("glm-")) {
      this.contextWindow = 131072; // Default for other GLM models
    }
    // OpenAI models
    else if (model.includes("gpt-4o") || model.includes("gpt-4-turbo")) {
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
    return getModelPricing(this.provider.name, this.modelName);
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
  private writeTokenFile(input: number, output: number, isEstimate?: boolean): void {
    try {
      const total = input + output;
      const leftPct =
        this.contextWindow > 0
          ? Math.max(
              0,
              Math.min(100, Math.round(((this.contextWindow - total) / this.contextWindow) * 100))
            )
          : 100;

      // Format provider name for display (opencode-zen -> Zen, openai -> OpenAI, glm -> GLM)
      const formatProviderName = (name: string): string => {
        if (name === "opencode-zen") return "Zen";
        if (name === "glm") return "GLM";
        if (name === "openai") return "OpenAI";
        return name.charAt(0).toUpperCase() + name.slice(1);
      };

      // Check if this is a free model
      const pricing = this.getPricing();
      const isFreeModel =
        pricing.isFree || (pricing.inputCostPer1M === 0 && pricing.outputCostPer1M === 0);

      const data: Record<string, any> = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: this.contextWindow,
        context_left_percent: leftPct,
        provider_name: formatProviderName(this.provider.name),
        updated_at: Date.now(),
        is_free: isFreeModel,
        is_estimated: isEstimate || false,
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
   *
   * RACE CONDITION HANDLING:
   * When multiple concurrent conversations share this handler, they can corrupt
   * the sessionInputTokens state. We detect this by checking if input tokens
   * decreased significantly (sign of a different conversation). In that case,
   * we only update sessionInputTokens if the new value is higher (to track the
   * main conversation with the largest context).
   */
  private updateTokenTracking(inputTokens: number, outputTokens: number): void {
    // Calculate incremental input tokens with race condition detection
    let incrementalInputTokens: number;

    if (inputTokens >= this.sessionInputTokens) {
      // Normal case: context grew or stayed same (continuation of conversation)
      incrementalInputTokens = inputTokens - this.sessionInputTokens;
      this.sessionInputTokens = inputTokens;
    } else if (inputTokens < this.sessionInputTokens * 0.5) {
      // Different conversation with much smaller context - charge full amount for it
      // but DON'T update sessionInputTokens (keep tracking the larger conversation)
      incrementalInputTokens = inputTokens;
      log(
        `[OpenAIHandler] Token tracking: detected concurrent conversation (${inputTokens} < ${this.sessionInputTokens}), charging full input`
      );
    } else {
      // Ambiguous case: tokens decreased but not by much - could be noise or small conversation
      // Use conservative approach: charge full amount and update tracking
      incrementalInputTokens = inputTokens;
      this.sessionInputTokens = inputTokens;
      log(
        `[OpenAIHandler] Token tracking: ambiguous token decrease (${inputTokens} vs ${this.sessionInputTokens}), charging full input`
      );
    }

    // Update session totals
    this.sessionOutputTokens += outputTokens;

    // Calculate cost
    const pricing = this.getPricing();
    const cost =
      (incrementalInputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M;
    this.sessionTotalCost += cost;

    this.writeTokenFile(
      Math.max(inputTokens, this.sessionInputTokens),
      this.sessionOutputTokens,
      pricing.isEstimate
    );
  }

  /**
   * Check if the current model supports vision/image input
   * Provider-level flag is checked first, then model-level detection for GLM
   * (GLM only supports images on "V" variants like glm-4.6v, glm-4.5v)
   */
  private supportsVision(): boolean {
    // Provider-level: if provider says no vision, respect it
    if (this.provider.capabilities && !this.provider.capabilities.supportsVision) {
      return false;
    }

    // Model-level: GLM models only support vision on "V" variants
    const model = this.modelName.toLowerCase();
    if (model.startsWith("glm-") && !/\d+\.?\d*v/.test(model)) {
      return false;
    }

    return true;
  }

  /**
   * Convert Claude messages to OpenAI format
   */
  private convertMessages(claudeRequest: any): any[] {
    // OllamaCloud expects string content, not arrays
    const useSimpleFormat = this.provider.name === "ollamacloud";
    const messages = convertMessagesToOpenAI(
      claudeRequest,
      `openai/${this.modelName}`,
      filterIdentity,
      useSimpleFormat
    );

    // Strip image content for models/providers that don't support vision
    if (!this.supportsVision()) {
      for (const msg of messages) {
        if (Array.isArray(msg.content)) {
          msg.content = msg.content.filter((part: any) => part.type !== "image_url");
          if (msg.content.length === 1 && msg.content[0].type === "text") {
            msg.content = msg.content[0].text;
          } else if (msg.content.length === 0) {
            msg.content = "";
          }
        }
      }
    }

    return messages;
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
          output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
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

    // Add max_output_tokens for Responses API (minimum 16 required)
    if (claudeRequest.max_tokens) {
      payload.max_output_tokens = Math.max(16, claudeRequest.max_tokens);
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
    _claudeRequest: any,
    toolNameMap?: Map<string, string>
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
    const functionCalls: Map<
      string,
      { name: string; arguments: string; index: number; claudeId?: string }
    > = new Map();

    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: string, data: any) => {
          if (!isClosed) {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            );
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
                  // Log the item type for debugging
                  if (getLogLevel() === "debug" && event.item?.type) {
                    log(
                      `[OpenAIHandler] Output item added: type=${event.item.type}, id=${event.item.id || event.item.call_id || "unknown"}`
                    );
                  }

                  // Handle function_call items
                  if (event.item?.type === "function_call") {
                    // OpenAI uses two IDs:
                    // - item.id: the fc_... ID used in argument deltas (item_id)
                    // - item.call_id: the call_... ID used in tool results
                    const itemId = event.item.id; // fc_...
                    const openaiCallId = event.item.call_id || itemId;
                    // Transform to Claude-style ID (toolu_...) for compatibility
                    const callId = openaiCallId.startsWith("toolu_")
                      ? openaiCallId
                      : `toolu_${openaiCallId.replace(/^fc_/, "")}`;
                    const rawFnName = event.item.name || "";
                    const fnName = toolNameMap?.get(rawFnName) || rawFnName;
                    const fnIndex = blockIndex + functionCalls.size + (hasTextContent ? 1 : 0);

                    log(
                      `[OpenAIHandler] Function call: itemId=${itemId}, openaiCallId=${openaiCallId}, claudeId=${callId}, name=${fnName}, index=${fnIndex}`
                    );

                    // Create the function call data
                    const fnCallData = {
                      name: fnName,
                      arguments: "",
                      index: fnIndex,
                      claudeId: callId,
                    };

                    // Store with BOTH IDs for lookup during argument streaming
                    // Argument deltas use item_id (fc_...), while tool results use call_id (call_...)
                    functionCalls.set(openaiCallId, fnCallData);
                    if (itemId && itemId !== openaiCallId) {
                      functionCalls.set(itemId, fnCallData);
                    }

                    // Close text block if open
                    if (hasTextContent && !hasToolUse) {
                      send("content_block_stop", { type: "content_block_stop", index: blockIndex });
                      blockIndex++;
                    }

                    // Send tool_use block start with Claude-style ID
                    send("content_block_start", {
                      type: "content_block_start",
                      index: fnIndex,
                      content_block: {
                        type: "tool_use",
                        id: callId,
                        name: fnName,
                        input: {},
                      },
                    });
                    hasToolUse = true;
                  }
                  // Handle reasoning items (Codex thinking/exploration)
                  // These are displayed as thinking blocks in Claude format
                  else if (event.item?.type === "reasoning") {
                    // Reasoning items contain the model's thinking process
                    // We'll capture this via response.reasoning_summary_text.delta events
                    log(`[OpenAIHandler] Reasoning block started`);
                  }
                } else if (event.type === "response.reasoning_summary_text.delta") {
                  // Codex reasoning/thinking text - display as regular text
                  // (Claude Code doesn't display "thinking" blocks from non-Claude models)
                  if (!hasTextContent) {
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
                } else if (event.type === "response.function_call_arguments.delta") {
                  // Streaming function call arguments
                  // OpenAI uses item_id (fc_...) to identify which function call this belongs to
                  const callId = event.call_id || event.item_id;

                  // Debug: log the lookup
                  if (getLogLevel() === "debug" && !functionCalls.has(callId)) {
                    log(
                      `[OpenAIHandler] Argument delta lookup failed: callId=${callId}, stored keys=[${Array.from(functionCalls.keys()).join(", ")}]`
                    );
                  }

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
                    // Try both IDs since we stored with both
                    const callId = event.item.call_id || event.item.id;
                    const fnCall = functionCalls.get(callId) || functionCalls.get(event.item.id);
                    if (fnCall) {
                      send("content_block_stop", {
                        type: "content_block_stop",
                        index: fnCall.index,
                      });
                    }
                  }
                } else if (event.type === "response.incomplete") {
                  // Response was cut off (token limit, content filter, etc.)
                  // Log the reason and continue - we'll still send proper termination events
                  log(`[OpenAIHandler] Response incomplete: ${event.reason || "unknown reason"}`);
                  // Extract any available usage data
                  if (event.response?.usage) {
                    inputTokens = event.response.usage.input_tokens || inputTokens;
                    outputTokens = event.response.usage.output_tokens || outputTokens;
                  }
                } else if (event.type === "response.completed" || event.type === "response.done") {
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
                } else if (event.type === "error") {
                  // OpenAI Responses API error event
                  const errMsg = event.error?.message || event.message || "Unknown API error";
                  const errCode = event.error?.code || event.code || "";
                  log(`[OpenAIHandler] Responses API error: ${errCode} - ${errMsg}`);

                  // Close any open content blocks
                  if (hasTextContent) {
                    send("content_block_stop", { type: "content_block_stop", index: blockIndex });
                    hasTextContent = false;
                  }
                  for (const [, fnCall] of functionCalls) {
                    send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
                  }

                  // Send error as text so the user sees it
                  const errorIdx = blockIndex + functionCalls.size + (hasToolUse ? 1 : 0);
                  send("content_block_start", {
                    type: "content_block_start",
                    index: errorIdx,
                    content_block: { type: "text", text: "" },
                  });
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: errorIdx,
                    delta: { type: "text_delta", text: `\n\n[API Error: ${errCode} ${errMsg}]` },
                  });
                  send("content_block_stop", { type: "content_block_stop", index: errorIdx });

                  // Properly terminate the stream
                  send("message_delta", {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                  });
                  send("message_stop", { type: "message_stop" });
                  isClosed = true;
                  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
                  this.updateTokenTracking(inputTokens, outputTokens);
                  controller.close();
                  return;
                } else if (event.type === "response.failed") {
                  // Extract error details from failed response
                  const failErr = event.response?.error;
                  const failMsg = failErr?.message || "Response failed";
                  const failCode = failErr?.code || "";
                  log(`[OpenAIHandler] Response failed: ${failCode} - ${failMsg}`);
                  // Extract any available usage
                  if (event.response?.usage) {
                    inputTokens = event.response.usage.input_tokens || inputTokens;
                    outputTokens = event.response.usage.output_tokens || outputTokens;
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

          // CRITICAL: Send all final events BEFORE setting isClosed
          // The send() function checks isClosed and returns early if true

          // Send content_block_stop for text if we have text content
          if (hasTextContent) {
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

          // NOW set isClosed after all events are sent
          isClosed = true;

          // Update token tracking
          this.updateTokenTracking(inputTokens, outputTokens);

          controller.close();
        } catch (error) {
          // Clean up ping interval on error
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          log(`[OpenAIHandler] Responses streaming error: ${error}`);

          // Send proper termination events so Claude Code doesn't get stuck
          if (!isClosed) {
            try {
              // Close any open content blocks
              if (hasTextContent) {
                send("content_block_stop", { type: "content_block_stop", index: blockIndex });
              }
              for (const [, fnCall] of functionCalls) {
                send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
              }

              // Send error as visible text
              const errorIdx = blockIndex + functionCalls.size + (hasToolUse ? 1 : 0);
              send("content_block_start", {
                type: "content_block_start",
                index: errorIdx,
                content_block: { type: "text", text: "" },
              });
              send("content_block_delta", {
                type: "content_block_delta",
                index: errorIdx,
                delta: { type: "text_delta", text: `\n\n[Stream error: ${error}]` },
              });
              send("content_block_stop", { type: "content_block_stop", index: errorIdx });

              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { input_tokens: inputTokens, output_tokens: outputTokens },
              });
              send("message_stop", { type: "message_stop" });
            } catch (sendErr) {
              log(`[OpenAIHandler] Error sending termination events: ${sendErr}`);
            }

            isClosed = true;
            this.updateTokenTracking(inputTokens, outputTokens);
            try { controller.close(); } catch { /* already closed */ }
          }
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

    // Get adapter and prepare request (adapter truncates tool names if needed)
    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();
    adapter.prepareRequest(apiPayload, claudeRequest);

    // Get tool name map from adapter (populated during prepareRequest)
    const toolNameMap = adapter.getToolNameMap();

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
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
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
              message:
                "Request to OpenAI API timed out. Check your network connection to api.openai.com",
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
      return this.handleResponsesStreaming(c, response, adapter, claudeRequest, toolNameMap);
    }

    // Use the shared streaming handler for Chat Completions API
    return createStreamingResponseHandler(
      c,
      response,
      adapter,
      `openai/${this.modelName}`,
      this.middlewareManager,
      (input, output) => this.updateTokenTracking(input, output),
      claudeRequest.tools,
      toolNameMap
    );
  }

  async shutdown(): Promise<void> {
    // Cleanup if needed
  }
}
