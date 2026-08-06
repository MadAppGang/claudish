/**
 * Devin credential — the Devin CLI's own session token, read verbatim.
 *
 * The artifact is unusual enough to be worth stating plainly: the
 * `authorization` header is the api key DOUBLED with a `-` separator, under the
 * `Basic` scheme and a LOWERCASE header name:
 *
 * ```
 * authorization: Basic devin-session-token$<JWT>-devin-session-token$<JWT>
 * ```
 *
 * That is why the `devin` provider definition sets `apiKeyEnvVar: ""`.
 * proxy-server's generic credential-extraction block strips a `Bearer ` prefix
 * from `auth.headers.Authorization` and would yield `""` for this — which makes
 * it `return null`, so the handler is never built and the model falls THROUGH to
 * OpenRouter. A wrong provider quietly succeeding is worse than a crash, so the
 * empty `apiKeyEnvVar` makes proxy-server skip the block entirely and lets the
 * transport pull its own artifact from the authority. Exactly the Antigravity
 * pattern.
 *
 * There is no exchange, no refresh, and no keychain — the value is used
 * verbatim in two places (this header and request metadata field `1.3`) — so
 * this provider has no `login`/`logout` and the transport has no
 * `forceRefreshAuth`.
 */

import { hasDevinCredentials, readDevinApiKey } from "../../providers/devin/devin-credentials.js";
import type { CredentialProvider, RequestAuth } from "./types.js";

/**
 * Build the Devin request headers for a key.
 *
 * Exported so the transport can mint headers locally when the authority has not
 * been consulted yet (probe/discovery paths), without duplicating the doubling
 * rule in two places.
 */
export function devinAuthHeaders(apiKey: string): Record<string, string> {
  return {
    // The doubled key is the literal scheme the Devin CLI uses. Lowercase
    // header name, `Basic` scheme, no base64 — all verified against live traffic.
    authorization: `Basic ${apiKey}-${apiKey}`,
    "connect-protocol-version": "1",
  };
}

export class DevinCredentialProvider implements CredentialProvider {
  readonly catalogName = "devin";

  /**
   * Available when a Devin credential resolves from env, claudish config, or the
   * Devin CLI's `credentials.toml`. Never throws — an absent Devin CLI is the
   * normal state for every user who does not have one.
   */
  async isAvailable(): Promise<boolean> {
    try {
      return hasDevinCredentials();
    } catch {
      return false;
    }
  }

  async getRequestAuth(): Promise<RequestAuth> {
    const apiKey = readDevinApiKey();
    if (!apiKey) {
      // TERMINAL: no amount of retrying produces a credential that is not on
      // disk. ComposedHandler turns a terminal auth failure into an HTTP 400
      // surfaced inline, instead of a 401 that sends the client into ~11 rounds
      // of "API error · Retrying" over a condition that cannot self-heal.
      const err: Error & { terminal?: boolean } = new Error(
        "No Devin credential. Sign in with the Devin CLI (`devin login`), or set WINDSURF_API_KEY. " +
          "Expected ~/.local/share/devin/credentials.toml."
      );
      err.terminal = true;
      throw err;
    }
    return { headers: devinAuthHeaders(apiKey) };
  }
}
