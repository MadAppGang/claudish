/**
 * OpenRouterTransport — OpenRouter API transport.
 *
 * Extends OpenAITransport with OpenRouter-specific rate limiting.
 * Auth headers and OpenRouter-specific headers (HTTP-Referer, X-Title)
 * come from TransportConfig via ApiKeyTransport.
 */

import { OpenAITransport } from "./openai.js";
import type { TransportConfig } from "./base.js";
import { OpenRouterRequestQueue } from "../../handlers/shared/openrouter-queue.js";

export class OpenRouterTransport extends OpenAITransport {
  private queue: OpenRouterRequestQueue;

  constructor(config: TransportConfig) {
    super(config);
    this.queue = OpenRouterRequestQueue.getInstance();
  }

  override async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    return this.queue.enqueue(fetchFn);
  }
}
