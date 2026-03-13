/**
 * Anthropic-Compatible ProviderTransport
 *
 * Handles communication with providers that speak native Anthropic API format
 * (MiniMax, Kimi, Kimi Coding, Z.AI). Auth uses x-api-key header with
 * anthropic-version, plus Kimi OAuth fallback for kimi-coding.
 */

import type { StreamFormat } from "./types.js";
import { KeyAuthTransport } from "./base.js";
import { log } from "../../logger.js";

export class AnthropicCompatTransport extends KeyAuthTransport {
  readonly streamFormat: StreamFormat = "anthropic-sse";

  override async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };

    if (this.authScheme === "bearer") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers["x-api-key"] = this.apiKey;
    }

    // Add provider-specific headers
    if (this.providerHeaders) {
      Object.assign(headers, this.providerHeaders);
    }

    // Kimi Coding: prefer API key auth, fall back to OAuth if no key provided
    if (this.name === "kimi-coding" && !this.apiKey) {
      try {
        const { existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");

        const credPath = join(homedir(), ".claudish", "kimi-oauth.json");
        if (existsSync(credPath)) {
          const data = JSON.parse(readFileSync(credPath, "utf-8"));
          if (data.access_token && data.refresh_token) {
            const { KimiOAuth } = await import("../../auth/kimi-oauth.js");
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
}
