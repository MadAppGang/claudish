/**
 * OpenRouterProvider — OpenRouter API transport.
 *
 * Transport concerns:
 * - Bearer token auth
 * - OpenRouter-specific headers (HTTP-Referer, X-Title)
 * - OpenRouterRequestQueue for rate limiting
 * - openai-sse stream format
 *
 * Context window is looked up via model translators in the composed handler,
 * not via the transport. Claudish no longer fetches the full OpenRouter catalog
 * for metadata — model info comes from Firebase.
 */

import { credentials } from "../../auth/credentials/authority.js";
import { OpenRouterRequestQueue } from "../../handlers/shared/openrouter-queue.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterProviderTransport implements ProviderTransport {
  readonly name = "openrouter";
  readonly displayName = "OpenRouter";
  readonly streamFormat: StreamFormat = "openai-sse";

  private modelId: string;
  private queue: OpenRouterRequestQueue;

  // The `apiKey` param is retained for signature compatibility but is NO LONGER
  // the signing source — the OpenRouter key is resolved ON DEMAND through the
  // credential authority (the single source of truth), so an op://-only key is
  // resolved at request time just like every direct provider.
  constructor(_apiKey: string, modelId?: string) {
    this.modelId = modelId ?? "";
    this.queue = OpenRouterRequestQueue.getInstance();
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
    // Resolve the OpenRouter key through the authority (env → config → op://,
    // lazy SDK). This is the single source of truth — no construction-time key.
    const auth = await credentials.getRequestAuth("openrouter", { model: this.modelId });
    return {
      ...auth.headers,
      "HTTP-Referer": "https://claudish.com",
      "X-Title": "Claudish - OpenRouter Proxy",
    };
  }

  async enqueueRequest(
    fetchFn: () => Promise<Response>,
    opts?: { signal?: AbortSignal }
  ): Promise<Response> {
    return this.queue.enqueue(fetchFn, opts);
  }

  /**
   * Transport-level context window is unknown in the Firebase model. The
   * ComposedHandler resolves context windows via model translators (which
   * know per-model defaults), so returning 0 here is the correct fallback.
   */
  getContextWindow(): number {
    return 0;
  }
}

// Backward-compatible alias
/** @deprecated Use OpenRouterProviderTransport */
export { OpenRouterProviderTransport as OpenRouterProvider };
