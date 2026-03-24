/**
 * MiniMaxModelDialect — Layer 2 dialect for MiniMax models.
 *
 * Handles MiniMax-specific quirks:
 * - Context window: all models are 204,800 tokens
 * - Temperature: must be in (0.0, 1.0] — clamps 0 → 0.01, >1 → 1.0
 * - Thinking: native support via standard `thinking` param (no conversion needed)
 * - Vision: not supported — supportsVision() returns false so ComposedHandler strips images
 */

import { BaseAPIFormat, AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";

export class MiniMaxModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // MiniMax interleaved thinking is handled by the model
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Handle request preparation — clamp temperature to MiniMax's accepted range.
   * The valid range is sourced from the model catalog (temperatureRange field).
   * The standard `thinking` parameter is supported natively by MiniMax's Anthropic-compatible
   * endpoint, so no conversion is needed here.
   */
  override prepareRequest(request: any, originalRequest: any): any {
    const entry = lookupModel(this.modelId);
    const tempRange = entry?.temperatureRange;

    if (request.temperature !== undefined && tempRange) {
      if (request.temperature < tempRange.min) {
        log(
          `[MiniMaxModelDialect] Clamping temperature ${request.temperature} → ${tempRange.min} (MiniMax requires >= ${tempRange.min})`
        );
        request.temperature = tempRange.min;
      } else if (request.temperature > tempRange.max) {
        log(
          `[MiniMaxModelDialect] Clamping temperature ${request.temperature} → ${tempRange.max} (MiniMax requires <= ${tempRange.max})`
        );
        request.temperature = tempRange.max;
      }
    }

    return request;
  }

  /**
   * Context window sourced from the model catalog.
   * Defaults to 204,800 (MiniMax standard context) if not in catalog.
   */
  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 204_800;
  }

  /**
   * MiniMax's Anthropic API does not support image or document content blocks.
   * Returning false causes ComposedHandler to strip/proxy image content.
   * Sourced from model catalog; defaults to false for unrecognized MiniMax models.
   */
  override supportsVision(): boolean {
    return lookupModel(this.modelId)?.supportsVision ?? false;
  }

  getName(): string {
    return "MiniMaxModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use MiniMaxModelDialect */
export { MiniMaxModelDialect as MiniMaxAdapter };
