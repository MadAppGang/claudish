import { ModelAdapter } from "./model-adapter.js";
import { log } from "../logger";

export class DeepSeekAdapter extends ModelAdapter {
  /**
   * Strip unsupported thinking parameters.
   * DeepSeek thinks automatically (R1) — Anthropic-format thinking params cause errors.
   */
  override prepareRequest(request: any, originalRequest: any): any {
    if (originalRequest.thinking) {
      log(`[DeepSeekAdapter] Stripping thinking object (not supported by API)`);
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
