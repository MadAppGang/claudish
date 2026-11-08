/**
 * Muse Code subscription credential — a key minted from a Meta `dca:` login.
 *
 * The `meta-muse-code` definition sets `apiKeyEnvVar: ""`, and that is
 * load-bearing: proxy-server's generic key extraction would otherwise cache a
 * short-lived minted key past its life, and the generic loop in
 * `authority.ts` would register an ApiKeyCredentialProvider for it.
 * `META_API_KEY` is NEVER aliased here: it is the METERED `meta` provider's
 * key, and honouring it would let a per-token key sign a provider claudish
 * reports as flat-rate SUB.
 *
 * Every artifact is `arm: "oauth"`. There is no api-key half, so nothing can
 * fall through to an unconfirmed key (CLAUDE.md: absent `arm` ⇒ metered).
 */

import {
  MUSE_NON_INTERACTIVE_MESSAGE,
  ensureMuseCredentialReady,
  isMuseCredentialConfigured,
  museCredentialStatusFromFiles,
  museSignerLabel,
  refreshMuseCredentialStatus,
  requestPathMayPrompt,
  resetMuseCredentialState,
} from "../../providers/meta-muse/muse-credentials.js";
import { credentialPromptRole } from "./prompt-role.js";
import type { CredentialProvider, ReadinessResult, RequestAuth } from "./types.js";
import { readinessDetail } from "./types.js";

export class MuseCodeCredentialProvider implements CredentialProvider {
  readonly catalogName = "meta-muse-code";

  /**
   * Present when claudish's own login or its borrowed copy is on disk, or —
   * only in a process that may read the Keychain — when the Muse Code CLI's
   * item exists (attributes only; no dialog). In a `never` process a
   * Keychain-only login is ABSENT: it could not be used here, and a kept
   * candidate would only fail later with the login message.
   */
  async describeReadiness(): Promise<ReadinessResult> {
    try {
      // A `never` process asks no Keychain question at all, not even the
      // attribute-only one: a locked login keychain can answer any `security`
      // call with an unlock dialog, and this process could not use the item.
      const status =
        credentialPromptRole() === "never"
          ? museCredentialStatusFromFiles()
          : await refreshMuseCredentialStatus();
      if (status === "absent" && credentialPromptRole() === "never") {
        return { readiness: "absent", detail: MUSE_NON_INTERACTIVE_MESSAGE };
      }
      if (status === "failed") {
        return {
          readiness: "failed",
          detail: "the macOS Keychain could not be asked about the Muse Code login",
        };
      }
      return { readiness: isMuseCredentialConfigured(status) ? "present" : "absent" };
    } catch (err) {
      return {
        readiness: "failed",
        detail: `Muse Code credential could not be read: ${readinessDetail(err) ?? "unknown error"}`,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.describeReadiness()).readiness === "present";
  }

  /** A confirmed key; the request path may use the Keychain only in an interactive launch. */
  async getRequestAuth(): Promise<RequestAuth> {
    const state = await ensureMuseCredentialReady({ prompt: requestPathMayPrompt() });
    return {
      headers: { Authorization: `Bearer ${state.key}` },
      arm: "oauth",
      // The source and tier of THIS state, captured with the key it signs with.
      signer: museSignerLabel(state),
    };
  }

  invalidate(): void {
    resetMuseCredentialState();
  }
}
