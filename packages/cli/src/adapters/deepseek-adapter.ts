import { BaseModelAdapter, AdapterResult } from "./base-adapter";
import { log } from "../logger";

export class DeepSeekAdapter extends BaseModelAdapter {
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

      log(`[DeepSeekAdapter] Stripping thinking object (not supported by API)`);

      // Cleanup: Remove raw thinking object
      delete request.thinking;
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.includes("deepseek");
  }

  getName(): string {
    return "DeepSeekAdapter";
  }
}
