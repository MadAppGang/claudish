/**
 * XiaomiModelDialect — Layer 2 dialect for Xiaomi (MiMo) models.
 *
 * Handles Xiaomi-specific quirks:
 * - 64-char tool name limit (OpenAI standard, strictly enforced by Xiaomi API)
 * - Strips unsupported thinking params
 * - Context window comes dynamically from OpenRouter model catalog
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import { log } from "../logger.js";

export class XiaomiModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  // Xiaomi's wire is OpenAI-shaped, so the base wire rule already returns 64;
  // the override survives only as documentation that Xiaomi enforces it strictly.
  override getToolNameLimit(): number | null {
    return super.getToolNameLimit() ?? 64;
  }

  override prepareRequest(request: any, originalRequest: any): any {
    // Xiaomi doesn't support thinking params
    if (originalRequest.thinking) {
      log(`[XiaomiModelDialect] Stripping thinking object (not supported by Xiaomi API)`);
      delete request.thinking;
    }

    // Tool-name encoding lives in the template post-pass. (S4-b 2e18042)
    super.prepareRequest(request, originalRequest);

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "xiaomi") || matchesModelFamily(modelId, "mimo");
  }

  getName(): string {
    return "XiaomiModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use XiaomiModelDialect */
export { XiaomiModelDialect as XiaomiAdapter };
