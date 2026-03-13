/**
 * Transport class hierarchy.
 *
 * Three tiers, capturing the actual trait subsets:
 *
 *   BaseTransport          - identity + endpoint (all transports)
 *   ├── ApiKeyTransport    - API key auth: bearer / x-api-key (most remote)
 *   └── OAuthTransport     - OAuth token auth with refresh (GeminiCodeAssist)
 *
 * LocalTransport extends BaseTransport directly (no auth, health checks instead).
 */

import type { ProviderTransport, StreamFormat } from "./types.js";

/** Fields needed to construct any transport. Auth fields are optional. */
export interface TransportConfig {
  name: string;
  displayName: string;
  baseUrl: string;
  apiPath: string;
  modelName: string;
  apiKey?: string;
  authScheme?: "bearer" | "x-api-key" | "none";
  headers?: Record<string, string>;
}

// ─── BaseTransport: identity + endpoint ──────────────────

export abstract class BaseTransport implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  abstract readonly streamFormat: StreamFormat;

  protected baseUrl: string;
  protected apiPath: string;
  protected modelName: string;

  constructor(config: TransportConfig) {
    this.name = config.name;
    this.displayName = config.displayName;
    this.baseUrl = config.baseUrl;
    this.apiPath = config.apiPath;
    this.modelName = config.modelName;
  }

  getEndpoint(): string {
    return `${this.baseUrl}${this.apiPath}`;
  }

  abstract getHeaders(): Promise<Record<string, string>>;
}

// ─── ApiKeyTransport: API key auth ──────────────────────

export abstract class ApiKeyTransport extends BaseTransport {
  protected apiKey: string;
  protected authScheme?: string;
  protected providerHeaders?: Record<string, string>;

  constructor(config: TransportConfig) {
    super(config);
    this.apiKey = config.apiKey || "";
    this.authScheme = config.authScheme;
    this.providerHeaders = config.headers;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      if (this.authScheme === "x-api-key") {
        headers["x-api-key"] = this.apiKey;
      } else if (this.authScheme !== "none") {
        // Default to Bearer when authScheme is "bearer" or undefined
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }
    }
    if (this.providerHeaders) {
      Object.assign(headers, this.providerHeaders);
    }
    return headers;
  }
}

// ─── OAuthTransport: token-based auth with refresh ───────

export abstract class OAuthTransport extends BaseTransport {
  protected accessToken: string | null = null;

  async getHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  abstract refreshAuth(): Promise<void>;
}
