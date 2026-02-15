/**
 * Abstract base class for remote API providers
 *
 * Provides common functionality for streaming, token tracking, and cost calculation
 * that is shared by OpenRouter, Gemini, and OpenAI handlers.
 */

import type { Context } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelHandler } from "../types.js";
import { AdapterManager } from "../../adapters/adapter-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../../middleware/index.js";
import { transformOpenAIToClaude } from "../../transform.js";
import { log, logStructured, getLogLevel, truncateContent } from "../../logger.js";
import {
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  createStreamingResponseHandler,
  filterIdentity,
} from "./openai-compat.js";
import type { RemoteProviderConfig, ModelPricing } from "./remote-provider-types.js";

/**
 * Abstract base class for remote API providers
 *
 * Subclasses must implement:
 * - getProviderConfig(): Provider-specific configuration
 * - getPricing(modelName): Pricing for the model
 * - buildRequestPayload(claudeRequest, messages, tools): Build API-specific request
 * - makeApiCall(payload): Make the actual API call
 *
 * Optionally override:
 * - handleStreamingResponse(): Custom streaming logic (default uses OpenAI-compatible format)
 * - convertMessages(): Custom message conversion
 * - convertTools(): Custom tool conversion
 */
export abstract class RemoteProviderHandler implements ModelHandler {
  protected targetModel: string;
  protected modelName: string;
  protected apiKey: string;
  protected adapterManager: AdapterManager;
  protected middlewareManager: MiddlewareManager;
  protected port: number;
  protected sessionTotalCost = 0;
  protected sessionInputTokens = 0;
  protected sessionOutputTokens = 0;
  protected contextWindow = 200000; // Default, can be updated by subclass
  protected CLAUDE_INTERNAL_CONTEXT_MAX = 200000;

  constructor(targetModel: string, modelName: string, apiKey: string, port: number) {
    this.targetModel = targetModel;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.port = port;
    this.adapterManager = new AdapterManager(targetModel);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[Handler:${targetModel}] Middleware init error: ${err}`));
  }

  /**
   * Get provider-specific configuration
   */
  protected abstract getProviderConfig(): RemoteProviderConfig;

  /**
   * Get pricing for the current model
   */
  protected abstract getPricing(): ModelPricing;

  /**
   * Get provider display name for status line
   */
  protected abstract getProviderName(): string;

  /**
   * Build the API request payload
   * @param claudeRequest - Transformed Claude request
   * @param messages - Converted messages
   * @param tools - Converted tools
   */
  protected abstract buildRequestPayload(claudeRequest: any, messages: any[], tools: any[]): any;

  /**
   * Get additional request headers (beyond Authorization)
   */
  protected getAdditionalHeaders(): Record<string, string> {
    return {};
  }

  /**
   * Get the API endpoint URL
   */
  protected getApiEndpoint(): string {
    const config = this.getProviderConfig();
    return `${config.baseUrl}${config.apiPath}`;
  }

  /**
   * Check if the model supports reasoning/thinking
   */
  protected supportsReasoning(): boolean {
    return false; // Subclasses can override
  }

  /**
   * Write token tracking file for status line display
   */
  protected writeTokenFile(input: number, output: number): void {
    try {
      const total = input + output;
      const leftPct =
        this.contextWindow > 0
          ? Math.max(
              0,
              Math.min(100, Math.round(((this.contextWindow - total) / this.contextWindow) * 100))
            )
          : 100;

      const pricing = this.getPricing();
      const data = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: this.contextWindow,
        context_left_percent: leftPct,
        is_free: pricing.isFree || false,
        is_estimated: pricing.isEstimate || false,
        provider_name: this.getProviderName(),
        model_name: this.modelName,
        updated_at: Date.now(),
      };

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[Handler] Error writing token file: ${e}`);
    }
  }

  /**
   * Update token counts and cost tracking
   */
  protected updateTokenTracking(inputTokens: number, outputTokens: number): void {
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
   * Check if the current model supports vision/image input.
   * Subclasses can override for model-specific checks.
   */
  protected supportsVision(): boolean {
    return true; // Default: assume vision is supported
  }

  /**
   * Convert Claude messages to provider format (default: OpenAI format)
   * Strips image content for models that don't support vision.
   */
  protected convertMessages(claudeRequest: any): any[] {
    const messages = convertMessagesToOpenAI(claudeRequest, this.targetModel, filterIdentity);

    // Strip image content for models that don't support vision
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
   * Convert Claude tools to provider format (default: OpenAI format)
   */
  protected convertTools(claudeRequest: any): any[] {
    return convertToolsToOpenAI(claudeRequest);
  }

  /**
   * Handle streaming response (default: OpenAI-compatible SSE format)
   * Subclasses with different streaming formats should override this.
   */
  protected handleStreamingResponse(
    c: Context,
    response: Response,
    adapter: any,
    claudeRequest: any,
    toolNameMap?: Map<string, string>
  ): Response {
    return createStreamingResponseHandler(
      c,
      response,
      adapter,
      this.targetModel,
      this.middlewareManager,
      (input, output) => this.updateTokenTracking(input, output),
      claudeRequest.tools,
      toolNameMap
    );
  }

  /**
   * Main request handler
   */
  async handle(c: Context, payload: any): Promise<Response> {
    const config = this.getProviderConfig();

    // Transform Claude request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

    // Convert messages and tools
    const messages = this.convertMessages(claudeRequest);
    const tools = this.convertTools(claudeRequest);

    // Log request summary
    const systemPromptLength =
      typeof claudeRequest.system === "string" ? claudeRequest.system.length : 0;
    logStructured(`${config.name} Request`, {
      targetModel: this.targetModel,
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
        log(`[${config.name}] Last user message: ${truncateContent(content, 500)}`);
      }
      if (tools.length > 0) {
        const toolNames = tools.map((t: any) => t.function?.name || t.name).join(", ");
        log(`[${config.name}] Tools: ${toolNames}`);
      }
    }

    // Build request payload
    const requestPayload = this.buildRequestPayload(claudeRequest, messages, tools);

    // Get adapter and prepare request (adapter truncates tool names if needed)
    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();
    adapter.prepareRequest(requestPayload, claudeRequest);

    // Get tool name map from adapter (populated during prepareRequest)
    const toolNameMap = adapter.getToolNameMap();

    // Call middleware
    await this.middlewareManager.beforeRequest({
      modelId: this.targetModel,
      messages,
      tools,
      stream: true,
    });

    // Make API call
    const endpoint = this.getApiEndpoint();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.getAdditionalHeaders(),
    };

    log(`[${config.name}] Calling API: ${endpoint}`);
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestPayload),
    });

    log(`[${config.name}] Response status: ${response.status}`);
    if (!response.ok) {
      const errorText = await response.text();
      log(`[${config.name}] Error: ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
    }

    if (droppedParams.length > 0) {
      c.header("X-Dropped-Params", droppedParams.join(", "));
    }

    // Handle streaming response
    return this.handleStreamingResponse(c, response, adapter, claudeRequest, toolNameMap);
  }

  /**
   * Cleanup handler
   */
  async shutdown(): Promise<void> {
    // Subclasses can override for cleanup
  }
}
