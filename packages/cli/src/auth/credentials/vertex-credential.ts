/**
 * Vertex AI credential — ADC / service-account based (no interactive login).
 *
 * Availability mirrors the existing vertex profile (provider-profiles.ts):
 * a Vertex project is configured (VERTEX_PROJECT / GOOGLE_CLOUD_PROJECT), or
 * VERTEX_API_KEY selects Express mode in the absence of a project. The request
 * token is obtained from the shared VertexAuthManager (gcloud ADC or service
 * account); there is no login/logout because auth is ADC-based.
 */

import { getVertexAuthManager, selectVertexAuthMode } from "../vertex-auth.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export class VertexCredentialProvider implements CredentialProvider {
  readonly catalogName = "vertex";

  async isAvailable(): Promise<boolean> {
    return selectVertexAuthMode() !== null;
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    // A project selects OAuth even when an Express key is also configured.
    if (selectVertexAuthMode() === "project") {
      const token = await getVertexAuthManager().getAccessToken();
      return { headers: { Authorization: `Bearer ${token}` } };
    }
    const expressKey = process.env.VERTEX_API_KEY;
    if (expressKey) return { headers: { Authorization: `Bearer ${expressKey}` } };
    throw new Error("Vertex requires a configured project or Express key");
  }
}
