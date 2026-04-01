/**
 * OpenAIOAuthProviderTransport — OpenAI API access via ChatGPT OAuth subscription.
 *
 * Transport concerns:
 * - OAuth access token via OpenAIOAuth.getAccessToken()
 * - Fixed endpoint: chatgpt.com/backend-api/codex/responses
 * - openai-responses-sse stream format (Responses API)
 * - 429 retry with exponential backoff
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import { log } from "../../logger.js";

const OPENAI_OAUTH_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export class OpenAIOAuthProviderTransport implements ProviderTransport {
  readonly name = "openai-oauth";
  readonly displayName = "OpenAI OAuth";
  readonly streamFormat: StreamFormat = "openai-responses-sse";

  private modelName: string;
  private accessToken: string | null = null;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  getEndpoint(): string {
    return OPENAI_OAUTH_ENDPOINT;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  /**
   * Refresh OAuth token before each request.
   * Uses dynamic import to avoid loading OAuth code unless needed.
   */
  async refreshAuth(): Promise<void> {
    const { getValidOpenAIAccessToken } = await import("../../auth/openai-oauth.js");
    this.accessToken = await getValidOpenAIAccessToken();
    log(`[OpenAIOAuth] Auth refreshed`);
  }

  /**
   * The Codex backend-api requires store=false and rejects max_output_tokens.
   */
  transformPayload(payload: any): any {
    const { max_output_tokens, ...rest } = payload;
    return { ...rest, store: false };
  }

  /**
   * Force refresh on 401 — called by ComposedHandler retry logic.
   */
  async forceRefreshAuth(): Promise<void> {
    const { OpenAIOAuth } = await import("../../auth/openai-oauth.js");
    const oauth = OpenAIOAuth.getInstance();
    await oauth.refreshToken();
    this.accessToken = await oauth.getAccessToken();
    log(`[OpenAIOAuth] Force refresh completed`);
  }

  /**
   * Retry on 429 with exponential backoff (same pattern as OpenAI transport).
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const maxRetries = 5;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetchFn();

        if (response.status === 429 && attempt < maxRetries) {
          lastResponse = response;
          const retryAfter = response.headers.get("Retry-After");
          let delayMs: number;
          if (retryAfter && !Number.isNaN(Number(retryAfter))) {
            delayMs = Math.min(Number(retryAfter) * 1000, 30000);
          } else {
            delayMs = Math.min(2000 * Math.pow(2, attempt), 30000);
          }
          log(`[OpenAI OAuth] 429 rate limited, retry ${attempt + 1}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        return response;
      } catch (fetchError: any) {
        if (fetchError.name === "AbortError") {
          log(`[OpenAI OAuth] Request timed out`);
          throw new Error("Request to OpenAI OAuth API timed out. Check your network connection.");
        }
        throw fetchError;
      }
    }

    return lastResponse!;
  }
}
