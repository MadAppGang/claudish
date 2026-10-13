/**
 * OpenRouterAPIFormat — Layer 1 wire format for OpenRouter API.
 *
 * Wraps a model-specific dialect (Grok, Gemini, Deepseek, etc.) and adds
 * OpenRouter-specific behaviors:
 * - Model-specific system prompts (Grok XML fix, Gemini reasoning suppression)
 * - stream_options: { include_usage: true }
 * - include_reasoning for models that support it
 * - the shared OpenAI tool-schema sanitizer
 * - Tool choice mapping from Claude format
 */

import {
  convertToolsToOpenAI,
  mapToolChoiceToOpenAI,
} from "../handlers/shared/format/openai-tools.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { type AdapterResult, BaseAPIFormat, DefaultAPIFormat } from "./base-api-format.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";

export class OpenRouterAPIFormat extends BaseAPIFormat {
  private innerAdapter: BaseAPIFormat;
  /**
   * The model's vendor, from its catalog connection (`""` when the catalog
   * names none or the model is not in the catalog). The upstream family's
   * fixes key on it; nothing here is chosen by the model name, and reasoning
   * is the connection wire's (step 5w).
   */
  private readonly vendor: string;

  constructor(modelId: string, options: { vendor: string }) {
    super(modelId);
    this.vendor = options.vendor;
    this.setUpstreamVendor(options.vendor);
    this.innerAdapter =
      options.vendor === "google" ? new GeminiAPIFormat(modelId) : new DefaultAPIFormat(modelId);
  }

  // ─── Text processing delegates to inner adapter ───────────────────

  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return this.innerAdapter.processTextContent(textContent, accumulatedText);
  }

  shouldHandle(_modelId: string): boolean {
    return true; // Always used explicitly
  }

  getName(): string {
    return `OpenRouterAPIFormat(${this.innerAdapter.getName()})`;
  }

  override reset(): void {
    super.reset();
    this.innerAdapter.reset();
  }

  // ─── Message conversion with model-specific system prompts ─────────

  override convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    // Use default OpenAI conversion
    const messages = super.convertMessages(claudeRequest, filterIdentityFn);

    // The Grok tool-format instruction is added by the shared converter above,
    // keyed on the connection's vendor (or the name, without a connection).

    if (this.vendor === "google") {
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
      messages[0].content += `\n\n${text}`;
    } else {
      messages.unshift({ role: "system", content: text });
    }
  }

  // ─── Tool conversion with uri format removal ──────────────────────

  override convertTools(claudeRequest: any, _summarize = false): any[] {
    // Was its own copy calling removeUriFormat directly, which skipped three
    // guards the shared sanitizer applies: the top-level oneOf/anyOf collapse,
    // the never-undefined `parameters` object, and the pattern-portability
    // strip that Claude Code 2.1.266's Artifact tool needs. OpenRouter forwards
    // to OpenAI models, so it inherits OpenAI's schema validator too.
    //
    // `summarize` stays ignored, as this override has always ignored it.
    return convertToolsToOpenAI(claudeRequest, false);
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

    const toolChoice = mapToolChoiceToOpenAI(claudeRequest.tool_choice);
    if (toolChoice !== undefined) {
      payload.tool_choice = toolChoice;
    }

    this.applyOpenAISamplingParams(payload, claudeRequest);

    return payload;
  }

  // ─── Delegate prepareRequest to inner adapter ──────────────────────

  protected override prepareRequestCommon(request: any, originalRequest: any): any {
    // Delegation runs the inner dialect's FULL template (its own common work
    // plus its own reasoning knob). OpenRouter always re-labels the wire to
    // openai-sse, so the Anthropic branch is unreachable here either way.
    return this.innerAdapter.prepareRequest(request, originalRequest);
  }

  override setResponseWireFormat(format: StreamFormat | undefined): void {
    // The inner adapter runs its OWN prepareRequest template (above), so it
    // encodes into its own bindings and needs the same answer to "can this
    // response be decoded". Without this it would fall back to its dialect's
    // self-declared `getStreamFormat()`.
    super.setResponseWireFormat(format);
    this.innerAdapter.setResponseWireFormat(format);
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
