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
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const credPath = join(homedir(), ".claudish", "kimi-oauth.json");
      let raw: string;
      try {
        raw = await readFile(credPath, "utf-8");
      } catch {
        // Credential file doesn't exist or isn't readable
        return super.getHeaders();
      }

      const data = JSON.parse(raw);
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
    } catch (e: any) {
      log(`[${this.displayName}] OAuth fallback failed: ${e.message}`);
    }

    // No OAuth either — return base headers (will likely fail with auth error)
    return super.getHeaders();
  }
}
