/**
 * Gemini Adapter
 *
 * Handles Gemini-specific transformations:
 * - Message conversion: Claude → Gemini parts format (user→user, assistant→model)
 * - Tool conversion: Claude tools → Gemini function declarations
 * - Payload building: generationConfig, systemInstruction, thinkingConfig
 * - thoughtSignature tracking across requests (required for Gemini 3/2.5 thinking)
 * - Reasoning text filtering (removes leaked internal monologue)
 *
 * Used with GeminiApiKeyProvider (direct API) and GeminiCodeAssistProvider (OAuth).
 */

import { BaseModelAdapter, type AdapterResult } from "./base-adapter.js";
import { convertToolsToGemini } from "../handlers/shared/gemini-schema.js";
import { filterIdentity } from "../handlers/shared/openai-compat.js";
import { log } from "../logger.js";

/**
 * Patterns that indicate internal reasoning/monologue that should be filtered.
 * Gemini sometimes leaks reasoning as regular text instead of keeping it in thinking blocks.
 */
const REASONING_PATTERNS = [
  /^Wait,?\s+I(?:'m|\s+am)\s+\w+ing\b/i,
  /^Wait,?\s+(?:if|that|the|this|I\s+(?:need|should|will|have|already))/i,
  /^Wait[.!]?\s*$/i,
  /^Let\s+me\s+(think|check|verify|see|look|analyze|consider|first|start)/i,
  /^Let's\s+(check|see|look|start|first|try|think|verify|examine|analyze)/i,
  /^I\s+need\s+to\s+/i,
  /^O[kK](?:ay)?[.,!]?\s*(?:so|let|I|now|first)?/i,
  /^[Hh]mm+/,
  /^So[,.]?\s+(?:I|let|first|now|the)/i,
  /^(?:First|Next|Then|Now)[,.]?\s+(?:I|let|we)/i,
  /^(?:Thinking\s+about|Considering)/i,
  /^I(?:'ll|\s+will)\s+(?:first|now|start|begin|try|check|fix|look|examine|modify|create|update|read|investigate|adjust|improve|integrate|mark|also|verify|need|rethink|add|help|use|run|search|find|explore|analyze|review|test|implement|write|make|set|get|see|open|close|save|load|fetch|call|send|build|compile|execute|process|handle|parse|format|validate|clean|clear|remove|delete|move|copy|rename|install|configure|setup|initialize|prepare|work|continue|proceed|ensure|confirm)/i,
  /^I\s+should\s+/i,
  /^I\s+will\s+(?:first|now|start|verify|check|create|modify|look|need|also|add|help|use|run|search|find|explore|analyze|review|test|implement|write)/i,
  /^(?:Debug|Checking|Verifying|Looking\s+at):/i,
  /^I\s+also\s+(?:notice|need|see|want)/i,
  /^The\s+(?:goal|issue|problem|idea|plan)\s+is/i,
  /^In\s+the\s+(?:old|current|previous|new|existing)\s+/i,
  /^`[^`]+`\s+(?:is|has|does|needs|should|will|doesn't|hasn't)/i,
];

const REASONING_CONTINUATION_PATTERNS = [
  /^And\s+(?:then|I|now|so)/i,
  /^And\s+I(?:'ll|\s+will)/i,
  /^But\s+(?:I|first|wait|actually|the|if)/i,
  /^Actually[,.]?\s+/i,
  /^Also[,.]?\s+(?:I|the|check|note)/i,
  /^\d+\.\s+(?:I|First|Check|Run|Create|Update|Read|Modify|Add|Fix|Look)/i,
  /^-\s+(?:I|First|Check|Run|Create|Update|Read|Modify|Add|Fix)/i,
  /^Or\s+(?:I|just|we|maybe|perhaps)/i,
  /^Since\s+(?:I|the|this|we|it)/i,
  /^Because\s+(?:I|the|this|we|it)/i,
  /^If\s+(?:I|the|this|we|it)\s+/i,
  /^This\s+(?:is|means|requires|should|will|confirms|suggests)/i,
  /^That\s+(?:means|is|should|will|explains|confirms)/i,
  /^Lines?\s+\d+/i,
  /^The\s+`[^`]+`\s+(?:is|has|contains|needs|should)/i,
];

export class GeminiAdapter extends BaseModelAdapter {
  /**
   * Map of tool_use_id → { name, thoughtSignature }.
   * Persists across requests (NOT cleared in reset) because Gemini requires
   * thoughtSignatures from previous responses to be echoed back in subsequent requests.
   */
  private toolCallMap = new Map<string, { name: string; thoughtSignature?: string }>();

  /** Reasoning filter state */
  private inReasoningBlock = false;
  private reasoningBlockDepth = 0;

  constructor(modelId: string) {
    super(modelId);
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
            log(
              `[GeminiAdapter] Warning: No function name found for tool_use_id ${block.tool_use_id}`
            );
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
          // Handles session recovery, migrations, or first request with history.
          if (!thoughtSignature) {
            thoughtSignature = "skip_thought_signature_validator";
            log(
              `[GeminiAdapter] Using dummy thoughtSignature for tool ${block.name} (${block.id})`
            );
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

    // Tools — convertTools returns Gemini format [{functionDeclarations: [...]}] or []
    if (tools && tools.length > 0) {
      payload.tools = tools;
    }

    // Thinking/reasoning configuration
    if (claudeRequest.thinking) {
      const { budget_tokens } = claudeRequest.thinking;

      if (this.modelId.includes("gemini-3")) {
        // Gemini 3 uses thinking_level
        payload.generationConfig.thinkingConfig = {
          thinkingLevel: budget_tokens >= 16000 ? "high" : "low",
        };
      } else {
        // Gemini 2.5 uses thinking_budget
        const MAX_GEMINI_BUDGET = 24576;
        payload.generationConfig.thinkingConfig = {
          thinkingBudget: Math.min(budget_tokens, MAX_GEMINI_BUDGET),
        };
      }
    }

    return payload;
  }

  // ─── Tool Call Registration (called by stream parser) ─────────────

  /**
   * Register a tool call from the streaming response.
   * Stores the tool ID, name, and thoughtSignature for use in subsequent requests.
   */
  registerToolCall(toolId: string, name: string, thoughtSignature?: string): void {
    this.toolCallMap.set(toolId, { name, thoughtSignature });
    if (thoughtSignature) {
      log(`[GeminiAdapter] Captured thoughtSignature for tool ${name} (${toolId})`);
    }
  }

  // ─── Text Processing (reasoning filter) ───────────────────────────

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    if (!textContent || textContent.trim() === "") {
      return { cleanedText: textContent, extractedToolCalls: [], wasTransformed: false };
    }

    const lines = textContent.split("\n");
    const cleanedLines: string[] = [];
    let wasFiltered = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        cleanedLines.push(line);
        continue;
      }

      if (this.isReasoningLine(trimmed)) {
        log(`[GeminiAdapter] Filtered reasoning: "${trimmed.substring(0, 50)}..."`);
        wasFiltered = true;
        this.inReasoningBlock = true;
        this.reasoningBlockDepth++;
        continue;
      }

      if (this.inReasoningBlock && this.isReasoningContinuation(trimmed)) {
        log(`[GeminiAdapter] Filtered reasoning continuation: "${trimmed.substring(0, 50)}..."`);
        wasFiltered = true;
        continue;
      }

      if (this.inReasoningBlock && trimmed.length > 20 && !this.isReasoningContinuation(trimmed)) {
        this.inReasoningBlock = false;
        this.reasoningBlockDepth = 0;
      }

      cleanedLines.push(line);
    }

    const cleanedText = cleanedLines.join("\n");

    return {
      cleanedText: wasFiltered ? cleanedText : textContent,
      extractedToolCalls: [],
      wasTransformed: wasFiltered,
    };
  }

  private isReasoningLine(line: string): boolean {
    return REASONING_PATTERNS.some((pattern) => pattern.test(line));
  }

  private isReasoningContinuation(line: string): boolean {
    return REASONING_CONTINUATION_PATTERNS.some((pattern) => pattern.test(line));
  }

  // ─── Adapter metadata ─────────────────────────────────────────────

  /**
   * Reset reasoning filter state between requests.
   * NOTE: toolCallMap is intentionally NOT cleared — it persists across requests
   * because Gemini requires thoughtSignatures from previous responses.
   */
  override reset(): void {
    this.inReasoningBlock = false;
    this.reasoningBlockDepth = 0;
    // Do NOT clear toolCallMap or toolNameMap
  }

  override getContextWindow(): number {
    return 1_000_000; // Gemini models have 1M context
  }

  shouldHandle(modelId: string): boolean {
    return modelId.includes("gemini") || modelId.includes("google/");
  }

  getName(): string {
    return "GeminiAdapter";
  }

  /**
   * Extract thought signatures from reasoning_details (OpenRouter path).
   * Not used in the native Gemini path — only relevant when Gemini models
   * are accessed through OpenRouter which translates to OpenAI format.
   */
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

  /** Get a thought signature for a specific tool call ID */
  getThoughtSignature(toolCallId: string): string | undefined {
    return this.toolCallMap.get(toolCallId)?.thoughtSignature;
  }

  /** Check if we have a thought signature for a tool call */
  hasThoughtSignature(toolCallId: string): boolean {
    return this.toolCallMap.has(toolCallId) && !!this.toolCallMap.get(toolCallId)?.thoughtSignature;
  }

  /** Get all stored thought signatures */
  getAllThoughtSignatures(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [id, info] of this.toolCallMap) {
      if (info.thoughtSignature) result.set(id, info.thoughtSignature);
    }
    return result;
  }
}
