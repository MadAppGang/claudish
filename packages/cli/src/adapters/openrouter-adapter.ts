/**
 * OpenRouter Format Adapter
 *
 * Extends OpenAI format with OpenRouter-specific behaviors:
 * - Model-specific system prompts (Grok XML fix, Gemini reasoning suppression)
 * - include_reasoning for models that support it
 * - removeUriFormat on tool schemas
 * - Thinking config passthrough
 */

import { OpenAIFormatAdapter } from "./openai-format-adapter.js";
import { removeUriFormat } from "../transform.js";
import { parseModelSpec } from "../providers/model-parser.js";

export class OpenRouterAdapter extends OpenAIFormatAdapter {

  override getName(): string {
    return "OpenRouterAdapter";
  }

  // ─── Message conversion with model-specific system prompts ─────────

  override convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    const messages = super.convertMessages(claudeRequest, filterIdentityFn);

    // Add model-specific system prompt tweaks
    if (this.modelId.includes("grok") || this.modelId.includes("x-ai")) {
      const msg =
        "IMPORTANT: When calling tools, you MUST use the OpenAI tool_calls format with JSON. NEVER use XML format like <xai:function_call>.";
      this.appendToSystemPrompt(messages, msg);
    }

    if (this.modelId.includes("gemini") || this.modelId.includes("google/")) {
      const geminiMsg = `CRITICAL INSTRUCTION FOR OUTPUT FORMAT:
1. Keep ALL internal reasoning INTERNAL. Never output your thought process as visible text.
2. Do NOT start responses with phrases like "Wait, I'm...", "Let me think...", "Okay, so...", "First, I need to..."
3. Do NOT output numbered planning steps or internal debugging statements.
4. Only output: final responses, tool calls, and code. Nothing else.
5. When calling tools, proceed directly without announcing your intentions.
6. Your internal thinking should use the reasoning/thinking API, not visible text output.`;
      this.appendToSystemPrompt(messages, geminiMsg);
    }

    return messages;
  }

  private appendToSystemPrompt(messages: any[], text: string): void {
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content += "\n\n" + text;
    } else {
      messages.unshift({ role: "system", content: text });
    }
  }

  // ─── Tool conversion with uri format removal ──────────────────────

  override convertTools(claudeRequest: any, _summarize = false): any[] {
    return (
      claudeRequest.tools?.map((tool: any) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: removeUriFormat(tool.input_schema),
        },
      })) || []
    );
  }

  // ─── Payload with OpenRouter-specific fields ───────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload = super.buildPayload(claudeRequest, messages, tools);

    // Include reasoning for models that support it
    if (this.modelSupportsReasoning()) {
      payload.include_reasoning = true;
    }

    // Pass through thinking config
    if (claudeRequest.thinking) {
      payload.thinking = claudeRequest.thinking;
    }

    return payload;
  }

  /** Synchronous reasoning support check via model ID patterns */
  private modelSupportsReasoning(): boolean {
    const model = parseModelSpec(this.modelId).model.toLowerCase();
    return model.startsWith("o1") || model.startsWith("o3") ||
      model.startsWith("r1") || model.startsWith("qwq") ||
      model.includes("reasoning");
  }
}
