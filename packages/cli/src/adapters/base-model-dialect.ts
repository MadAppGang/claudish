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

import { truncateToolName } from "./tool-name-utils.js";
import type { ModelDialect } from "./model-dialect.js";
import type { StreamFormat } from "../providers/transport/types.js";
import type { AdapterResult } from "./base-api-format.js";
import type { ModelPricing } from "../handlers/shared/remote-provider-types.js";
import { getModelPricing } from "../handlers/shared/remote-provider-types.js";

export abstract class BaseModelDialect implements ModelDialect {
  protected modelId: string;

  /**
   * Map of truncated tool names back to original names.
   * Populated during prepareRequest() when tool names are truncated.
   */
  protected toolNameMap: Map<string, string> = new Map();

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
   * Get the tool name map (truncated -> original).
   */
  getToolNameMap(): Map<string, string> {
    return this.toolNameMap;
  }

  /**
   * Restore a potentially truncated tool name to its original.
   */
  restoreToolName(name: string): string {
    return this.toolNameMap.get(name) || name;
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
  reset(): void {
    this.toolNameMap.clear();
  }

  /**
   * Context window size for this model (tokens).
   */
  getContextWindow(): number {
    return 200_000;
  }

  /**
   * Whether this model supports vision/image input.
   */
  supportsVision(): boolean {
    return true;
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

  /**
   * Truncate tool names in the request payload if the model has a name length limit.
   */
  protected truncateToolNames(request: any): void {
    const limit = this.getToolNameLimit();
    if (!limit || !request.tools) return;

    for (const tool of request.tools) {
      const originalName = tool.function?.name || tool.name;
      if (originalName && originalName.length > limit) {
        const truncated = truncateToolName(originalName, limit);
        this.toolNameMap.set(truncated, originalName);
        if (tool.function?.name) {
          tool.function.name = truncated;
        } else if (tool.name) {
          tool.name = truncated;
        }
      }
    }
  }

  /**
   * Truncate tool names in assistant message history (for messages array).
   */
  protected truncateToolNamesInMessages(messages: any[]): void {
    const limit = this.getToolNameLimit();
    if (!limit) return;

    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (name && name.length > limit) {
            const truncated = truncateToolName(name, limit);
            tc.function.name = truncated;
            if (!this.toolNameMap.has(truncated)) {
              this.toolNameMap.set(truncated, name);
            }
          }
        }
      }
    }
  }
}
