/**
 * Base adapter for model-specific transformations
 *
 * Different models have different quirks that need translation:
 * - Grok: XML function calls instead of JSON tool_calls
 * - Deepseek: May have its own format
 * - Others: Future model-specific behaviors
 */

import { truncateToolName } from "./tool-name-utils.js";
import type { ModelPricing } from "../handlers/shared/remote-provider-types.js";
import { getModelPricing } from "../handlers/shared/remote-provider-types.js";
import type { StreamFormat } from "../providers/transport/types.js";
import type { FormatConverter } from "./format-converter.js";
import type { ModelTranslator } from "./model-translator.js";

/**
 * Match a model ID against a model family name, handling vendor-prefixed IDs.
 *
 * Matches: "grok-beta", "x-ai/grok-beta", "openrouter/x-ai/grok-beta"
 * Does NOT match: "qwen-grok-hybrid" (grok is not at a family boundary)
 *
 * @param modelId - The full model ID (may include vendor prefix)
 * @param family - The family name to match (e.g., "grok", "deepseek", "qwen")
 */
export function matchesModelFamily(modelId: string, family: string): boolean {
  const lower = modelId.toLowerCase();
  const fam = family.toLowerCase();
  return lower.startsWith(fam) || lower.includes(`/${fam}`);
}
import { convertMessagesToOpenAI } from "../handlers/shared/format/openai-messages.js";
import { convertToolsToOpenAI } from "../handlers/shared/format/openai-tools.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface AdapterResult {
  /** Cleaned text content (with XML/special formats removed) */
  cleanedText: string;
  /** Extracted tool calls from special formats */
  extractedToolCalls: ToolCall[];
  /** Whether any transformation was done */
  wasTransformed: boolean;
}

export abstract class BaseModelAdapter implements FormatConverter, ModelTranslator {
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
   * Process text content and extract any model-specific tool call formats
   * @param textContent - The raw text content from the model
   * @param accumulatedText - The accumulated text so far (for multi-chunk parsing)
   * @returns Cleaned text and any extracted tool calls
   */
  abstract processTextContent(textContent: string, accumulatedText: string): AdapterResult;

  /**
   * Check if this adapter should be used for the given model
   */
  abstract shouldHandle(modelId: string): boolean;

  /**
   * Get adapter name for logging
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
   * Use after prepareRequest() to get the mapping for response processing.
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
   * Handle any request preparation before sending to the model
   * Useful for mapping parameters like thinking budget -> reasoning_effort
   * @param request - The OpenRouter payload being prepared
   * @param originalRequest - The original Claude-format request
   * @returns The modified request payload
   */
  prepareRequest(request: any, originalRequest: any): any {
    return request;
  }

  /**
   * Reset internal state between requests (prevents state contamination)
   */
  reset(): void {
    this.toolNameMap.clear();
  }

  // ─── ComposedHandler integration (Phase 1c) ───────────────────────
  // These methods have sensible defaults so existing adapters continue
  // to work unchanged. Override in specific adapters as needed.

  /**
   * Convert Claude-format messages to the target API format.
   * Default: delegates to convertMessagesToOpenAI.
   * Override for non-OpenAI formats (e.g., Gemini parts-based format).
   */
  convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    return convertMessagesToOpenAI(claudeRequest, this.modelId, filterIdentityFn);
  }

  /**
   * Convert Claude tools to the target API format.
   * Default: OpenAI function-calling format.
   */
  convertTools(claudeRequest: any, summarize = false): any[] {
    return convertToolsToOpenAI(claudeRequest, summarize);
  }

  /**
   * Build the full request payload for the target API.
   * Default: OpenAI Chat Completions format.
   * Override for Gemini (generateContent), Anthropic passthrough, etc.
   */
  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      stream: true,
    };
    if (tools.length > 0) {
      payload.tools = tools;
    }
    if (claudeRequest.max_tokens) {
      payload.max_tokens = claudeRequest.max_tokens;
    }
    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }
    return payload;
  }

  /**
   * The stream format this adapter's target API returns.
   * Default: "openai-sse" (most common format).
   * Override for Anthropic passthrough ("anthropic-sse"), Gemini ("gemini-sse"), etc.
   */
  getStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  /**
   * Context window size for this model (tokens).
   * Used for token tracking and context-left-percent calculation.
   */
  getContextWindow(): number {
    return 200_000;
  }

  /**
   * Pricing info for this model. Used by TokenTracker.
   * Default: delegates to the centralized getModelPricing.
   */
  getPricing(providerName: string): ModelPricing {
    return getModelPricing(providerName, this.modelId);
  }

  /**
   * Whether this model supports vision/image input.
   */
  supportsVision(): boolean {
    return true;
  }

  /**
   * Truncate tool names in the request payload if the model has a name length limit.
   * Handles both Chat Completions format ({type:"function", function:{name}})
   * and Responses API format ({type:"function", name}).
   * Stores the mapping in this.toolNameMap for reverse mapping in responses.
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
   * This is needed because historical tool_use blocks in the conversation
   * may contain names that exceed the model's limit.
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

/**
 * Default adapter that does no transformation
 */
export class DefaultAdapter extends BaseModelAdapter {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  shouldHandle(modelId: string): boolean {
    return false; // Default adapter is fallback
  }

  getName(): string {
    return "DefaultAdapter";
  }
}
