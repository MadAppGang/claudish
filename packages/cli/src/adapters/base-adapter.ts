/**
 * Base adapter for model-specific transformations
 *
 * Different models have different quirks that need translation:
 * - Grok: XML function calls instead of JSON tool_calls
 * - Deepseek: May have its own format
 * - Others: Future model-specific behaviors
 */

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

export abstract class BaseModelAdapter {
  protected modelId: string;

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
    // Default implementation does nothing
    // Subclasses can override if they maintain state
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
