/**
 * Gemini API Handler
 *
 * Handles direct communication with Google's Gemini API using API key authentication.
 * Extends BaseGeminiHandler to inherit shared Gemini logic.
 *
 * API Documentation: https://ai.google.dev/gemini-api/docs
 */

import { BaseGeminiHandler } from "./base-gemini-handler.js";
import type { RemoteProvider } from "./shared/remote-provider-types.js";

/**
 * Gemini API Handler with API Key Authentication
 *
 * Provides API key-based authentication for Gemini API.
 * All message conversion, tool handling, and streaming logic
 * is inherited from BaseGeminiHandler.
 */
export class GeminiHandler extends BaseGeminiHandler {
  private provider: RemoteProvider;
  private apiKey: string;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string, port: number) {
    super(modelName, port);
    this.provider = provider;
    this.apiKey = apiKey;
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
      "x-goog-api-key": this.apiKey,
    };
  }

  /**
   * Get provider display name
   */
  protected getProviderName(): string {
    return "Gemini API";
  }
}
