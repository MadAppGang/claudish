/**
 * `claudish login muse` — claudish's OWN Muse Code login, by Meta's device code
 * flow (RFC 8628), so a user needs neither the Muse Code CLI nor a Keychain
 * approval.
 *
 * ## The wire (captured 2026-10-16, muse-wire.md §8)
 *
 * ```
 * POST https://auth.meta.com/oidc/device/authorization/   (form)  client_id=1031625952748946
 * → {device_code, user_code, verification_uri, verification_uri_complete, expires_in: 600, interval: 5}
 * POST https://auth.meta.com/oidc/device/token/   (form)
 *   grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…
 * → 400 {"error":"authorization_pending"} | 400 {"error":"slow_down"} | 200 {access_token, …}
 * ```
 *
 * No scope parameter. The success body was not captured (approval was not
 * given), so only `access_token` is required; `token_type`, when present, must
 * be Bearer; `refresh_token` / `expires_in` are kept if Meta sends them and
 * never relied on. The durable credential is the `dca:` access token: it is
 * used until `/muse-code/key` answers 401, then the user logs in again.
 *
 * ## After approval
 *
 * The token is minted once (`muse-mint.ts`) BEFORE it is stored:
 * - confirmed → stored in `~/.claudish/meta-muse-oauth.json` (0600, atomic);
 * - the account has no active subscription → NOT stored, and the subscribe
 *   message is the login's failure (a stored unsubscribed login would be tried
 *   first on every request and block a working borrowed copy);
 * - the key service is unreachable or busy → stored, with a warning: the login
 *   itself succeeded, and the request path confirms the entitlement later.
 *
 * Then the in-process credential state and the authority's memo are dropped.
 *
 * ## Logout
 *
 * `claudish logout muse` removes BOTH claudish files — the own login and the
 * borrowed copy of the Muse Code CLI's login. It never touches the Muse Code
 * CLI's Keychain item, and it does not revoke remotely (the revocation
 * endpoint's shape was not captured).
 */

import { execFile } from "node:child_process";
import { log } from "../logger.js";
import { resetMuseCredentialState } from "../providers/meta-muse/muse-credentials.js";
import {
  type MuseMint,
  MuseSubscriptionRequiredError,
  mintMuseApiKey,
} from "../providers/meta-muse/muse-mint.js";
import {
  defaultMuseStoreDir,
  deleteMuseStores,
  writeMuseStore,
} from "../providers/meta-muse/muse-store.js";
import { credentials } from "./credentials/authority.js";

export const MUSE_OIDC_CLIENT_ID = "1031625952748946";
const AUTH_BASE = "https://auth.meta.com";
const DEVICE_AUTHORIZATION_URL = `${AUTH_BASE}/oidc/device/authorization/`;
const DEVICE_TOKEN_URL = `${AUTH_BASE}/oidc/device/token/`;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 defaults when the authorization response omits them. */
const DEFAULT_INTERVAL_S = 5;
const DEFAULT_EXPIRES_S = 600;
/** RFC 8628 §3.5: `slow_down` raises the interval by 5 s, for good. */
const SLOW_DOWN_STEP_MS = 5000;

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenAnswer {
  access_token?: unknown;
  token_type?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** Side effects, injectable so the flow is checkable with no network and no browser. */
export interface MuseOAuthDeps {
  fetch: (...args: Parameters<typeof fetch>) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openBrowser: (url: string) => Promise<void>;
  print: (line: string) => void;
  mint: (accessToken: string) => Promise<MuseMint>;
  dir: () => string;
}

function openInBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  // execFile, not a shell: the URL is the vendor's and is passed as one argument.
  return new Promise((resolve) => {
    execFile(command, [url], () => resolve());
  });
}

const defaultDeps: MuseOAuthDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  openBrowser: openInBrowser,
  print: (line) => console.log(line),
  mint: (token) => mintMuseApiKey(token),
  dir: defaultMuseStoreDir,
};

function describe(answer: TokenAnswer, status: number): string {
  if (typeof answer.error_description === "string" && answer.error_description) {
    return answer.error_description;
  }
  if (typeof answer.error === "string" && answer.error) return answer.error;
  return `HTTP ${status}`;
}

export class MuseCodeOAuth {
  private static instance: MuseCodeOAuth | null = null;

  static getInstance(): MuseCodeOAuth {
    if (!MuseCodeOAuth.instance) MuseCodeOAuth.instance = new MuseCodeOAuth();
    return MuseCodeOAuth.instance;
  }

  constructor(private readonly deps: MuseOAuthDeps = defaultDeps) {}

  /** The full device-code login; resolves once the login is stored. */
  async login(): Promise<void> {
    const auth = await this.requestDeviceCode();
    const url = auth.verification_uri_complete ?? auth.verification_uri;
    this.deps.print("\nSign in to Meta for Muse Code (a Muse Code subscription is required).");
    this.deps.print(`\n  Code: ${auth.user_code}`);
    this.deps.print(`  URL:  ${url}\n`);
    await this.deps.openBrowser(url);
    this.deps.print("Approve the request in your browser; waiting…");

    const token = await this.pollForToken(auth);
    let tier: string | undefined;
    try {
      tier = (await this.deps.mint(token.accessToken)).subsTierName;
    } catch (err) {
      if (err instanceof MuseSubscriptionRequiredError) throw err;
      if ((err as { terminal?: unknown })?.terminal === true) throw err;
      this.deps.print(
        `Warning: the Muse Code key service could not confirm the subscription yet (${(err as Error).message}); the login is saved and will be confirmed on first use.`
      );
    }

    writeMuseStore(
      "own-login",
      {
        access_token: token.accessToken,
        obtained_at: new Date(this.deps.now()).toISOString(),
        client_id: MUSE_OIDC_CLIENT_ID,
        ...(token.refreshToken ? { refresh_token: token.refreshToken } : {}),
        ...(token.expiresIn !== undefined ? { token_expires_in: token.expiresIn } : {}),
        ...(tier ? { subs_tier_name: tier } : {}),
      },
      this.deps.dir()
    );
    this.invalidate();
    this.deps.print(
      `\nSigned in to Muse Code${tier ? ` (${tier})` : ""}. Try it with: claudish --model muse@muse-spark-1.3 "hello"\n`
    );
  }

  /** Remove claudish's own login and its borrowed copy. Never touches the Keychain. */
  async logout(): Promise<void> {
    deleteMuseStores(this.deps.dir());
    this.invalidate();
  }

  /** Drop the core's minted key and the authority's memo (which also clears the signed arm). */
  private invalidate(): void {
    resetMuseCredentialState();
    try {
      credentials.invalidate("meta-muse-code");
    } catch (err) {
      log(`[MuseCodeOAuth] credential invalidate failed: ${(err as Error).message}`);
    }
  }

  private async requestDeviceCode(): Promise<DeviceAuthorization> {
    const response = await this.deps.fetch(DEVICE_AUTHORIZATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: MUSE_OIDC_CLIENT_ID }),
    });
    const parsed = (await response.json().catch(() => ({}))) as Partial<DeviceAuthorization> &
      TokenAnswer;
    if (
      !response.ok ||
      typeof parsed.device_code !== "string" ||
      typeof parsed.user_code !== "string" ||
      typeof parsed.verification_uri !== "string"
    ) {
      throw new Error(
        `Could not start the Meta device login: ${describe(parsed, response.status)}`
      );
    }
    return parsed as DeviceAuthorization;
  }

  /**
   * Poll until approval, refusal or expiry. `authorization_pending` and a
   * network blip keep waiting; `slow_down` adds 5 s to the interval for the
   * rest of the wait; anything else ends the login with Meta's own words.
   */
  private async pollForToken(
    auth: DeviceAuthorization
  ): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
    let intervalMs =
      (auth.interval && auth.interval > 0 ? auth.interval : DEFAULT_INTERVAL_S) * 1000;
    const deadline =
      this.deps.now() +
      (auth.expires_in && auth.expires_in > 0 ? auth.expires_in : DEFAULT_EXPIRES_S) * 1000;

    while (this.deps.now() < deadline) {
      await this.deps.sleep(intervalMs);
      let response: Response;
      let answer: TokenAnswer;
      try {
        response = await this.deps.fetch(DEVICE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT,
            device_code: auth.device_code,
            client_id: MUSE_OIDC_CLIENT_ID,
          }),
        });
        answer = (await response.json().catch(() => ({}))) as TokenAnswer;
      } catch (error) {
        log(`[MuseCodeOAuth] poll failed, retrying: ${(error as Error).message}`);
        continue;
      }

      if (typeof answer.access_token === "string" && answer.access_token.length > 0) {
        if (typeof answer.token_type === "string" && answer.token_type.toLowerCase() !== "bearer") {
          throw new Error(
            `Meta sign-in returned a ${answer.token_type} token, not a Bearer grant.`
          );
        }
        return {
          accessToken: answer.access_token,
          ...(typeof answer.refresh_token === "string" && answer.refresh_token
            ? { refreshToken: answer.refresh_token }
            : {}),
          ...(typeof answer.expires_in === "number" ? { expiresIn: answer.expires_in } : {}),
        };
      }
      if (answer.error === "authorization_pending") continue;
      if (answer.error === "slow_down") {
        intervalMs += SLOW_DOWN_STEP_MS;
        continue;
      }
      throw new Error(`Meta sign-in failed: ${describe(answer, response.status)}`);
    }
    throw new Error(
      "Meta sign-in timed out: the device code expired. Run `claudish login muse` again."
    );
  }
}
