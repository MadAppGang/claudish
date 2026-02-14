/**
 * LiteLLM Handler
 *
 * Handles communication with LiteLLM proxy instances.
 * LiteLLM uses OpenAI-compatible API format, so we extend RemoteProviderHandler
 * with LiteLLM-specific configuration.
 *
 * LiteLLM proxies provide:
 * - Unified interface to 100+ LLM providers
 * - Load balancing, fallbacks, and budget controls
 * - OpenAI-compatible /v1/chat/completions endpoint
 */

import { RemoteProviderHandler } from "./shared/remote-provider-handler.js";
import type { RemoteProviderConfig, ModelPricing } from "./shared/remote-provider-types.js";

/**
 * LiteLLM Handler
 *
 * Uses LiteLLM's OpenAI-compatible API with dynamic base URL configuration.
 * The base URL and API key are provided at runtime via CLI flags or environment variables.
 */
export class LiteLLMHandler extends RemoteProviderHandler {
  private baseUrl: string;

  constructor(
    targetModel: string,
    modelName: string,
    apiKey: string,
    port: number,
    baseUrl: string
  ) {
    super(targetModel, modelName, apiKey, port);
    this.baseUrl = baseUrl;
  }

  /**
   * Get provider configuration for LiteLLM
   */
  protected getProviderConfig(): RemoteProviderConfig {
    return {
      name: "litellm",
      baseUrl: this.baseUrl,
      apiPath: "/v1/chat/completions",
      apiKeyEnvVar: "LITELLM_API_KEY",
    };
  }

  /**
   * Get pricing for the current model
   * LiteLLM pricing should ideally come from model discovery API,
   * but we default to reasonable estimates for now.
   */
  protected getPricing(): ModelPricing {
    // TODO: Look up per-model pricing from cached LiteLLM model_hub data
    // For now, use reasonable default estimates. Real pricing is shown in --models selector.
    return {
      inputCostPer1M: 1.0,
      outputCostPer1M: 4.0,
      isEstimate: true,
    };
  }

  /**
   * Get provider display name for status line
   */
  protected getProviderName(): string {
    return "LiteLLM";
  }

  /**
   * Build the API request payload for LiteLLM
   * LiteLLM uses standard OpenAI format
   */
  protected buildRequestPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelName,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: claudeRequest.max_tokens,
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

    return payload;
  }
}
