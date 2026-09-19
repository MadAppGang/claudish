/**
 * VertexProviderTransport — Vertex AI transport with OAuth authentication.
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

import { credentials } from "../../auth/credentials/authority.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import {
  type VertexConfig,
  buildVertexOAuthEndpoint,
  getVertexAuthManager,
} from "../../auth/vertex-auth.js";
import { log } from "../../logger.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

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

export class VertexProviderTransport implements ProviderTransport {
  readonly name = "vertex";
  readonly displayName = "Vertex AI";
  readonly streamFormat: StreamFormat;

  private config: VertexConfig;
  private parsed: ParsedVertexModel;
  /** Delegated per-request auth artifact (Bearer header), from the authority. */
  private cachedAuth: RequestAuth | null = null;

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
    return { ...(this.cachedAuth?.headers ?? {}) };
  }

  getRequestInit(): Record<string, any> {
    return {
      signal: AbortSignal.timeout(30000), // 30s timeout for Vertex
    };
  }

  /**
   * Delegate normal-path auth to the credential authority. The Vertex credential
   * mints the Bearer header from the shared VertexAuthManager (ADC / service
   * account), which the transport no longer manages itself.
   */
  async refreshAuth(): Promise<void> {
    try {
      this.cachedAuth = await credentials.getRequestAuth("vertex", { model: this.parsed.model });
    } catch (e: any) {
      throw new Error(`Vertex AI auth failed: ${e.message}`);
    }
  }

  /**
   * 401 retry: force a real token refresh. The credential's getRequestAuth does
   * not express a force-refresh, so we bust the SHARED VertexAuthManager cache
   * directly (preserving the exact 401-retry semantics), then re-delegate to
   * repopulate the cached artifact with the fresh token.
   */
  async forceRefreshAuth(): Promise<void> {
    log("[VertexOAuth] Force refreshing auth token");
    await getVertexAuthManager().refreshToken();
    this.cachedAuth = await credentials.getRequestAuth("vertex", {
      model: this.parsed.model,
      forceRefresh: true,
    });
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
