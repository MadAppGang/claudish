/**
 * Vertex AI credential — ADC / service-account based (no interactive login).
 *
 * Availability mirrors the vertex profile (provider-profiles.ts): a Google Cloud
 * project resolves (VERTEX_PROJECT / GOOGLE_CLOUD_PROJECT, the ADC file's
 * quota_project_id, or `gcloud config get project`). The request token comes
 * from the shared VertexAuthManager (gcloud ADC or service account); there is no
 * login/logout because auth is ADC-based.
 *
 * There is no API-key mode. VERTEX_API_KEY (Express) was deleted on 2026-09-21.
 */

import {
  getVertexAuthManager,
  resetVertexAuthManager,
  resetVertexProjectDiscovery,
  resolveVertexConfig,
  selectVertexAuthMode,
  validateVertexOAuthConfig,
} from "../vertex-auth.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export class VertexCredentialProvider implements CredentialProvider {
  readonly catalogName = "vertex";

  async isAvailable(): Promise<boolean> {
    const config = await resolveVertexConfig();
    return selectVertexAuthMode({ project: config?.projectId }) !== null;
  }

  invalidate(): void {
    resetVertexAuthManager();
    resetVertexProjectDiscovery();
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    const config = await resolveVertexConfig();
    if (selectVertexAuthMode({ project: config?.projectId }) === "project") {
      const token = await getVertexAuthManager().getAccessToken();
      return { headers: { Authorization: `Bearer ${token}` } };
    }
    // Name the remedy rather than the symptom: with ADC present this is a
    // missing PROJECT, and "no credential" would send the user to re-run a
    // login that already succeeded.
    throw new Error(
      (await validateVertexOAuthConfig()) ?? "Vertex requires a Google Cloud project"
    );
  }
}
