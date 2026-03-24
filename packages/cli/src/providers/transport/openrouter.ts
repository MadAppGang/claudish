/**
 * OpenRouterProvider — OpenRouter API transport.
 *
 * Transport concerns:
 * - Bearer token auth
 * - OpenRouter-specific headers (HTTP-Referer, X-Title)
 * - Rate limiting via onResponse/calculateDelay overrides (X-RateLimit headers)
 * - openai-sse stream format
 * - Context window lookup from cached OpenRouter model catalog
 */

import type { StreamFormat } from "./types.js";
import { BaseTransport } from "./base.js";
import type { QueueState } from "../../handlers/shared/request-queue.js";
import { getCachedOpenRouterModels } from "../../model-loader.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterProviderTransport extends BaseTransport {
  readonly name = "openrouter";
  readonly displayName = "OpenRouter";
  readonly streamFormat: StreamFormat = "openai-sse";

  private apiKey: string;
  private modelId: string;

  // Rate limit state from X-RateLimit headers
  private limitRequests: number | null = null;
  private remainingRequests: number | null = null;
  private resetTime: number | null = null;

  constructor(apiKey: string, modelId?: string) {
    super("openrouter", {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
    });
    this.apiKey = apiKey;
    this.modelId = modelId || "";
  }

  overrideStreamFormat(): StreamFormat {
    return "openai-sse";
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

  getContextWindow(): number {
    const models = this.modelId ? getCachedOpenRouterModels() : null;
    const model = models?.find((m: any) => m.id === this.modelId);
    return model?.context_length || model?.top_provider?.context_length || 200_000;
  }

  protected override onResponse(response: Response, state: QueueState): boolean {
    const lr = response.headers.get("X-RateLimit-Limit-Requests");
    if (lr) this.limitRequests = parseInt(lr, 10);
    const rr = response.headers.get("X-RateLimit-Remaining-Requests");
    if (rr) this.remainingRequests = parseInt(rr, 10);
    const r = response.headers.get("X-RateLimit-Reset-Requests");
    if (r) this.resetTime = parseFloat(r);

    if (response.status === 429) {
      this.remainingRequests = 0;
      const ra = response.headers.get("Retry-After");
      if (ra) {
        const s = parseInt(ra, 10);
        if (!isNaN(s)) state.currentDelayMs = Math.max(state.currentDelayMs, Math.min(s * 1000, state.maxDelayMs));
      }
      return true;
    }
    return false;
  }

  protected override calculateDelay(state: QueueState): number {
    let delayMs = state.baseDelayMs;
    if (this.remainingRequests !== null && this.limitRequests !== null && this.limitRequests > 0) {
      const pct = this.remainingRequests / this.limitRequests;
      if (pct < 0.2) delayMs = Math.max(delayMs, 3000);
      else if (pct < 0.5) delayMs = Math.max(delayMs, 2000);
    }
    if (this.resetTime !== null && this.remainingRequests !== null && this.remainingRequests > 0) {
      const until = this.resetTime - Date.now() / 1000;
      if (until > 0) delayMs = Math.max(delayMs, Math.min((until * 1000) / this.remainingRequests, state.maxDelayMs));
    }
    if (state.consecutiveErrors > 0) delayMs *= 1 + state.consecutiveErrors * 0.5;
    return Math.min(delayMs, state.maxDelayMs);
  }
}

// Backward-compatible alias
/** @deprecated Use OpenRouterProviderTransport */
export { OpenRouterProviderTransport as OpenRouterProvider };
