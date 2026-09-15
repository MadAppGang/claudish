/**
 * AnthropicAPIFormat — Layer 1 wire format for Anthropic Messages API.
 *
 * Identity transform for providers that speak native Anthropic/Claude API format.
 * Messages, tools, and payload are passed through as-is (no conversion to OpenAI format).
 * Used by: MiniMax, Kimi, Kimi Coding, Z.AI
 */

import { BaseAPIFormat, type AdapterResult } from "./base-api-format.js";
import type { StreamFormat } from "../providers/transport/types.js";

export class AnthropicAPIFormat extends BaseAPIFormat {
  constructor(modelId: string, _providerName?: string) {
    super(modelId);
    // _providerName retained for backward compat with call sites; no longer used.
  }

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  shouldHandle(modelId: string): boolean {
    return false; // Not auto-selected; always explicitly passed
  }

  getName(): string {
    return "AnthropicAPIFormat";
  }

  /**
   * Pass through Claude messages, stripping Claude-internal content types
   * that non-Anthropic providers don't support (e.g. tool_reference from
   * the deferred tool loading / ToolSearch system).
   */
  override convertMessages(claudeRequest: any, _filterFn?: any): any[] {
    const messages = claudeRequest.messages || [];
    return messages.map((msg: any) => this.stripUnsupportedContentTypes(msg));
  }

  private stripUnsupportedContentTypes(message: any): any {
    if (!message.content || !Array.isArray(message.content)) {
      return message;
    }
    const filteredContent = message.content
      .map((block: any) => {
        // Strip tool_reference from tool_result content arrays
        if (block.type === "tool_result" && Array.isArray(block.content)) {
          const filtered = block.content.filter((c: any) => c.type !== "tool_reference");
          // Keep a non-empty placeholder: Kimi Coding rejects empty text blocks
          // with HTTP 400 `text content is empty`.
          return {
            ...block,
            content:
              filtered.length > 0
                ? filtered
                : [{ type: "text", text: "[unsupported tool references omitted]" }],
          };
        }
        return block;
      })
      .filter((block: any) => block.type !== "tool_reference");
    return { ...message, content: filteredContent };
  }

  /**
   * Pass through Claude tools as-is — no OpenAI conversion.
   */
  override convertTools(claudeRequest: any, _summarize?: boolean): any[] {
    return claudeRequest.tools || [];
  }

  /**
   * Rebuild the Anthropic-format payload from the claudeRequest.
   * This reconstructs the same payload that Claude Code originally sent,
   * with the model name replaced to match the target provider's model.
   */
  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      max_tokens: claudeRequest.max_tokens || 4096,
      stream: true,
    };

    if (claudeRequest.system) {
      payload.system = claudeRequest.system;
    }
    if (tools.length > 0) {
      payload.tools = tools;
    }
    if (claudeRequest.thinking) {
      payload.thinking = claudeRequest.thinking;
    }
    if (claudeRequest.tool_choice) {
      payload.tool_choice = claudeRequest.tool_choice;
    }
    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }
    if (claudeRequest.stop_sequences) {
      payload.stop_sequences = claudeRequest.stop_sequences;
    }
    if (claudeRequest.metadata) {
      payload.metadata = claudeRequest.metadata;
    }

    return payload;
  }

  override getStreamFormat(): StreamFormat {
    return "anthropic-sse";
  }

  override supportsVision(): boolean {
    return true; // These providers handle vision natively
  }
}

// Backward-compatible alias
/** @deprecated Use AnthropicAPIFormat */
export { AnthropicAPIFormat as AnthropicPassthroughAdapter };
