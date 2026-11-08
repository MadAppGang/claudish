/**
 * Grok Build subscription credential — the Grok CLI's own OIDC token.
 *
 * `grok login` writes `~/.grok/auth.json` (mode 0600), keyed by an OIDC SCOPE
 * string rather than a fixed name:
 *
 * ```json
 * {
 *   "https://auth.x.ai::<client_id>": {
 *     "key": "<JWT>", "refresh_token": "...", "expires_at": "...",
 *     "auth_mode": "oidc", "oidc_issuer": "https://auth.x.ai",
 *     "oidc_client_id": "<client_id>"
 *   }
 * }
 * ```
 *
 * Two facts separate this from the Devin credential, which is otherwise the
 * closest analogue:
 *
 * 1. **The token expires in 6 hours** (measured: create 22:50:04Z → expires
 *    04:50:04Z). A claudish session routinely outlives that, so read-only access
 *    is not enough — this module refreshes.
 * 2. **Refresh needs no client secret.** `auth.x.ai`'s discovery document lists
 *    `"none"` in `token_endpoint_auth_methods_supported`, i.e. a PUBLIC client,
 *    and the `client_id` is a field in the credential file itself. That makes
 *    this strictly simpler than Antigravity, which extracts a client_id/secret
 *    pair out of the user's local `agy` binary at runtime.
 *
 * The file is SHARED with a tool claudish does not own. An OIDC server may
 * rotate the refresh token on use, so a refresh that is not persisted would
 * leave the user's own `grok` CLI holding a dead token — claudish would have
 * broken someone else's tool. Write-back is therefore atomic (temp + rename,
 * mode preserved) and non-negotiable.
 *
 * Reads are deliberately NOT memoized. The file is ~1.7 KB, which is nothing
 * beside the HTTP request it authorizes, and the `grok` CLI may rewrite it
 * concurrently — a fresh read is how we notice.
 *
 * Full reverse-engineering write-up: `ai-docs/reports/grok-subscription/protocol-spec.md`.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  credentialHttpError,
  isTransientCredentialError,
} from "../../auth/credentials/credential-error.js";
import {
  GROK_PUBLIC_CLIENT_ID,
  GrokOAuth,
  grokOAuthPath,
  setGrokOAuthPathForTesting,
} from "../../auth/grok-oauth.js";
import { classifyConnectionError, markOwnTimeout } from "../../handlers/shared/connection-error.js";
import { TOKEN_REFRESH_TIMEOUT_MS } from "../../handlers/shared/transient-retry.js";
import { log } from "../../logger.js";

/** Base-URL override, the same variable the Grok CLI installer honours. */
export const GROK_PROXY_URL_ENV = "GROK_PROXY_URL";

/** The backend the Grok CLI talks to when nothing overrides it. */
export const DEFAULT_GROK_PROXY_URL = "https://cli-chat-proxy.grok.com/v1";

/**
 * Client identifier the proxy expects. Recovered from the shipped binary,
 * adjacent to the literals `cli-chat-proxy` and `x-grok-client-identifier`.
 */
export const GROK_CLIENT_IDENTIFIER = "grok-shell";

/**
 * Last-resort client version.
 *
 * Only used when the local install cannot be read at all. The proxy enforces a
 * MINIMUM version and rejects anything below it, so this is a floor known to be
 * accepted — never a pin. The real value comes from the user's own install; see
 * `readGrokClientVersion`.
 */
export const FALLBACK_GROK_CLIENT_VERSION = "1.0.4";

/** The legacy scope key, still parsed by xAI's own installer. */
const LEGACY_SCOPE = "https://accounts.x.ai/sign-in";

/** Refresh this many ms BEFORE `expires_at`, so a request never races expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Test seam: an explicit `~/.grok` directory. */
let grokHomeOverride: string | null = null;

/**
 * Point the reader at a specific grok home (tests only). Pass `null` to restore.
 *
 * Tests must NOT try to move `homedir()` — it cannot be re-pointed at runtime in
 * Bun (the standing lesson from `onepassword-config.test.ts`).
 */
export function setGrokHomeForTesting(path: string | null): void {
  grokHomeOverride = path;
  refreshInFlight = null;
  // Point the OAuth store at a sibling inside the SAME temp home, so a test
  // that seams only `~/.grok` cannot accidentally read the developer's real
  // `claudish login grok` credential and take the wrong branch.
  setGrokOAuthPathForTesting(path ? join(path, "claudish-grok-oauth.json") : null);
  liveClientVersion = null;
}

/** The `~/.grok` directory claudish reads (honours the test seam). */
export function grokHome(): string {
  return grokHomeOverride ?? join(homedir(), ".grok");
}

/** The credential file written by `grok login`. */
export function grokAuthPath(): string {
  return join(grokHome(), "auth.json");
}

/** One resolved credential entry, with the scope key it was found under. */
export interface GrokCredential {
  /** The OIDC scope string this entry is keyed by — needed to write it back. */
  scope: string;
  /** The bearer access token. */
  key: string;
  refreshToken?: string;
  /** RFC3339 instant, as written by the CLI. */
  expiresAt?: string;
  clientId?: string;
  issuer?: string;
  authMode?: string;
}

interface RawEntry {
  key?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  oidc_client_id?: unknown;
  oidc_issuer?: unknown;
  auth_mode?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Read + parse `auth.json`. A missing or malformed file is `undefined`, never a
 * throw: an absent Grok CLI is the normal state for every user without one.
 *
 * Entry selection mirrors xAI's own installer precedence — the OIDC entry wins,
 * then the legacy scope, then a lone entry. The scope string EMBEDS the
 * client_id and can rotate, so it is never matched as a hardcoded literal.
 */
export function readGrokCredential(): GrokCredential | undefined {
  let parsed: Record<string, RawEntry>;
  try {
    parsed = JSON.parse(readFileSync(grokAuthPath(), "utf8")) as Record<string, RawEntry>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const entries = Object.entries(parsed).filter(
    ([, v]) => v && typeof v === "object" && str(v.key)
  );
  if (entries.length === 0) return undefined;

  const chosen =
    entries.find(([, v]) => str(v.auth_mode)?.toLowerCase() === "oidc") ??
    entries.find(([scope]) => scope === LEGACY_SCOPE) ??
    entries[0];

  const [scope, raw] = chosen;
  const key = str(raw.key);
  if (!key) return undefined;

  return {
    scope,
    key,
    refreshToken: str(raw.refresh_token),
    expiresAt: str(raw.expires_at),
    clientId: str(raw.oidc_client_id),
    issuer: str(raw.oidc_issuer),
    authMode: str(raw.auth_mode),
  };
}

/**
 * Test seam for claudish's own OAuth store path.
 *
 * MANDATORY in any test that exercises token resolution. Without it the default
 * path is the real `~/.claudish/grok-oauth.json`, so whether a test takes the
 * OAuth branch or the CLI branch depends on whether the developer running it
 * happens to be logged in — the same class of machine-state dependency that
 * made `setPeerLockProbe` necessary for the 1Password suite.
 */
export function setClaudishGrokOAuthPathForTesting(path: string | null): void {
  // ONE seam: `GrokOAuth` reads the same path, so the readiness check and the
  // token resolver can never read two different files under a test override.
  setGrokOAuthPathForTesting(path);
}

/** claudish's OWN OAuth store, written by `claudish login grok`. */
export function claudishGrokOAuthPath(): string {
  return grokOAuthPath();
}

/**
 * Whether `claudish login grok` has been run.
 *
 * Deliberately a bare `existsSync` rather than a parse: this is called from the
 * sync readiness classifier, and "a credential file exists" is the question the
 * classifier is actually asking. A corrupt file surfaces later as a real error
 * with a real message, which is more useful than silently reading as
 * "logged out".
 */
export function hasClaudishGrokOAuth(): boolean {
  return existsSync(claudishGrokOAuthPath());
}

/**
 * Whether ANY Grok subscription credential is available — sync and cheap enough
 * for the TUI's readiness classifier and the routing check.
 *
 * Two independent sources, in preference order:
 *   1. claudish's own OAuth store (`claudish login grok`) — no Grok CLI needed.
 *   2. The Grok CLI's `~/.grok/auth.json` — reused for free when present.
 */
export function hasGrokCredentials(): boolean {
  return hasClaudishGrokOAuth() || readGrokCredential() !== undefined;
}

/**
 * The OIDC client id to authenticate as.
 *
 * Prefers the id recorded in a local `~/.grok/auth.json`, so if xAI ever rotates
 * the CLI's public client id, a user who has the CLI installed picks the new one
 * up with no claudish release. The published constant is the floor for machines
 * that have never had the CLI.
 */
export function resolveGrokClientId(): string {
  return readGrokCredential()?.clientId ?? GROK_PUBLIC_CLIENT_ID;
}

/**
 * Whether this credential is expired (or close enough that a request would race
 * expiry). An entry with no `expires_at` is treated as still valid — we cannot
 * prove otherwise, and a needless refresh would rotate a working token.
 */
export function isGrokCredentialExpired(cred: GrokCredential, now = Date.now()): boolean {
  if (!cred.expiresAt) return false;
  const expiry = Date.parse(cred.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry - EXPIRY_SKEW_MS <= now;
}

/**
 * The installed CLI version, for the `x-grok-client-version` header.
 *
 * The proxy enforces a MINIMUM version — without this header every request
 * fails with `Your Grok CLI version (none) is outdated`. The user's CLI
 * self-updates, so the value is READ from the local install rather than pinned;
 * a literal would guarantee a future silent breakage of exactly the kind this
 * gate exists to cause.
 */
export function readGrokClientVersion(): string {
  return readLocalGrokVersion() ?? FALLBACK_GROK_CLIENT_VERSION;
}

/**
 * The version recorded by a LOCAL Grok CLI install, or undefined when there is
 * none. Split out from `readGrokClientVersion` so the async resolver can tell
 * "no CLI installed" (→ consult the live channel pointer) apart from "CLI
 * installed and it reports X".
 */
function readLocalGrokVersion(): string | undefined {
  for (const [file, field] of [
    ["version.json", "version"],
    ["models_cache.json", "grok_version"],
  ] as const) {
    try {
      const parsed = JSON.parse(readFileSync(join(grokHome(), file), "utf8")) as Record<
        string,
        unknown
      >;
      const version = str(parsed[field]);
      if (version) return version;
    } catch {
      // Try the next source.
    }
  }
  return undefined;
}

/**
 * The channel pointer xAI's own installer reads to find the current release.
 * Returns a bare version string, e.g. `1.0.5`.
 */
const GROK_CHANNEL_URL = "https://x.ai/cli/stable";

/** Cached live version, so the pointer is fetched at most once per process. */
let liveClientVersion: string | null = null;

/**
 * The `x-grok-client-version` value, resolved for BOTH install states.
 *
 * Order: the local install (authoritative when the CLI is present) → the live
 * channel pointer → the floor constant.
 *
 * The live fetch is what makes standalone `claudish login grok` durable. The
 * proxy's gate is a MINIMUM version, so a shipped constant works only until
 * xAI raises that minimum above it — at which point every request fails with
 * `426 Upgrade Required` and the fix would require a claudish release. Reading
 * the same pointer xAI's installer reads means the floor is only ever a
 * last resort.
 *
 * A failed fetch is not an error: it falls through to the constant, because a
 * version header that might be stale is strictly better than no request at all.
 */
export async function resolveGrokClientVersion(): Promise<string> {
  const local = readLocalGrokVersion();
  if (local) return local;
  if (liveClientVersion) return liveClientVersion;

  try {
    const response = await fetch(GROK_CHANNEL_URL, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const version = (await response.text()).trim().split(/\s+/)[0];
      // Guard the shape: this endpoint is plain text, so a redirect to an HTML
      // error page would otherwise be signed into a header verbatim.
      if (/^\d+\.\d+\.\d+(-[A-Za-z0-9._]+)?$/.test(version)) {
        liveClientVersion = version;
        return version;
      }
    }
  } catch {
    // Offline or blocked — the constant below is the fallback.
  }
  return FALLBACK_GROK_CLIENT_VERSION;
}

/** The proxy base URL, without a trailing slash. */
export function readGrokProxyUrl(): string {
  const fromEnv = process.env[GROK_PROXY_URL_ENV]?.trim();
  return (fromEnv || DEFAULT_GROK_PROXY_URL).replace(/\/+$/, "");
}

/** Headers the proxy requires. All three are mandatory; see the module header. */
export function grokAuthHeaders(token: string, version = readGrokClientVersion()) {
  return {
    Authorization: `Bearer ${token}`,
    "x-grok-client-version": version,
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
  };
}

/** A terminal error — one that no amount of retrying can resolve. */
function terminal(message: string): Error & { terminal?: boolean } {
  const err: Error & { terminal?: boolean } = new Error(message);
  err.terminal = true;
  return err;
}

const SIGN_IN_HINT =
  "Run `claudish login grok` (no Grok CLI required — SuperGrok or X Premium+ subscription). " +
  "An existing `grok login` (~/.grok/auth.json) is also picked up automatically.";

/**
 * Persist a refreshed token back into `auth.json`, atomically.
 *
 * Read-modify-write of the WHOLE file so unrelated scopes and fields the CLI
 * cares about survive untouched, then temp + rename so a crash mid-write can
 * never leave the user with a truncated credential file. Mode 0600 matches what
 * `grok login` writes.
 *
 * Compare-and-set on the refresh token: the entry is written only while it still
 * holds `refreshedFrom`, the refresh token this refresh presented. If `grok login`
 * rewrote the entry during the exchange, the newer login is kept and nothing is
 * written; the caller still signs THIS request with the token it just received (the
 * server issued it, so it is valid), and the next resolve reads the file again (there
 * is no cache) and uses the newer entry, refreshing from its own token if needed.
 */
function persistRefreshedToken(
  scope: string,
  refreshedFrom: string | undefined,
  next: { key: string; refreshToken?: string; expiresAt?: string }
): void {
  const path = grokAuthPath();
  let parsed: Record<string, Record<string, unknown>>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
  } catch {
    // If the file became unreadable between resolve and write-back, do not
    // recreate it from partial state — the CLI owns this file.
    return;
  }

  const entry = parsed[scope];
  if (!entry || typeof entry !== "object") return;
  if (str(entry.refresh_token) !== refreshedFrom) {
    log("[Grok] ~/.grok/auth.json changed during the token refresh; kept the newer file");
    return;
  }

  entry.key = next.key;
  if (next.refreshToken) entry.refresh_token = next.refreshToken;
  if (next.expiresAt) entry.expires_at = next.expiresAt;

  const tmp = `${path}.claudish.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Single-flight guard.
 *
 * ComposedHandler can have several requests in flight against one provider. Each
 * would otherwise refresh independently, and because the server may ROTATE the
 * refresh token, the second call would present a token the first just
 * invalidated — turning a working session into `invalid_grant`.
 */
let refreshInFlight: Promise<string> | null = null;

/** The refresh ceiling: TOKEN_REFRESH_TIMEOUT_MS, unless a test shortens it. */
let refreshTimeoutMs = TOKEN_REFRESH_TIMEOUT_MS;

/** Shorten the refresh ceiling (tests only). Pass `null` to restore TOKEN_REFRESH_TIMEOUT_MS. */
export function setGrokRefreshTimeoutForTesting(ms: number | null): void {
  refreshTimeoutMs = ms ?? TOKEN_REFRESH_TIMEOUT_MS;
}

/**
 * Exchange the refresh token for a new access token and persist the result.
 *
 * Public-client refresh: `client_id` in the body, no secret. Verified against
 * `auth.x.ai`'s discovery document, which lists `"none"` among its supported
 * token-endpoint auth methods.
 */
async function performRefresh(cred: GrokCredential): Promise<string> {
  if (!cred.refreshToken || !cred.clientId) {
    throw terminal(`Grok credential is expired and cannot be refreshed. ${SIGN_IN_HINT}`);
  }

  const tokenEndpoint = `${(cred.issuer ?? "https://auth.x.ai").replace(/\/+$/, "")}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cred.refreshToken,
    client_id: cred.clientId,
  });

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      // Bounds the single-flight latch below — see TOKEN_REFRESH_TIMEOUT_MS.
      signal: AbortSignal.timeout(refreshTimeoutMs),
    });
  } catch (error) {
    // A network failure is NOT terminal — it can self-heal, so let the normal
    // retry path see it rather than rendering a dead-end 400.
    // `{ cause }` so `classifyConnectionError` can find the real syscall code
    // instead of depending on Bun's connect sentence surviving inside the
    // interpolated message above — which it does today, by luck, and would stop
    // doing the moment either side of that string is reworded. This is the
    // FIRST network touch of a `gk@` request (ComposedHandler calls getHeaders()
    // before the upstream fetch), so an unclassifiable failure here escapes into
    // the fallback chain with `status: 0`.
    //
    // `claudishEndpoint` names the host that ACTUALLY failed. Without it the
    // handler falls back to the model endpoint, so an `auth.x.ai` outage was
    // reported — in the banner, in the log, and in the episode key — as
    // `api.x.ai`: the wrong host, and the wrong advice for a user trying to fix
    // it. `local.ts` attaches the same property for the same reason.
    //
    // `markOwnTimeout`: the ceiling above is ours, so a `TimeoutError` from it
    // is a reachability fact about the auth host, and must classify as one.
    throw Object.assign(
      new Error(
        `Could not reach ${tokenEndpoint} to refresh the Grok token: ${(error as Error).message}`,
        { cause: markOwnTimeout(error) }
      ),
      { claudishEndpoint: tokenEndpoint }
    );
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      detail = parsed.error_description ?? parsed.error ?? detail;
    } catch {
      // Keep the raw prose.
    }
    // `invalid_grant` means the refresh token is dead — only a new login fixes
    // it. Terminal, so ComposedHandler renders it inline instead of sending
    // Claude Code into ~11 rounds of "API error · Retrying".
    // 429/5xx from the token host is transient (retry the same hop); anything
    // else is a dead grant and terminal (`credential-error.ts`).
    throw credentialHttpError(
      `Grok token refresh failed (${response.status}): ${detail}. ${SIGN_IN_HINT}`,
      response.status
    );
  }

  const parsed = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const accessToken = str(parsed.access_token);
  if (!accessToken) {
    throw terminal(`Grok token refresh returned no access_token. ${SIGN_IN_HINT}`);
  }

  const expiresAt =
    typeof parsed.expires_in === "number"
      ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
      : undefined;

  try {
    persistRefreshedToken(cred.scope, cred.refreshToken, {
      key: accessToken,
      refreshToken: str(parsed.refresh_token),
      expiresAt,
    });
  } catch {
    // A failed write-back must not fail the REQUEST — we hold a valid token in
    // memory. The cost is re-refreshing next run, not an outage.
  }

  return accessToken;
}

/**
 * The access token to sign a request with, refreshing first when expired.
 *
 * Throws a TERMINAL error when there is no credential at all: no amount of
 * retrying produces a token that is not on disk.
 */
export async function resolveGrokAccessToken(): Promise<string> {
  // 1. claudish's OWN OAuth store (`claudish login grok`). Preferred because we
  //    own that file outright — refresh and write-back carry none of the
  //    lost-update risk of writing a file the Grok CLI also owns.
  if (hasClaudishGrokOAuth()) {
    try {
      return await GrokOAuth.getInstance().getToken();
    } catch (error) {
      // A transient or network failure is rethrown FIRST, whatever else is on
      // disk: the claudish login is fine and its token host only blinked, so
      // the request retries. Falling through would sign with a possibly stale
      // ~/.grok/auth.json, and wrapping it terminal would stop a working
      // subscription.
      if (isTransientCredentialError(error) || classifyConnectionError(error)) throw error;
      // Otherwise fall through to the CLI credential rather than failing
      // outright: a user who has BOTH should not be blocked by one being
      // broken. With no CLI credential either, this throw carries the message.
      if (!readGrokCredential()) throw terminal(`${(error as Error).message}`);
    }
  }

  // 2. The Grok CLI's own credential, reused verbatim.
  const cred = readGrokCredential();
  if (!cred) throw terminal(`No Grok subscription credential. ${SIGN_IN_HINT}`);
  if (!isGrokCredentialExpired(cred)) return cred.key;
  return refreshShared(cred);
}

/**
 * Refresh REGARDLESS of what `expires_at` claims, for the transport's 401 retry.
 *
 * `expires_at` is only advisory — the SERVER decides when a token is dead, and
 * it can revoke early or disagree with a skewed local clock. Without this, such
 * a token is re-sent unchanged on every request and the session is stuck until
 * the user notices and re-runs `grok login`. With it, a 401 self-heals once.
 *
 * Shares the single-flight latch with the expiry path, so a 401 arriving while a
 * scheduled refresh is already running joins it rather than racing it — which
 * matters because the server may rotate the refresh token.
 */
export async function forceRefreshGrokAccessToken(): Promise<string> {
  if (hasClaudishGrokOAuth()) {
    const oauth = GrokOAuth.getInstance();
    await oauth.refreshToken();
    return oauth.getToken();
  }
  const cred = readGrokCredential();
  if (!cred) throw terminal(`No Grok subscription credential. ${SIGN_IN_HINT}`);
  return refreshShared(cred);
}

function refreshShared(cred: GrokCredential): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh(cred).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}
