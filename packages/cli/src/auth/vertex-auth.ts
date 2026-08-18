/**
 * Vertex AI OAuth Authentication Manager
 *
 * Handles OAuth2 token generation for full Vertex AI access.
 * Supports:
 * - Application Default Credentials (ADC) via gcloud CLI
 * - Service Account JSON via GOOGLE_APPLICATION_CREDENTIALS
 *
 * Used for partner models (Anthropic Claude, Mistral, etc.) and
 * project-based Vertex AI access.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execAsync = promisify(exec);

interface VertexAccessToken {
  token: string;
  expiresAt: number;
}

export interface VertexConfig {
  projectId: string;
  location: string;
}

/**
 * Manages OAuth2 tokens for Vertex AI
 */
export class VertexAuthManager {
  private cachedToken: VertexAccessToken | null = null;
  private refreshPromise: Promise<string> | null = null;
  private tokenRefreshMargin = 5 * 60 * 1000; // Refresh 5 minutes before expiry

  /**
   * Get a valid access token, refreshing if needed
   */
  async getAccessToken(): Promise<string> {
    // If refresh already in progress, wait for it
    if (this.refreshPromise) {
      log("[VertexAuth] Waiting for in-progress refresh");
      return this.refreshPromise;
    }

    // Check cache
    if (this.isTokenValid()) {
      return this.cachedToken!.token;
    }

    // Start refresh (lock to prevent duplicate refreshes)
    this.refreshPromise = this.doRefresh();

    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Force refresh the token
   */
  async refreshToken(): Promise<void> {
    this.cachedToken = null;
    await this.getAccessToken();
  }

  /**
   * Check if cached token is still valid
   */
  private isTokenValid(): boolean {
    if (!this.cachedToken) return false;
    return Date.now() < this.cachedToken.expiresAt - this.tokenRefreshMargin;
  }

  /**
   * Perform the actual token refresh
   */
  private async doRefresh(): Promise<string> {
    log("[VertexAuth] Refreshing token");

    // Try ADC first (gcloud)
    const adcToken = await this.tryADC();
    if (adcToken) {
      this.cachedToken = adcToken;
      log(`[VertexAuth] ADC token valid until ${new Date(adcToken.expiresAt).toISOString()}`);
      return adcToken.token;
    }

    // Try service account
    const saToken = await this.tryServiceAccount();
    if (saToken) {
      this.cachedToken = saToken;
      log(
        `[VertexAuth] Service account token valid until ${new Date(saToken.expiresAt).toISOString()}`
      );
      return saToken.token;
    }

    throw new Error(
      "Failed to authenticate with Vertex AI.\n\n" +
        "Options:\n" +
        "1. Run: gcloud auth application-default login\n" +
        "2. Set: export GOOGLE_APPLICATION_CREDENTIALS='/path/to/service-account.json'\n"
    );
  }

  /**
   * Try to get token via Application Default Credentials (gcloud)
   */
  private async tryADC(): Promise<VertexAccessToken | null> {
    try {
      // Check if ADC credentials file exists
      const adcPath = join(homedir(), ".config/gcloud/application_default_credentials.json");

      if (!existsSync(adcPath)) {
        log("[VertexAuth] ADC credentials file not found");
        return null;
      }

      // Get token via gcloud CLI
      const { stdout } = await execAsync("gcloud auth application-default print-access-token", {
        timeout: 10000,
      });

      const token = stdout.trim();
      if (!token) {
        log("[VertexAuth] ADC returned empty token");
        return null;
      }

      // Tokens typically last 1 hour, use 55 minutes to be safe
      const expiresAt = Date.now() + 55 * 60 * 1000;

      return { token, expiresAt };
    } catch (e: any) {
      log(`[VertexAuth] ADC failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Try to get token via service account JSON
   */
  private async tryServiceAccount(): Promise<VertexAccessToken | null> {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath) {
      return null;
    }

    if (!existsSync(credPath)) {
      throw new Error(
        `Service account file not found: ${credPath}\n\nCheck GOOGLE_APPLICATION_CREDENTIALS path.`
      );
    }

    try {
      // Use gcloud with service account
      const { stdout } = await execAsync(
        `gcloud auth print-access-token --credential-file-override="${credPath}"`,
        { timeout: 10000 }
      );

      const token = stdout.trim();
      if (!token) {
        log("[VertexAuth] Service account returned empty token");
        return null;
      }

      // Tokens typically last 1 hour, use 55 minutes to be safe
      const expiresAt = Date.now() + 55 * 60 * 1000;

      return { token, expiresAt };
    } catch (e: any) {
      log(`[VertexAuth] Service account auth failed: ${e.message}`);
      return null;
    }
  }
}

/**
 * Get Vertex AI configuration from environment
 */
export function getVertexConfig(): VertexConfig | null {
  const projectId = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    return null;
  }

  return {
    projectId,
    location: process.env.VERTEX_LOCATION || "us-central1",
  };
}

/**
 * Validate Vertex AI OAuth configuration
 * Returns error message if invalid, null if OK
 */
export function validateVertexOAuthConfig(): string | null {
  const config = getVertexConfig();
  if (!config) {
    return (
      "Missing VERTEX_PROJECT environment variable.\n\n" +
      "Set it with:\n" +
      "  export VERTEX_PROJECT='your-gcp-project-id'\n" +
      "  export VERTEX_LOCATION='us-central1'  # optional"
    );
  }

  // Check for credentials
  const adcPath = join(homedir(), ".config/gcloud/application_default_credentials.json");
  const hasADC = existsSync(adcPath);
  const hasServiceAccount = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!hasADC && !hasServiceAccount) {
    return (
      "No Vertex AI credentials found.\n\n" +
      "Options:\n" +
      "1. Run: gcloud auth application-default login\n" +
      "2. Set: export GOOGLE_APPLICATION_CREDENTIALS='/path/to/service-account.json'"
    );
  }

  return null;
}

/**
 * API host for a Vertex location.
 *
 * Most locations are regional and take the `<location>-aiplatform.googleapis.com`
 * template. Two do not, and both were previously built from that template and
 * 404'd, so the location was unreachable rather than merely degraded.
 *
 * Measured 2026-08-18, POSTing a real generateContent path to each host. A 401
 * means the route exists and wants credentials; a 404 means there is no such
 * route. DNS does not discriminate here — every name below resolves, because
 * `*.googleapis.com` has a catch-all frontend.
 *
 *   location     host built                              code
 *   us-central1  us-central1-aiplatform.googleapis.com   401   regional, unchanged
 *   us           us-aiplatform.googleapis.com            401   regional, unchanged
 *   eu           eu-aiplatform.googleapis.com            404   BROKEN
 *                aiplatform.eu.rep.googleapis.com        401   the real one
 *   global       global-aiplatform.googleapis.com        404   BROKEN
 *                aiplatform.googleapis.com               401   the real one
 *
 * `us` stays on the regional host on purpose, even though
 * `aiplatform.us.rep.googleapis.com` also answers 401. Both are real and they
 * are different endpoints — only the REP one carries a data-residency
 * guarantee. But nothing observable from outside says which a user setting
 * `VERTEX_LOCATION=us` intends, and the current construction already reaches a
 * live route. Rerouting it would be inference; this table is measurement.
 * A user who needs US data residency should be given a way to ask for it
 * explicitly rather than have it inferred from a location string.
 *
 * Reported by @nickoloss in #145, who found the eu case and verified the host.
 */
export function vertexApiHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (location === "eu") return "aiplatform.eu.rep.googleapis.com";
  return `${location}-aiplatform.googleapis.com`;
}

/**
 * Build Vertex AI endpoint URL for OAuth mode
 */
export function buildVertexOAuthEndpoint(
  config: VertexConfig,
  publisher: string,
  model: string,
  streaming = true
): string {
  const method = streaming ? "streamGenerateContent" : "generateContent";

  // For Gemini models (publisher: google), use generateContent
  // For partner models (publisher: anthropic, mistral), use rawPredict
  if (publisher === "google") {
    // Add ?alt=sse for SSE streaming format
    const sseParam = streaming ? "?alt=sse" : "";
    return (
      `https://${vertexApiHost(config.location)}/v1/` +
      `projects/${config.projectId}/locations/${config.location}/` +
      `publishers/${publisher}/models/${model}:${method}${sseParam}`
    );
  }
  if (publisher === "mistralai") {
    // Mistral uses regional rawPredict/streamRawPredict endpoint
    const mistralMethod = streaming ? "streamRawPredict" : "rawPredict";
    return (
      `https://${vertexApiHost(config.location)}/v1/` +
      `projects/${config.projectId}/locations/${config.location}/` +
      `publishers/mistralai/models/${model}:${mistralMethod}`
    );
  }
  // Other partners (MiniMax, Meta, etc.) use global OpenAI-compatible endpoint
  return `https://aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/global/endpoints/openapi/chat/completions`;
}

// Singleton instance
let authManagerInstance: VertexAuthManager | null = null;

/**
 * Get the shared VertexAuthManager instance
 */
export function getVertexAuthManager(): VertexAuthManager {
  if (!authManagerInstance) {
    authManagerInstance = new VertexAuthManager();
  }
  return authManagerInstance;
}
