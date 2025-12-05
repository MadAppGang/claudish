/**
 * OpenAI adapter for handling model-specific behaviors
 *
 * Handles:
 * - Mapping 'thinking.budget_tokens' to 'reasoning_effort' for o1/o3 models
 */

import { log } from "../logger.js";
import { type AdapterResult, BaseModelAdapter } from "./base-adapter.js";

export class OpenAIAdapter extends BaseModelAdapter {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    // OpenAI models return standard content, no XML parsing needed for tool calls
    // (OpenRouter handles standard tool_calls mapping for us)
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Handle request preparation - specifically for mapping reasoning parameters
   */
  override prepareRequest(request: any, originalRequest: any): any {
    // Handle mapping of 'thinking' parameter from Claude (budget_tokens) to reasoning_effort
    if (originalRequest.thinking) {
      const { budget_tokens } = originalRequest.thinking;

      // Logic for mapping budget to effort
      // < 4000: minimal
      // 4000 - 15999: low
      // 16000 - 31999: medium
      // >= 32000: high
      let effort = "medium";

      if (budget_tokens < 4000) effort = "minimal";
      else if (budget_tokens < 16000) effort = "low";
      else if (budget_tokens >= 32000) effort = "high";

      // Special case: GPT-5-codex might not support minimal (per notes), but we'll try to follow budget
      // The API should degrade gracefully if minimal isn't supported, or we could add a model check here

      request.reasoning_effort = effort;

      // Cleanup: Remove raw thinking object as we've translated it
      // This prevents OpenRouter from having both params if it decides to pass thinking through
      request.thinking = undefined;

      log(`[OpenAIAdapter] Mapped budget ${budget_tokens} -> reasoning_effort: ${effort}`);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    // Handle explicit OpenAI models or OpenRouter prefixes for OpenAI reasoning models
    // Checking for o1/o3 specifically as they are the current reasoning models
    return modelId.startsWith("openai/") || modelId.includes("o1") || modelId.includes("o3");
  }

  getName(): string {
    return "OpenAIAdapter";
  }
}
