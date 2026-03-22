/**
 * CodexAPIFormat — Layer 1 wire format for the OpenAI Responses API.
 *
 * The Responses API is a distinct wire format from Chat Completions:
 * - Uses 'input' instead of 'messages'
 * - Uses 'instructions' instead of 'system' messages
 * - Uses 'max_output_tokens' instead of 'max_tokens'
 * - Tools are flattened (no 'function' wrapper)
 * - SSE events use different event names (response.output_text.delta etc.)
 *
 * This format handles Codex-family and Responses-only OpenAI models.
 */

import { BaseAPIFormat, type AdapterResult, matchesModelFamily } from "./base-api-format.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { log } from "../logger.js";
import { resolveOpenAIReasoningEffort } from "./openai-reasoning.js";

export class CodexAPIFormat extends BaseAPIFormat {
  constructor(modelId: string) {
    super(modelId);
  }

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "codex");
  }

  getName(): string {
    return "CodexAPIFormat";
  }

  override getStreamFormat(): StreamFormat {
    return "openai-responses-sse";
  }

  override prepareRequest(request: any, originalRequest: any): any {
    const reasoning = resolveOpenAIReasoningEffort(this.modelId, originalRequest);
    if (reasoning) {
      request.reasoning = { effort: reasoning.effort };
      delete request.thinking;
      log(`[CodexAPIFormat] Mapped ${reasoning.source} -> reasoning.effort: ${reasoning.effort}`);
    }

    this.truncateToolNames(request);
    return request;
  }

  override getContextWindow(): number {
    // Codex models: use a safe default
    return 200_000;
  }

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
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

    const reasoning = resolveOpenAIReasoningEffort(this.modelId, claudeRequest);
    if (reasoning) {
      payload.reasoning = { effort: reasoning.effort };
      log(`[CodexAPIFormat] Mapped ${reasoning.source} -> reasoning.effort: ${reasoning.effort}`);
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

  // ─── Private helpers ───────────────────────────────────────────────

  /**
   * Convert Chat Completions format messages to Responses API format.
   * System messages go to 'instructions' field (handled by buildPayload).
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

// Backward-compatible alias
/** @deprecated Use CodexAPIFormat */
export { CodexAPIFormat as CodexAdapter };
