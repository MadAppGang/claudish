/**
 * Anthropic-Compatible ProviderTransport
 *
 * Handles communication with providers that speak native Anthropic API format
 * (MiniMax, Kimi, Kimi Coding, Z.AI). Auth uses x-api-key header with
 * anthropic-version, plus Kimi OAuth fallback for kimi-coding.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderTransport, StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { log } from "../../logger.js";
import { KimiOAuth } from "../../auth/kimi-oauth.js";

export class AnthropicProviderTransport implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat = "anthropic-sse";

  private provider: RemoteProvider;
  private apiKey: string;

  constructor(provider: RemoteProvider, apiKey: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.displayName = AnthropicProviderTransport.formatDisplayName(provider.name);
  }

  getEndpoint(): string {
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };

    if (this.provider.authScheme === "bearer") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers["x-api-key"] = this.apiKey;
    }

    // Add provider-specific headers
    if (this.provider.headers) {
      Object.assign(headers, this.provider.headers);
    }

    // Kimi Coding: prefer API key auth, fall back to OAuth if no key provided
    if (this.provider.name === "kimi-coding" && !this.apiKey) {
      try {
        const credPath = join(homedir(), ".claudish", "kimi-oauth.json");
        if (existsSync(credPath)) {
          const data = JSON.parse(readFileSync(credPath, "utf-8"));
          if (data.access_token && data.refresh_token) {
            const oauth = KimiOAuth.getInstance();
            const accessToken = await oauth.getAccessToken();

            // Replace API key auth with Bearer token
            delete headers["x-api-key"];
            headers["Authorization"] = `Bearer ${accessToken}`;

            // Add Kimi-specific platform headers
            const platformHeaders = oauth.getPlatformHeaders();
            Object.assign(headers, platformHeaders);
          }
        }
      } catch (e: any) {
        log(`[${this.displayName}] OAuth fallback failed: ${e.message}`);
      }
    }

    return headers;
  }

  /**
   * Retry HTTP 429 responses with jittered exponential backoff.
   *
   * The anthropic-compat providers (Z.AI, MiniMax, Kimi) previously had NO
   * transport-level retry at all — a bare 429 propagated straight up. This
   * mirrors OpenAIProviderTransport's retry but ADDS jitter: the whole cluster
   * shares a single key per provider, so without jitter every machine retries
   * on the same 2s/4s/8s boundary and re-collides on the burst limit. The
   * jitter spreads those retries out.
   *
   * Note: this only covers errors the provider returns as an HTTP 429. Z.AI's
   * burst limit is frequently delivered as HTTP 200 + an in-stream SSE error
   * ([1302]); that variant is handled one layer up in ComposedHandler (peek +
   * backoff-retry + cross-provider fallback), since it isn't visible from the
   * Response status alone.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const maxRetries = 5;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetchFn();

      if (response.status === 429 && attempt < maxRetries) {
        lastResponse = response;
        const retryAfter = response.headers.get("Retry-After");
        let delayMs: number;
        if (retryAfter && !Number.isNaN(Number(retryAfter))) {
          delayMs = Math.min(Number(retryAfter) * 1000, 30000);
        } else {
          // Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped)
          delayMs = Math.min(2000 * Math.pow(2, attempt), 30000);
        }
        // Jitter: spread cluster-wide synchronized retries off the same boundary.
        const jitterMs = Math.floor(Math.random() * 1000);
        const totalMs = delayMs + jitterMs;
        log(
          `[${this.displayName}] 429 rate limited, retry ${attempt + 1}/${maxRetries} in ${(totalMs / 1000).toFixed(1)}s`
        );
        await new Promise((resolve) => setTimeout(resolve, totalMs));
        continue;
      }

      return response;
    }

    // All retries exhausted — return the last 429 response
    return lastResponse!;
  }

  private static formatDisplayName(name: string): string {
    const map: Record<string, string> = {
      minimax: "MiniMax",
      "minimax-coding": "MiniMax Coding",
      kimi: "Kimi",
      "kimi-coding": "Kimi Coding",
      moonshot: "Kimi",
      zai: "Z.AI",
    };
    return map[name.toLowerCase()] || name.charAt(0).toUpperCase() + name.slice(1);
  }
}

// Backward-compatible alias
/** @deprecated Use AnthropicProviderTransport */
export { AnthropicProviderTransport as AnthropicCompatProvider };
