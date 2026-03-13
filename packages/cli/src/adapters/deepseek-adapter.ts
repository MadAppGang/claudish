import { ModelAdapter } from "./model-adapter.js";
import { log } from "../logger";

export class DeepSeekAdapter extends ModelAdapter {
  /**
   * Handle request preparation:
   * - Strip unsupported thinking parameters
   * - Override sampling params for local models
   */
  override prepareRequest(request: any, originalRequest: any): any {
    if (originalRequest.thinking) {
      log(`[DeepSeekAdapter] Stripping thinking object (not supported by API)`);
      delete request.thinking;
    }

    // Override sampling params for local models (detected by presence of temperature in request)
    if (request.temperature !== undefined) {
      request.temperature = 0.6;
      request.top_p = 0.95;
      request.top_k = 40;
      request.min_p = 0.0;
      request.repetition_penalty = 1.0;
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
