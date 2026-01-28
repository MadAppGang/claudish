/**
 * Kimi OAuth Authentication Manager
 *
 * Handles Device Authorization Grant (RFC 8628) for Kimi/Moonshot AI API access.
 * Supports:
 * - Device authorization flow with browser-based user authorization
 * - Secure credential storage with 0600 permissions
 * - Automatic token refresh with 5-minute buffer
 * - Singleton pattern for shared token management
 * - Persistent device ID for platform headers
 * - Network retry with exponential backoff
 * - API key fallback on refresh failure
 *
 * Credentials stored at: ~/.claudish/kimi-oauth.json
 * Device ID stored at: ~/.claudish/kimi-device-id
 */

import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, unlinkSync, openSync, writeSync, closeSync } from "node:fs";
import { homedir, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execAsync = promisify(exec);

/**
 * Kimi OAuth credentials structure
 */
export interface KimiCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp (ms)
  scope: string;
  token_type: string;
}

/**
 * Device authorization response
 */
interface DeviceAuthorization {
  user_code: string;
  device_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * Token response
 */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  error?: string;
  error_description?: string;
}

/**
 * OAuth configuration for Kimi/Moonshot AI
 */
const OAUTH_CONFIG = {
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
  authHost: "https://auth.kimi.com",
  deviceAuthPath: "/api/oauth/device_authorization",
  tokenPath: "/api/oauth/token",
};

/**
 * Manages OAuth authentication for Kimi/Moonshot AI API
 */
export class KimiOAuth {
  private static instance: KimiOAuth | null = null;
  private credentials: KimiCredentials | null = null;
  private refreshPromise: Promise<string> | null = null;
  private tokenRefreshMargin = 5 * 60 * 1000; // Refresh 5 minutes before expiry
  private deviceId: string; // Persistent device ID (generated once)

  /**
   * Get singleton instance
   */
  static getInstance(): KimiOAuth {
    if (!KimiOAuth.instance) {
      KimiOAuth.instance = new KimiOAuth();
    }
    return KimiOAuth.instance;
  }

  /**
   * Private constructor (singleton pattern)
   * FIX C3: Generate/load device ID in constructor (not per-request)
   */
  private constructor() {
    // Load or create device ID
    this.deviceId = this.loadOrCreateDeviceId();
    log(`[KimiOAuth] Device ID loaded: ${this.deviceId}`);

    // Try to load existing credentials on startup
    this.credentials = this.loadCredentials();
  }

  /**
   * Check if credentials exist (without validating expiry)
   * Use this to determine if login is needed before making requests
   */
  hasCredentials(): boolean {
    return this.credentials !== null && !!this.credentials.refresh_token;
  }

  /**
   * Get credentials file path
   */
  private getCredentialsPath(): string {
    const claudishDir = join(homedir(), ".claudish");
    return join(claudishDir, "kimi-oauth.json");
  }

  /**
   * Get device ID file path
   */
  private getDeviceIdPath(): string {
    const claudishDir = join(homedir(), ".claudish");
    return join(claudishDir, "kimi-device-id");
  }

  /**
   * Load or create persistent device ID
   * FIX C3: Called once in constructor, cached in instance
   */
  private loadOrCreateDeviceId(): string {
    const deviceIdPath = this.getDeviceIdPath();
    const claudishDir = join(homedir(), ".claudish");

    // Ensure directory exists
    if (!existsSync(claudishDir)) {
      const { mkdirSync } = require("node:fs");
      mkdirSync(claudishDir, { recursive: true });
    }

    // Try to load existing device ID
    if (existsSync(deviceIdPath)) {
      try {
        const deviceId = readFileSync(deviceIdPath, "utf-8").trim();
        if (deviceId) {
          return deviceId;
        }
      } catch (e: any) {
        log(`[KimiOAuth] Failed to load device ID: ${e.message}`);
      }
    }

    // Generate new device ID (UUID v4)
    const deviceId = randomBytes(16)
      .toString("hex")
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

    // Save to file
    try {
      const fd = openSync(deviceIdPath, "w", 0o600);
      try {
        writeSync(fd, deviceId, 0, "utf-8");
      } finally {
        closeSync(fd);
      }
      log(`[KimiOAuth] New device ID created: ${deviceId}`);
    } catch (e: any) {
      log(`[KimiOAuth] Failed to save device ID: ${e.message}`);
    }

    return deviceId;
  }

  /**
   * Get version from package.json
   */
  private getVersion(): string {
    try {
      const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
      return packageJson.version;
    } catch {
      return "4.0.6"; // Fallback
    }
  }

  /**
   * Get platform headers (X-Msh-*)
   * Uses cached device ID from constructor
   */
  getPlatformHeaders(): Record<string, string> {
    return {
      "X-Msh-Platform": "claudish",
      "X-Msh-Version": this.getVersion(),
      "X-Msh-Device-Name": hostname(),
      "X-Msh-Device-Model": `${platform()}-${process.arch}`,
      "X-Msh-Os-Version": release(),
      "X-Msh-Device-Id": this.deviceId,
    };
  }

  /**
   * Start OAuth login flow (Device Authorization Grant)
   */
  async login(): Promise<void> {
    log("[KimiOAuth] Starting Device Authorization Grant flow");

    // Step 1: Request device authorization
    const deviceAuth = await this.requestDeviceAuthorization();

    // Step 2: Display user code and open browser
    console.log("\n🔐 Kimi OAuth Login");
    console.log("═".repeat(60));
    console.log(`\nPlease authorize this device:`);
    console.log(`\n  Visit: ${deviceAuth.verification_uri_complete}`);
    console.log(`  User Code: ${deviceAuth.user_code}`);
    console.log(`\nWaiting for authorization...`);

    await this.openBrowser(deviceAuth.verification_uri_complete);

    // Step 3: Poll for token
    const tokens = await this.pollForToken(
      deviceAuth.device_code,
      deviceAuth.interval,
      deviceAuth.expires_in
    );

    // Step 4: Save credentials
    const credentials: KimiCredentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token!,
      expires_at: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
      token_type: tokens.token_type,
    };

    this.saveCredentials(credentials);
    this.credentials = credentials;

    log("[KimiOAuth] Login successful");
  }

  /**
   * Request device authorization from Kimi OAuth server
   */
  private async requestDeviceAuthorization(): Promise<DeviceAuthorization> {
    log("[KimiOAuth] Requesting device authorization");

    const url = `${OAUTH_CONFIG.authHost}${OAUTH_CONFIG.deviceAuthPath}`;
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      ...this.getPlatformHeaders(),
    };

    const body = new URLSearchParams({
      client_id: OAUTH_CONFIG.clientId,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Device authorization failed: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as DeviceAuthorization;

      if (!data.device_code || !data.user_code || !data.verification_uri_complete) {
        throw new Error("Invalid device authorization response");
      }

      log(
        `[KimiOAuth] Device authorization received: ${data.user_code} (expires in ${data.expires_in}s)`
      );

      return data;
    } catch (e: any) {
      throw new Error(`Failed to request device authorization: ${e.message}`);
    }
  }

  /**
   * Poll for token (RFC 8628 compliant)
   * FIX H2: Implements slow_down backoff (+5s per occurrence)
   * FIX H3: Network retry with exponential backoff
   */
  private async pollForToken(
    deviceCode: string,
    interval: number,
    expiresIn: number
  ): Promise<TokenResponse> {
    log(`[KimiOAuth] Starting polling (interval: ${interval}s, timeout: ${expiresIn}s)`);

    const startTime = Date.now();
    const timeoutMs = expiresIn * 1000;
    let currentInterval = interval * 1000; // Convert to ms

    while (Date.now() - startTime < timeoutMs) {
      // Wait for the current interval before polling
      await new Promise((resolve) => setTimeout(resolve, currentInterval));

      // Poll with retry logic (FIX H3)
      const result = await this.pollForTokenWithRetry(deviceCode);

      // Handle different response types
      if (result.error) {
        if (result.error === "authorization_pending") {
          // User hasn't authorized yet, continue polling
          log("[KimiOAuth] Authorization pending...");
          continue;
        } else if (result.error === "slow_down") {
          // FIX H2: RFC 8628 Section 3.5 - increase interval by 5 seconds
          currentInterval += 5000;
          log(`[KimiOAuth] Slow down requested, new interval: ${currentInterval / 1000}s`);
          continue;
        } else if (result.error === "expired_token") {
          throw new Error("Device code expired. Please run `claudish --kimi-login` again.");
        } else if (result.error === "access_denied") {
          throw new Error("Authorization denied by user.");
        } else {
          throw new Error(`OAuth error: ${result.error} - ${result.error_description}`);
        }
      }

      // Success!
      if (result.access_token && result.refresh_token) {
        log("[KimiOAuth] Token received successfully");
        return result;
      }

      // Unexpected response
      throw new Error("Invalid token response (missing access_token or refresh_token)");
    }

    throw new Error(`Authorization timed out after ${expiresIn} seconds.`);
  }

  /**
   * Poll for token with network retry (FIX H3)
   * Max 3 retries with exponential backoff (1s, 2s, 4s)
   */
  private async pollForTokenWithRetry(
    deviceCode: string,
    retryCount = 0
  ): Promise<TokenResponse> {
    const maxRetries = 3;
    const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s

    try {
      const url = `${OAUTH_CONFIG.authHost}${OAUTH_CONFIG.tokenPath}`;
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        ...this.getPlatformHeaders(),
      };

      const body = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      // Parse response (could be success or error)
      const data = (await response.json()) as TokenResponse;
      return data;
    } catch (e: any) {
      // Network error - retry if not exhausted
      if (retryCount < maxRetries) {
        log(
          `[KimiOAuth] Network error during polling (attempt ${retryCount + 1}/${maxRetries}), retrying in ${backoffMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.pollForTokenWithRetry(deviceCode, retryCount + 1);
      }

      throw new Error(`Network error during token polling: ${e.message}`);
    }
  }

  /**
   * Open URL in default browser
   * FIX M4: Catch errors silently, always show URL
   */
  private async openBrowser(url: string): Promise<void> {
    const currentPlatform = platform();

    try {
      if (currentPlatform === "darwin") {
        await execAsync(`open "${url}"`);
      } else if (currentPlatform === "win32") {
        await execAsync(`start "${url}"`);
      } else {
        // Linux/Unix
        await execAsync(`xdg-open "${url}"`);
      }
    } catch (e: any) {
      // Silently catch browser open errors (URL already displayed to user)
      log(`[KimiOAuth] Failed to open browser: ${e.message}`);
    }
  }

  /**
   * Logout - delete stored credentials
   */
  async logout(): Promise<void> {
    const credPath = this.getCredentialsPath();

    if (existsSync(credPath)) {
      unlinkSync(credPath);
      log("[KimiOAuth] Credentials deleted");
    }

    this.credentials = null;
  }

  /**
   * Get valid access token, refreshing if needed
   * FIX C2: Promise caching with .finally() cleanup
   */
  async getAccessToken(): Promise<string> {
    // If refresh already in progress, wait for it
    if (this.refreshPromise) {
      log("[KimiOAuth] Waiting for in-progress refresh");
      return this.refreshPromise;
    }

    // Check if we have credentials
    if (!this.credentials) {
      throw new Error("No Kimi OAuth credentials found. Please run `claudish --kimi-login` first.");
    }

    // Check if token is still valid (with 5-minute buffer)
    if (this.isTokenValid()) {
      return this.credentials.access_token;
    }

    // Start refresh (lock to prevent duplicate refreshes)
    // FIX C2: Use .finally() to ensure lock is released even on error
    this.refreshPromise = this.doRefreshToken().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Check if cached token is still valid (with 5-minute buffer)
   * FIX H5: Includes 5-minute buffer
   */
  private isTokenValid(): boolean {
    if (!this.credentials) return false;
    return Date.now() < this.credentials.expires_at - this.tokenRefreshMargin;
  }

  /**
   * Perform the actual token refresh
   * FIX H4: Falls back to API key if available on failure
   */
  private async doRefreshToken(): Promise<string> {
    if (!this.credentials) {
      throw new Error("No Kimi OAuth credentials found. Please run `claudish --kimi-login` first.");
    }

    log("[KimiOAuth] Refreshing access token");

    try {
      const url = `${OAUTH_CONFIG.authHost}${OAUTH_CONFIG.tokenPath}`;
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        ...this.getPlatformHeaders(),
      };

      const body = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        grant_type: "refresh_token",
        refresh_token: this.credentials.refresh_token,
      });

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
      }

      const tokens = (await response.json()) as TokenResponse;

      // Update credentials (keep existing refresh token if new one not provided)
      const updatedCredentials: KimiCredentials = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || this.credentials.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        scope: tokens.scope,
        token_type: tokens.token_type,
      };

      this.saveCredentials(updatedCredentials);
      this.credentials = updatedCredentials;

      log(
        `[KimiOAuth] Token refreshed, valid until ${new Date(updatedCredentials.expires_at).toISOString()}`
      );

      return updatedCredentials.access_token;
    } catch (e: any) {
      log(`[KimiOAuth] Refresh failed: ${e.message}`);

      // Delete invalid credentials
      const credPath = this.getCredentialsPath();
      if (existsSync(credPath)) {
        unlinkSync(credPath);
      }
      this.credentials = null;

      // FIX H4: Check for API key fallback (FR5 priority)
      if (process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY) {
        log("[KimiOAuth] Falling back to API key mode");
        // Return empty string to signal fallback to handler
        // Handler will detect API key and use it instead
        throw new Error("OAuth_FALLBACK_TO_API_KEY");
      }

      // No API key available, throw error with instructions
      throw new Error(
        `OAuth credentials invalid. Please re-login or set API key:\n` +
          `  - Run: claudish --kimi-login\n` +
          `  - Or set: export MOONSHOT_API_KEY='your-api-key'\n\n` +
          `Details: ${e.message}`
      );
    }
  }

  /**
   * Load credentials from file
   */
  private loadCredentials(): KimiCredentials | null {
    const credPath = this.getCredentialsPath();

    if (!existsSync(credPath)) {
      return null;
    }

    try {
      const data = readFileSync(credPath, "utf-8");
      const credentials = JSON.parse(data) as KimiCredentials;

      // Validate structure
      if (
        !credentials.access_token ||
        !credentials.refresh_token ||
        !credentials.expires_at ||
        !credentials.scope ||
        !credentials.token_type
      ) {
        log("[KimiOAuth] Invalid credentials file structure");
        return null;
      }

      log("[KimiOAuth] Loaded credentials from file");
      return credentials;
    } catch (e: any) {
      log(`[KimiOAuth] Failed to load credentials: ${e.message}`);
      return null;
    }
  }

  /**
   * Save credentials to file with 0600 permissions
   */
  private saveCredentials(credentials: KimiCredentials): void {
    const credPath = this.getCredentialsPath();
    const claudishDir = join(homedir(), ".claudish");

    // Ensure directory exists
    if (!existsSync(claudishDir)) {
      const { mkdirSync } = require("node:fs");
      mkdirSync(claudishDir, { recursive: true });
    }

    // Atomically create file with secure permissions (0600) to prevent race condition
    const fd = openSync(credPath, "w", 0o600);
    try {
      const data = JSON.stringify(credentials, null, 2);
      writeSync(fd, data, 0, "utf-8");
    } finally {
      closeSync(fd);
    }

    log(`[KimiOAuth] Credentials saved to ${credPath}`);
  }
}

/**
 * Get the shared KimiOAuth instance
 */
export function getKimiOAuth(): KimiOAuth {
  return KimiOAuth.getInstance();
}

/**
 * Get a valid access token (refreshing if needed)
 * Helper function for handlers to use
 */
export async function getValidKimiAccessToken(): Promise<string> {
  const oauth = KimiOAuth.getInstance();
  return oauth.getAccessToken();
}

/**
 * Check if Kimi OAuth credentials are available AND valid (sync check)
 * CRITICAL: Includes expiry check with 5-minute buffer
 * This is called by the provider resolver AFTER checking for API key env vars (FR5 priority)
 */
export function hasKimiOAuthCredentials(): boolean {
  try {
    const credPath = join(homedir(), ".claudish", "kimi-oauth.json");
    if (!existsSync(credPath)) return false;

    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    // Check if token exists and is not expired (with 5-minute buffer)
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5 minutes
    return !!(
      data.access_token &&
      data.refresh_token &&
      data.expires_at &&
      data.expires_at > now + bufferMs
    );
  } catch {
    return false;
  }
}
