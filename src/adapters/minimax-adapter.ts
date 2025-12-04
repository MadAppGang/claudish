import { log } from "../logger";
import { type AdapterResult, BaseModelAdapter } from "./base-adapter";

export class MiniMaxAdapter extends BaseModelAdapter {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
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

      log("[MiniMaxAdapter] Enabled reasoning_split: true");

      // Cleanup: Remove raw thinking object
      request.thinking = undefined;
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
