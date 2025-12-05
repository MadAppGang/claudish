import { log } from "../logger";
import { type AdapterResult, BaseModelAdapter } from "./base-adapter";

export class QwenAdapter extends BaseModelAdapter {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    // Qwen models return standard content
    // However, some newer models might wrap thinking in <think> tags which we might want to handle
    // For now, we pass through as is, similar to OpenAI
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

      // Qwen specific parameters
      request.enable_thinking = true;
      request.thinking_budget = budget_tokens;

      log(
        `[QwenAdapter] Mapped budget ${budget_tokens} -> enable_thinking: true, thinking_budget: ${budget_tokens}`
      );

      // Cleanup: Remove raw thinking object
      request.thinking = undefined;
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.includes("qwen") || modelId.includes("alibaba");
  }

  getName(): string {
    return "QwenAdapter";
  }
}
