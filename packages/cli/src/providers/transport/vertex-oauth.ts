/**
 * VertexOAuthTransport — Vertex AI transport with OAuth authentication.
 *
 * Supports multiple publishers via dynamic stream format:
 * - Google (Gemini): gemini-sse stream format
 * - Anthropic (Claude): anthropic-sse passthrough
 * - Mistral/Meta: openai-sse format
 *
 * Transport concerns:
 * - OAuth token management with 401 retry (via forceRefreshAuth)
 * - Dynamic endpoint per publisher (streamGenerateContent vs streamRawPredict)
 * - 30s request timeout
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import {
  getVertexAuthManager,
  buildVertexOAuthEndpoint,
  type VertexConfig,
} from "../../auth/vertex-auth.js";
import { log } from "../../logger.js";

export interface ParsedVertexModel {
  publisher: string;
  model: string;
}

/**
 * Parse vertex model string into publisher and model.
 *   "gemini-2.5-flash" → { publisher: "google", model: "gemini-2.5-flash" }
 *   "anthropic/claude-3-5-sonnet" → { publisher: "anthropic", model: "claude-3-5-sonnet" }
 */
export function parseVertexModel(modelId: string): ParsedVertexModel {
  const parts = modelId.split("/");
  if (parts.length === 1) {
    return { publisher: "google", model: parts[0] };
  }
  return { publisher: parts[0], model: parts.slice(1).join("/") };
}

export class VertexOAuthTransport implements ProviderTransport {
  readonly name = "vertex";
  readonly displayName = "Vertex AI";
  readonly streamFormat: StreamFormat;

  private config: VertexConfig;
  private parsed: ParsedVertexModel;
  private accessToken?: string;

  constructor(config: VertexConfig, parsed: ParsedVertexModel) {
    this.config = config;
    this.parsed = parsed;

    // Stream format depends on publisher
    if (parsed.publisher === "google") {
      this.streamFormat = "gemini-sse";
    } else if (parsed.publisher === "anthropic") {
      this.streamFormat = "anthropic-sse";
    } else {
      this.streamFormat = "openai-sse";
    }
  }

  getEndpoint(): string {
    return buildVertexOAuthEndpoint(
      this.config,
      this.parsed.publisher,
      this.parsed.model,
      true // streaming
    );
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  getRequestInit(): Record<string, any> {
    return {
      signal: AbortSignal.timeout(30000), // 30s timeout for Vertex
    };
  }

  async refreshAuth(): Promise<void> {
    const authManager = getVertexAuthManager();
    try {
      this.accessToken = await authManager.getAccessToken();
    } catch (e: any) {
      throw new Error(`Vertex AI auth failed: ${e.message}`);
    }
  }

  async forceRefreshAuth(): Promise<void> {
    log("[VertexOAuth] Force refreshing auth token");
    const authManager = getVertexAuthManager();
    await authManager.refreshToken();
    this.accessToken = await authManager.getAccessToken();
  }

  /**
   * For Anthropic on Vertex: add anthropic_version and remove model field.
   * rawPredict doesn't use model in the body (it's in the URL).
   */
  transformPayload(payload: any): any {
    if (this.parsed.publisher === "anthropic") {
      payload.anthropic_version = "vertex-2023-10-16";
      delete payload.model;
    }
    return payload;
  }

  /** Expose parsed model info for adapter selection */
  getParsed(): ParsedVertexModel {
    return this.parsed;
  }
}
