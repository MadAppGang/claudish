/**
 * OpenAIFormatAdapter — OpenAI Chat Completions / Responses API wire format.
 *
 * Handles:
 * - Chat Completions payload building (stream_options, max_completion_tokens)
 * - Codex Responses API message conversion and payload building
 * - reasoning_effort mapping for o1/o3 models
 * - Tool name truncation (64-char limit)
 * - Tool choice mapping from Claude format
 *
 * Used as the base format for: OpenAI direct, GitHub Models, xAI, Kimi, ZAI.
 */

import { FormatAdapter } from "./format-adapter.js";
import { parseModelSpec } from "../providers/model-parser.js";
import { log } from "../logger.js";

export class OpenAIFormatAdapter extends FormatAdapter {
  private providerCapabilities?: { supportsVision?: boolean };

  constructor(modelId: string, providerCapabilities?: { supportsVision?: boolean }) {
    super(modelId);
    this.providerCapabilities = providerCapabilities;
  }

  getName(): string {
    return "OpenAIFormatAdapter";
  }

  override getToolNameLimit(): number | null {
    return 64;
  }

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
      log(`[OpenAIFormatAdapter] Mapped budget ${budget_tokens} -> reasoning_effort: ${effort}`);
    }

    // Truncate tool names if model has a limit
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    if (this.isCodexModel()) {
      return this.buildResponsesPayload(claudeRequest, messages, tools);
    }
    return this.buildChatCompletionsPayload(claudeRequest, messages, tools);
  }

  override supportsVision(): boolean {
    if (this.providerCapabilities && this.providerCapabilities.supportsVision === false) {
      return false;
    }
    return true;
  }

  override getContextWindow(): number {
    const m = this.bareModel;
    if (m.startsWith("gpt-5")) return 256_000;
    if (m.startsWith("o1") || m.startsWith("o3")) return 200_000;
    if (m.startsWith("gpt-4o") || m.startsWith("gpt-4-turbo")) return 128_000;
    if (m.startsWith("gpt-3.5")) return 16_385;
    return 128_000;
  }

  // ─── Private helpers ───────────────────────────────────────────────

  /** Bare model name (vendor prefix stripped, lowercased). Cached. */
  private _bareModel: string | null = null;
  protected get bareModel(): string {
    if (this._bareModel === null) {
      this._bareModel = parseModelSpec(this.modelId).model.toLowerCase();
    }
    return this._bareModel;
  }

  protected isReasoningModel(): boolean {
    return this.bareModel.startsWith("o1") || this.bareModel.startsWith("o3");
  }

  protected isCodexModel(): boolean {
    return this.bareModel.startsWith("codex");
  }

  protected usesMaxCompletionTokens(): boolean {
    return (
      this.bareModel.startsWith("gpt-5") ||
      this.bareModel.startsWith("o1") ||
      this.bareModel.startsWith("o3") ||
      this.bareModel.startsWith("o4")
    );
  }

  protected buildChatCompletionsPayload(claudeRequest: any, messages: any[], tools: any[]): any {
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

    // Reasoning params for o1/o3
    if (claudeRequest.thinking && this.isReasoningModel()) {
      const { budget_tokens } = claudeRequest.thinking;
      let effort = "medium";
      if (budget_tokens < 4000) effort = "minimal";
      else if (budget_tokens < 16000) effort = "low";
      else if (budget_tokens >= 32000) effort = "high";
      payload.reasoning_effort = effort;
      log(`[OpenAIFormatAdapter] Mapped thinking.budget_tokens ${budget_tokens} -> reasoning_effort: ${effort}`);
    }

    return payload;
  }

  protected buildResponsesPayload(claudeRequest: any, messages: any[], tools: any[]): any {
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

  protected convertMessagesToResponsesAPI(messages: any[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue;

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
