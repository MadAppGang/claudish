/**
 * Antigravity credential (OAuth-based, subscription endpoint).
 *
 * Mirrors gemini-credential.ts, but:
 *  - the OAuth token comes from the SHARED Antigravity store (`agy` keychain
 *    item), refreshed/written back by getValidAntigravityAccessToken();
 *  - the identity is ALWAYS Antigravity (antigravity UA + ideType ANTIGRAVITY),
 *    independent of CLAUDISH_GEMINI_ANTIGRAVITY;
 *  - the requested model id is resolved to a LIVE-served id
 *    (resolveAntigravityServedModel over getServedAntigravityModels) before it goes
 *    into the CodeAssist envelope.
 *
 * Request artifact:
 *  - Authorization: Bearer <antigravity oauth token>
 *  - User-Agent: antigravity/cli/<version> (...), the version the installed agy
 *    reports, captured per auth session by getValidAntigravityAccessToken()
 *    (see auth/antigravity-client-version.ts)
 *  - x-activity-request-id: short random id (matches the Antigravity CLI logger)
 *  - payload wrapped in the CodeAssist envelope
 *    {model, project, user_prompt_id, request: <inner>} (+ enabled_credit_types
 *    for paid tiers).
 */

import { randomUUID } from "node:crypto";
import { resolveAntigravityServedModel } from "../../providers/transport/antigravity.js";
import {
  getValidAntigravityAccessToken,
  readSharedAntigravityToken,
} from "../antigravity-token.js";
import {
  buildAntigravityUserAgent,
  getServedAntigravityModels,
  setupAntigravityUser,
} from "../antigravity-user.js";
import type {
  CredentialProvider,
  ReadinessResult,
  RequestAuth,
  RequestAuthContext,
} from "./types.js";
import { readinessDetail } from "./types.js";

/** Generate a short random request ID (matches the Antigravity CLI activity logger). */
function createActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

export class AntigravityCredentialProvider implements CredentialProvider {
  readonly catalogName = "antigravity";

  /**
   * Available when a shared Antigravity token exists in the keychain.
   *
   * A non-macOS platform or an empty store is `absent` — the normal state for
   * anyone not signed in to Antigravity. A store read that THREW is `failed`:
   * nothing was learned, and reporting it as absence is what silently replaces
   * a subscription with a metered provider.
   *
   * KNOWN RESIDUAL, declared rather than papered over: `defaultReadStore` in
   * `auth/antigravity-token.ts` swallows its own `security` failure into `null`,
   * so a LOCKED keychain still arrives here as `absent`. Closing that means
   * changing the shared agy/claudish token path's contract — the same change
   * `architecture/keychain.md` already parks as deserving its own commit. This
   * method reports honestly for everything that reaches it; the gap is one
   * level down, not here.
   */
  async describeReadiness(): Promise<ReadinessResult> {
    try {
      return { readiness: readSharedAntigravityToken() !== null ? "present" : "absent" };
    } catch (err) {
      return {
        readiness: "failed",
        detail: `Antigravity token store could not be read: ${readinessDetail(err) ?? "unknown error"}`,
      };
    }
  }

  /** Unchanged contract: the `=== "present"` projection of the above. */
  async isAvailable(): Promise<boolean> {
    return (await this.describeReadiness()).readiness === "present";
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    const token = await getValidAntigravityAccessToken();
    const { projectId, tierId } = await setupAntigravityUser(token);
    // Resolve the requested id against the account's dynamic models catalog
    // (fetchAvailableModels).
    const servedModel = resolveAntigravityServedModel(
      ctx.model,
      await getServedAntigravityModels(token, projectId)
    );
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": buildAntigravityUserAgent(),
        "x-activity-request-id": createActivityRequestId(),
      },
      transformPayload: (inner: any) => {
        const env: any = {
          model: servedModel,
          project: projectId,
          user_prompt_id: randomUUID(),
          request: inner,
        };
        if (tierId && tierId !== "free-tier") {
          env.enabled_credit_types = ["GOOGLE_ONE_AI"];
        }
        return env;
      },
    };
  }
}
