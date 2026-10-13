/**
 * OpenAIAPIFormat — Layer 1 wire format for the OpenAI Chat Completions API.
 *
 * Converts the Claude request into a Chat Completions body: messages, tools,
 * tool choice, sampling parameters. It decides NOTHING about the output-limit
 * field or reasoning: on a catalog connection both come from the connection's
 * `wire` (`ComposedHandler` step 5w, `providers/wire-request.ts`), which
 * overwrites whatever is written here. Without a wire (a custom endpoint),
 * the documented default applies: `max_tokens`, and no reasoning field —
 * `--model-params` adds one where the user knows the endpoint takes it.
 */

import { mapToolChoiceToOpenAI } from "../handlers/shared/format/openai-tools.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { type AdapterResult, BaseAPIFormat } from "./base-api-format.js";

export class OpenAIAPIFormat extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override getStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  /**
   * OpenAI's Chat Completions API hard-caps the tools array at 128. Exceeding
   * it fails the whole request with HTTP 400 "Invalid 'tools': array too long".
   * (Note: CodexAPIFormat is a separate class and is intentionally NOT capped
   * here — the Responses API path keeps its own behavior.)
   */
  override getMaxToolCount(): number | null {
    return 128;
  }

  /**
   * Chat Completions has no `thinking` block; a leftover one is removed. The
   * reasoning field itself is the wire's to write.
   */
  protected override applyNativeReasoning(request: any, _originalRequest: any): any {
    if (request.thinking) delete request.thinking;
    return request;
  }

  /** Never selected by model name: the connection's `wire.api` chooses this format. */
  shouldHandle(_modelId: string): boolean {
    return false;
  }

  getName(): string {
    return "OpenAIAPIFormat";
  }

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: claudeRequest.max_tokens,
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
}

// Backward-compatible alias
/** @deprecated Use OpenAIAPIFormat */
export { OpenAIAPIFormat as OpenAIAdapter };
