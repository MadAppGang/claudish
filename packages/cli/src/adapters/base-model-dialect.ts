/**
 * BaseModelDialect — abstract base for model dialect implementations (Layer 2).
 *
 * Model dialects handle per-model-family quirks: context windows, parameter mappings
 * (thinking -> reasoning_effort), vision support, tool name limits, and text
 * post-processing (reasoning filters, XML parsing, token stripping).
 *
 * This class is for pure dialect adapters that do NOT define a wire format.
 * Wire format adapters (OpenAI, Gemini, Anthropic, etc.) extend BaseAPIFormat instead.
 */

import type { ModelDialect } from "./model-dialect.js";
import type { StreamFormat } from "../providers/transport/types.js";
import type { AdapterResult } from "./base-api-format.js";
import type { ModelPricing } from "../handlers/shared/remote-provider-types.js";
import { getModelPricing } from "../handlers/shared/remote-provider-types.js";

export abstract class BaseModelDialect implements ModelDialect {
  protected modelId: string;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  /**
   * Process text content and extract any model-specific tool call formats.
   */
  abstract processTextContent(textContent: string, accumulatedText: string): AdapterResult;

  /**
   * Get name for logging.
   */
  abstract getName(): string;

  /**
   * Maximum tool name length allowed by this model's API.
   * Returns null if no limit (default).
   */
  getToolNameLimit(): number | null {
    return null;
  }

  /**
   * Handle any request preparation before sending to the model.
   */
  prepareRequest(request: any, originalRequest: any): any {
    return request;
  }

  /**
   * Reset internal state between requests.
   */
  reset(): void {}

  /**
   * Context window size for this model (tokens).
   */
  getContextWindow(): number {
    return 200_000;
  }

  /**
   * Whether this model supports vision/image input.
   * Default false; override in dialects for models with vision support.
   */
  supportsVision(): boolean {
    return false;
  }

  /**
   * Stream format: dialects have no opinion (wire format is the adapter's job).
   * Returns undefined so ComposedHandler falls through to the format adapter.
   */
  getStreamFormat(): StreamFormat | undefined {
    return undefined;
  }

  /**
   * Pricing info for this model.
   */
  getPricing(providerName: string): ModelPricing {
    return getModelPricing(providerName, this.modelId);
  }
}
