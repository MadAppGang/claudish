/**
 * KimiCodingTransport: Anthropic-compatible transport with OAuth fallback.
 *
 * Extends AnthropicCompatTransport with one override:
 * - If no API key is provided, falls back to OAuth credentials from
 *   ~/.claudish/kimi-oauth.json (device-flow auth for Kimi Coding Plan)
 */

import { AnthropicCompatTransport } from "./anthropic-compat.js";
import { log } from "../../logger.js";

export class KimiCodingTransport extends AnthropicCompatTransport {
  override async getHeaders(): Promise<Record<string, string>> {
    // If API key is available, use standard Anthropic-compat auth
    if (this.apiKey) {
      return super.getHeaders();
    }

    // No API key — try OAuth fallback
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };

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

          headers["Authorization"] = `Bearer ${accessToken}`;

          // Add Kimi-specific platform headers
          const platformHeaders = oauth.getPlatformHeaders();
          Object.assign(headers, platformHeaders);

          return headers;
        }
      }
    } catch (e: any) {
      log(`[${this.displayName}] OAuth fallback failed: ${e.message}`);
    }

    // No OAuth either — return base headers (will likely fail with auth error)
    return super.getHeaders();
  }
}
