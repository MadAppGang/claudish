/**
 * GeminiApiKeyTransport -- direct Gemini API access with API key authentication.
 *
 * Transport concerns:
 * - x-goog-api-key header
 * - Endpoint URL with {model} substitution
 * - GeminiRequestQueue for rate limiting
 * - gemini-sse stream format
 */

import type { StreamFormat } from "./types.js";
import { KeyAuthTransport } from "./base.js";
import { GeminiRequestQueue } from "../../handlers/shared/gemini-queue.js";

export class GeminiApiKeyTransport extends KeyAuthTransport {
  readonly streamFormat: StreamFormat = "gemini-sse";

  override getEndpoint(_model?: string): string {
    const apiPath = this.apiPath.replace("{model}", this.modelName);
    return `${this.baseUrl}${apiPath}`;
  }

  override async getHeaders(): Promise<Record<string, string>> {
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
