/**
 * GeminiApiKeyProvider — direct Gemini API access with API key authentication.
 *
 * Transport concerns:
 * - x-goog-api-key header
 * - Endpoint URL with {model} substitution
 * - Rate limiting via onResponse override (parses quotaResetDelay from 429)
 * - gemini-sse stream format
 */

import type { StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { BaseTransport } from "./base.js";
import type { QueueState } from "../../handlers/shared/request-queue.js";

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

  protected override onResponse(response: Response, state: QueueState): boolean {
    if (response.status !== 429) return false;
    try {
      response.clone().text().then(text => {
        const data = JSON.parse(text);
        const detail = data?.error?.details?.find((d: any) => d.quotaResetDelay);
        if (detail?.quotaResetDelay) {
          const match = detail.quotaResetDelay.match(/(\d+(?:\.\d+)?)/);
          if (match) {
            state.currentDelayMs = Math.min(
              Math.max(Math.ceil(parseFloat(match[1]) * 1000), state.baseDelayMs),
              state.maxDelayMs,
            );
          }
        }
      }).catch(() => {});
    } catch {}
    return true;
  }

  getNonStreamingEndpoint(_model?: string): string {
    const apiPath = this.provider.apiPath
      .replace("{model}", this.modelName)
      .replace(":streamGenerateContent", ":generateContent");
    const url = new URL(apiPath, this.provider.baseUrl);
    url.searchParams.delete("alt");
    return url.toString();
  }
}

// Backward-compatible alias
/** @deprecated Use GeminiProviderTransport */
export { GeminiProviderTransport as GeminiApiKeyProvider };
