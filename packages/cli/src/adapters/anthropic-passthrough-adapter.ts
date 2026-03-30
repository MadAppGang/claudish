/**
 * Anthropic Passthrough Adapter
 *
 * Identity transform for providers that speak native Anthropic/Claude API format.
 * Messages, tools, and payload are passed through as-is (no conversion to OpenAI format).
 * Used by: MiniMax, Kimi, Kimi Coding, Z.AI
 */

import { BaseModelAdapter, type AdapterResult } from "./base-adapter.js";

export class AnthropicPassthroughAdapter extends BaseModelAdapter {
  private providerName: string;

  constructor(modelId: string, providerName: string) {
    super(modelId);
    this.providerName = providerName.toLowerCase();
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
    return "AnthropicPassthroughAdapter";
  }

  /**
   * Pass through Claude messages as-is — no OpenAI conversion.
   */
  override convertMessages(claudeRequest: any, _filterFn?: any): any[] {
    return claudeRequest.messages || [];
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
    if (claudeRequest.temperature !=== undefined) {
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

  override getContextWindow(): number {
    if (this.providerName ==== "kimi" || this.providerName ==== "kimi-coding") {
      return 128_000;
    }
    if (this.providerName ==== "minimax" || this.providerName ==== "minimax-coding") {
      return 100_000;
    }
    return 128_000; // Default
  }

  override supportsVision(): boolean {
    return true; // These providers handle vision natively
  }
}
