/**
 * GrokModelDialect — Layer 2 dialect for xAI Grok models.
 *
 * Translates xAI XML function calls to Claude Code tool_calls:
 * <xai:function_call name="ToolName">
 *   <xai:parameter name="param1">value1</xai:parameter>
 *   <xai:parameter name="param2">value2</xai:parameter>
 * </xai:function_call>
 *
 * This dialect translates that to Claude Code's expected tool_calls format.
 */

import { BaseModelDialect } from "./base-model-dialect.js";
import type { AdapterResult, ToolCall } from "./base-api-format.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";

export class GrokModelDialect extends BaseModelDialect {
  private xmlBuffer: string = "";

  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // Accumulate text to handle XML split across multiple chunks
    this.xmlBuffer += textContent;

    // Pattern to match complete xAI function calls
    const xmlPattern = /<xai:function_call name="([^"]+)">(.*?)<\/xai:function_call>/gs;
    const matches = [...this.xmlBuffer.matchAll(xmlPattern)];

    if (matches.length === 0) {
      // No complete XML function calls found yet
      // Check if we have a partial XML opening tag
      const hasPartialXml = this.xmlBuffer.includes("<xai:function_call");

      if (hasPartialXml) {
        // Keep accumulating, don't send text yet
        return {
          cleanedText: "",
          extractedToolCalls: [],
          wasTransformed: false,
        };
      }

      // Normal text, not XML
      const result = {
        cleanedText: this.xmlBuffer,
        extractedToolCalls: [],
        wasTransformed: false,
      };
      this.xmlBuffer = ""; // Clear buffer
      return result;
    }

    // Extract tool calls from XML
    const toolCalls: ToolCall[] = matches.map((match) => {
      const toolName = match[1];
      const xmlParams = match[2];

      return {
        id: `grok_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: toolName,
        arguments: this.parseXmlParameters(xmlParams),
      };
    });

    // Remove XML from text and get any remaining content
    let cleanedText = this.xmlBuffer;
    for (const match of matches) {
      cleanedText = cleanedText.replace(match[0], "");
    }

    // Clear buffer for next chunk
    this.xmlBuffer = "";

    return {
      cleanedText: cleanedText.trim(),
      extractedToolCalls: toolCalls,
      wasTransformed: true,
    };
  }

  /**
   * Handle request preparation - specifically for mapping reasoning parameters
   */
  override prepareRequest(request: any, originalRequest: any): any {
    const modelId = this.modelId || "";

    if (originalRequest.thinking) {
      // Only Grok 3 Mini supports reasoning_effort
      const supportsReasoningEffort = modelId.includes("mini");

      if (supportsReasoningEffort) {
        // Map budget to reasoning_effort (supported: low, high)
        // using 20k as threshold based on typical extensive reasoning
        const { budget_tokens } = originalRequest.thinking;
        const effort = budget_tokens >= 20000 ? "high" : "low";

        request.reasoning_effort = effort;
        log(`[GrokModelDialect] Mapped budget ${budget_tokens} -> reasoning_effort: ${effort}`);
      } else {
        log(`[GrokModelDialect] Model ${modelId} does not support reasoning params. Stripping.`);
      }

      // Always remove raw thinking object for Grok to avoid API errors
      delete request.thinking;
    }

    return request;
  }

  /**
   * Parse xAI parameter XML format to JSON arguments
   * Handles: <xai:parameter name="key">value</xai:parameter>
   */
  private parseXmlParameters(xmlContent: string): Record<string, any> {
    const params: Record<string, any> = {};
    const paramPattern = /<xai:parameter name="([^"]+)">([^<]*)<\/xai:parameter>/g;

    let match;
    while ((match = paramPattern.exec(xmlContent)) !== null) {
      const paramName = match[1];
      const paramValue = match[2];

      // Try to parse as JSON (for objects/arrays), otherwise use as string
      try {
        params[paramName] = JSON.parse(paramValue);
      } catch {
        // Not valid JSON, use as string
        params[paramName] = paramValue;
      }
    }

    return params;
  }

  getName(): string {
    return "GrokModelDialect";
  }

  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 131_072;
  }

  /**
   * Reset internal state (useful between requests)
   */
  reset(): void {
    this.xmlBuffer = "";
  }
}

// Backward-compatible alias
/** @deprecated Use GrokModelDialect */
export { GrokModelDialect as GrokAdapter };
