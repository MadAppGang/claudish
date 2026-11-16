/**
 * NativeAnthropicCredentialProvider — credential authority for the native Claude
 * Code pass-through.
 *
 * The native path normally carries the user's OWN inbound auth header (Claude
 * Code's session), which the NativeHandler prefers. This provider supplies the
 * FALLBACK credential (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) for when no
 * inbound auth is present — resolved through the single layer (env → config →
 * op://) so even the native fallback no longer reads process.env directly.
 */

import { realValueFor } from "../../env-placeholder.js";
import { getApiKey } from "../../profile-config.js";
import { hasOpSources, resolveOpKeyForEnvVars } from "./op-source.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export class NativeAnthropicCredentialProvider implements CredentialProvider {
  readonly catalogName = "native-anthropic";
  private cachedKey: string | undefined;

  invalidate(): void {
    this.cachedKey = undefined;
  }

  /** Resolve ANTHROPIC_API_KEY: env → config → op:// (lazy SDK). */
  private async resolveKey(): Promise<string> {
    if (this.cachedKey !== undefined) return this.cachedKey;
    // claudish's own placeholder pair, inherited from a proxied parent session, is
    // not a key: signing with it answers 401.
    const local =
      realValueFor("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY) ||
      realValueFor("ANTHROPIC_AUTH_TOKEN", process.env.ANTHROPIC_AUTH_TOKEN) ||
      realValueFor("ANTHROPIC_API_KEY", getApiKey("ANTHROPIC_API_KEY"));
    if (local) {
      this.cachedKey = local;
      return local;
    }
    if (hasOpSources()) {
      const r = await resolveOpKeyForEnvVars(new Set(["ANTHROPIC_API_KEY"]), {
        onAuthFailure: "skip",
      });
      const v = r.ANTHROPIC_API_KEY;
      if (v) {
        process.env.ANTHROPIC_API_KEY = v; // write-through mirror
        this.cachedKey = v;
        return v;
        // (not cached as "" on a transient miss — see ApiKeyCredentialProvider)
      }
      return "";
    }
    this.cachedKey = "";
    return "";
  }

  async isAvailable(): Promise<boolean> {
    if (
      realValueFor("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY) ||
      realValueFor("ANTHROPIC_AUTH_TOKEN", process.env.ANTHROPIC_AUTH_TOKEN)
    ) {
      return true;
    }
    return !!(await this.resolveKey());
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    const key = await this.resolveKey();
    return key ? { headers: { "x-api-key": key } } : { headers: {} };
  }
}
