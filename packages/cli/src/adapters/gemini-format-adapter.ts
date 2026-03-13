/**
 * GeminiFormatAdapter — Gemini wire format conversion.
 *
 * Handles Gemini-specific serialization:
 * - Message conversion: Claude → Gemini parts format (user→user, assistant→model)
 * - Tool conversion: Claude tools → Gemini function declarations
 * - Payload building: generationConfig, systemInstruction, thinkingConfig
 * - thoughtSignature tracking across requests (required for Gemini 3/2.5 thinking)
 *
 * Does NOT handle: reasoning text filtering (that's GeminiModelAdapter's job).
 *
 * Used with GeminiApiKeyTransport (direct API) and GeminiCodeAssistTransport (OAuth).
 */

import { FormatAdapter } from "./format-adapter.js";
import { convertToolsToGemini } from "../handlers/shared/gemini-schema.js";
import { filterIdentity } from "../handlers/shared/openai-compat.js";
import { log } from "../logger.js";

export class GeminiFormatAdapter extends FormatAdapter {
  /**
   * Map of tool_use_id → { name, thoughtSignature }.
   * Persists across requests (NOT cleared in reset) because Gemini requires
   * thoughtSignatures from previous responses to be echoed back in subsequent requests.
   */
  private toolCallMap = new Map<string, { name: string; thoughtSignature?: string }>();

  constructor(modelId: string) {
    super(modelId);
  }

  getName(): string {
    return "GeminiFormatAdapter";
  }

  // ─── Message Conversion (Claude → Gemini parts) ─────────────────

  override convertMessages(claudeRequest: any, _filterIdentityFn?: (s: string) => string): any[] {
    const messages: any[] = [];

    if (claudeRequest.messages) {
      for (const msg of claudeRequest.messages) {
        if (msg.role === "user") {
          const parts = this.convertUserParts(msg);
          if (parts.length > 0) messages.push({ role: "user", parts });
        } else if (msg.role === "assistant") {
          const parts = this.convertAssistantParts(msg);
          if (parts.length > 0) messages.push({ role: "model", parts });
        }
      }
    }

    return messages;
  }

  private convertUserParts(msg: any): any[] {
    const parts: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
        } else if (block.type === "tool_result") {
          const toolInfo = this.toolCallMap.get(block.tool_use_id);
          if (!toolInfo) {
            log(`[GeminiFormatAdapter] Warning: No function name found for tool_use_id ${block.tool_use_id}`);
            continue;
          }
          parts.push({
            functionResponse: {
              name: toolInfo.name,
              response: {
                content:
                  typeof block.content === "string" ? block.content : JSON.stringify(block.content),
              },
            },
          });
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }

    return parts;
  }

  private convertAssistantParts(msg: any): any[] {
    const parts: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          // Look up stored thoughtSignature for this tool call
          const toolInfo = this.toolCallMap.get(block.id);
          let thoughtSignature = toolInfo?.thoughtSignature;

          // If no signature found, use dummy to skip validation.
          // Required for Gemini 3/2.5 with thinking enabled.
          if (!thoughtSignature) {
            thoughtSignature = "skip_thought_signature_validator";
            log(`[GeminiFormatAdapter] Using dummy thoughtSignature for tool ${block.name} (${block.id})`);
          }

          const functionCallPart: any = {
            functionCall: {
              name: block.name,
              args: block.input,
            },
          };

          if (thoughtSignature) {
            functionCallPart.thoughtSignature = thoughtSignature;
          }

          // Ensure tool is tracked in our map (for tool_result lookups)
          if (!this.toolCallMap.has(block.id)) {
            this.toolCallMap.set(block.id, { name: block.name, thoughtSignature });
          }

          parts.push(functionCallPart);
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }

    return parts;
  }

  // ─── Tool Conversion ──────────────────────────────────────────────

  override convertTools(claudeRequest: any, _summarize = false): any[] {
    const result = convertToolsToGemini(claudeRequest.tools);
    return result || [];
  }

  // ─── Payload Building ─────────────────────────────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      contents: messages,
      generationConfig: {
        temperature: claudeRequest.temperature ?? 1,
        maxOutputTokens: claudeRequest.max_tokens,
      },
    };

    // System instruction
    if (claudeRequest.system) {
      let systemContent = Array.isArray(claudeRequest.system)
        ? claudeRequest.system.map((i: any) => i.text || i).join("\n\n")
        : claudeRequest.system;
      systemContent = filterIdentity(systemContent);

      // Gemini-specific reasoning suppression
      systemContent += `\n\nCRITICAL INSTRUCTION FOR OUTPUT FORMAT:
1. Keep ALL internal reasoning INTERNAL. Never output your thought process as visible text.
2. Do NOT start responses with phrases like "Wait, I'm...", "Let me think...", "Okay, so..."
3. Only output: final responses, tool calls, and code. Nothing else.`;

      payload.systemInstruction = { parts: [{ text: systemContent }] };
    }

    // Tools
    if (tools && tools.length > 0) {
      payload.tools = tools;
    }

    // Thinking/reasoning configuration
    if (claudeRequest.thinking) {
      const { budget_tokens } = claudeRequest.thinking;

      if (this.modelId.includes("gemini-3")) {
        payload.generationConfig.thinkingConfig = {
          thinkingLevel: budget_tokens >= 16000 ? "high" : "low",
        };
      } else {
        const MAX_GEMINI_BUDGET = 24576;
        payload.generationConfig.thinkingConfig = {
          thinkingBudget: Math.min(budget_tokens, MAX_GEMINI_BUDGET),
        };
      }
    }

    return payload;
  }

  // ─── Tool Call Registration (called by stream parser) ─────────────

  registerToolCall(toolId: string, name: string, thoughtSignature?: string): void {
    this.toolCallMap.set(toolId, { name, thoughtSignature });
    if (thoughtSignature) {
      log(`[GeminiFormatAdapter] Captured thoughtSignature for tool ${name} (${toolId})`);
    }
  }

  // ─── Model metadata ─────────────────────────────────────────────

  override getContextWindow(): number {
    return 1_000_000;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  /** toolCallMap is intentionally NOT cleared — persists across requests */
  override reset(): void {
    super.reset();
  }

  // ─── ThoughtSignature accessors ─────────────────────────────────

  extractThoughtSignaturesFromReasoningDetails(
    reasoningDetails: any[] | undefined
  ): Map<string, string> {
    const extracted = new Map<string, string>();
    if (!reasoningDetails || !Array.isArray(reasoningDetails)) return extracted;

    for (const detail of reasoningDetails) {
      if (detail?.type === "reasoning.encrypted" && detail.id && detail.data) {
        this.toolCallMap.set(detail.id, {
          name: this.toolCallMap.get(detail.id)?.name || "",
          thoughtSignature: detail.data,
        });
        extracted.set(detail.id, detail.data);
      }
    }

    return extracted;
  }

  getThoughtSignature(toolCallId: string): string | undefined {
    return this.toolCallMap.get(toolCallId)?.thoughtSignature;
  }

  hasThoughtSignature(toolCallId: string): boolean {
    return this.toolCallMap.has(toolCallId) && !!this.toolCallMap.get(toolCallId)?.thoughtSignature;
  }

  getAllThoughtSignatures(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [id, info] of this.toolCallMap) {
      if (info.thoughtSignature) result.set(id, info.thoughtSignature);
    }
    return result;
  }
}
