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
import { getModelPricing, type ModelPricing, type RemoteProvider } from "./shared/remote-provider-types.js";

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
    this.middlewareManager.initialize().catch(err =>
      log(`[OpenAIHandler:${modelName}] Middleware init error: ${err}`)
    );

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
   */
  private getApiEndpoint(): string {
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  /**
   * Write token tracking file
   */
  private writeTokenFile(input: number, output: number): void {
    try {
      const total = input + output;
      const leftPct = this.contextWindow > 0
        ? Math.max(0, Math.min(100, Math.round(((this.contextWindow - total) / this.contextWindow) * 100)))
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
    const cost = (inputTokens / 1_000_000) * pricing.inputCostPer1M +
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
   * Build the OpenAI API request payload
   */
  private buildOpenAIPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelName,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      max_tokens: claudeRequest.max_tokens,
      stream_options: { include_usage: true },
    };

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
      log(`[OpenAIHandler] Mapped thinking.budget_tokens ${budget_tokens} -> reasoning_effort: ${effort}`);
    }

    return payload;
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
    const systemPromptLength = typeof claudeRequest.system === "string" ? claudeRequest.system.length : 0;
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
        const content = typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg.content);
        log(`[OpenAI] Last user message: ${truncateContent(content, 500)}`);
      }
      if (tools.length > 0) {
        const toolNames = tools.map((t: any) => t.function?.name || t.name).join(", ");
        log(`[OpenAI] Tools: ${toolNames}`);
      }
    }

    // Build OpenAI request
    const openAIPayload = this.buildOpenAIPayload(claudeRequest, messages, tools);

    // Get adapter and prepare request
    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();
    adapter.prepareRequest(openAIPayload, claudeRequest);

    // Call middleware
    await this.middlewareManager.beforeRequest({
      modelId: `openai/${this.modelName}`,
      messages,
      tools,
      stream: true,
    });

    // Make API call
    const endpoint = this.getApiEndpoint();
    log(`[OpenAIHandler] Calling API: ${endpoint}`);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(openAIPayload),
    });

    log(`[OpenAIHandler] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      log(`[OpenAIHandler] Error: ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
    }

    if (droppedParams.length > 0) {
      c.header("X-Dropped-Params", droppedParams.join(", "));
    }

    // Use the shared streaming handler since OpenAI uses the same format
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
