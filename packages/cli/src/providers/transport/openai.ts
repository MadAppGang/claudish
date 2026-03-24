/**
 * OpenAI ProviderTransport
 *
 * Handles communication with OpenAI's API (and OpenAI-compatible providers
 * like GLM, Zen). Supports both Chat Completions and Codex Responses API.
 * Includes custom 429 retry logic with exponential backoff (up to 5 retries).
 */

import type { StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { BaseTransport } from "./base.js";
import { log } from "../../logger.js";

export class OpenAIProviderTransport extends BaseTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat;
  readonly tokenStrategy = "delta-aware" as const;

  private provider: RemoteProvider;
  protected apiKey: string;
  private modelName: string;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string) {
    super(provider.name);
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.displayName = OpenAIProviderTransport.formatDisplayName(provider.name);

    // Codex models use the Responses API which has a different streaming format
    this.streamFormat = modelName.toLowerCase().includes("codex")
      ? "openai-responses-sse"
      : "openai-sse";
  }

  getEndpoint(): string {
    if (this.modelName.toLowerCase().includes("codex")) {
      return `${this.provider.baseUrl}/v1/responses`;
    }
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Override fetch with 429 retry with exponential backoff and detailed error handling.
   * Bypasses the base RequestQueue to implement its own retry logic.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const maxRetries = 5;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetchFn();

        if (response.status === 429 && attempt < maxRetries) {
          lastResponse = response;
          // Parse Retry-After header if present
          const retryAfter = response.headers.get("Retry-After");
          let delayMs: number;
          if (retryAfter && !Number.isNaN(Number(retryAfter))) {
            delayMs = Math.min(Number(retryAfter) * 1000, 30000);
          } else {
            // Exponential backoff: 2s, 4s, 8s, 16s, 30s
            delayMs = Math.min(2000 * Math.pow(2, attempt), 30000);
          }
          log(`[${this.displayName}] 429 rate limited, retry ${attempt + 1}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        return response;
      } catch (fetchError: any) {
        if (fetchError.name === "AbortError") {
          log(`[${this.displayName}] Request timed out after 30s`);
          throw new OpenAITimeoutError(this.provider.baseUrl);
        }
        if (fetchError.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
          log(`[${this.displayName}] Connection timeout: ${fetchError.message}`);
          throw new OpenAIConnectionError(this.provider.baseUrl, fetchError.cause?.code);
        }
        throw fetchError;
      }
    }

    // All retries exhausted — return the last 429 response
    return lastResponse!;
  }

  static formatDisplayName(name: string): string {
    if (name === "opencode-zen") return "Zen";
    if (name === "opencode-zen-go") return "Zen Go";
    if (name === "glm") return "GLM";
    if (name === "glm-coding") return "GLM Coding";
    if (name === "openai") return "OpenAI";
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

export class OpenAITimeoutError extends Error {
  constructor(baseUrl: string) {
    super(`Request to OpenAI API timed out. Check your network connection to ${baseUrl}`);
    this.name = "OpenAITimeoutError";
  }
}

export class OpenAIConnectionError extends Error {
  constructor(baseUrl: string, code: string) {
    super(
      `Cannot connect to OpenAI API (${baseUrl}). This may be due to: network/firewall blocking, VPN interference, or regional restrictions. Error: ${code}`
    );
    this.name = "OpenAIConnectionError";
  }
}

// Backward-compatible alias
/** @deprecated Use OpenAIProviderTransport */
export { OpenAIProviderTransport as OpenAIProvider };
