import { ModelAdapter } from "./model-adapter.js";

export class MistralAdapter extends ModelAdapter {
  override prepareRequest(request: any, _originalRequest: any): any {
    // Override sampling params for local models (detected by presence of temperature in request)
    if (request.temperature !== undefined) {
      request.temperature = 0.7;
      request.top_p = 0.9;
      request.top_k = 50;
      request.min_p = 0.0;
      request.repetition_penalty = 1.0;
    }
    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.toLowerCase().includes("mistral");
  }

  getName(): string {
    return "MistralAdapter";
  }
}
