/**
 * GLM (Zhipu AI) Model Adapter
 *
 * Handles GLM-specific quirks:
 * - Context window sizes per model variant
 * - Strips unsupported thinking params (GLM doesn't support explicit thinking API)
 * - Vision support detection
 */

import { BaseModelAdapter, AdapterResult, matchesModelFamily } from "./base-adapter";
import { log } from "../logger";

/** GLM model context windows (pattern-match, checked in order) */
const GLM_CONTEXT_WINDOWS: Array<[string, number]> = [
  ["glm-5-turbo", 202_752],
  ["glm-5", 80_000],
  ["glm-4.7-flash", 202_752],
  ["glm-4.7", 202_752],
  ["glm-4.6v", 131_072],
  ["glm-4.6", 204_800],
  ["glm-4.5v", 65_536],
  ["glm-4.5-flash", 131_072],
  ["glm-4.5-air", 131_072],
  ["glm-4.5", 131_072],
  ["glm-4-long", 1_000_000],
  ["glm-4-plus", 128_000],
  ["glm-4-flash", 128_000],
  ["glm-4-32b", 128_000],
  ["glm-4", 128_000],
  ["glm-3-turbo", 128_000],
  ["glm-", 131_072],
];

/** GLM models that support vision (explicit list for clarity) */
const GLM_VISION_MODELS = ["glm-4v", "glm-4v-plus", "glm-4.5v", "glm-4.6v", "glm-5"];

export class GLMAdapter extends BaseModelAdapter {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override prepareRequest(request: any, originalRequest: any): any {
    // GLM doesn't support thinking params via API
    if (originalRequest.thinking) {
      log(`[GLMAdapter] Stripping thinking object (not supported by GLM API)`);
      delete request.thinking;
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "glm-") || matchesModelFamily(modelId, "chatglm-") || modelId.toLowerCase().includes("zhipu/");
  }

  getName(): string {
    return "GLMAdapter";
  }

  getContextWindow(): number {
    const lower = this.modelId.toLowerCase();
    for (const [pattern, size] of GLM_CONTEXT_WINDOWS) {
      if (lower.includes(pattern)) return size;
    }
    return 128_000;
  }

  supportsVision(): boolean {
    const lower = this.modelId.toLowerCase();
    return GLM_VISION_MODELS.some((m) => lower.includes(m));
  }
}
