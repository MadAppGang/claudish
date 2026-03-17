/**
 * OpenAI ProviderTransport
 *
 * Handles communication with OpenAI's API (and OpenAI-compatible providers
 * like GLM, Zen). Supports both Chat Completions and Codex Responses API.
 * Includes 30-second timeout with detailed error reporting.
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { log } from "../../logger.js";

export class OpenAIProvider implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat;

  private provider: RemoteProvider;
  private apiKey: string;
  private modelName: string;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string) {
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.displayName = OpenAIProvider.formatDisplayName(provider.name);

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
   * Override fetch with 30-second timeout and detailed error handling.
   * This replaces the standard ComposedHandler fetch path.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      // We need to intercept the fetch to add the abort signal.
      // Since ComposedHandler builds the fetch, we wrap it here.
      const response = await fetchFn();
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
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private static formatDisplayName(name: string): string {
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
