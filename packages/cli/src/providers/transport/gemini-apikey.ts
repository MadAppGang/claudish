/**
 * GeminiApiKeyProvider — direct Gemini API access with API key authentication.
 *
 * Transport concerns:
 * - x-goog-api-key header
 * - Endpoint URL with {model} substitution
 * - RequestQueue with geminiOnResponse hook for rate limiting
 * - gemini-sse stream format
 */

import type { StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { BaseTransport } from "./base.js";
import { geminiOnResponse } from "../../handlers/shared/request-queue.js";

export class GeminiProviderTransport extends BaseTransport {
  readonly name = "gemini";
  readonly displayName = "Gemini API";
  readonly streamFormat: StreamFormat = "gemini-sse";
  readonly tokenStrategy = "standard" as const;

  private provider: RemoteProvider;
  private apiKey: string;
  private modelName: string;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string) {
    super("gemini", {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      onResponse: geminiOnResponse,
    });
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
  }

  getEndpoint(_model?: string): string {
    const apiPath = this.provider.apiPath.replace("{model}", this.modelName);
    return `${this.provider.baseUrl}${apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      "x-goog-api-key": this.apiKey,
    };
  }

  getNonStreamingEndpoint(_model?: string): string {
    const apiPath = this.provider.apiPath
      .replace("{model}", this.modelName)
      .replace(":streamGenerateContent", ":generateContent");
    return `${this.provider.baseUrl}${apiPath}`;
  }
}

// Backward-compatible alias
/** @deprecated Use GeminiProviderTransport */
export { GeminiProviderTransport as GeminiApiKeyProvider };
