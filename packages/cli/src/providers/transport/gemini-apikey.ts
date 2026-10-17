/**
 * GeminiApiKeyProvider — direct Gemini API access with API key authentication.
 *
 * Transport concerns:
 * - x-goog-api-key header
 * - Endpoint URL with {model} substitution
 * - GeminiRequestQueue for rate limiting
 * - gemini-sse stream format
 */

import { GeminiRequestQueue } from "../../handlers/shared/gemini-queue.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

export class GeminiProviderTransport implements ProviderTransport {
  readonly name = "gemini";
  readonly displayName = "Gemini API";
  readonly streamFormat: StreamFormat = "gemini-sse";

  private provider: RemoteProvider;
  private apiKey: string;
  private modelName: string;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string) {
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

  /**
   * Rate-limited request via GeminiRequestQueue singleton.
   * Serializes all Gemini requests to prevent quota exhaustion.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const queue = GeminiRequestQueue.getInstance();
    return queue.enqueue(fetchFn);
  }
}

// Backward-compatible alias
/** @deprecated Use GeminiProviderTransport */
export { GeminiProviderTransport as GeminiApiKeyProvider };
