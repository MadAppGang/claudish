/**
 * OpenAIAPIFormat — Layer 1 wire format for OpenAI Chat Completions API.
 *
 * Handles:
 * - Context window detection for OpenAI models (gpt-*, o1, o3)
 * - Mapping Claude thinking/output_config to OpenAI reasoning_effort
 * - max_completion_tokens vs max_tokens for newer models
 * - Tool choice mapping
 *
 * Also serves as Layer 2 ModelDialect for OpenAI-native chat models.
 */

import { BaseAPIFormat, type AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";
import {
  isOpenAIChatModel,
  mapBudgetTokensToReasoningEffort,
  resolveOpenAIReasoningEffort,
} from "./openai-reasoning.js";

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
    const reasoning = resolveOpenAIReasoningEffort(this.modelId, originalRequest);
    if (reasoning) {
      request.reasoning_effort = reasoning.effort;
      delete request.thinking;
      log(`[OpenAIAPIFormat] Mapped ${reasoning.source} -> reasoning_effort: ${reasoning.effort}`);
    } else if (originalRequest.thinking?.budget_tokens !== undefined && this.isReasoningModel()) {
      const effort = mapBudgetTokensToReasoningEffort(originalRequest.thinking.budget_tokens);
      request.reasoning_effort = effort;
      delete request.thinking;
      log(
        `[OpenAIAPIFormat] Mapped thinking.budget_tokens ${originalRequest.thinking.budget_tokens} -> reasoning_effort: ${effort}`
      );
    } else if (request.thinking && isOpenAIChatModel(this.modelId)) {
      delete request.thinking;
      log(`[OpenAIAPIFormat] Stripped unsupported thinking params for ${this.modelId}`);
    }

    // Truncate tool names if model has a limit
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return isOpenAIChatModel(modelId) || modelId.includes("o1") || modelId.includes("o3");
  }

  getName(): string {
    return "OpenAIAPIFormat";
  }

  // ─── ComposedHandler integration ───────────────────────────────────

  override getContextWindow(): number {
    const model = this.modelId.toLowerCase();

    // OpenAI models
    if (model.includes("gpt-5.4")) return 1_050_000;
    if (model.includes("gpt-5")) return 400_000;
    if (model.includes("o1") || model.includes("o3") || model.includes("o4")) return 200_000;
    if (model.includes("gpt-4o") || model.includes("gpt-4-turbo")) return 128_000;
    if (model.includes("gpt-3.5")) return 16_385;

    return 128_000; // Default
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

    const reasoning = resolveOpenAIReasoningEffort(this.modelId, claudeRequest);
    if (reasoning) {
      payload.reasoning_effort = reasoning.effort;
      log(`[OpenAIAPIFormat] Mapped ${reasoning.source} -> reasoning_effort: ${reasoning.effort}`);
    } else if (claudeRequest.thinking?.budget_tokens !== undefined && this.isReasoningModel()) {
      const effort = mapBudgetTokensToReasoningEffort(claudeRequest.thinking.budget_tokens);
      payload.reasoning_effort = effort;
      log(
        `[OpenAIAPIFormat] Mapped thinking.budget_tokens ${claudeRequest.thinking.budget_tokens} -> reasoning_effort: ${effort}`
      );
    }

    return payload;
  }
}

// Backward-compatible alias
/** @deprecated Use OpenAIAPIFormat */
export { OpenAIAPIFormat as OpenAIAdapter };
