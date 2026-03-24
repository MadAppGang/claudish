/**
 * XiaomiModelDialect — Layer 2 dialect for Xiaomi (MiMo) models.
 *
 * Handles Xiaomi-specific quirks:
 * - 64-char tool name limit (OpenAI standard, strictly enforced by Xiaomi API)
 * - Strips unsupported thinking params
 * - Context window comes dynamically from OpenRouter model catalog
 */

import { BaseAPIFormat, AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";

export class XiaomiModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override getToolNameLimit(): number | null {
    return lookupModel(this.modelId)?.toolNameLimit ?? null;
  }

  override prepareRequest(request: any, originalRequest: any): any {
    // Xiaomi doesn't support thinking params
    if (originalRequest.thinking) {
      log(`[XiaomiModelDialect] Stripping thinking object (not supported by Xiaomi API)`);
      delete request.thinking;
    }

    // Truncate tool names to 64 chars
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  getName(): string {
    return "XiaomiModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use XiaomiModelDialect */
export { XiaomiModelDialect as XiaomiAdapter };
