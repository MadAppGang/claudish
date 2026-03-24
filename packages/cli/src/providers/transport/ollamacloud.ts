/**
 * OllamaCloud ProviderTransport
 *
 * Handles communication with OllamaCloud API (https://ollama.com/api/chat).
 * Uses Bearer token auth and Ollama's native JSONL streaming format.
 */

import type { StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { ApiKeyTransport } from "./base.js";

export class OllamaProviderTransport extends ApiKeyTransport {
  readonly name = "ollamacloud";
  readonly displayName = "OllamaCloud";
  readonly streamFormat: StreamFormat = "ollama-jsonl";
  readonly tokenStrategy = "accumulate-both" as const;

  constructor(provider: RemoteProvider, apiKey: string) {
    super("ollamacloud", provider.baseUrl, provider.apiPath, apiKey);
  }

  async getHeaders(): Promise<Record<string, string>> {
    // Only include Authorization if key is present (matches original behavior)
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
