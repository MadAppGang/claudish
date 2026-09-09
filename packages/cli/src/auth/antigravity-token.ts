/**
 * Antigravity shared OAuth token — read / refresh / write.
 *
 * Antigravity's own CLI (`agy`) stores its OAuth token in the macOS login
 * keychain, and claudish shares that SAME store so a single sign-in covers both
 * tools (Jack's explicit requirement). agy OWNS the refresh lifecycle too:
 * claudish never handles the Antigravity client secret in ANY form (no embed, no
 * scrape, no token exchange). When the shared token is expired, claudish asks agy
 * to refresh it — running `agy models` (a lightweight authed command that lists
 * served models, no generation quota) makes agy mint a fresh token with ITS OWN
 * current secret and write it back to the shared store. claudish then simply
 * RE-READS the store.
 *
 * Store layout (macOS login keychain):
 *   service = "gemini", account = "antigravity"
 *   value   = "go-keyring-base64:" + base64(JSON)   (zalando/go-keyring format)
 *   JSON    = { token: { access_token, token_type, refresh_token, expiry(RFC3339) },
 *               id_token, auth_method }
 *
 * Why delegate refresh: Antigravity's client_secret is a static literal baked
 * into the `agy` binary, and agy AUTO-UPDATES — each release rotates the secret
 * and Google revokes the old one — so any secret claudish embedded or scraped
 * would break within days, and there's no dynamic client registration. Letting
 * agy do the refresh means claudish is always current, holds no secret, and stays
 * out of the OAuth-client business entirely.
 *
 * Every side effect (keychain read/write/delete, the agy refresh command, clock)
 * is behind an injectable `deps` object so the module is fully testable with no
 * real keychain and no real agy process.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, logStderr } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keychain service used by the shared agy/claudish token item. */
const KC_SERVICE = "gemini";
/** Keychain account used by the shared agy/claudish token item. */
const KC_ACCOUNT = "antigravity";
/** go-keyring single-item value prefix. Chunked values use other prefixes (unsupported). */
const PREFIX = "go-keyring-base64:";
/** Refresh when the access token is within this window of its expiry (~2 min). */
const EXPIRY_SKEW_MS = 120_000;
/**
 * Max time to wait for `agy models` to refresh the shared token.
 *
 * MUST STAY BELOW THE SHORTEST CALLER DEADLINE. This was 40s while the config
 * TUI's provider probe aborts its whole request at 15s
 * (`tui/hooks/useRouteProbe.ts`) — so the refresh was granted 2.7× longer than
 * the operation containing it, and a slow refresh was killed from outside
 * before it could report anything. The user saw `timeout · 15004ms` on the
 * provider row, with no indication that a refresh had been in flight, and the
 * next attempt reported the still-expired token as an unrecoverable session.
 *
 * At 12s the refresh now fails INSIDE its own timeout, so it can say what
 * happened and recommend waiting rather than a pointless re-login. A healthy
 * refresh is a single network round-trip (~1-3s); the only thing 12s cannot
 * absorb is agy self-updating, which no caller-side ceiling could absorb either
 * and which is precisely the case the "timeout" message now names.
 */
const AGY_REFRESH_TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The OAuth token as stored under `token` in the shared store's JSON. */
export interface AntigravityToken {
  access_token: string;
  token_type: string;
  refresh_token: string;
  /** RFC3339 timestamp of access-token expiry (Go time.Time format). */
  expiry: string;
}

/** The full decoded shared-store record. Unknown fields are preserved on write. */
interface SharedStoreRecord {
  token: AntigravityToken;
  id_token?: string;
  auth_method?: string;
  [key: string]: unknown;
}

/**
 * Injectable side-effect seams. Tests supply fakes so no real keychain, agy
 * process, or clock is ever touched.
 */
/**
 * What happened when we asked the Antigravity CLI to refresh.
 *
 * `detail` carries agy's own stderr, truncated. agy explains its failures
 * perfectly well; claudish was throwing that explanation away and substituting a
 * guess.
 */
export type AgyRefreshOutcome =
  | { kind: "ran" }
  | { kind: "not-installed" }
  | { kind: "timeout" }
  | { kind: "failed"; detail: string };

export interface AntigravityTokenDeps {
  /** Read the raw keychain value (with the `go-keyring-base64:` prefix), or null. */
  readStore: () => string | null;
  /** Write the raw keychain value (with the prefix). */
  writeStore: (rawValue: string) => void;
  /** Delete the shared keychain item entirely (logout). Optional; defaults to `security delete-generic-password`. */
  deleteStore?: () => void;
  /**
   * Ask the Antigravity CLI to refresh the shared token — the real implementation
   * runs `agy models` (a lightweight authed command), which makes agy mint a fresh
   * token with its OWN current secret and write it back to the shared store.
   * claudish never touches the client secret itself.
   *
   * Returns WHY it did not work, rather than nothing. The previous signature was
   * `() => void` with the failure swallowed by a bare `catch {}` and agy's output
   * sent to `stdio: "ignore"` — so three genuinely different situations (agy not
   * installed / agy failed or timed out / agy succeeded but the session is
   * revoked) all surfaced as one message telling the user to re-login. Only the
   * third is actually fixed by re-logging in; for the second the fix is usually
   * to wait, because agy AUTO-UPDATES and a 177MB self-update makes `agy models`
   * take minutes.
   */
  runAgyRefresh: () => AgyRefreshOutcome;
  /** Current time in ms since epoch (defaults to Date.now). */
  now: () => number;
}

// ---------------------------------------------------------------------------
// Default (real) deps
// ---------------------------------------------------------------------------

/**
 * Burst memo for the raw keychain READ.
 *
 * `defaultReadStore` spawns `security`, and since `antigravity` became visible in
 * the model picker that spawn sits on the picker-open path: the picker resolves
 * `credentials.isAvailable()` for every offered provider, which lands here. One
 * open can therefore fork `security` several times for an answer that cannot have
 * changed in between.
 *
 * A process-lifetime cache would be WRONG — `agy` signs in and out underneath us,
 * writing the same keychain item from another process — so the TTL is deliberately
 * short. The goal is collapsing a burst inside ONE operation, not caching across a
 * session. Every write path claudish owns invalidates it explicitly (see
 * `invalidateReadStoreMemo` callers), because a stale read after a refresh would
 * hand back the token that was just replaced.
 */
const READ_STORE_TTL_MS = 3000;
let cachedRawStore: { at: number; value: string | null } | null = null;

/** Drop the read memo — call after ANY mutation of the shared keychain item. */
function invalidateReadStoreMemo(): void {
  cachedRawStore = null;
}

/** Read the shared token via macOS `security`. Non-darwin → null (with a warning). */
function defaultReadStore(): string | null {
  if (process.platform !== "darwin") {
    logStderr(
      "[Antigravity] Shared token store is macOS-only for now (other keyring backends are a follow-up)."
    );
    return null;
  }
  const now = Date.now();
  if (cachedRawStore && now - cachedRawStore.at < READ_STORE_TTL_MS) return cachedRawStore.value;
  let value: string | null = null;
  try {
    // `stdio` MUST be named. Node documents execFileSync's default as "pipe",
    // but carves out stderr: without an explicit `stdio` the child writes fd 2
    // straight to the PARENT's terminal. The miss here is the common case — a
    // user who is not signed in to Antigravity — and `security` announces it
    // with "security: SecKeychainSearchCopyNext: The specified item could not
    // be found in the keychain." The catch below cannot suppress that: it owns
    // the exception, while the CHILD already owned the file descriptor.
    //
    // That line is not an error. It is "not signed in", which this function
    // reports as `null` by design. Printing it corrupts the config TUI, which
    // shares its terminal with the Claude Code TUI, and it repeats forever
    // because READ_STORE_TTL_MS is 3s and the provider roster is rebuilt on
    // every render. Same policy as providers/keychain.ts — see the spawn
    // comment there, and terminal-isolation.ts for the display corruption.
    //
    // stdout stays PIPED because it carries the token; ignoring it the way the
    // write/delete siblings do would make every read return null. stdin is
    // ignored so this can never interact with a parent terminal in raw mode.
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const trimmed = out.trim();
    value = trimmed.length > 0 ? trimmed : null;
  } catch {
    // Item not found (agy not signed in) or `security` unavailable.
    value = null;
  }
  // Memoize the MISS too: "not signed in" is the case that repeats hardest on the
  // picker path, and it costs a failed spawn each time.
  cachedRawStore = { at: now, value };
  return value;
}

/** Write the shared token via macOS `security` (upsert with -U). */
function defaultWriteStore(rawValue: string): void {
  if (process.platform !== "darwin") {
    throw new Error("[Antigravity] Cannot write the shared token store on a non-macOS platform.");
  }
  // Invalidate BEFORE the write, so a throwing `security` still leaves the memo
  // dropped rather than serving a value the store may or may not still hold.
  invalidateReadStoreMemo();
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w", rawValue],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
}

/**
 * Locate the user's agy binary: `which agy`, else ~/.local/bin/agy.
 * Exported so the login-delegation flow (antigravity-oauth.ts) uses the SAME
 * locator as the refresh scrape.
 */
export function locateAgyBinary(): string | null {
  try {
    const p = execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
    if (p.length > 0) return p;
  } catch {
    // fall through to the conventional install path
  }
  const fallback = join(homedir(), ".local", "bin", "agy");
  return existsSync(fallback) ? fallback : null;
}

/** Delete the shared token via macOS `security` (idempotent — missing item is fine). */
function defaultDeleteStore(): void {
  if (process.platform !== "darwin") return;
  invalidateReadStoreMemo();
  try {
    execFileSync("security", ["delete-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Item not found / already gone — logout is idempotent.
  }
}

/**
 * Ask the Antigravity CLI to refresh the shared token.
 *
 * `agy models` is a lightweight authed command (lists served models — no
 * generation quota). Running it when the stored token is expired makes agy mint a
 * fresh token with ITS OWN current secret and write it back to the shared store;
 * claudish then simply re-reads it. No-op (silent) when agy isn't installed — the
 * caller re-reads, sees the token is still stale, and throws an actionable error.
 * claudish never handles the client secret in any form.
 */
function defaultRunAgyRefresh(): AgyRefreshOutcome {
  const agy = locateAgyBinary();
  if (!agy) return { kind: "not-installed" };
  try {
    // stderr is CAPTURED, not discarded. It is the only account of why a refresh
    // failed, and sending it to /dev/null is what forced the caller to guess.
    execFileSync(agy, ["models"], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      timeout: AGY_REFRESH_TIMEOUT_MS,
    });
    return { kind: "ran" };
  } catch (err) {
    const e = err as { code?: string; signal?: string; stderr?: string };
    // A killed child reports no exit code. `agy` self-updates (a ~177MB
    // download), and during that window `agy models` can far exceed any sane
    // ceiling — a timeout here means "busy", not "signed out".
    if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") return { kind: "timeout" };
    return { kind: "failed", detail: (e.stderr ?? "").trim().slice(0, 300) };
  } finally {
    // agy writes the refreshed token into the SAME keychain item from ANOTHER
    // process, and `resolveValidToken` re-reads immediately after this returns.
    // Without this drop, that re-read would replay the expired token from the
    // memo and the successful refresh would be reported as "couldn't be
    // refreshed". In the `finally` because a timed-out agy may still have
    // written before we gave up on it.
    invalidateReadStoreMemo();
  }
}

const defaultDeps: AntigravityTokenDeps = {
  readStore: defaultReadStore,
  writeStore: defaultWriteStore,
  deleteStore: defaultDeleteStore,
  runAgyRefresh: defaultRunAgyRefresh,
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/** Decode the raw store value into a record. Returns null when absent/unsupported. */
function parseRecord(raw: string | null): SharedStoreRecord | null {
  if (!raw) return null;
  if (!raw.startsWith(PREFIX)) {
    // go-keyring chunks values that exceed the keychain item limit under other
    // prefixes; that layout is unsupported for now.
    logStderr(
      "[Antigravity] Shared token is in an unsupported keyring format (not go-keyring-base64) — skipping."
    );
    return null;
  }
  try {
    const json = Buffer.from(raw.slice(PREFIX.length), "base64").toString("utf8");
    const rec = JSON.parse(json) as SharedStoreRecord;
    if (!rec?.token?.access_token) return null;
    return rec;
  } catch (err) {
    log(`[Antigravity] Failed to decode shared token: ${err}`);
    return null;
  }
}

/** Encode a record back into the raw `go-keyring-base64:` store value. */
function encodeRecord(rec: SharedStoreRecord): string {
  return PREFIX + Buffer.from(JSON.stringify(rec), "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// Public: read / write
// ---------------------------------------------------------------------------

/** Read the current shared Antigravity token, or null if absent/unsupported. */
export function readSharedAntigravityToken(
  deps: AntigravityTokenDeps = defaultDeps
): AntigravityToken | null {
  const rec = parseRecord(deps.readStore());
  return rec ? rec.token : null;
}

/**
 * Memoized "is an Antigravity token present in the shared store" — for the SYNC
 * readiness classifier that the config TUI's React render path calls on every
 * frame. `readSharedAntigravityToken()` shells out to `security`, so cache the
 * boolean for a few seconds; the TTL means signing into Antigravity is reflected
 * without a claudish restart, without spawning a process per render.
 */
let cachedHasToken: { at: number; value: boolean } | null = null;
const HAS_TOKEN_TTL_MS = 5000;
export function hasSharedAntigravityToken(deps: AntigravityTokenDeps = defaultDeps): boolean {
  const now = Date.now();
  if (cachedHasToken && now - cachedHasToken.at < HAS_TOKEN_TTL_MS) return cachedHasToken.value;
  let value = false;
  try {
    value = readSharedAntigravityToken(deps) != null;
  } catch {
    value = false;
  }
  cachedHasToken = { at: now, value };
  return value;
}

/**
 * Write an updated Antigravity token back to the shared store, PRESERVING every
 * other field (id_token / auth_method / unknown keys) — only the token's
 * access_token / refresh_token / expiry / token_type are replaced. This is the
 * refresh write-back; agy owns the FULL record on first login.
 */
export function writeSharedAntigravityToken(
  tok: AntigravityToken,
  deps: AntigravityTokenDeps = defaultDeps
): void {
  const existing = parseRecord(deps.readStore());
  const base: SharedStoreRecord = existing ?? { token: tok };
  const merged: SharedStoreRecord = {
    ...base,
    token: { ...base.token, ...tok },
  };
  deps.writeStore(encodeRecord(merged));
}

/**
 * Delete the shared Antigravity token (logout). Idempotent — a missing item is
 * not an error. Also clears the memoized presence flag so the config TUI reflects
 * the logout immediately.
 */
export function deleteSharedAntigravityToken(deps: AntigravityTokenDeps = defaultDeps): void {
  (deps.deleteStore ?? defaultDeleteStore)();
  _resetAntigravityTokenState();
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** True when the access token is expired or within EXPIRY_SKEW_MS of expiry. */
function needsRefresh(tok: AntigravityToken, now: number): boolean {
  const expMs = Date.parse(tok.expiry);
  // An unparseable/absent expiry is treated as needing refresh (fail safe).
  if (Number.isNaN(expMs)) return true;
  return now >= expMs - EXPIRY_SKEW_MS;
}

// ---------------------------------------------------------------------------
// Public: valid access token (single-flight)
// ---------------------------------------------------------------------------

/** In-flight resolve promise — collapses concurrent callers onto one refresh. */
let inFlight: Promise<string> | null = null;

async function resolveValidToken(deps: AntigravityTokenDeps): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      "[Antigravity] The shared Antigravity token store is macOS-only for now. " +
        "Use g@<model> with GEMINI_API_KEY on this platform."
    );
  }

  const rec = parseRecord(deps.readStore());
  if (!rec) {
    throw new Error(
      "[Antigravity] No Antigravity session found. Sign in with `claudish login antigravity`, " +
        "or use g@<model> with GEMINI_API_KEY " +
        "(get one at https://aistudio.google.com/app/apikey)."
    );
  }

  if (!needsRefresh(rec.token, deps.now())) {
    return rec.token.access_token;
  }

  // Expired/near-expiry → ask agy to refresh (it owns the secret). Running `agy
  // models` mints a fresh token into the shared store; we then RE-READ it.
  log("[Antigravity] Access token expired/near-expiry — asking the Antigravity CLI to refresh.");
  const outcome = deps.runAgyRefresh();

  const refreshedRec = parseRecord(deps.readStore());
  if (refreshedRec && !needsRefresh(refreshedRec.token, deps.now())) {
    log("[Antigravity] Shared token refreshed by the Antigravity CLI.");
    return refreshedRec.token.access_token;
  }

  // Still stale. WHY decides what the user should actually do — and only one of
  // these four is fixed by signing in again. Reporting them all as "session
  // expired, re-login" sent users through an OAuth flow that could not help,
  // most often while agy was simply mid-self-update.
  throw new Error(`[Antigravity] ${describeRefreshFailure(outcome)}`);
}

/** Turn a refresh outcome into the remediation that actually applies to it. */
function describeRefreshFailure(outcome: AgyRefreshOutcome): string {
  switch (outcome.kind) {
    case "not-installed":
      return (
        "The Antigravity CLI (`agy`) is not installed, so the expired session could not be " +
        "refreshed. Run `claudish login antigravity` — it installs and authenticates it."
      );
    case "timeout":
      return (
        `The Antigravity CLI did not finish within ${Math.round(AGY_REFRESH_TIMEOUT_MS / 1000)}s, ` +
        "so the session could not be refreshed. `agy` auto-updates itself (a large download) " +
        "and is unusably slow while it does — this usually clears on its own. Try again in a " +
        "minute; run `agy models` to see what it is doing. You are most likely still signed in."
      );
    case "failed":
      return (
        "The Antigravity CLI could not refresh the session" +
        (outcome.detail ? `: ${outcome.detail}` : ".") +
        " If it reports being signed out, run `claudish login antigravity`."
      );
    default:
      // agy ran cleanly and the token is STILL stale — the session really is
      // revoked, which is the one case a fresh sign-in fixes.
      return (
        "The Antigravity session is expired and the Antigravity CLI refreshed it without " +
        "producing a valid token — the session has most likely been revoked. " +
        "Run `claudish login antigravity`."
      );
  }
}

/**
 * Read → refresh-if-needed (via agy) → return a valid Antigravity access token.
 * Single-flight: concurrent callers share one in-flight resolution so only ONE
 * `agy models` refresh runs even under a parallel spawn. Throws a clear,
 * actionable error when the store is missing (not signed in), when agy can't
 * refresh it, or on a non-macOS platform.
 */
export function getValidAntigravityAccessToken(
  deps: AntigravityTokenDeps = defaultDeps
): Promise<string> {
  if (inFlight) return inFlight;
  inFlight = resolveValidToken(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// ---------------------------------------------------------------------------
// Public: forced refresh (the backend rejected the token we presented)
// ---------------------------------------------------------------------------

/**
 * Re-mint the shared Antigravity token even though it is not locally expired.
 *
 * `needsRefresh()` only ever asks the CLOCK. A token Google invalidated
 * server-side — session revoked, signed in elsewhere, OAuth client rotated —
 * still carries a future `expiry`, so claudish considers itself healthy and
 * keeps presenting a dead credential until the clock catches up. This is the
 * escape hatch for the one moment when we hold better evidence than the clock:
 * the backend has just REJECTED the token.
 *
 * Stamping the stored expiry into the past before calling agy is LOAD-BEARING.
 * `agy models` re-mints only when AGY believes the token is expired, so against
 * a locally-valid record it would authenticate with the same dead token, exit 0,
 * and the "refresh" would be a silent no-op — the caller then retries with the
 * credential that just failed. Marking the record expired is honest (the backend
 * already told us it is dead), and a failed re-mint restores exactly what we
 * found, so an absent or broken agy cannot leave the store worse than it was.
 *
 * Throws rather than returning null: the caller is mid-retry, and a null would
 * send it back upstream with the same rejected credential instead of surfacing
 * an actionable message.
 */
export async function forceRefreshAntigravityToken(
  deps: AntigravityTokenDeps = defaultDeps
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      "[Antigravity] The shared Antigravity token store is macOS-only for now. " +
        "Use g@<model> with GEMINI_API_KEY on this platform."
    );
  }

  // Drop the single-flight promise AND the read memo first, so nothing below can
  // be handed back the very token the backend just rejected.
  _resetAntigravityTokenState();

  const rec = parseRecord(deps.readStore());
  if (!rec) {
    throw new Error(
      "[Antigravity] No Antigravity session found. Sign in with `claudish login antigravity`, " +
        "or use g@<model> with GEMINI_API_KEY " +
        "(get one at https://aistudio.google.com/app/apikey)."
    );
  }

  const original = rec.token;
  log("[Antigravity] Upstream rejected the current token — asking the Antigravity CLI to re-mint.");
  writeSharedAntigravityToken(
    { ...original, expiry: new Date(deps.now() - 1000).toISOString() },
    deps
  );
  deps.runAgyRefresh();

  const refreshed = parseRecord(deps.readStore());
  const token = refreshed?.token;
  if (token && token.access_token !== original.access_token && !needsRefresh(token, deps.now())) {
    log("[Antigravity] Shared token re-minted by the Antigravity CLI.");
    return token.access_token;
  }

  // Restore ONLY when agy never wrote (the store still holds our own expiry
  // stamp). If agy did write something — even something we can't use — that
  // record is more current than ours, and clobbering it would undo a real
  // sign-in. Our stamp was a means to provoke the re-mint, never a verdict to
  // persist.
  if (!refreshed || refreshed.token.access_token === original.access_token) {
    writeSharedAntigravityToken(original, deps);
  }
  _resetAntigravityTokenState();
  throw new Error(
    "[Antigravity] The Antigravity session was rejected upstream and could not be re-minted. " +
      "Run `claudish login antigravity` to sign in again."
  );
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Clear the in-flight promise, the memoized presence flag, and the raw read memo
 * (between tests, and after any out-of-band change to the shared store).
 *
 * The read memo is included so callers that already documented themselves as
 * "reset, then read FRESH" — antigravity-oauth's `readToken` — keep that
 * guarantee now that the default read is memoized at all.
 */
export function _resetAntigravityTokenState(): void {
  inFlight = null;
  cachedHasToken = null;
  invalidateReadStoreMemo();
}
