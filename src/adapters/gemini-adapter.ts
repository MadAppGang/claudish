/**
 * Gemini adapter for extracting thought signatures from reasoning_details
 *
 * OpenRouter translates Gemini's responses to OpenAI format but puts
 * thought_signatures in the reasoning_details array instead of tool_calls.extra_content.
 *
 * Streaming response structure from OpenRouter:
 * {
 *   "choices": [{
 *     "delta": {
 *       "tool_calls": [{...}],  // No extra_content here
 *       "reasoning_details": [{  // Thought signatures are HERE
 *         "id": "tool_123",
 *         "type": "reasoning.encrypted",
 *         "data": "<encrypted-signature>"
 *       }]
 *     }
 *   }]
 * }
 *
 * This adapter extracts signatures from reasoning_details and stores them
 * for later inclusion in tool results.
 */

import { BaseModelAdapter, AdapterResult, ToolCall } from "./base-adapter";
import { log } from "../logger";

/**
 * Patterns that indicate internal reasoning/monologue that should be filtered
 * These are common patterns Gemini uses when "thinking out loud" instead of
 * keeping reasoning internal.
 */
const REASONING_PATTERNS = [
  // "Wait, I'm X-ing" pattern (the scaling tools bug)
  /^Wait,?\s+I(?:'m|\s+am)\s+\w+ing\b/i,
  // "Wait, if/that/the/this" reasoning patterns
  /^Wait,?\s+(?:if|that|the|this|I\s+(?:need|should|will|have|already))/i,
  // Simple "Wait" or "Wait." lines
  /^Wait[.!]?\s*$/i,
  // "Let me think/check/verify" patterns
  /^Let\s+me\s+(think|check|verify|see|look|analyze|consider|first|start)/i,
  // "Let's" patterns (common in Gemini reasoning)
  /^Let's\s+(check|see|look|start|first|try|think|verify|examine|analyze)/i,
  // "I need to" reasoning
  /^I\s+need\s+to\s+/i,
  // "Okay" or "Ok" standalone or with trailing reasoning
  /^O[kK](?:ay)?[.,!]?\s*(?:so|let|I|now|first)?/i,
  // "Hmm" thinking
  /^[Hh]mm+/,
  // "So," or "So I" reasoning connectors
  /^So[,.]?\s+(?:I|let|first|now|the)/i,
  // "First," "Next," "Then," step reasoning
  /^(?:First|Next|Then|Now)[,.]?\s+(?:I|let|we)/i,
  // "Thinking about" or "Considering"
  /^(?:Thinking\s+about|Considering)/i,
  // "I should/will/ll" followed by verbs - EXPANDED to catch more patterns
  // This catches most "I'll <verb>" reasoning patterns
  /^I(?:'ll|\s+will)\s+(?:first|now|start|begin|try|check|fix|look|examine|modify|create|update|read|investigate|adjust|improve|integrate|mark|also|verify|need|rethink|add|help|use|run|search|find|explore|analyze|review|test|implement|write|make|set|get|see|open|close|save|load|fetch|call|send|build|compile|execute|process|handle|parse|format|validate|clean|clear|remove|delete|move|copy|rename|install|configure|setup|initialize|prepare|work|continue|proceed|ensure|confirm)/i,
  /^I\s+should\s+/i,
  // "I will" at start of sentence (planning statement)
  /^I\s+will\s+(?:first|now|start|verify|check|create|modify|look|need|also|add|help|use|run|search|find|explore|analyze|review|test|implement|write)/i,
  // Internal debugging statements
  /^(?:Debug|Checking|Verifying|Looking\s+at):/i,
  // "I also" observations
  /^I\s+also\s+(?:notice|need|see|want)/i,
  // "The goal is" or "The issue is" observations
  /^The\s+(?:goal|issue|problem|idea|plan)\s+is/i,
  // "In the old/current/previous" design observations
  /^In\s+the\s+(?:old|current|previous|new|existing)\s+/i,
  // Code-like reasoning with backticks followed by observations
  /^`[^`]+`\s+(?:is|has|does|needs|should|will|doesn't|hasn't)/i,
];

/**
 * Patterns that indicate a line is likely part of reasoning block
 * Used for multi-line reasoning detection
 */
const REASONING_CONTINUATION_PATTERNS = [
  // "And then" or "And I"
  /^And\s+(?:then|I|now|so)/i,
  // "And I'll" continuation
  /^And\s+I(?:'ll|\s+will)/i,
  // "But" reasoning pivots
  /^But\s+(?:I|first|wait|actually|the|if)/i,
  // "Actually" corrections
  /^Actually[,.]?\s+/i,
  // "Also" additions
  /^Also[,.]?\s+(?:I|the|check|note)/i,
  // Numbered steps (1., 2., etc) in reasoning
  /^\d+\.\s+(?:I|First|Check|Run|Create|Update|Read|Modify|Add|Fix|Look)/i,
  // Dash-prefixed steps
  /^-\s+(?:I|First|Check|Run|Create|Update|Read|Modify|Add|Fix)/i,
  // "Or" alternatives in reasoning
  /^Or\s+(?:I|just|we|maybe|perhaps)/i,
  // "Since" explanations
  /^Since\s+(?:I|the|this|we|it)/i,
  // "Because" explanations
  /^Because\s+(?:I|the|this|we|it)/i,
  // "If" conditional reasoning
  /^If\s+(?:I|the|this|we|it)\s+/i,
  // "This" observations in reasoning context
  /^This\s+(?:is|means|requires|should|will|confirms|suggests)/i,
  // "That" observations
  /^That\s+(?:means|is|should|will|explains|confirms)/i,
  // Code file references in reasoning
  /^Lines?\s+\d+/i,
  // Variable/property observations
  /^The\s+`[^`]+`\s+(?:is|has|contains|needs|should)/i,
];

export class GeminiAdapter extends BaseModelAdapter {
  // Store for thought signatures: tool_call_id -> signature
  private thoughtSignatures = new Map<string, string>();

  // Buffer for detecting multi-line reasoning blocks
  private reasoningBuffer: string[] = [];
  private inReasoningBlock = false;
  private reasoningBlockDepth = 0;

  /**
   * Process text content from Gemini, filtering out internal reasoning
   * that should not be displayed to the user.
   *
   * Gemini models (especially through OpenRouter) sometimes output their
   * internal reasoning as regular text instead of keeping it in reasoning_details.
   * This manifests as lines like:
   * - "Wait, I'm scaling tools."
   * - "Let me check the file first."
   * - "Okay, so I need to..."
   */
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // Skip empty content
    if (!textContent || textContent.trim() === "") {
      return { cleanedText: textContent, extractedToolCalls: [], wasTransformed: false };
    }

    // Check for reasoning patterns in the new content
    const lines = textContent.split("\n");
    const cleanedLines: string[] = [];
    let wasFiltered = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) {
        cleanedLines.push(line);
        continue;
      }

      // Check if this line matches reasoning patterns
      const isReasoning = this.isReasoningLine(trimmed);

      if (isReasoning) {
        log(`[GeminiAdapter] Filtered reasoning: "${trimmed.substring(0, 50)}..."`);
        wasFiltered = true;
        this.inReasoningBlock = true;
        this.reasoningBlockDepth++;
        continue; // Skip this line
      }

      // Check for reasoning continuation
      if (this.inReasoningBlock && this.isReasoningContinuation(trimmed)) {
        log(`[GeminiAdapter] Filtered reasoning continuation: "${trimmed.substring(0, 50)}..."`);
        wasFiltered = true;
        continue;
      }

      // End reasoning block on substantial non-reasoning content
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

  /**
   * Check if a line matches known reasoning patterns
   */
  private isReasoningLine(line: string): boolean {
    return REASONING_PATTERNS.some((pattern) => pattern.test(line));
  }

  /**
   * Check if a line is likely a continuation of reasoning
   */
  private isReasoningContinuation(line: string): boolean {
    return REASONING_CONTINUATION_PATTERNS.some((pattern) => pattern.test(line));
  }

  /**
   * Reset reasoning state (called between messages)
   */
  private resetReasoningState(): void {
    this.reasoningBuffer = [];
    this.inReasoningBlock = false;
    this.reasoningBlockDepth = 0;
  }

  /**
   * Handle request preparation - specifically for mapping reasoning parameters
   */
  override prepareRequest(request: any, originalRequest: any): any {
    if (originalRequest.thinking) {
      const { budget_tokens } = originalRequest.thinking;
      const modelId = this.modelId || "";

      if (modelId.includes("gemini-3")) {
        // Gemini 3 uses thinking_level
        const level = budget_tokens >= 16000 ? "high" : "low";
        request.thinking_level = level;
        log(`[GeminiAdapter] Mapped budget ${budget_tokens} -> thinking_level: ${level}`);
      } else {
        // Default to Gemini 2.5 thinking_config (also covers 2.0-flash-thinking)
        // Cap budget at max allowed (24k) to prevent errors
        const MAX_GEMINI_BUDGET = 24576;
        const budget = Math.min(budget_tokens, MAX_GEMINI_BUDGET);

        request.thinking_config = {
          thinking_budget: budget,
        };
        log(
          `[GeminiAdapter] Mapped budget ${budget_tokens} -> thinking_config.thinking_budget: ${budget}`
        );
      }

      // Cleanup: Remove raw thinking object
      delete request.thinking;
    }
    return request;
  }

  /**
   * Extract thought signatures from reasoning_details
   * This should be called when processing streaming chunks
   */
  extractThoughtSignaturesFromReasoningDetails(
    reasoningDetails: any[] | undefined
  ): Map<string, string> {
    const extracted = new Map<string, string>();

    if (!reasoningDetails || !Array.isArray(reasoningDetails)) {
      return extracted;
    }

    for (const detail of reasoningDetails) {
      if (detail && detail.type === "reasoning.encrypted" && detail.id && detail.data) {
        this.thoughtSignatures.set(detail.id, detail.data);
        extracted.set(detail.id, detail.data);
      }
    }

    return extracted;
  }

  /**
   * Get a thought signature for a specific tool call ID
   */
  getThoughtSignature(toolCallId: string): string | undefined {
    return this.thoughtSignatures.get(toolCallId);
  }

  /**
   * Check if we have a thought signature for a tool call
   */
  hasThoughtSignature(toolCallId: string): boolean {
    return this.thoughtSignatures.has(toolCallId);
  }

  /**
   * Get all stored thought signatures
   */
  getAllThoughtSignatures(): Map<string, string> {
    return new Map(this.thoughtSignatures);
  }

  /**
   * Clear stored signatures and reasoning state (call between requests)
   */
  reset(): void {
    this.thoughtSignatures.clear();
    this.resetReasoningState();
  }

  shouldHandle(modelId: string): boolean {
    return modelId.includes("gemini") || modelId.includes("google/");
  }

  getName(): string {
    return "GeminiAdapter";
  }
}
