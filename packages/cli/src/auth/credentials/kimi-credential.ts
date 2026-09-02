/**
 * Kimi / Moonshot credentials — OAuth with API-key fallback.
 *
 * There are TWO distinct Kimi products, each with its own endpoint AND its own
 * API key, but both reachable via the same `claudish login kimi` OAuth flow:
 *
 *   - Kimi (regular, kimi@)   → api.moonshot.ai, key MOONSHOT_API_KEY / KIMI_API_KEY
 *   - Kimi Coding Plan (kc@)  → api.kimi.com/coding, key KIMI_CODING_API_KEY
 *
 * `makeKimiCredential()` and `makeKimiCodingCredential()` each return a
 * CompositeCredentialProvider sharing the OAuth half ({@link KimiOAuthHalf}) as
 * primary, but with DIFFERENT API-key fallback halves keyed on each product's
 * own env var. They MUST stay separate: aliasing kimi-coding onto the regular
 * Kimi credential makes the coding endpoint receive the regular Moonshot key
 * (the wrong product's key) → 401. The OAuth refresh throws
 * "OAuth_FALLBACK_TO_API_KEY" when it fails and an API key is present — the
 * composite's `fallbackSignal` catches exactly that and falls through.
 */

import { KimiOAuth } from "../kimi-oauth.js";
import { hasOAuthCredentials } from "../oauth-registry.js";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { CompositeCredentialProvider } from "./composite-credential.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

/**
 * The OAuth half of the Kimi composite credential.
 */
export class KimiOAuthHalf implements CredentialProvider {
  readonly catalogName = "kimi";
  private oauth = KimiOAuth.getInstance();

  async isAvailable(): Promise<boolean> {
    return hasOAuthCredentials("kimi");
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    // May throw "OAuth_FALLBACK_TO_API_KEY" — the composite catches it.
    const token = await this.oauth.getAccessToken();
    return {
      // Marked for the same reason the Codex OAuth half is: this is the primary
      // half of a composite whose fallback also returns an artifact, so nothing
      // downstream can tell the arms apart without being told. Kimi has no
      // billing consumer today — note it also sets NO `endpoint`, which is why
      // "infer the arm from the endpoint override" was rejected as a mechanism.
      arm: "oauth",
      headers: {
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${token}`,
        ...this.oauth.getPlatformHeaders(),
      },
    };
  }

  async login(): Promise<void> {
    await this.oauth.login();
  }

  async logout(): Promise<void> {
    await this.oauth.logout();
  }
}

/**
 * Build the regular Kimi credential: OAuth primary + MOONSHOT_API_KEY fallback.
 *
 * Note: KIMI_CODING_API_KEY is intentionally NOT an alias here — that key
 * belongs to the coding-plan product (different endpoint) and must never be
 * resolved for the regular Kimi endpoint.
 */
export function makeKimiCredential(): CompositeCredentialProvider {
  return new CompositeCredentialProvider(
    "kimi",
    new KimiOAuthHalf(),
    new ApiKeyCredentialProvider({
      catalogName: "kimi",
      envVar: "MOONSHOT_API_KEY",
      aliases: ["KIMI_API_KEY"],
    }),
    { fallbackSignal: "OAuth_FALLBACK_TO_API_KEY" }
  );
}

/**
 * Build the Kimi Coding Plan credential: OAuth primary (same `claudish login
 * kimi` flow) + KIMI_CODING_API_KEY fallback.
 *
 * The API-key half is keyed on the dedicated coding-plan env var so the
 * coding endpoint (api.kimi.com/coding) receives the coding-plan key, not the
 * regular Moonshot key. catalogName is "kimi-coding" for accurate provenance.
 */
export function makeKimiCodingCredential(): CompositeCredentialProvider {
  return new CompositeCredentialProvider(
    "kimi-coding",
    new KimiOAuthHalf(),
    new ApiKeyCredentialProvider({
      catalogName: "kimi-coding",
      envVar: "KIMI_CODING_API_KEY",
    }),
    { fallbackSignal: "OAuth_FALLBACK_TO_API_KEY" }
  );
}
