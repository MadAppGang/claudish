/**
 * OllamaCloud ProviderTransport
 *
 * Handles communication with OllamaCloud API (https://ollama.com/api/chat).
 * Uses Bearer token auth and Ollama's native JSONL streaming format.
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";

export class OllamaProviderTransport implements ProviderTransport {
  readonly name = "ollamacloud";
  readonly displayName = "OllamaCloud";
  readonly streamFormat: StreamFormat = "ollama-jsonl";
  readonly tokenStrategy = "accumulate-both" as const;

  private provider: RemoteProvider;
  private apiKey: string;

  constructor(provider: RemoteProvider, apiKey: string) {
    this.provider = provider;
    this.apiKey = apiKey;
  }

  getEndpoint(): string {
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

// Backward-compatible alias
/** @deprecated Use OllamaProviderTransport */
export { OllamaProviderTransport as OllamaCloudProvider };
