/**
 * OpenAI Codex OAuth Authentication Manager
 *
 * Handles OAuth2 PKCE flow for OpenAI Codex API access via ChatGPT Plus/Pro subscription.
 * Supports:
 * - Browser-based OAuth login with local callback server
 * - Secure credential storage with 0600 permissions
 * - Automatic token refresh with 5-minute buffer
 * - Singleton pattern for shared token management
 * - Account ID extraction from id_token JWT claims
 *
 * Credentials stored at: ~/.claudish/codex-oauth.json
 *
 * ## The file is SHARED with the account pool, and so is its refresh gate
 *
 * `LegacyCodexFileStore` (`accounts/token-store.ts`) reads and writes this same
 * file as the synthesized legacy `default` account, and keeps two keys of its
 * own in it: `claudish_generation` (bumped on every persist — the only way a
 * gate waiter can tell "the holder rotated" from "nothing happened") and
 * `claudish_journal` (an in-flight rotation, made durable before the exchange).
 * So:
 *
 * - **Every write here is read-merge-write.** A whole-document rewrite from this
 *   class's four-key view deleted both, dropping the generation to 0 and closing
 *   an open journal the pool had not resolved.
 * - **Every refresh here takes the pool's gate for that account** — the SAME
 *   lock file (`accountLockPath("openai-codex", LEGACY_CODEX_ACCOUNT_ID)`), with
 *   the same "fail, never proceed unlocked" semantics. Two refreshers exchanging
 *   one refresh token is `refresh_token_reused` for the second, and reuse
 *   detection can revoke the whole grant.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { markOwnTimeout } from "../handlers/shared/connection-error.js";
import { TOKEN_REFRESH_TIMEOUT_MS } from "../handlers/shared/transient-retry.js";
import { log } from "../logger.js";
import { resolveUpstreamUrl } from "../test-upstream.js";
import { atomicWriteFileSync } from "./accounts/atomic-write.js";
import { EXCHANGE_TIMEOUT_MS } from "./accounts/exchange.js";
import type { LockHandle } from "./accounts/file-lock.js";
import { accountLockPath, legacyCodexCredentialsPath } from "./accounts/paths.js";
import {
  type AcquireGateOptions,
  isGateUnavailable,
  withRefreshGate,
} from "./accounts/refresh-lock.js";
// From `types.ts`, the dependency-free home `paths.ts` validates this id against,
// so the sentinel this class locks on is the one the path builder accepts.
import { LEGACY_CODEX_ACCOUNT_ID } from "./accounts/types.js";
import { credentialHttpError } from "./credentials/credential-error.js";

import {
  type CodexPkceDeps,
  CODEX_OAUTH_CONFIG as OAUTH_CONFIG,
  loginCodexPkce,
} from "./codex-pkce.js";

/** The one recovery a user can always take, named in every refresh failure. */
const LOGIN_COMMAND = "claudish login codex";

/**
 * A terminal Codex OAuth refresh (or re-read) failure that produced no usable token.
 *
 * ComposedHandler answers 400 with `x-claudish-auth-verdict: terminal` and
 * `upstream_status: 401`. The verdict keeps the reason inline rather than behind
 * "API error · Retrying" (#148), and the routing chain continues only to remaining
 * SUBSCRIPTION candidates, never metered. The upstream status describes the
 * credential failure, not the token endpoint's own `invalid_grant` 400.
 *
 * Transient failures are NOT this error: a busy refresh gate or token host uses
 * `credentialHttpError`, and an unreachable token host ({@link tokenHostUnreachable})
 * is classified by ComposedHandler and held in the connection recovery ladder.
 * Neither signs with the api-key arm or advances to a metered candidate. Nor is
 * a LOCAL failure (an unreadable credential file, a refresh lock that could not
 * be created or was taken over, a token that could not be saved): that is
 * {@link CodexOAuthLocalError}.
 *
 * The message is one line and always names `claudish login codex`.
 */
export class CodexOAuthRefreshError extends Error {
  readonly terminal = true;
  readonly upstreamStatus = 401;

  constructor(message: string) {
    super(message);
    this.name = "CodexOAuthRefreshError";
  }
}

/**
 * A LOCAL failure of the legacy Codex login: the credential file exists and
 * could not be read or holds no usable token pair, the refresh lock could not
 * be created or was taken over before the save, or a refreshed token could not
 * be written. No credential was presented to OpenAI and rejected.
 *
 * So it is never {@link CodexOAuthRefreshError}. A terminal verdict with
 * `upstream_status: 401` moves a bare routing chain to its next hop, metered
 * included (`FallbackHandler`, `9ace3fe5`), and a disk or lock fault must not
 * move a subscriber onto per-token billing, nor tell them their login was
 * rejected. Transient with NO upstream status: ComposedHandler answers 503
 * with the transient verdict (`auth-failure.ts`), so the same hop is retried
 * and the chain never walks. The message carries the repair instruction.
 * The pool's equivalent is `RefreshUnavailableError` (`accounts/errors.ts`).
 */
export class CodexOAuthLocalError extends Error {
  readonly transient = true;

  constructor(message: string) {
    super(message);
    this.name = "CodexOAuthLocalError";
  }
}

/** What a refresh was asked to do — the two triggers want different adoption rules. */
type RefreshTrigger =
  /** The cached token is near expiry. Any fresh token on disk will do. */
  | { kind: "expiry" }
  /**
   * Upstream rejected a bearer (the 401 path). A token on disk is adopted only if
   * it is fresh AND is not the one this process was handing out when the forced
   * refresh was requested — adopting that would re-send the rejected bearer.
   */
  | { kind: "forced"; rejected: string | undefined };

/** The credential file as read, with the pool's generation beside it. */
interface CredentialFileRead {
  credentials: CodexCredentials;
  generation: number;
}

/**
 * What the credential file says about "is a Codex OAuth login configured?" —
 * the three outcomes that must never collapse into two.
 *
 * - `present` — read, parsed, and carrying a usable token pair.
 * - `absent` — the file does not exist (`ENOENT`/`ENOTDIR` and nothing else), or
 *   it is a readable JSON object that names no refresh token. The second is the
 *   account registry's "present-and-empty" (`accounts/registry.ts`,
 *   `refreshLegacy`), kept identical so Phase 2's pool predicate answers the
 *   same way this one does. Falling through to an api key is legitimate here.
 * - `failed` — the file exists and could not be read or parsed (`EACCES`, `EIO`,
 *   `EMFILE`, `EISDIR`, truncated or invalid JSON, not an object), or it names a
 *   refresh token beside an unusable access token or expiry. NEVER "no login".
 */
type CredentialFileOutcome =
  | { kind: "present"; read: CredentialFileRead }
  | { kind: "absent" }
  | { kind: "failed"; error: CodexOAuthLocalError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absence is `ENOENT`/`ENOTDIR` ONLY — `existsSync` also says "no" for `EACCES`. */
function isAbsenceError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The on-disk document, as far as this class reads it. Every field unverified. */
interface RawCredentialFile {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  account_id?: unknown;
  claudish_generation?: unknown;
}

/** A token endpoint's error body — both the OAuth-standard and the OpenAI shapes. */
interface TokenEndpointErrorBody {
  error?: string | { code?: unknown; message?: unknown };
  error_description?: unknown;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The credential file exists and could not be used. One line: what is wrong,
 * what to do, and — because this is the case that USED to sign metered — that
 * no api-key fallback stands behind it.
 */
function credentialFileUnreadable(credPath: string, detail: string): CodexOAuthLocalError {
  return new CodexOAuthLocalError(
    `Could not read the OpenAI Codex credential file (${credPath}): ${detail}. ` +
      `Fix its permissions or contents, or run \`${LOGIN_COMMAND}\` to replace it; ` +
      "claudish does not fall back to OPENAI_CODEX_API_KEY while this file exists."
  );
}

/** Anything a credential-file read threw, as the local error the handler surfaces. */
function asCredentialFileError(e: unknown, credPath: string): CodexOAuthLocalError {
  return e instanceof CodexOAuthLocalError
    ? e
    : credentialFileUnreadable(credPath, errorMessage(e));
}

/**
 * Redact and bound a token-endpoint error body before it enters a message.
 *
 * That message now reaches Claude Code's transcript (it is the inline 400), so it
 * must never carry the presented refresh token — `accounts/exchange.ts` refuses
 * to log these bodies wholesale for the same reason. The OAuth `error` code and
 * its description are what a user can act on; the rest is dropped.
 */
function describeTokenEndpointError(body: string, presentedRefreshToken: string): string {
  let text = "";
  try {
    const parsed = JSON.parse(body) as TokenEndpointErrorBody | null;
    const err = parsed?.error;
    const nested = typeof err === "object" && err !== null ? err : undefined;
    const code =
      typeof err === "string" ? err : typeof nested?.code === "string" ? nested.code : undefined;
    const message =
      typeof parsed?.error_description === "string"
        ? parsed.error_description
        : typeof nested?.message === "string"
          ? nested.message
          : undefined;
    text = [code, message].filter(Boolean).join(": ");
  } catch {
    text = body;
  }
  if (presentedRefreshToken) text = text.split(presentedRefreshToken).join("[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 200) text = `${text.slice(0, 200)}…`;
  return text ? ` ${text}` : "";
}

/**
 * OAuth credentials structure
 */
export interface CodexCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp (ms)
  account_id?: string; // Extracted from id_token JWT claims (chatgpt_account_id)
}

/**
 * OpenAI OAuth token response
 */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string; // JWT containing chatgpt_account_id claim
}

/**
 * The ceiling on ONE refresh-token exchange: the SHORTER of the two bounds this
 * exchange sits under, as one signal.
 *
 * Both bound the same hazard — a hung exchange holding something its waiters
 * are queued on — and this exchange has two kinds of waiter:
 *
 * - **the in-process single flight** (`refreshPromise`), which every recovery
 *   ladder attempt re-enters. It must clear inside one attempt, so the ceiling
 *   sits below `PER_ATTEMPT_CONNECT_CAP_MS`: `TOKEN_REFRESH_TIMEOUT_MS` (20 s).
 * - **the cross-process refresh gate** it runs under. Other processes wait for
 *   the gate for `GATE_TIMEOUT_MS` (20 s), so the exchange must end well inside
 *   that, leaving room for the persist: `EXCHANGE_TIMEOUT_MS` (10 s), the same
 *   budget the account pool's exchange uses under the same gate.
 *
 * At 20 s alone, a hung exchange could hold the gate for as long as a waiter
 * waits, and a waiter that lost that race answered the terminal "another
 * claudish process holds the refresh lock" instead of reaching the network
 * itself.
 *
 * The resulting `TimeoutError` is tagged `markOwnTimeout` (see
 * {@link tokenHostUnreachable}): a token host that does not answer inside our
 * own ceiling is a reachability fact.
 */
const CODEX_EXCHANGE_TIMEOUT_MS = Math.min(TOKEN_REFRESH_TIMEOUT_MS, EXCHANGE_TIMEOUT_MS);

/**
 * The error for "the token host could not be reached": a plain `Error` the
 * handler CLASSIFIES as a connection failure, never a `CodexOAuthRefreshError`.
 *
 * `{ cause }` makes classification structural: `classifyConnectionError` walks
 * the cause chain for the code, whatever the message says. `markOwnTimeout`
 * tags our own ceiling's `TimeoutError`; untagged it would classify as nothing
 * and be answered as a credential failure. `claudishEndpoint` names the host
 * that actually failed — without it the handler reports the MODEL host. The
 * same shape as `grok-credentials.ts` and `vertex-oauth.ts`.
 */
function tokenHostUnreachable(e: unknown, tokenUrl: string): Error {
  log(`[CodexOAuth] Could not reach ${tokenUrl}: ${errorMessage(e)}`);
  return Object.assign(
    new Error(`Could not reach ${tokenUrl} to refresh the Codex token: ${errorMessage(e)}`, {
      cause: markOwnTimeout(e),
    }),
    { claudishEndpoint: tokenUrl }
  );
}

/**
 * Manages OAuth authentication for OpenAI Codex API (ChatGPT Plus/Pro subscription)
 */
export class CodexOAuth {
  private static instance: CodexOAuth | null = null;
  private credentials: CodexCredentials | null = null;
  /**
   * Set when the last read found the credential file PRESENT BUT UNREADABLE
   * (the `failed` outcome), and `credentials` is then null.
   *
   * This is what keeps `failed` from reading as `absent`. Before it existed the
   * load caught every read and parse error and answered `null`, so
   * `hasCredentials()` was false, `CodexOAuthHalf.isAvailable()` was false, and
   * the composite signed with `OPENAI_CODEX_API_KEY` — a flat-rate user billed
   * per token because the file was briefly unreadable (accounts-validation.md,
   * V16b). It is NOT a cache of the failure: {@link getAccessToken} re-reads the
   * file on every request while it is set, so a transient `EMFILE` clears on the
   * next one.
   */
  private credentialFileFailure: CodexOAuthLocalError | null = null;
  /** Test seam: replaces the credential file's `readFileSync(path, "utf-8")`. */
  private readCredentialText: (path: string) => string = (path) => readFileSync(path, "utf-8");
  /**
   * The in-process single flight. EVERY refresh — expiry-driven and forced —
   * goes through {@link startRefresh}, so concurrent callers in this process
   * share one exchange; the gate then serialises across processes.
   */
  private refreshPromise: Promise<string> | null = null;
  private tokenRefreshMargin = 5 * 60 * 1000; // Refresh 5 minutes before expiry
  /** Test seam: clock/sleep/liveness/path overrides for the refresh gate. */
  private gateOverrides: Pick<AcquireGateOptions, "deps" | "path"> = {};

  /**
   * TEST SEAM. Reset in place and re-read the credential file from the current
   * `HOME`. Never replace the object: holders such as the credential authority
   * keep the reference they were given, leaving them on an orphan that still
   * reaches the real credential file if the singleton is replaced.
   */
  static _resetInstanceForTests(): void {
    const instance = CodexOAuth.instance;
    if (!instance) return;
    instance.credentials = null;
    instance.credentialFileFailure = null;
    instance.readCredentialText = (path) => readFileSync(path, "utf-8");
    instance.refreshPromise = null;
    instance.tokenRefreshMargin = 5 * 60 * 1000;
    instance.gateOverrides = {};
    instance.loadCredentials();
  }

  /**
   * TEST SEAM. Inject the refresh gate's `deps` (clock, sleep, liveness) or its
   * path, so a test can drive "gate held → timeout" without waiting 20 s and
   * without writing under the real `~/.claudish`. Production passes nothing.
   */
  _setRefreshGateOptionsForTests(opts: Pick<AcquireGateOptions, "deps" | "path">): void {
    this.gateOverrides = { ...opts };
  }

  /**
   * TEST SEAM. Replace how the credential file's bytes are read, so a test can
   * raise `EMFILE`/`EIO` (which no `chmod` produces) for ONE read and prove the
   * next request retries it. Throw an error whose `code` is `ENOENT` to model
   * absence. `null` restores `readFileSync`. Affects the classifying and strict
   * reads only, never `saveCredentials`' merge read. Production passes nothing.
   */
  _setCredentialFileReaderForTests(read: ((path: string) => string) | null): void {
    this.readCredentialText = read ?? ((path) => readFileSync(path, "utf-8"));
  }

  /**
   * Get singleton instance
   */
  static getInstance(): CodexOAuth {
    if (!CodexOAuth.instance) {
      CodexOAuth.instance = new CodexOAuth();
    }
    return CodexOAuth.instance;
  }

  /**
   * Private constructor (singleton pattern)
   */
  private constructor() {
    // Classify the credential file on startup: present, absent or failed.
    this.loadCredentials();
  }

  /**
   * Re-read the credential file from disk into the in-memory singleton.
   *
   * The singleton loads credentials ONCE in its constructor, so a login that
   * happens in a CHILD process (e.g. the config TUI spawns `claudish login
   * codex`) writes a fresh token file this long-lived parent never sees — its
   * request path keeps using the stale startup snapshot and fails until the
   * process is relaunched. Calling this after a login child returns picks up the
   * new token in-process, no restart needed.
   *
   * It drops an in-flight refresh so the re-entered TUI does not wait on one
   * started against the pre-login grant. That is safe ONLY because every
   * refresh now re-reads the file under the cross-process gate, and refuses to
   * overwrite material that changed during its exchange: a second flight queues
   * on the gate behind the first and then adopts its result instead of
   * presenting the same refresh token again. It is NOT part of the 401 path —
   * {@link forceRefresh} never calls it, because clearing the single flight
   * there is what let N concurrent 401s each spend the same refresh token.
   */
  reloadCredentials(): void {
    this.loadCredentials();
    this.refreshPromise = null;
  }

  /**
   * Is a Codex OAuth login CONFIGURED? Not "is it usable right now" — that is a
   * readiness question, answered at sign time by {@link getAccessToken}.
   *
   * True for a loaded credential with a refresh token (`present`), and ALSO for
   * a credential file that exists but could not be read (`failed`). False only
   * for `absent`: no file, or a readable one that names no refresh token.
   *
   * The `failed` → true answer is the fix for V16b, and it is load-bearing in
   * two places that read this one method:
   *
   * - `CodexOAuthHalf.isAvailable()` — so the composite commits to the OAuth half
   *   instead of falling through to the api-key half, and the request then fails
   *   VISIBLY in `getAccessToken()` (a `CodexOAuthLocalError`: 503 with the
   *   transient verdict, naming the file) instead of silently signing
   *   `OPENAI_CODEX_API_KEY`.
   * - the billing probe (`billing-probe.ts` `PROBES`) — it answers "subscription"
   *   here, which is safe as money: when this is true the composite never reaches
   *   the api-key half, so nothing this answer covers can be metered. The two
   *   read the same method so they cannot drift.
   *
   * No I/O: it reads what the last load recorded. The re-read happens on the
   * request path, where a failure can be reported.
   */
  hasCredentials(): boolean {
    return (
      (this.credentials !== null && !!this.credentials.refresh_token) ||
      this.credentialFileFailure !== null
    );
  }

  /**
   * Get credentials file path — the SAME resolver `LegacyCodexFileStore` uses,
   * so this class and the pool can never be talking about two different files.
   */
  private getCredentialsPath(): string {
    return legacyCodexCredentialsPath();
  }

  /**
   * The legacy account's refresh gate: the identical lock file the pool's
   * `TokenManager` takes for it (`token-manager.ts` defaults `lockPathFor` to
   * `accountLockPath(ref.provider, ref.id, env)`, and the synthesized legacy
   * account is `{provider: "openai-codex", id: LEGACY_CODEX_ACCOUNT_ID}`).
   */
  private getRefreshGatePath(): string {
    return this.gateOverrides.path ?? accountLockPath("openai-codex", LEGACY_CODEX_ACCOUNT_ID);
  }

  /**
   * Start OAuth login flow
   * Opens browser, starts local callback server, exchanges code for tokens
   */
  async login(deps: CodexPkceDeps = {}): Promise<void> {
    // Managed or suppressed: refused BEFORE the browser, naming the account verbs.
    const { assertLegacyCodexLoginPermitted, saveLegacyCodexLogin } = await import(
      "./accounts/management.js"
    );
    assertLegacyCodexLoginPermitted();
    const { credentials } = await loginCodexPkce(deps);
    const accountId = credentials.account_id;

    // Save credentials. `account_id` is written even when undefined, on purpose:
    // saveCredentials overlays these four keys on the existing file, and a login
    // may be to a DIFFERENT ChatGPT account, so a stale id must be cleared rather
    // than inherited. The pool's own keys survive the overlay.
    //
    // Not under the refresh gate: a login presents an authorization code, not the
    // refresh token, so it cannot cause `refresh_token_reused`, and a completed
    // browser login must never be discarded because a lock was busy. The ordering
    // hazard it does have — a refresh persisting the OLD grant over this — is
    // closed on the refresh side (see refreshHoldingGate's pre-persist re-read).
    // The CONFIG lock is taken, waiting out a busy holder: an `account add`
    // enrolling this file, or a remove suppressing it, sees the old login or the
    // new one, never a write that lands after it published.
    await saveLegacyCodexLogin(() => {
      this.saveCredentials(credentials);
      this.setCredentials(credentials);
    });

    log("[CodexOAuth] Login successful");
    if (accountId) {
      log(`[CodexOAuth] Account ID: ${accountId}`);
    }
  }

  /**
   * Logout - delete stored credentials
   */
  async logout(): Promise<void> {
    // Managed: refused before anything is unlinked, naming `account remove`.
    const { assertLegacyCodexLogoutPermitted } = await import("./accounts/management.js");
    assertLegacyCodexLogoutPermitted();
    const credPath = this.getCredentialsPath();

    if (existsSync(credPath)) {
      unlinkSync(credPath);
      log("[CodexOAuth] Credentials deleted");
    }

    this.setCredentials(null);
  }

  /**
   * Get valid access token, refreshing if needed
   */
  async getAccessToken(): Promise<string> {
    // If refresh already in progress, wait for it
    if (this.refreshPromise) {
      log("[CodexOAuth] Waiting for in-progress refresh");
      return this.refreshPromise;
    }

    // The file EXISTS but the last read could not use it (`failed`). The
    // composite committed to this half because of that (see hasCredentials), so
    // the answer must come from here: re-read on EVERY request — a transient
    // `EMFILE` must not stick — and if it still fails, throw the local error
    // naming the file (transient: no credential was rejected). Never a null that a caller could read as "no login".
    if (!this.credentials && this.credentialFileFailure) {
      this.loadCredentials();
      if (this.credentialFileFailure) throw this.credentialFileFailure;
    }

    // Check if we have credentials
    if (!this.credentials) {
      throw new CodexOAuthRefreshError(
        `No OpenAI Codex OAuth credentials found. Please run \`${LOGIN_COMMAND}\` first.`
      );
    }

    // Check if token is still valid
    if (this.isTokenValid()) {
      return this.credentials.access_token;
    }

    return this.startRefresh({ kind: "expiry" });
  }

  /**
   * Get the stored account ID (ChatGPT-Account-ID header value)
   */
  getAccountId(): string | undefined {
    return this.credentials?.account_id;
  }

  /**
   * The 401 path: upstream rejected the bearer this process signed with, so the
   * cached token is worthless however fresh its `expires_at` claims to be.
   *
   * Three properties, each closing a way N concurrent 401s (main turn,
   * subagents, background calls) used to spend ONE refresh token N times:
   *
   * 1. **Joins the in-process single flight.** A refresh already running — for
   *    either trigger — is awaited, never duplicated.
   * 2. **Takes the cross-process gate** shared with the account pool.
   * 3. **Re-reads the file under the gate.** If another process (or the pool)
   *    already rotated, and the token on disk is fresh and is not the one this
   *    process was handing out, it is adopted with NO exchange. Otherwise the
   *    CURRENT on-disk refresh token is exchanged exactly once.
   *
   * The comparison is against the token this process held when the refresh was
   * requested, because the handler's retry context does not carry the rejected
   * bearer itself. The one gap that leaves — a request signed before an
   * in-process refresh finished whose 401 lands after it — costs a second,
   * SEQUENTIAL exchange of the then-current refresh token, never a reuse.
   */
  async forceRefresh(): Promise<string> {
    if (this.refreshPromise) {
      log("[CodexOAuth] Forced refresh joined the in-progress refresh");
      return this.refreshPromise;
    }
    return this.startRefresh({ kind: "forced", rejected: this.credentials?.access_token });
  }

  /**
   * Force refresh the access token. Kept for existing callers; it is
   * {@link forceRefresh} — single flight, gate and all.
   */
  async refreshToken(): Promise<void> {
    await this.forceRefresh();
  }

  /**
   * Check if cached token is still valid
   */
  private isTokenValid(): boolean {
    if (!this.credentials) return false;
    return this.isFresh(this.credentials);
  }

  private isFresh(credentials: CodexCredentials): boolean {
    return Date.now() < credentials.expires_at - this.tokenRefreshMargin;
  }

  /** May this on-disk token be used as the refresh's result, with no exchange? */
  private isAdoptable(onDisk: CodexCredentials, trigger: RefreshTrigger): boolean {
    if (!this.isFresh(onDisk)) return false;
    return trigger.kind === "expiry" || onDisk.access_token !== trigger.rejected;
  }

  /**
   * The single flight. The `finally` clears the slot only if it still holds
   * THIS flight: `reloadCredentials()` may have dropped it and a newer flight may
   * own it by the time this one settles, and clearing that one would let a third
   * caller start a duplicate.
   */
  private startRefresh(trigger: RefreshTrigger): Promise<string> {
    const flight: Promise<string> = this.refreshUnderGate(trigger).finally(() => {
      if (this.refreshPromise === flight) this.refreshPromise = null;
    });
    this.refreshPromise = flight;
    return flight;
  }

  /**
   * Refresh under the legacy account's gate, or adopt what the holder wrote.
   *
   * The gate NEVER degrades to unlocked (`withRefreshGate` has no such mode). When
   * it cannot be taken, the file is re-read: a fresh, adoptable token there means
   * the holder rotated while this process waited, and that is the success path.
   * Otherwise every reason is transient, an unwritable gate included: a lock
   * that cannot be created is a local fault, and no credential was rejected.
   */
  private async refreshUnderGate(trigger: RefreshTrigger): Promise<string> {
    const before = this.readCredentialFile();
    try {
      return await withRefreshGate(
        "openai-codex",
        LEGACY_CODEX_ACCOUNT_ID,
        (handle) => this.refreshHoldingGate(trigger, handle),
        {
          path: this.getRefreshGatePath(),
          gen: before?.generation ?? 0,
          ...(this.gateOverrides.deps ? { deps: this.gateOverrides.deps } : {}),
        }
      );
    } catch (err) {
      if (!isGateUnavailable(err)) throw err;
      const latest = this.readCredentialFile();
      if (latest && this.isAdoptable(latest.credentials, trigger)) {
        log(
          `[CodexOAuth] Refresh gate unavailable (${err.reason}); the holder already rotated — using its token`
        );
        this.setCredentials(latest.credentials);
        return latest.credentials.access_token;
      }
      log(`[CodexOAuth] Refresh gate unavailable: ${err.message}`);
      if (err.reason !== "unwritable") {
        throw credentialHttpError(
          `Another claudish process is refreshing the OpenAI Codex login (${err.reason}); retrying will usually work.`,
          503
        );
      }
      throw new CodexOAuthLocalError(
        "Could not refresh the OpenAI Codex login: the refresh lock could not be created " +
          `(${err.reason}). Retry the request; if this persists, run \`${LOGIN_COMMAND}\`.`
      );
    }
  }

  /** Everything from here down runs with the gate held. */
  private async refreshHoldingGate(trigger: RefreshTrigger, handle: LockHandle): Promise<string> {
    // Re-read under the gate. The in-memory copy is this process's snapshot; the
    // file is what every other process (and the pool) wrote.
    const onDisk = this.readCredentialFile();
    if (!onDisk) {
      throw new CodexOAuthRefreshError(
        `No OpenAI Codex OAuth credentials found. Please run \`${LOGIN_COMMAND}\` first.`
      );
    }
    if (this.isAdoptable(onDisk.credentials, trigger)) {
      log("[CodexOAuth] Another process already rotated the token — using it, no exchange");
      this.setCredentials(onDisk.credentials);
      return onDisk.credentials.access_token;
    }

    const updated = await this.exchangeRefreshToken(onDisk.credentials);

    // The fence: a holder suspended past the stale TTL and stolen from must not
    // write over its successor. The new token is then NOT used either — a token
    // in this process's hands that the file does not hold is the next process's
    // `invalid_grant`.
    if (!handle.holdsLock()) {
      throw new CodexOAuthLocalError(
        "Could not refresh the OpenAI Codex login: the refresh lock was taken over before the new " +
          `token could be saved. Retry the request; if this persists, run \`${LOGIN_COMMAND}\`.`
      );
    }

    // Neither a login nor a logout takes the gate (see login()). If one landed
    // during the exchange, persisting this rotation would silently undo it: a
    // login's fresh grant replaced by the old one, or a logout's deleted file
    // recreated. The file wins in both cases.
    const current = this.readCredentialFile();
    if (!current) {
      log("[CodexOAuth] The credential file was removed during the exchange — not recreating it");
      this.setCredentials(null);
      throw new CodexOAuthRefreshError(
        `No OpenAI Codex OAuth credentials found. Please run \`${LOGIN_COMMAND}\` first.`
      );
    }
    if (current.credentials.refresh_token !== onDisk.credentials.refresh_token) {
      log("[CodexOAuth] The credential file changed during the exchange — keeping it");
      this.setCredentials(current.credentials);
      return current.credentials.access_token;
    }

    try {
      this.saveCredentials(updated);
    } catch (e) {
      // The exchange succeeded and the file does not hold its result. The token
      // is not used: every other process — and this one's next refresh, which
      // re-reads the file — would present the refresh token just consumed.
      // Local: the vendor accepted the exchange. If the consumed token is
      // presented again, the vendor's own rejection is the terminal answer.
      log(`[CodexOAuth] Could not save the refreshed token: ${errorMessage(e)}`);
      throw new CodexOAuthLocalError(
        `Could not save the refreshed OpenAI Codex login (${errorMessage(e)}). ` +
          `Run \`${LOGIN_COMMAND}\` to sign in again.`
      );
    }
    this.setCredentials(updated);
    log(`[CodexOAuth] Token refreshed, valid until ${new Date(updated.expires_at).toISOString()}`);
    return updated.access_token;
  }

  /**
   * One refresh-token exchange. OpenAI uses a PUBLIC PKCE client — no
   * client_secret needed in refresh requests.
   *
   * Presents `from.refresh_token` — the one just re-read from disk under the
   * gate, never this process's startup snapshot.
   */
  private async exchangeRefreshToken(from: CodexCredentials): Promise<CodexCredentials> {
    log("[CodexOAuth] Refreshing access token");

    // resolveUpstreamUrl is a no-op unless CLAUDISH_TEST_UPSTREAM names a
    // LOOPBACK target — the mock-upstream e2e counts exchanges at its own
    // token endpoint, which is the only way the "exactly one exchange across N
    // processes" property is observable at all.
    const tokenUrl = resolveUpstreamUrl(OAUTH_CONFIG.tokenUrl);

    // THE FETCH ITSELF THROWING MEANS THE NETWORK, NOT THE CREDENTIAL — so it is
    // the one refresh failure here that is NOT a `CodexOAuthRefreshError`. That
    // error is terminal with `upstreamStatus: 401`, which lets a routing chain
    // ADVANCE: raised for an outage, it walked a subscriber onto the next
    // candidate — possibly metered — for a fault that had nothing to do with
    // their login, and told them to log in again. This throw is instead
    // classified by ComposedHandler (`classifyConnectionError`) and held by the
    // recovery ladder, which answers `connection_error` if the host never comes
    // back. Neither route signs with OPENAI_CODEX_API_KEY: `signRequest` has no
    // catch, and the credential composite rethrows.
    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: from.refresh_token,
          client_id: OAUTH_CONFIG.clientId,
        }),
        // Bounds BOTH waiters of this exchange: the in-process single flight and
        // the cross-process gate — see CODEX_EXCHANGE_TIMEOUT_MS.
        signal: AbortSignal.timeout(CODEX_EXCHANGE_TIMEOUT_MS),
      });
    } catch (e) {
      throw tokenHostUnreachable(e, tokenUrl);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const detail = describeTokenEndpointError(errorText, from.refresh_token);
      log(`[CodexOAuth] Refresh failed: HTTP ${response.status}${detail}`);
      // 429/5xx is a busy or down token host, not a dead login: retryable, and
      // with no login hint, since a new login does not help. Safe to retry
      // because a non-2xx rotated nothing.
      if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
        throw credentialHttpError(
          `The Codex token host is busy or unavailable (HTTP ${response.status}); retrying will usually work.${detail}`,
          response.status
        );
      }
      throw new CodexOAuthRefreshError(
        `OpenAI Codex login expired or was revoked — run \`${LOGIN_COMMAND}\` to sign in again. ` +
          `(token refresh: HTTP ${response.status}${detail})`
      );
    }

    let tokens: TokenResponse;
    try {
      tokens = (await response.json()) as TokenResponse;
    } catch (e) {
      // TERMINAL, even for a connection reset mid-body — unlike the fetch throw
      // above, and on purpose. A 2xx means the vendor has already ROTATED the
      // refresh token; only its answer was lost. Handing this to the recovery
      // ladder would re-present the consumed token on the next attempt:
      // `refresh_token_reused`, which reuse detection can escalate into revoking
      // the whole grant. The pool's exchange reaches the same verdict for the same
      // reason (`accounts/exchange.ts`: an unreadable 2xx is "outcome unknown").
      throw new CodexOAuthRefreshError(
        `Run \`${LOGIN_COMMAND}\` to sign in again: the Codex token endpoint returned an unreadable body ` +
          `(${errorMessage(e)}). A retry can succeed only if another claudish process already saved a newer token.`
      );
    }
    if (typeof tokens?.access_token !== "string" || tokens.access_token.length === 0) {
      // Persisting this would write a file every later read rejects — a silent
      // logout. Refuse before anything is written.
      throw new CodexOAuthRefreshError(
        "Could not refresh the OpenAI Codex login: the token endpoint returned no access token. " +
          `Retry; if this persists, run \`${LOGIN_COMMAND}\`.`
      );
    }

    // Extract account_id from refreshed id_token if present. A refresh is the
    // SAME account, so an id_token that yields no id keeps the known one rather
    // than erasing it (saveCredentials overlays, so `undefined` would delete it).
    const accountId =
      (tokens.id_token ? this.extractAccountId(tokens.id_token) : undefined) ?? from.account_id;

    // Keep the existing refresh token if a new one is not provided. A missing
    // `expires_in` is an hour, not `NaN`.
    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600;
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || from.refresh_token,
      expires_at: Date.now() + expiresIn * 1000,
      account_id: accountId,
    };
  }

  /**
   * The ONE writer of the in-memory credential. Every caller has just settled
   * the file's outcome as present (a read, a login's write) or absent (a
   * logout, a file found removed), so a recorded `failed` is stale by then.
   */
  private setCredentials(credentials: CodexCredentials | null): void {
    this.credentials = credentials;
    this.credentialFileFailure = null;
  }

  /**
   * Load the credential file into memory, for startup, `reloadCredentials()`
   * and the per-request re-read in {@link getAccessToken}. Never throws: the
   * outcome is RECORDED — `present` in `credentials`, `failed` in
   * `credentialFileFailure`, `absent` as neither.
   *
   * It used to answer `null` for every failure, which is how an unreadable file
   * read as "never logged in" and signed metered (V16b).
   */
  private loadCredentials(): void {
    const outcome = this.classifyCredentialFile();
    switch (outcome.kind) {
      case "present":
        this.setCredentials(outcome.read.credentials);
        log("[CodexOAuth] Loaded credentials from file");
        return;
      case "absent":
        this.setCredentials(null);
        return;
      case "failed":
        this.credentials = null;
        this.credentialFileFailure = outcome.error;
        log(
          `[CodexOAuth] Credential file present but unusable — Codex requests fail until it is fixed: ${outcome.error.message}`
        );
        return;
    }
  }

  /** Read the credential file and name its outcome. Never throws. */
  private classifyCredentialFile(): CredentialFileOutcome {
    let raw: RawCredentialFile | null;
    try {
      raw = this.readRawCredentialFile();
    } catch (e) {
      return { kind: "failed", error: asCredentialFileError(e, this.getCredentialsPath()) };
    }
    if (raw === null) return { kind: "absent" };
    // A readable document with no refresh token names no login. This is the
    // one parse result that is NOT a failure, and it is the registry's rule
    // (`refreshLegacy`: "present-and-empty"), so a user here signs with the api
    // key today and after Phase 2 alike. It is also the billing probe's "trap"
    // state (billing-probe.ts): an access token with no refresh token is metered.
    if (typeof raw.refresh_token !== "string" || !raw.refresh_token) {
      log("[CodexOAuth] Credential file names no refresh token — treating it as no login");
      return { kind: "absent" };
    }
    try {
      return { kind: "present", read: this.projectCredentialFile(raw) };
    } catch (e) {
      return { kind: "failed", error: asCredentialFileError(e, this.getCredentialsPath()) };
    }
  }

  /**
   * The STRICT read the refresh path uses under the gate: `null` ONLY for a
   * confirmed absence, and a throw for anything unreadable — the rule every
   * account-pool store obeys. Collapsing "unreadable" into "absent" here would
   * report a working login as missing, and exchanging after a failed read would
   * present a refresh token nobody re-checked.
   *
   * Returns the four keys this class owns, projected — never the pool's keys,
   * which must not leak into a later overlay as if this class had written them.
   */
  private readCredentialFile(): CredentialFileRead | null {
    const raw = this.readRawCredentialFile();
    return raw === null ? null : this.projectCredentialFile(raw);
  }

  /**
   * The file's bytes, parsed. `null` for absence, and absence is the read
   * failing with `ENOENT`/`ENOTDIR` — nothing else. This used to be
   * `existsSync`, which also answers `false` when a parent directory denies
   * access (fix B1 found the same trap in the registry), so a `chmod 000
   * ~/.claudish` read as "never logged in".
   *
   * Everything else throws a `CodexOAuthLocalError` naming the file. The
   * parser's own message is deliberately NOT included: the error reaches Claude
   * Code's transcript as the inline 400, and some engines quote the input it
   * choked on — which here is a token.
   */
  private readRawCredentialFile(): RawCredentialFile | null {
    const credPath = this.getCredentialsPath();
    let text: string;
    try {
      text = this.readCredentialText(credPath);
    } catch (e) {
      if (isAbsenceError(e)) return null;
      throw credentialFileUnreadable(credPath, errorMessage(e));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw credentialFileUnreadable(
        credPath,
        `it is not valid JSON (${text.length === 0 ? "empty" : "truncated or corrupted"})`
      );
    }
    if (!isRecord(parsed)) {
      throw credentialFileUnreadable(credPath, "it is not a JSON object");
    }
    return parsed as RawCredentialFile;
  }

  /** Validate and project the token pair. Throws on an unusable one. */
  private projectCredentialFile(raw: RawCredentialFile): CredentialFileRead {
    const credPath = this.getCredentialsPath();
    // The same acceptance the lenient loader always applied (all three truthy),
    // now typed rather than trusted.
    const accessToken = raw.access_token;
    const refreshToken = raw.refresh_token;
    const expiresAt = raw.expires_at;
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      typeof refreshToken !== "string" ||
      !refreshToken ||
      typeof expiresAt !== "number" ||
      !expiresAt
    ) {
      log("[CodexOAuth] Invalid credentials file structure");
      throw new CodexOAuthLocalError(
        `The OpenAI Codex credential file (${credPath}) has no usable token pair. ` +
          `Run \`${LOGIN_COMMAND}\` to replace it.`
      );
    }
    const accountId = raw.account_id;
    const generation = raw.claudish_generation;
    return {
      credentials: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        ...(typeof accountId === "string" && accountId ? { account_id: accountId } : {}),
      },
      generation: typeof generation === "number" ? generation : 0,
    };
  }

  /**
   * Save credentials DURABLY: temp → fsync → rename → fsync(dir), mode 0600.
   *
   * The previous implementation was `openSync(path, "w", 0600)` + `writeSync`,
   * which TRUNCATES first and writes second. A crash, a full disk or a kill
   * between those two steps left a ZERO-BYTE credential file — the refresh token
   * gone, the user silently logged out, and no way back except a browser
   * re-login. `open("w")` is atomic only in the sense of creating the file with
   * the mode already applied (the race it was written to fix); it is not atomic
   * in its CONTENT, which is the property a credential file needs.
   *
   * `atomicWriteFileSync` renames onto the final name, so a concurrent reader
   * sees the whole old file or the whole new one and never a truncated one, and
   * chmods 0600 explicitly rather than relying on the inherited umask.
   *
   * READ-MERGE-WRITE. The file is shared with `LegacyCodexFileStore`, which
   * keeps `claudish_generation` and `claudish_journal` in it (and a newer or
   * older claudish may keep more). Every key this class does not own is carried
   * over untouched; the four it owns are overlaid — an explicit `undefined`
   * `account_id` deletes a stale one, which is what a login to a different
   * account needs.
   *
   * `claudish_generation` is BUMPED, not merely preserved: the store's contract
   * is "monotonic, bumped on every successful persist", and it is the only signal
   * a pool waiter has that the holder ahead of it rotated. A write here that left
   * it unchanged would be a rotation the pool cannot see.
   *
   * An existing file that cannot be parsed contributes nothing — the same choice
   * `LegacyCodexFileStore.write` makes: the four keys are the only ones this
   * write can honestly claim to know, and refusing would strand a fresh token.
   */
  private saveCredentials(credentials: CodexCredentials): void {
    const credPath = this.getCredentialsPath();
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(credPath)) {
        const parsed = JSON.parse(readFileSync(credPath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
      }
    } catch {
      existing = {};
    }
    const previousGeneration =
      typeof existing.claudish_generation === "number" ? existing.claudish_generation : 0;
    const document = {
      ...existing,
      ...credentials,
      claudish_generation: previousGeneration + 1,
    };
    atomicWriteFileSync(credPath, JSON.stringify(document, null, 2), { mode: 0o600 });
    log(`[CodexOAuth] Credentials saved to ${credPath}`);
  }

  /**
   * Extract chatgpt_account_id from id_token JWT payload.
   * Simple base64 decode of the payload section — no signature validation needed
   * (the token was just received over HTTPS from the auth server).
   */
  private extractAccountId(idToken: string): string | undefined {
    try {
      const parts = idToken.split(".");
      if (parts.length !== 3) return undefined;

      // Decode the payload (second part)
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
      const authClaim = payload["https://api.openai.com/auth"];
      const accountId =
        authClaim?.chatgpt_account_id || payload.chatgpt_account_id || authClaim?.user_id;

      if (accountId) {
        log(`[CodexOAuth] Extracted account ID from id_token: ${accountId}`);
        return accountId;
      }

      return undefined;
    } catch (e: any) {
      log(`[CodexOAuth] Failed to extract account ID from id_token: ${e.message}`);
      return undefined;
    }
  }
}

/**
 * Get the shared CodexOAuth instance
 */
export function getCodexOAuth(): CodexOAuth {
  return CodexOAuth.getInstance();
}

/**
 * Get a valid access token (refreshing if needed)
 * Helper function for handlers to use
 */
export async function getValidCodexAccessToken(): Promise<string> {
  const oauth = CodexOAuth.getInstance();
  return oauth.getAccessToken();
}
