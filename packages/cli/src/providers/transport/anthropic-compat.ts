/**
 * Anthropic-Compatible ProviderTransport
 *
 * Handles communication with providers that speak native Anthropic API format
 * (MiniMax, Kimi, Kimi Coding, Z.AI). Auth uses x-api-key header with
 * anthropic-version, plus Kimi OAuth fallback for kimi-coding.
 */

import type { StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { BaseTransport } from "./base.js";

export class AnthropicProviderTransport extends BaseTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat = "anthropic-sse";
  readonly tokenStrategy = "standard" as const;

  private provider: RemoteProvider;
  protected apiKey: string;

  constructor(provider: RemoteProvider, apiKey: string) {
    super(provider.name);
    this.provider = provider;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.displayName = AnthropicProviderTransport.formatDisplayName(provider.name);
  }

  getEndpoint(): string {
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };

    if (this.provider.authScheme === "bearer") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers["x-api-key"] = this.apiKey;
    }

    // Add provider-specific headers
    if (this.provider.headers) {
      Object.assign(headers, this.provider.headers);
    }

    return headers;
  }

  private static formatDisplayName(name: string): string {
    const map: Record<string, string> = {
      minimax: "MiniMax",
      "minimax-coding": "MiniMax Coding",
      kimi: "Kimi",
      "kimi-coding": "Kimi Coding",
      moonshot: "Kimi",
      zai: "Z.AI",
    };
    return map[name.toLowerCase()] || name.charAt(0).toUpperCase() + name.slice(1);
  }
}

// Backward-compatible alias
/** @deprecated Use AnthropicProviderTransport */
export { AnthropicProviderTransport as AnthropicCompatProvider };
