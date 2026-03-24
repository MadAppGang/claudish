/**
 * OpenRouterAPIFormat — Layer 1 wire format for OpenRouter API.
 *
 * Wraps a model-specific dialect (Grok, Gemini, Deepseek, etc.) and adds
 * OpenRouter-specific behaviors:
 * - Model-specific system prompts (Grok XML fix, Gemini reasoning suppression)
 * - stream_options: { include_usage: true }
 * - include_reasoning for models that support it
 * - removeUriFormat on tool schemas
 * - Tool choice mapping from Claude format
 */

import { BaseAPIFormat, type AdapterResult } from "./base-api-format.js";
import { resolveModelDialect } from "../providers/provider-profiles.js";
import { removeUriFormat } from "../transform.js";
import { log } from "../logger.js";

export class OpenRouterAPIFormat extends BaseAPIFormat {
  private innerAdapter: BaseAPIFormat;

  constructor(modelId: string) {
    super(modelId);

    // Get model-specific dialect (GrokModelDialect, GeminiAPIFormat, etc.)
    this.innerAdapter = resolveModelDialect(modelId);
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

  getName(): string {
    return `OpenRouterAPIFormat(${this.innerAdapter.getName()})`;
  }

  override reset(): void {
    super.reset();
    this.innerAdapter.reset();
  }

  // Model-specific system prompts are handled by the inner dialect's prepareRequest()
  // (GrokModelDialect injects tool format instruction, GeminiModelDialect injects output format)

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

// Backward-compatible alias
/** @deprecated Use OpenRouterAPIFormat */
export { OpenRouterAPIFormat as OpenRouterAdapter };
