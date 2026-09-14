/**
 * LiteLLM ProviderTransport
 *
 * Handles communication with LiteLLM proxy instances.
 * LiteLLM uses OpenAI-compatible /v1/chat/completions endpoint.
 */

import { discoverViaOpenAIModels } from "./probe-discovery.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

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

export class LiteLLMProviderTransport implements ProviderTransport {
  readonly name = "litellm";
  readonly displayName = "LiteLLM";
  readonly streamFormat: StreamFormat = "openai-sse";

  private baseUrl: string;
  private apiKey: string;
  private modelName: string;

  constructor(baseUrl: string, apiKey: string, modelName: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  /**
   * LiteLLM normalizes all responses to OpenAI SSE format server-side,
   * regardless of the underlying model (even if the adapter declares anthropic-sse).
   */
  overrideStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  getEndpoint(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    return headers;
  }

  async discoverProbeModel(exclude?: ReadonlySet<string>) {
    return discoverViaOpenAIModels(`${this.baseUrl}/v1/models`, await this.getHeaders(), {
      key: `litellm:${this.baseUrl}`,
      displayName: this.displayName,
      exclude,
    });
  }

  async getExtraPayloadFields(): Promise<Record<string, any>> {
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
