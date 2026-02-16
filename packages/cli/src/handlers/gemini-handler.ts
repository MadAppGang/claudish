/**
 * Gemini API Handler
 *
 * Handles direct communication with Google's Gemini API using API key authentication.
 * Extends BaseGeminiHandler to inherit shared Gemini logic.
 *
 * API Documentation: https://ai.google.dev/gemini-api/docs
 */

import { BaseGeminiHandler } from "./base-gemini-handler.js";
import { KeyPool } from "./shared/key-pool.js";
import type { RemoteProvider } from "./shared/remote-provider-types.js";

/**
 * Gemini API Handler with API Key Authentication
 *
 * Provides API key-based authentication for Gemini API.
 * Supports multiple API keys with round-robin rotation and automatic failover on 429.
 * All message conversion, tool handling, and streaming logic
 * is inherited from BaseGeminiHandler.
 */
export class GeminiHandler extends BaseGeminiHandler {
  private provider: RemoteProvider;
  private keyPool: KeyPool;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string, port: number) {
    super(modelName, port);
    this.provider = provider;
    this.keyPool = new KeyPool(apiKey, "Gemini");
  }

  /**
   * Get the API endpoint URL
   */
  protected getApiEndpoint(): string {
    const baseUrl = this.provider.baseUrl;
    const apiPath = this.provider.apiPath.replace("{model}", this.modelName);
    return `${baseUrl}${apiPath}`;
  }

  /**
   * Get authentication headers (API key)
   */
  protected async getAuthHeaders(): Promise<Record<string, string>> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": this.keyPool.getCurrentKey(),
    };
  }

  /**
   * Get the key pool for rotation
   */
  protected getKeyPool(): KeyPool {
    return this.keyPool;
  }

  /**
   * Get provider display name
   */
  protected getProviderName(): string {
    return "Gemini API";
  }
}
