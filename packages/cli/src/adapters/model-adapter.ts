/**
 * ModelAdapter — model-specific quirk handling.
 *
 * Owns: text post-processing (reasoning filters, XML parsing, token stripping),
 *       parameter mapping (thinking budget → reasoning_effort), context window
 *       and vision overrides for specific model families.
 *
 * Does NOT own: wire format conversion (messages, tools, payload shape).
 *               Those belong to FormatAdapter.
 *
 * Resolved by selectModelAdapter() in the provider factory via inline
 * model name matching. ProviderHandler calls ModelAdapter methods after
 * FormatAdapter methods, allowing model quirks to apply regardless of
 * which provider/format is used.
 */

import { BaseAdapter } from "./base-adapter.js";

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

export class ModelAdapter extends BaseAdapter {
  getName(): string {
    return "ModelAdapter";
  }

  /**
   * Process text content from the model's streaming response.
   * Used to filter leaked reasoning, parse XML tool calls, strip special tokens.
   */
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }
}
