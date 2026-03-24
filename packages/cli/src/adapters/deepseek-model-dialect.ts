/**
 * DeepSeekModelDialect — Layer 2 dialect for DeepSeek models.
 *
 * Handles DeepSeek-specific quirks:
 * - Strips unsupported thinking params (DeepSeek thinks automatically)
 */

import { BaseModelDialect } from "./base-model-dialect.js";
import type { AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";

export class DeepSeekModelDialect extends BaseModelDialect {
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

  getName(): string {
    return "DeepSeekModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use DeepSeekModelDialect */
export { DeepSeekModelDialect as DeepSeekAdapter };
