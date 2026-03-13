import { ModelAdapter } from "./model-adapter.js";

export class LlamaAdapter extends ModelAdapter {
  override prepareRequest(request: any, _originalRequest: any): any {
    // Override sampling params for local models (detected by presence of temperature in request)
    if (request.temperature !== undefined) {
      request.temperature = 0.7;
      request.top_p = 0.9;
      request.top_k = 40;
      request.min_p = 0.05;
      request.repetition_penalty = 1.1;
    }
    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.toLowerCase().includes("llama");
  }

  getName(): string {
    return "LlamaAdapter";
  }
}
