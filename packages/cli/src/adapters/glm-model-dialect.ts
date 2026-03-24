/**
 * GLMModelDialect — Layer 2 dialect for Zhipu AI GLM models.
 *
 * Handles GLM-specific quirks:
 * - Context window sizes per model variant (sourced from model-catalog.ts)
 * - Strips unsupported thinking params (GLM doesn't support explicit thinking API)
 * - Vision support detection (sourced from model-catalog.ts)
 */

import { BaseModelDialect } from "./base-model-dialect.js";
import type { AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";

export class GLMModelDialect extends BaseModelDialect {
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
      log(`[GLMModelDialect] Stripping thinking object (not supported by GLM API)`);
      delete request.thinking;
    }

    return request;
  }

  getName(): string {
    return "GLMModelDialect";
  }

  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 128_000;
  }

  override supportsVision(): boolean {
    return lookupModel(this.modelId)?.supportsVision ?? false;
  }
}

// Backward-compatible alias
/** @deprecated Use GLMModelDialect */
export { GLMModelDialect as GLMAdapter };
