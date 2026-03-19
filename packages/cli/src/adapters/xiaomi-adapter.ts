/**
 * Xiaomi (MiMo) Model Adapter
 *
 * Handles Xiaomi-specific quirks:
 * - 64-char tool name limit (OpenAI standard, strictly enforced by Xiaomi API)
 * - Strips unsupported thinking params
 * - Context window comes dynamically from OpenRouter model catalog
 */

import { BaseModelAdapter, AdapterResult, matchesModelFamily } from "./base-adapter";
import { log } from "../logger";

export class XiaomiAdapter extends BaseModelAdapter {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override getToolNameLimit(): number | null {
    return 64;
  }

  override prepareRequest(request: any, originalRequest: any): any {
    // Xiaomi doesn't support thinking params
    if (originalRequest.thinking) {
      log(`[XiaomiAdapter] Stripping thinking object (not supported by Xiaomi API)`);
      delete request.thinking;
    }

    // Truncate tool names to 64 chars
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "xiaomi") || matchesModelFamily(modelId, "mimo");
  }

  getName(): string {
    return "XiaomiAdapter";
  }
}
