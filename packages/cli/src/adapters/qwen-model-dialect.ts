/**
 * QwenModelDialect — Layer 2 dialect for Qwen (Alibaba) models.
 *
 * Handles Qwen-specific quirks:
 * - Strips special tokens from output
 * - Maps thinking → enable_thinking + thinking_budget params
 */

import { BaseAPIFormat, AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";

// Qwen special tokens that should be stripped from output
const QWEN_SPECIAL_TOKENS = [
  "<|im_start|>",
  "<|im_end|>",
  "<|endoftext|>",
  "<|end|>",
  "assistant\n", // Role marker that sometimes leaks
];

export class QwenModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // Strip Qwen special tokens that may leak through
    // This can happen when the model gets confused and outputs its chat template
    let cleanedText = textContent;
    for (const token of QWEN_SPECIAL_TOKENS) {
      cleanedText = cleanedText.replaceAll(token, "");
    }

    // Also handle partial tokens at chunk boundaries
    // e.g., "<|im_" at the end of one chunk and "start|>" at the beginning of next
    cleanedText = cleanedText.replace(/<\|[a-z_]*$/i, ""); // Partial at end
    cleanedText = cleanedText.replace(/^[a-z_]*\|>/i, ""); // Partial at start

    const wasTransformed = cleanedText !== textContent;
    if (wasTransformed && cleanedText.length === 0) {
      // Entire chunk was special tokens, skip it
      return {
        cleanedText: "",
        extractedToolCalls: [],
        wasTransformed: true,
      };
    }

    return {
      cleanedText,
      extractedToolCalls: [],
      wasTransformed,
    };
  }

  /**
   * Handle request preparation - specifically for mapping reasoning parameters
   */
  override prepareRequest(request: any, originalRequest: any): any {
    if (originalRequest.thinking) {
      const { budget_tokens } = originalRequest.thinking;

      // Qwen specific parameters
      request.enable_thinking = true;
      request.thinking_budget = budget_tokens;

      log(
        `[QwenModelDialect] Mapped budget ${budget_tokens} -> enable_thinking: true, thinking_budget: ${budget_tokens}`
      );

      // Cleanup: Remove raw thinking object
      delete request.thinking;
    }

    return request;
  }

  getName(): string {
    return "QwenModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use QwenModelDialect */
export { QwenModelDialect as QwenAdapter };
