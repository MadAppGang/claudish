/**
 * LiteLLM ProviderTransport
 *
 * Handles communication with LiteLLM proxy instances.
 * LiteLLM uses OpenAI-compatible /v1/chat/completions endpoint.
 */

import type { StreamFormat } from "./types.js";
import { ApiKeyTransport } from "./base.js";

/**
 * Extra headers that LiteLLM should forward to specific providers.
 * Matched by model name pattern (case-insensitive).
 *
 * Kimi for Coding requires a recognized agent User-Agent header,
 * otherwise returns 403 "only available for Coding Agents".
 */
const MODEL_EXTRA_HEADERS: Array<{ pattern: string; headers: Record<string, string> }> = [
  { pattern: "kimi", headers: { "User-Agent": "claude-code/1.0" } },
];

export class LiteLLMProviderTransport extends ApiKeyTransport {
  readonly name = "litellm";
  readonly displayName = "LiteLLM";
  readonly streamFormat: StreamFormat = "openai-sse";

  private modelName: string;

  constructor(baseUrl: string, apiKey: string, modelName: string) {
    super("litellm", baseUrl, "/v1/chat/completions", apiKey);
    this.modelName = modelName;
  }

  /**
   * LiteLLM normalizes all responses to OpenAI SSE format server-side,
   * regardless of the underlying model (even if the adapter declares anthropic-sse).
   */
  overrideStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  getExtraPayloadFields(): Record<string, any> {
    const fields: Record<string, any> = {};

    // Add provider-specific extra headers that LiteLLM forwards downstream
    const extraHeaders = this.getExtraHeaders();
    if (extraHeaders) {
      fields.extra_headers = extraHeaders;
    }

    return fields;
  }

  /**
   * Get extra headers for LiteLLM to forward to the downstream provider.
   */
  private getExtraHeaders(): Record<string, string> | null {
    const model = this.modelName.toLowerCase();
    const merged: Record<string, string> = {};
    let found = false;

    for (const { pattern, headers } of MODEL_EXTRA_HEADERS) {
      if (model.includes(pattern)) {
        Object.assign(merged, headers);
        found = true;
      }
    }

    return found ? merged : null;
  }
}

// Backward-compatible alias
/** @deprecated Use LiteLLMProviderTransport */
export { LiteLLMProviderTransport as LiteLLMProvider };
