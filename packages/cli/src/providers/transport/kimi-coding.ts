/**
 * KimiCodingTransport — Kimi Coding Plan transport.
 *
 * Extends AnthropicProviderTransport with OAuth fallback: when no API key
 * is configured, attempts to load stored OAuth credentials from
 * ~/.claudish/kimi-oauth.json and use Bearer token auth instead.
 */

import { AnthropicProviderTransport } from "./anthropic-compat.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { log } from "../../logger.js";

export class KimiCodingTransport extends AnthropicProviderTransport {
  constructor(provider: RemoteProvider, apiKey: string) {
    super(provider, apiKey);
  }

  override async getHeaders(): Promise<Record<string, string>> {
    const headers = await super.getHeaders();

    // If an API key was provided, the base class already set auth headers
    if (this.apiKey) {
      return headers;
    }

    // OAuth fallback: load stored credentials when no API key is set
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

    return headers;
  }
}
