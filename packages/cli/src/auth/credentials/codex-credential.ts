/**
 * OpenAI Codex credential — OAuth (ChatGPT Plus/Pro) with API-key fallback.
 *
 * `makeCodexCredential()` returns a CompositeCredentialProvider whose primary is
 * the OAuth half ({@link CodexOAuthHalf}) and whose fallback is an API-key
 * provider keyed on OPENAI_CODEX_API_KEY. The fallback has NO aliases — it must
 * NOT accept the generic OPENAI_API_KEY (that key is for the regular OpenAI
 * provider, not the Codex Responses endpoint).
 */

import { CodexOAuth } from "../codex-oauth.js";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { CompositeCredentialProvider } from "./composite-credential.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

/** ChatGPT Codex backend endpoint (OAuth tokens only work here, not api.openai.com). */
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/**
 * Build the Codex OAuth headers (moved from providers/transport/openai-codex.ts).
 */
function buildOAuthHeaders(token: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream",
  };
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
    // Add conversation/session headers for stateless operation
    headers["x-conversation-id"] = "claudish-session";
    headers["x-session-id"] = "claudish-session";
  }
  return headers;
}

/**
 * The OAuth half of the Codex composite credential.
 */
export class CodexOAuthHalf implements CredentialProvider {
  readonly catalogName = "openai-codex";
  private oauth = CodexOAuth.getInstance();

  async isAvailable(): Promise<boolean> {
    return this.oauth.hasCredentials();
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    const token = await this.oauth.getAccessToken();
    const accountId = this.oauth.getAccountId();
    return {
      // The ONLY place an `openai-codex` artifact is stamped "oauth". The
      // transport turns that into the SUB billing label; nothing else may.
      arm: "oauth",
      headers: buildOAuthHeaders(token, accountId),
      endpoint: CODEX_RESPONSES_ENDPOINT,
      transformPayload: (p: any) => ({
        ...p,
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
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
 * Build the full Codex credential: OAuth primary + OPENAI_CODEX_API_KEY fallback.
 */
export function makeCodexCredential(): CompositeCredentialProvider {
  return new CompositeCredentialProvider(
    "openai-codex",
    new CodexOAuthHalf(),
    new ApiKeyCredentialProvider({
      catalogName: "openai-codex",
      envVar: "OPENAI_CODEX_API_KEY",
    })
  );
}
