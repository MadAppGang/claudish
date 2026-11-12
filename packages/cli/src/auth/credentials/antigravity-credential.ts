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
import type { EffortLevel } from "../../adapters/base-api-format.js";
import {
  antigravityBodyForModelId,
  resolveAntigravityServedModel,
} from "../../providers/transport/antigravity.js";
import {
  antigravityTokenLineageMaterial,
  getValidAntigravityAccessToken,
  readSharedAntigravityToken,
} from "../antigravity-token.js";
import {
  antigravityHost,
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

  /**
   * The shared login's refresh-token lineage (the access token when the store
   * holds no refresh token), bound to the backend host. A refresh that keeps the
   * refresh token keeps the identity; a new sign-in moves it.
   */
  async accountIdentity(): Promise<string | undefined> {
    const token = readSharedAntigravityToken();
    if (!token) return undefined;
    const lineage = antigravityTokenLineageMaterial(token);
    return lineage ? `${lineage}\n${antigravityHost()}` : undefined;
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    const token = await getValidAntigravityAccessToken();
    const { projectId, tierId } = await setupAntigravityUser(token);
    // Resolve the requested id against the account's dynamic models catalog
    // (fetchAvailableModels), at the request's effort: the level can be carried
    // in the model id. The same function the transport and the availability
    // check use, so all three choose the same id.
    const served = await getServedAntigravityModels(token, projectId);
    const servedModelAt = (effort: EffortLevel | undefined) =>
      resolveAntigravityServedModel(ctx.model, served, effort);
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": buildAntigravityUserAgent(),
        "x-activity-request-id": createActivityRequestId(),
      },
      transformPayload: (inner: any, request?: { effort?: EffortLevel }) => {
        const model = servedModelAt(request ? request.effort : ctx.effort);
        const env: any = {
          model,
          project: projectId,
          user_prompt_id: randomUUID(),
          // When the id sent carries the effort, the body carries none beside
          // it; otherwise the dialect's control stays.
          request: antigravityBodyForModelId(inner, model),
        };
        if (tierId && tierId !== "free-tier") {
          env.enabled_credit_types = ["GOOGLE_ONE_AI"];
        }
        return env;
      },
    };
  }
}
