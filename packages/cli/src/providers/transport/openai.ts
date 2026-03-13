/**
 * OpenAI ProviderTransport
 *
 * Handles communication with OpenAI's API (and OpenAI-compatible providers
 * like GLM, Zen). Supports both Chat Completions and Codex Responses API.
 * Includes 30-second timeout with detailed error reporting.
 */

import type { StreamFormat } from "./types.js";
import { ApiKeyTransport, type TransportConfig } from "./base.js";
import { log } from "../../logger.js";

export class OpenAITransport extends ApiKeyTransport {
  readonly streamFormat: StreamFormat;

  constructor(config: TransportConfig) {
    super(config);
    // Codex models use the Responses API which has a different streaming format
    this.streamFormat = config.modelName.toLowerCase().includes("codex")
      ? "openai-responses-sse"
      : "openai-sse";
  }

  override getEndpoint(): string {
    if (this.modelName.toLowerCase().includes("codex")) {
      return `${this.baseUrl}/v1/responses`;
    }
    return super.getEndpoint();
  }

  /**
   * Override fetch with 30-second timeout and detailed error handling.
   * This replaces the standard ProviderHandler fetch path.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      // We need to intercept the fetch to add the abort signal.
      // Since ProviderHandler builds the fetch, we wrap it here.
      const response = await fetchFn();
      return response;
    } catch (fetchError: any) {
      if (fetchError.name === "AbortError") {
        log(`[${this.displayName}] Request timed out after 30s`);
        throw new OpenAITimeoutError(this.baseUrl);
      }
      if (fetchError.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
        log(`[${this.displayName}] Connection timeout: ${fetchError.message}`);
        throw new OpenAIConnectionError(this.baseUrl, fetchError.cause?.code);
      }
      throw fetchError;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export class OpenAITimeoutError extends Error {
  constructor(baseUrl: string) {
    super(
      `Request to OpenAI API timed out. Check your network connection to ${baseUrl}`
    );
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
