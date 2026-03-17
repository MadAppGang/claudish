/**
 * OpenAI adapter for handling model-specific behaviors
 *
 * Handles:
 * - Context window detection for OpenAI, Grok, GLM, Kimi models
 * - Mapping 'thinking.budget_tokens' to 'reasoning_effort' for o1/o3 models
 * - max_completion_tokens vs max_tokens for newer models
 * - Codex Responses API message conversion and payload building
 * - Vision support detection (GLM-specific V-variant rule)
 * - Tool choice mapping
 */

import { BaseModelAdapter, type AdapterResult } from "./base-adapter.js";
import { log } from "../logger.js";

export class OpenAIAdapter extends BaseModelAdapter {
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

  /**
   * Handle request preparation — reasoning parameters and tool name truncation
   */
  override prepareRequest(request: any, originalRequest: any): any {
    // Map thinking.budget_tokens -> reasoning_effort for o1/o3 models
    if (originalRequest.thinking && this.isReasoningModel()) {
      const { budget_tokens } = originalRequest.thinking;
      let effort = "medium";
      if (budget_tokens < 4000) effort = "minimal";
      else if (budget_tokens < 16000) effort = "low";
      else if (budget_tokens >= 32000) effort = "high";

      request.reasoning_effort = effort;
      delete request.thinking;
      log(`[OpenAIAdapter] Mapped budget ${budget_tokens} -> reasoning_effort: ${effort}`);
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
    return "OpenAIAdapter";
  }

  // ─── ComposedHandler integration ───────────────────────────────────

  override getContextWindow(): number {
    const model = this.modelId.toLowerCase();

    // xAI Grok models
    if (model.includes("grok-4.1-fast") || model.includes("grok-4-1-fast")) return 2_000_000;
    if (model.includes("grok-4-fast")) return 2_000_000;
    if (model.includes("grok-code-fast")) return 256_000;
    if (model.includes("grok-4")) return 256_000;
    if (model.includes("grok-3")) return 131_072;
    if (model.includes("grok-2")) return 131_072;
    if (model.includes("grok")) return 131_072;

    // Kimi models
    if (model.includes("kimi-k2.5") || model.includes("kimi-k2-5")) return 262_144;
    if (model.includes("kimi-k2")) return 262_144;
    if (model.includes("kimi")) return 131_072;

    // GLM/Zhipu models
    if (model.includes("glm-5")) return 204_800;
    if (model.includes("glm-4.7-flash")) return 200_000;
    if (model.includes("glm-4.7")) return 204_800;
    if (model.includes("glm-4.6v")) return 128_000;
    if (model.includes("glm-4.6")) return 204_800;
    if (model.includes("glm-4.5v")) return 64_000;
    if (model.includes("glm-4.5-flash")) return 131_072;
    if (model.includes("glm-4.5-air")) return 131_072;
    if (model.includes("glm-4.5")) return 131_072;
    if (model.includes("glm-")) return 131_072;

    // OpenAI models
    if (model.includes("gpt-5")) return 256_000;
    if (model.includes("o1") || model.includes("o3")) return 200_000;
    if (model.includes("gpt-4o") || model.includes("gpt-4-turbo")) return 128_000;
    if (model.includes("gpt-3.5")) return 16_385;

    return 128_000; // Default
  }

  override supportsVision(): boolean {
    // GLM-specific: only "V" variants support vision
    const model = this.modelId.toLowerCase();
    if (model.startsWith("glm-") && !/\d+\.?\d*v/.test(model)) {
      return false;
    }
    return true;
  }

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    if (this.isCodexModel()) {
      return this.buildResponsesPayload(claudeRequest, messages, tools);
    }
    return this.buildChatCompletionsPayload(claudeRequest, messages, tools);
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private isReasoningModel(): boolean {
    const model = this.modelId.toLowerCase();
    return model.includes("o1") || model.includes("o3");
  }

  private isCodexModel(): boolean {
    return this.modelId.toLowerCase().includes("codex");
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
    if (claudeRequest.thinking && this.isReasoningModel()) {
      const { budget_tokens } = claudeRequest.thinking;
      let effort = "medium";
      if (budget_tokens < 4000) effort = "minimal";
      else if (budget_tokens < 16000) effort = "low";
      else if (budget_tokens >= 32000) effort = "high";
      payload.reasoning_effort = effort;
      log(
        `[OpenAIAdapter] Mapped thinking.budget_tokens ${budget_tokens} -> reasoning_effort: ${effort}`
      );
    }

    return payload;
  }

  /**
   * Build Responses API payload for Codex models.
   * Uses 'input' instead of 'messages', different content types.
   */
  private buildResponsesPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const convertedMessages = this.convertMessagesToResponsesAPI(messages);

    const payload: any = {
      model: this.modelId,
      input: convertedMessages,
      stream: true,
    };

    if (claudeRequest.system) {
      payload.instructions = claudeRequest.system;
    }

    if (claudeRequest.max_tokens) {
      payload.max_output_tokens = Math.max(16, claudeRequest.max_tokens);
    }

    if (tools.length > 0) {
      payload.tools = tools.map((tool: any) => {
        if (tool.type === "function" && tool.function) {
          return {
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          };
        }
        return tool;
      });
    }

    return payload;
  }

  /**
   * Convert Chat Completions format messages to Responses API format.
   */
  private convertMessagesToResponsesAPI(messages: any[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue; // Goes to instructions field

      if (msg.role === "tool") {
        result.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        });
        continue;
      }

      if (msg.role === "assistant" && msg.tool_calls) {
        if (msg.content) {
          const textContent =
            typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          if (textContent) {
            result.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: textContent }],
            });
          }
        }
        for (const toolCall of msg.tool_calls) {
          if (toolCall.type === "function") {
            result.push({
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
              status: "completed",
            });
          }
        }
        continue;
      }

      if (typeof msg.content === "string") {
        result.push({
          type: "message",
          role: msg.role,
          content: [
            {
              type: msg.role === "user" ? "input_text" : "output_text",
              text: msg.content,
            },
          ],
        });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const convertedContent = msg.content.map((block: any) => {
          if (block.type === "text") {
            return {
              type: msg.role === "user" ? "input_text" : "output_text",
              text: block.text,
            };
          }
          if (block.type === "image_url") {
            const imageUrl =
              typeof block.image_url === "string"
                ? block.image_url
                : block.image_url?.url || block.image_url;
            return { type: "input_image", image_url: imageUrl };
          }
          return block;
        });
        result.push({ type: "message", role: msg.role, content: convertedContent });
        continue;
      }

      if (msg.role) {
        result.push({ type: "message", ...msg });
      } else {
        result.push(msg);
      }
    }

    return result;
  }
}
