/**
 * Gemini adapter for extracting thought signatures from reasoning_details
 *
 * OpenRouter translates Gemini's responses to OpenAI format but puts
 * thought_signatures in the reasoning_details array instead of tool_calls.extra_content.
 *
 * Streaming response structure from OpenRouter:
 * {
 *   "choices": [{
 *     "delta": {
 *       "tool_calls": [{...}],  // No extra_content here
 *       "reasoning_details": [{  // Thought signatures are HERE
 *         "id": "tool_123",
 *         "type": "reasoning.encrypted",
 *         "data": "<encrypted-signature>"
 *       }]
 *     }
 *   }]
 * }
 *
 * This adapter extracts signatures from reasoning_details and stores them
 * for later inclusion in tool results.
 */

import { log } from "../logger";
import { type AdapterResult, BaseModelAdapter } from "./base-adapter";

export class GeminiAdapter extends BaseModelAdapter {
  // Store for thought signatures: tool_call_id -> signature
  private thoughtSignatures = new Map<string, string>();

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    // Gemini doesn't use special text formats like Grok's XML
    // This adapter is primarily for reasoning_details extraction
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
    if (originalRequest.thinking) {
      const { budget_tokens } = originalRequest.thinking;
      const modelId = this.modelId || "";

      if (modelId.includes("gemini-3")) {
        // Gemini 3 uses thinking_level
        const level = budget_tokens >= 16000 ? "high" : "low";
        request.thinking_level = level;
        log(`[GeminiAdapter] Mapped budget ${budget_tokens} -> thinking_level: ${level}`);
      } else {
        // Default to Gemini 2.5 thinking_config (also covers 2.0-flash-thinking)
        // Cap budget at max allowed (24k) to prevent errors
        const MAX_GEMINI_BUDGET = 24576;
        const budget = Math.min(budget_tokens, MAX_GEMINI_BUDGET);

        request.thinking_config = {
          thinking_budget: budget,
        };
        log(
          `[GeminiAdapter] Mapped budget ${budget_tokens} -> thinking_config.thinking_budget: ${budget}`
        );
      }

      // Cleanup: Remove raw thinking object
      request.thinking = undefined;
    }
    return request;
  }

  /**
   * Extract thought signatures from reasoning_details
   * This should be called when processing streaming chunks
   */
  extractThoughtSignaturesFromReasoningDetails(
    reasoningDetails: any[] | undefined
  ): Map<string, string> {
    const extracted = new Map<string, string>();

    if (!reasoningDetails || !Array.isArray(reasoningDetails)) {
      return extracted;
    }

    for (const detail of reasoningDetails) {
      if (detail && detail.type === "reasoning.encrypted" && detail.id && detail.data) {
        this.thoughtSignatures.set(detail.id, detail.data);
        extracted.set(detail.id, detail.data);
      }
    }

    return extracted;
  }

  /**
   * Get a thought signature for a specific tool call ID
   */
  getThoughtSignature(toolCallId: string): string | undefined {
    return this.thoughtSignatures.get(toolCallId);
  }

  /**
   * Check if we have a thought signature for a tool call
   */
  hasThoughtSignature(toolCallId: string): boolean {
    return this.thoughtSignatures.has(toolCallId);
  }

  /**
   * Get all stored thought signatures
   */
  getAllThoughtSignatures(): Map<string, string> {
    return new Map(this.thoughtSignatures);
  }

  /**
   * Clear stored signatures (call between requests)
   */
  reset(): void {
    this.thoughtSignatures.clear();
  }

  shouldHandle(modelId: string): boolean {
    return modelId.includes("gemini") || modelId.includes("google/");
  }

  getName(): string {
    return "GeminiAdapter";
  }
}
