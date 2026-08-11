/**
 * DeepSeekModelDialect — Layer 2 dialect for DeepSeek models.
 *
 * Handles DeepSeek-specific quirks:
 * - Strips unsupported thinking params (DeepSeek thinks automatically)
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import { log } from "../logger.js";

export class DeepSeekModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Handle request preparation - specifically for stripping unsupported parameters
   */
  override prepareRequest(request: any, originalRequest: any): any {
    if (originalRequest.thinking) {
      // DeepSeek doesn't support thinking params via API options
      // It thinks automatically or via other means (R1)
      // Stripping thinking object to prevent API errors

      log(`[DeepSeekModelDialect] Stripping thinking object (not supported by API)`);

      // Cleanup: Remove raw thinking object
      delete request.thinking;
    }

    return request;
  }

  /**
   * DeepSeek thinks automatically and REQUIRES reasoning_content to be echoed
   * back on every assistant turn that produced reasoning. Stripping the thinking
   * block from history makes the OpenAI-format converter omit reasoning_content,
   * which DeepSeek rejects with HTTP 400 "The reasoning_content in the thinking
   * mode must be passed back to the API". Preserve the block so the converter
   * can round-trip it.
   */
  override preserveThinkingInHistory(): boolean {
    return true;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "deepseek");
  }

  getName(): string {
    return "DeepSeekModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use DeepSeekModelDialect */
export { DeepSeekModelDialect as DeepSeekAdapter };
