/**
 * OpenAIAPIFormat — Layer 1 wire format for OpenAI Chat Completions API.
 *
 * Handles:
 * - Context window detection for OpenAI models (gpt-*, o1, o3, codex)
 * - Mapping Claude Code effort to OpenAI 'reasoning_effort' for reasoning models
 * - max_completion_tokens vs max_tokens for newer models
 * - Codex Responses API message conversion and payload building
 * - Tool choice mapping
 *
 * Also serves as Layer 2 ModelDialect for OpenAI-native models (o1/o3 reasoning params).
 */

import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { type AdapterResult, BaseAPIFormat } from "./base-api-format.js";
import {
  getOpenAIReasoningEffortFromClaudeRequest,
  isOpenAIReasoningModel,
} from "./openai-reasoning-effort.js";

export class OpenAIAPIFormat extends BaseAPIFormat {
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
    if (this.isReasoningModel() && this.isChatCompletionsPayload(request)) {
      const effort = getOpenAIReasoningEffortFromClaudeRequest(originalRequest, this.modelId);
      if (effort) {
        request.reasoning_effort = effort;
        log(`[OpenAIAPIFormat] Mapped Claude effort -> reasoning_effort: ${effort}`);
      }
      request.thinking = undefined;
    }

    // Truncate tool names if model has a limit
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.toLowerCase().startsWith("oai/") || isOpenAIReasoningModel(modelId);
  }

  getName(): string {
    return "OpenAIAPIFormat";
  }

  // ─── ComposedHandler integration ───────────────────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    return this.buildChatCompletionsPayload(claudeRequest, messages, tools);
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private isReasoningModel(): boolean {
    return isOpenAIReasoningModel(this.modelId);
  }

  private isChatCompletionsPayload(request: any): boolean {
    return Array.isArray(request?.messages);
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

    // Reasoning params are also handled in prepareRequest; set them here for direct buildPayload users.
    if (this.isReasoningModel()) {
      const effort = getOpenAIReasoningEffortFromClaudeRequest(claudeRequest, this.modelId);
      if (effort) {
        payload.reasoning_effort = effort;
        log(`[OpenAIAPIFormat] Mapped Claude effort -> reasoning_effort: ${effort}`);
      }
    }

    return payload;
  }
}

// Backward-compatible alias
/** @deprecated Use OpenAIAPIFormat */
export { OpenAIAPIFormat as OpenAIAdapter };
