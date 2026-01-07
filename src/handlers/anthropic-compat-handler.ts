/**
 * Anthropic-Compatible API Handler
 *
 * Handles direct communication with providers that use Anthropic-compatible APIs
 * (MiniMax, Kimi/Moonshot, etc.)
 *
 * These providers accept the same request/response format as Anthropic's API,
 * so we can pass through requests with minimal transformation.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { log, logStructured } from "../logger.js";
import {
  type ModelPricing,
  type RemoteProvider,
  getModelPricing,
} from "./shared/remote-provider-types.js";
import type { ModelHandler } from "./types.js";

/**
 * Handler for Anthropic-compatible APIs
 *
 * Uses the native Anthropic message format, so requests are passed through
 * with minimal modification (just updating the endpoint and API key).
 */
export class AnthropicCompatHandler implements ModelHandler {
  private provider: RemoteProvider;
  private modelName: string;
  private apiKey: string;
  private port: number;
  private sessionTotalCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private contextWindow = 128000; // Default context window

  constructor(provider: RemoteProvider, modelName: string, apiKey: string, port: number) {
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.port = port;

    // Set context window based on provider
    this.setContextWindow();
  }

  /**
   * Set context window based on provider/model
   */
  private setContextWindow(): void {
    const provider = this.provider.name.toLowerCase();
    const model = this.modelName.toLowerCase();

    if (provider === "kimi" || provider === "moonshot") {
      this.contextWindow = 128000; // Kimi has 128k context
    } else if (provider === "minimax") {
      this.contextWindow = 100000; // MiniMax context window
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
      log(`[AnthropicCompatHandler] Error writing token file: ${e}`);
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
   * Main request handler
   */
  async handle(c: Context, payload: any): Promise<Response> {
    // Log request summary
    const systemPromptLength = typeof payload.system === "string" ? payload.system.length : 0;
    logStructured(`${this.provider.name} Request`, {
      targetModel: `${this.provider.name}/${this.modelName}`,
      originalModel: payload.model,
      messageCount: payload.messages?.length || 0,
      toolCount: payload.tools?.length || 0,
      systemPromptLength,
      maxTokens: payload.max_tokens,
    });

    // Update model in payload to match the target model name
    const requestPayload = {
      ...payload,
      model: this.modelName,
    };

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };

    // Add any provider-specific headers
    if (this.provider.headers) {
      Object.assign(headers, this.provider.headers);
    }

    // Make API call
    const endpoint = this.getApiEndpoint();
    log(`[${this.provider.name}] Calling API: ${endpoint}`);

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestPayload),
    });

    log(`[${this.provider.name}] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      log(`[${this.provider.name}] Error: ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
    }

    // Handle streaming response
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return this.handleStreamingResponse(c, response);
    }
    // Non-streaming response (rare)
    const data = await response.json();
    return c.json(data);
  }

  /**
   * Handle streaming response
   */
  private handleStreamingResponse(c: Context, response: Response): Response {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    return c.body(
      new ReadableStream({
        start: async (controller) => {
          const reader = response.body?.getReader();
          if (!reader) {
            controller.close();
            return;
          }

          let buffer = "";
          let hasUsage = false;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              // Pass through the chunk
              controller.enqueue(value);

              // Parse for usage tracking
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim() || !line.startsWith("data: ")) continue;
                const dataStr = line.slice(6);
                if (dataStr === "[DONE]") continue;

                try {
                  const chunk = JSON.parse(dataStr);

                  // Extract usage from message_delta event
                  if (chunk.type === "message_delta" && chunk.usage && !hasUsage) {
                    const { input_tokens = 0, output_tokens = 0 } = chunk.usage;
                    if (input_tokens > 0 || output_tokens > 0) {
                      this.updateTokenTracking(input_tokens, output_tokens);
                      hasUsage = true;
                    }
                  }

                  // Extract usage from message_stop event
                  if (chunk.type === "message_stop" && chunk.message?.usage && !hasUsage) {
                    const { input_tokens = 0, output_tokens = 0 } = chunk.message.usage;
                    if (input_tokens > 0 || output_tokens > 0) {
                      this.updateTokenTracking(input_tokens, output_tokens);
                      hasUsage = true;
                    }
                  }
                } catch (e) {
                  // Ignore parse errors
                }
              }
            }

            controller.close();
          } catch (e) {
            log(`[${this.provider.name}] Stream error: ${e}`);
            controller.close();
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

  async shutdown(): Promise<void> {
    // Cleanup if needed
  }
}
