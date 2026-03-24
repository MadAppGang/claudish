/**
 * OpenRouterProvider — OpenRouter API transport.
 *
 * Transport concerns:
 * - Bearer token auth
 * - OpenRouter-specific headers (HTTP-Referer, X-Title)
 * - RequestQueue with OpenRouter rate limit hooks
 * - openai-sse stream format
 * - Context window lookup from cached OpenRouter model catalog
 */

import type { StreamFormat } from "./types.js";
import { BaseTransport } from "./base.js";
import { createOpenRouterHooks } from "../../handlers/shared/request-queue.js";
import { getCachedOpenRouterModels } from "../../model-loader.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterProviderTransport extends BaseTransport {
  readonly name = "openrouter";
  readonly displayName = "OpenRouter";
  readonly streamFormat: StreamFormat = "openai-sse";

  private apiKey: string;
  private modelId: string;

  constructor(apiKey: string, modelId?: string) {
    const hooks = createOpenRouterHooks();
    super("openrouter", {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      calculateDelay: hooks.calculateDelay,
      onResponse: hooks.onResponse,
    });
    this.apiKey = apiKey;
    this.modelId = modelId || "";
  }

  /**
   * OpenRouter normalizes all responses to OpenAI SSE format server-side,
   * regardless of the underlying model (even if the adapter declares anthropic-sse).
   */
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

  /**
   * Look up context window from the cached OpenRouter model catalog.
   * The catalog is pre-warmed at startup via warmAllCatalogs().
   */
  getContextWindow(): number {
    const models = this.modelId ? getCachedOpenRouterModels() : null;
    const model = models?.find((m: any) => m.id === this.modelId);
    return model?.context_length || model?.top_provider?.context_length || 200_000;
  }
}

// Backward-compatible alias
/** @deprecated Use OpenRouterProviderTransport */
export { OpenRouterProviderTransport as OpenRouterProvider };
