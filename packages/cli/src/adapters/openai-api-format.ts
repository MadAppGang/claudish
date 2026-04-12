/**
 * OpenAIAPIFormat — Layer 1 wire format for OpenAI Chat Completions API.
 *
 * Handles:
 * - Context window detection for OpenAI models (gpt-*, o1, o3, codex)
 * - Mapping 'thinking.budget_tokens' to 'reasoning_effort' for o1/o3 models
 * - max_completion_tokens vs max_tokens for newer models
 * - Codex Responses API message conversion and payload building
 * - Tool choice mapping
 *
 * Also serves as Layer 2 ModelDialect for OpenAI-native models (o1/o3 reasoning params).
 */

import { BaseAPIFormat, type AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { lookupModel } from "./model-catalog.js";

export class OpenAIAPIFormat extends BaseAPIFormat {
  constructor(modelId: string) {
    super(modelId);
  }

  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override getStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  /**
   * Handle request preparation — reasoning parameters and tool name truncation
   */
  override prepareRequest(request: any, originalRequest: any): any {
    // Map thinking.budget_tokens -> reasoning_effort for o1/o3/gpt-5.x reasoning models
    // Valid levels per openai-python SDK (shared/reasoning_effort.py):
    // none, minimal, low, medium, high, xhigh
    // Issue #84: GPT-5.x models support xhigh but the previous mapping capped at high.
    if (originalRequest.thinking && this.isReasoningModel()) {
      const { budget_tokens } = originalRequest.thinking;
      let effort = "medium";
      if (budget_tokens < 4000) effort = "minimal";
      else if (budget_tokens < 16000) effort = "low";
      else if (budget_tokens < 32000) effort = "high";
      else effort = "xhigh";

      request.reasoning_effort = effort;
      delete request.thinking;
      log(`[OpenAIAPIFormat] Mapped budget ${budget_tokens} -> reasoning_effort: ${effort}`);
    }

    // Truncate tool names if model has a limit
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.startsWith("oai/") || modelId.includes("o1") || modelId.includes("o3");
  }

  getName(): string {
    return "OpenAIAPIFormat";
  }

  // ─── ComposedHandler integration ───────────────────────────────────

  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    return this.buildChatCompletionsPayload(claudeRequest, messages, tools);
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private isReasoningModel(): boolean {
    const model = this.modelId.toLowerCase();
    return model.includes("o1") || model.includes("o3");
  }

  private usesMaxCompletionTokens(): boolean {
    const model = this.modelId.toLowerCase();
    return (
      model.includes("gpt-5") ||
      model.includes("o1") ||
      model.includes("o3") ||
      model.includes("o4")
    );
  }

  private buildChatCompletionsPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (this.usesMaxCompletionTokens()) {
      payload.max_completion_tokens = claudeRequest.max_tokens;
    } else {
      payload.max_tokens = claudeRequest.max_tokens;
    }

    if (tools.length > 0) {
      payload.tools = tools;
    }

    if (claudeRequest.tool_choice) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        payload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        payload.tool_choice = type;
      }
    }

    // Reasoning params handled in prepareRequest instead
    // Same xhigh mapping as prepareRequest (issue #84)
    if (claudeRequest.thinking && this.isReasoningModel()) {
      const { budget_tokens } = claudeRequest.thinking;
      let effort = "medium";
      if (budget_tokens < 4000) effort = "minimal";
      else if (budget_tokens < 16000) effort = "low";
      else if (budget_tokens < 32000) effort = "high";
      else effort = "xhigh";
      payload.reasoning_effort = effort;
      log(
        `[OpenAIAPIFormat] Mapped thinking.budget_tokens ${budget_tokens} -> reasoning_effort: ${effort}`
      );
    }

    return payload;
  }
}

// Backward-compatible alias
/** @deprecated Use OpenAIAPIFormat */
export { OpenAIAPIFormat as OpenAIAdapter };
