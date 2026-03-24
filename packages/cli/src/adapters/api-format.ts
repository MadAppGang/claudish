/**
 * APIFormat — translates between Claude API format and target model's wire format.
 *
 * Each implementation represents a distinct API contract:
 * - OpenAI Chat Completions format
 * - Anthropic Messages format (passthrough)
 * - Gemini generateContent format
 * - Ollama chat format
 *
 * The format also declares which stream format its target API returns,
 * so the correct stream parser is selected automatically.
 */

import type { StreamFormat } from "../providers/transport/types.js";

export interface APIFormat {
  /** Convert Claude-format messages to the target API format */
  convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[];

  /** Convert Claude tools to the target API format */
  convertTools(claudeRequest: any, summarize?: boolean): any[];

  /** Build the full request payload for the target API */
  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any;

  /**
   * The stream format this format's target API returns.
   * Used by ComposedHandler to select the correct stream parser.
   */
  getStreamFormat(): StreamFormat;

  /** Process text content from the model response (clean up, extract tool calls) */
  processTextContent(
    textContent: string,
    accumulatedText: string
  ): import("./base-api-format.js").AdapterResult;

  /** Parse a non-streaming response body into content + usage.
   *  Default handles OpenAI format. Override for other wire formats. */
  parseResponse(data: any): { content: string; usage?: { input: number; output: number } };
}
