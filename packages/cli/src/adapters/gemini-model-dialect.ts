/**
 * GeminiModelDialect — Gemini model-specific quirks (Layer 2 dialect).
 *
 * Handles reasoning text filtering: Gemini sometimes leaks internal monologue
 * as regular text instead of keeping it in thinking blocks.
 *
 * Applied regardless of transport path (direct Gemini API, OpenRouter, LiteLLM).
 */

import { BaseModelDialect } from "./base-model-dialect.js";
import type { AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";

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

export class GeminiModelDialect extends BaseModelDialect {
  private inReasoningBlock = false;
  private reasoningBlockDepth = 0;

  getName(): string {
    return "GeminiModelDialect";
  }

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

      if (REASONING_PATTERNS.some((p) => p.test(trimmed))) {
        log(`[GeminiModelDialect] Filtered reasoning: "${trimmed.substring(0, 50)}..."`);
        wasFiltered = true;
        this.inReasoningBlock = true;
        this.reasoningBlockDepth++;
        continue;
      }

      if (this.inReasoningBlock && REASONING_CONTINUATION_PATTERNS.some((p) => p.test(trimmed))) {
        log(
          `[GeminiModelDialect] Filtered reasoning continuation: "${trimmed.substring(0, 50)}..."`
        );
        wasFiltered = true;
        continue;
      }

      if (
        this.inReasoningBlock &&
        trimmed.length > 20 &&
        !REASONING_CONTINUATION_PATTERNS.some((p) => p.test(trimmed))
      ) {
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

  override reset(): void {
    this.inReasoningBlock = false;
    this.reasoningBlockDepth = 0;
  }

  override getContextWindow(): number {
    return 1_048_576; // Gemini models have 1M context (2^20 tokens)
  }
}
