/**
 * Anthropic-Compatible ProviderTransport
 *
 * Handles communication with providers that speak native Anthropic API format
 * (MiniMax, Kimi, Z.AI). Auth uses x-api-key header with anthropic-version.
 *
 * Subclassed by KimiCodingTransport for OAuth fallback.
 */

import type { StreamFormat } from "./types.js";
import { ApiKeyTransport } from "./base.js";

export class AnthropicCompatTransport extends ApiKeyTransport {
  readonly streamFormat: StreamFormat = "anthropic-sse";

  override async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };

    if (this.authScheme === "bearer") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers["x-api-key"] = this.apiKey;
    }

    // Add provider-specific headers
    if (this.providerHeaders) {
      Object.assign(headers, this.providerHeaders);
    }

    return headers;
  }
}
