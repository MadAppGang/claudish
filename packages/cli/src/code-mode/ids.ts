/**
 * Identity keys for `openai-codex` requests.
 *
 * `accountKey` names the ChatGPT account ONE request signs with. It is read
 * from that request's own auth binding (the artifact `refreshAuth` returned),
 * never from the `CodexOAuth` singleton or the transport's shared artifact,
 * because the login can change in-process (`reloadCredentials`) between two
 * requests, and a value read from shared state could name another request's
 * account.
 */

import { createHash } from "node:crypto";
import type { AuthBinding } from "../providers/transport/types.js";

/** The header the Codex OAuth artifact carries when the login has an account id. */
const ACCOUNT_ID_HEADER = "chatgpt-account-id";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * `sha256("openai-codex\0" + chatgpt-account-id)` from the binding's headers.
 *
 * Defined only when the binding's arm is `"oauth"` and the account-id header
 * is present (`codex-credential.ts` sets it only when the login has an account
 * id). Undefined otherwise: an api-key request, a legacy transport with no
 * binding, or a login without an account id.
 */
export function accountKeyFromBinding(binding: AuthBinding | undefined): string | undefined {
  const auth = binding?.auth;
  if (!auth || auth.arm !== "oauth") return undefined;
  let accountId: string | undefined;
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (name.toLowerCase() === ACCOUNT_ID_HEADER && typeof value === "string" && value) {
      accountId = value;
      break;
    }
  }
  if (!accountId) return undefined;
  return sha256Hex(`openai-codex\0${accountId}`);
}
