/**
 * OpenRouterTransport — OpenRouter API transport.
 *
 * Transport concerns:
 * - Bearer token auth
 * - OpenRouter-specific headers (HTTP-Referer, X-Title)
 * - OpenRouterRequestQueue for rate limiting
 * - openai-sse stream format
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import { OpenRouterRequestQueue } from "../../handlers/shared/openrouter-queue.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterTransport implements ProviderTransport {
  readonly name = "openrouter";
  readonly displayName = "OpenRouter";
  readonly streamFormat: StreamFormat = "openai-sse";

  private apiKey: string;
  private queue: OpenRouterRequestQueue;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.queue = OpenRouterRequestQueue.getInstance();
  }

  getEndpoint(): string {
    return OPENROUTER_API_URL;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": "https://claudish.com",
      "X-Title": "Claudish - OpenRouter Proxy",
    };
  }

  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    return this.queue.enqueue(fetchFn);
  }
}
