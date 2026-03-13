/**
 * GLM (Zhipu AI) Model Adapter
 *
 * Handles GLM-specific quirks:
 * - Context window sizes per model variant
 * - Strips unsupported thinking params (GLM doesn't support explicit thinking API)
 * - Vision support detection
 */

import { ModelAdapter } from "./model-adapter.js";
import { log } from "../logger";

/** GLM model context windows */
const GLM_CONTEXT_WINDOWS: [string, number][] = [
  ["glm-5", 204_800],
  ["glm-4.7-flash", 200_000],
  ["glm-4.7", 204_800],
  ["glm-4.6v", 128_000],
  ["glm-4.6", 204_800],
  ["glm-4.5v", 64_000],
  ["glm-4.5-flash", 131_072],
  ["glm-4.5-air", 131_072],
  ["glm-4.5", 131_072],
  ["glm-4-long", 1_000_000],
  ["glm-4-plus", 128_000],
  ["glm-4-flash", 128_000],
  ["glm-4", 128_000],
  ["glm-3-turbo", 128_000],
];

/** GLM models that support vision */
const GLM_VISION_MODELS = ["glm-4v", "glm-4v-plus", "glm-5"];

export class GLMAdapter extends ModelAdapter {
  override prepareRequest(request: any, originalRequest: any): any {
    if (originalRequest.thinking) {
      log(`[GLMAdapter] Stripping thinking object (not supported by GLM API)`);
      delete request.thinking;
    }
    return request;
  }


  getName(): string {
    return "GLMAdapter";
  }

  override getContextWindow(): number | undefined {
    const lower = this.modelId.toLowerCase();
    for (const [pattern, size] of GLM_CONTEXT_WINDOWS) {
      if (lower.includes(pattern)) return size;
    }
    return 131_072;
  }

  override supportsVision(): boolean | undefined {
    const lower = this.modelId.toLowerCase();
    return GLM_VISION_MODELS.some((m) => lower.includes(m));
  }
}
