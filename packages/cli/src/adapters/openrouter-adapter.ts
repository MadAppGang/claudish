/**
 * OpenRouter Adapter
 *
 * Wraps a model-specific adapter (Grok, Gemini, Deepseek, etc.) and adds
 * OpenRouter-specific behaviors:
 * - Model-specific system prompts (Grok XML fix, Gemini reasoning suppression)
 * - stream_options: { include_usage: true }
 * - include_reasoning for models that support it
 * - removeUriFormat on tool schemas
 * - Tool choice mapping from Claude format
 */

import { BaseModelAdapter, type AdapterResult } from "./base-adapter.js";
import { AdapterManager } from "./adapter-manager.js";
import { removeUriFormat } from "../transform.js";
import { log } from "../logger.js";

export class OpenRouterAdapter extends BaseModelAdapter {
  private innerAdapter: BaseModelAdapter;

  constructor(modelId: string) {
    super(modelId);

    // Get model-specific adapter (GrokAdapter, GeminiAdapter, etc.)
    const manager = new AdapterManager(modelId);
    this.innerAdapter = manager.getAdapter();
  }

  /** Synchronous reasoning support check via model ID patterns */
  private modelSupportsReasoning(): boolean {
    const id = this.modelId.toLowerCase();
    return (
      id.includes("o1") ||
      id.includes("o3") ||
      id.includes("r1") ||
      id.includes("qwq") ||
      id.includes("reasoning")
    );
  }

  // ─── Text processing delegates to inner adapter ───────────────────

  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return this.innerAdapter.processTextContent(textContent, accumulatedText);
  }

  shouldHandle(modelId: string): boolean {
    return true; // Always used explicitly
  }

  getName(): string {
    return `OpenRouterAdapter(${this.innerAdapter.getName()})`;
  }

  override reset(): void {
    super.reset();
    this.innerAdapter.reset();
  }

  // ─── Message conversion with model-specific system prompts ─────────

  override convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    // Use default OpenAI conversion
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

  override convertTools(claudeRequest: any, summarize = false): any[] {
    // Convert to OpenAI format, but strip uri format from schemas
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
    const payload: any = {
      model: this.modelId,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      max_tokens: claudeRequest.max_tokens,
      stream_options: { include_usage: true },
    };

    if (tools.length > 0) {
      payload.tools = tools;
    }

    // Include reasoning for models that support it
    if (this.modelSupportsReasoning()) {
      payload.include_reasoning = true;
    }

    // Pass through thinking config
    if (claudeRequest.thinking) {
      payload.thinking = claudeRequest.thinking;
    }

    // Tool choice mapping from Claude format
    if (claudeRequest.tool_choice) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        payload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        payload.tool_choice = type;
      }
    }

    return payload;
  }

  // ─── Delegate prepareRequest to inner adapter ──────────────────────

  override prepareRequest(request: any, originalRequest: any): any {
    return this.innerAdapter.prepareRequest(request, originalRequest);
  }

  override getToolNameMap(): Map<string, string> {
    // Merge maps from both adapters
    const map = new Map(super.getToolNameMap());
    for (const [k, v] of this.innerAdapter.getToolNameMap()) {
      map.set(k, v);
    }
    return map;
  }

  /** Expose reasoning details extraction for Gemini via OpenRouter */
  extractThoughtSignaturesFromReasoningDetails(reasoningDetails: any[]): Map<string, string> {
    if (
      typeof (this.innerAdapter as any).extractThoughtSignaturesFromReasoningDetails === "function"
    ) {
      return (this.innerAdapter as any).extractThoughtSignaturesFromReasoningDetails(
        reasoningDetails
      );
    }
    return new Map();
  }
}
