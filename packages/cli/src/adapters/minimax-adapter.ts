import { BaseModelAdapter, AdapterResult } from "./base-adapter";
import { log } from "../logger";

export class MiniMaxAdapter extends BaseModelAdapter {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // MiniMax interleaved thinking is handled by the model
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
      // MiniMax uses reasoning_split boolean
      request.reasoning_split = true;

      log(`[MiniMaxAdapter] Enabled reasoning_split: true`);

      // Cleanup: Remove raw thinking object
      delete request.thinking;
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.includes("minimax");
  }

  getName(): string {
    return "MiniMaxAdapter";
  }
}
