/**
 * LiteLLMAPIFormat — Layer 1 wire format for LiteLLM proxy.
 *
 * An OpenAI-compatible payload with stream_options and tool_choice. Nothing
 * here is chosen by model name: an image goes as the standard `image_url`
 * part, and the upstream's own answer is what tells the user it cannot read
 * one. (A MiniMax-by-name inline-base64 rewrite used to sit here.)
 */

import { mapToolChoiceToOpenAI } from "../handlers/shared/format/openai-tools.js";
import { DefaultAPIFormat } from "./base-api-format.js";

export class LiteLLMAPIFormat extends DefaultAPIFormat {
  private visionSupported: boolean;

  // baseUrl is accepted for backwards-compatible call sites (provider-profiles,
  // custom-endpoints-loader, tests) but no longer consulted — the cached
  // catalog read this fed has been removed.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(modelId: string, _baseUrl: string) {
    super(modelId);
    this.visionSupported = this.checkVisionSupport();
  }

  getName(): string {
    return "LiteLLMAPIFormat";
  }

  shouldHandle(_modelId: string): boolean {
    return false; // Always used explicitly, not via DialectManager matching
  }

  supportsVision(): boolean {
    return this.visionSupported;
  }

  /**
   * Build LiteLLM-specific request payload.
   * Standard OpenAI format with stream_options and tool_choice support.
   */
  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
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

  private checkVisionSupport(): boolean {
    // Vision support data is no longer cached locally — claudish doesn't fetch
    // LiteLLM's catalog (per the Firebase-only catalog rule). Default to true
    // and let LiteLLM 4xx if the model can't actually do vision; a server-side
    // error is more informative than a stale local guess.
    return true;
  }
}

// Backward-compatible alias
/** @deprecated Use LiteLLMAPIFormat */
export { LiteLLMAPIFormat as LiteLLMAdapter };
