/**
 * OpenAI adapter for handling model-specific behaviors
 *
 * Handles:
 * - Mapping 'thinking.budget_tokens' to 'reasoning_effort' for o1/o3 models
 * - Tool name truncation (OpenAI enforces 64-char limit on function names)
 */

import { BaseModelAdapter, AdapterResult } from "./base-adapter.js";
import { log } from "../logger.js";

export class OpenAIAdapter extends BaseModelAdapter {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // OpenAI models return standard content, no XML parsing needed for tool calls
    // (OpenRouter handles standard tool_calls mapping for us)
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * OpenAI enforces a 64-character limit on tool/function names.
   */
  override getToolNameLimit(): number | null {
    return 64;
  }

  /**
   * Handle request preparation:
   * - Map reasoning parameters (thinking budget -> reasoning_effort)
   * - Truncate tool names that exceed OpenAI's 64-char limit
   */
  override prepareRequest(request: any, originalRequest: any): any {
    // Handle mapping of 'thinking' parameter from Claude (budget_tokens) to reasoning_effort
    if (originalRequest.thinking) {
      const { budget_tokens } = originalRequest.thinking;

      // Logic for mapping budget to effort
      // < 4000: minimal
      // 4000 - 15999: low
      // 16000 - 31999: medium
      // >= 32000: high
      let effort = "medium";

      if (budget_tokens < 4000) effort = "minimal";
      else if (budget_tokens < 16000) effort = "low";
      else if (budget_tokens >= 32000) effort = "high";

      // Special case: GPT-5-codex might not support minimal (per notes), but we'll try to follow budget
      // The API should degrade gracefully if minimal isn't supported, or we could add a model check here

      // Responses API uses { reasoning: { effort } }, Chat Completions uses { reasoning_effort }
      if (request.input) {
        // Responses API format (detected by presence of 'input' instead of 'messages')
        request.reasoning = { effort };
        log(`[OpenAIAdapter] Mapped budget ${budget_tokens} -> reasoning.effort: ${effort} (Responses API)`);
      } else {
        // Chat Completions API format
        request.reasoning_effort = effort;
        log(`[OpenAIAdapter] Mapped budget ${budget_tokens} -> reasoning_effort: ${effort}`);
      }

      // Cleanup: Remove raw thinking object as we've translated it
      delete request.thinking;
    }

    // Truncate tool names that exceed OpenAI's 64-char limit
    this.truncateToolNames(request);

    // Also truncate in message history (assistant tool_calls)
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }
    // For Responses API format, messages are in request.input
    if (request.input) {
      this.truncateToolNamesInMessages(request.input);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return (
      lower.startsWith("oai/") ||
      lower.startsWith("openai/") ||
      lower.includes("gpt-") ||
      lower.includes("gpt4") ||
      lower.includes("o1") ||
      lower.includes("o3") ||
      lower.includes("o4") ||
      lower.includes("codex") ||
      lower.includes("chatgpt")
    );
  }

  getName(): string {
    return "OpenAIAdapter";
  }
}
