/**
 * The vendor half of a refresh: `refresh_token` in, a new token pair out.
 *
 * One tiny implementation per vendor, behind the {@link TokenExchange} port, so
 * `token-manager.ts` — which owns the gate, the journal and the persist — never
 * imports a vendor's HTTP client and can be driven entirely from a fake.
 *
 * ## Why `invalid_grant` gets its own error class here
 *
 * It is the one response the manager must treat differently from every other
 * failure: a transport error is transient and retried, while `invalid_grant`
 * means the presented refresh token is dead and the manager has to work out
 * WHICH of the three causes it is. Classifying it at the edge, where the vendor's
 * own body is in hand, keeps that decision out of a string match further up.
 *
 * ## The exchange is BOUNDED, and a timeout is "unknown", not "failed"
 *
 * The exchange runs under the refresh gate, whose heartbeat keeps the holder
 * looking alive for as long as the hold lasts. An unbounded `fetch` therefore
 * held the gate for as long as the socket stayed open, and every waiter timed
 * out behind it. It now carries an `AbortSignal` of {@link EXCHANGE_TIMEOUT_MS} —
 * half the waiters' acquire timeout, leaving the other half for the journal and
 * final persists.
 *
 * Three outcomes, kept apart:
 *
 * - a definite `invalid_grant`, or any other 400/401/403 (a refusal of the
 *   presented refresh token), enters the gate-holder reauth path; every other
 *   error response retains its terminal/transient HTTP status;
 * - no response → {@link ExchangeOutcomeUnknownError} with structural connection
 *   cause and the actual endpoint. The journal stays unknown, but recovery can
 *   retry the token host (with the accepted response-loss risk);
 * - unreadable/invalid 2xx → unknown journal and `PersistOutcomeUnknownError`,
 *   without a recoverable cause. Do not immediately re-present a token whose
 *   successful rotation response was lost.
 */

import { markOwnTimeout } from "../../handlers/shared/connection-error.js";
import { log } from "../../logger.js";
import { resolveUpstreamUrl } from "../../test-upstream.js";
import { credentialHttpError } from "../credentials/credential-error.js";
import { RefreshUnavailableError } from "./errors.js";
import { GATE_TIMEOUT_MS } from "./refresh-lock.js";
import {
  ExchangeOutcomeUnknownError,
  InvalidGrantError,
  RefreshTokenRejectedError,
} from "./token-manager.js";
import type { TokenExchange, TokenExchangeResult } from "./token-manager.js";
import type { StoredTokenRecord } from "./token-store.js";
import type { AccountProvider, AccountRef } from "./types.js";

/**
 * Codex's public PKCE client. No `client_secret` — a public client has none, and
 * inventing one would be rejected.
 */
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/**
 * The exchange's whole budget — request, response and body. Shorter than the
 * waiters' {@link GATE_TIMEOUT_MS} by construction.
 */
export const EXCHANGE_TIMEOUT_MS = Math.floor(GATE_TIMEOUT_MS / 2);

/** `chatgpt_account_id` out of an id_token, without verifying it — display only. */
function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64").toString("utf-8")
    );
    const auth = payload?.["https://api.openai.com/auth"];
    const id = auth?.chatgpt_account_id ?? payload?.chatgpt_account_id ?? auth?.user_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

export interface CodexTokenExchangeOptions {
  /** The HTTP client. A seam so a test can hang, drop or answer the exchange. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** The exchange budget. Defaults to {@link EXCHANGE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The clock `expires_in` is resolved against. */
  now?: () => number;
}

/** Why a fetch rejected, without the request (which carries the refresh token). */
function describeTransportFailure(err: unknown, timeoutMs: number): string {
  const name = (err as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return `no response within ${timeoutMs} ms`;
  }
  return `the connection failed (${name ?? "error"})`;
}

/** The Codex exchange, with injectable transport, budget and clock. */
export function createCodexTokenExchange(opts: CodexTokenExchangeOptions = {}): TokenExchange {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? EXCHANGE_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());

  return {
    async refresh(record: StoredTokenRecord, ref: AccountRef): Promise<TokenExchangeResult> {
      // `resolveUpstreamUrl` is a no-op unless CLAUDISH_TEST_UPSTREAM names a
      // LOOPBACK target. The e2e counts exchanges at its own token endpoint,
      // which is the only way "exactly one exchange across N processes" is
      // observable.
      const tokenUrl = resolveUpstreamUrl(CODEX_TOKEN_URL);
      let response: Response;
      try {
        response = await doFetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: record.refreshToken,
            client_id: CODEX_CLIENT_ID,
          }),
          // Bounds the WHOLE exchange: the signal also aborts the body read below.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw Object.assign(
          new ExchangeOutcomeUnknownError(describeTransportFailure(err, timeoutMs), {
            cause: markOwnTimeout(err),
          }),
          { claudishEndpoint: tokenUrl }
        );
      }

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          // Headers arrived. Unreadable bytes prove no credential verdict and
          // must not trigger an immediate exchange of a possibly consumed token.
          const status = response.status === 429 || response.status >= 500 ? response.status : 503;
          throw new RefreshUnavailableError(
            "token error response unreadable",
            undefined,
            [],
            status
          );
        }
        // Never log the body wholesale — it can echo the presented token.
        if (isInvalidGrant(body)) throw new InvalidGrantError(`${ref.label}`);
        // Any other 400/401/403 is the token host refusing THIS refresh token
        // (`refresh_token_reused`, `refresh_token_expired`, …). Left terminal it
        // wedged the pool on the dead account; as a rejection, the gate holder
        // records `needsReauth` and the pool tries the next account.
        if (REFRESH_REJECTION_STATUSES.has(response.status)) {
          throw new RefreshTokenRejectedError(response.status, errorCodeOf(body));
        }
        throw credentialHttpError(`token refresh failed: ${response.status}`, response.status);
      }

      const result = await readTokenPair(response, timeoutMs, now);
      log(`[accounts] ${ref.label}: Codex token exchanged`);
      return result;
    },
  };
}

/** Token-host statuses that are a verdict on the presented refresh token. */
const REFRESH_REJECTION_STATUSES = new Set([400, 401, 403]);

/**
 * The structured `error` / `error.code` of a token error body, only when it is
 * a short identifier: the body can echo the presented token, so free text is
 * never carried into a message or the state file.
 */
function errorCodeOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const raw =
      typeof parsed?.error === "string"
        ? parsed.error
        : typeof parsed?.error === "object" && parsed.error !== null
          ? (parsed.error as { code?: unknown }).code
          : undefined;
    return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function isInvalidGrant(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return (
      parsed?.error === "invalid_grant" ||
      (typeof parsed?.error === "object" &&
        parsed.error !== null &&
        (parsed.error as { code?: unknown }).code === "invalid_grant")
    );
  } catch {
    return false;
  }
}

/**
 * The new pair out of a 2xx. The vendor MAY have rotated by now, so anything
 * that stops us reading the pair is an unknown outcome, not a clean failure.
 */
async function readTokenPair(
  response: Response,
  timeoutMs: number,
  now: () => number
): Promise<TokenExchangeResult> {
  let tokens: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
  };
  try {
    tokens = (await response.json()) as typeof tokens;
  } catch (err) {
    throw new ExchangeOutcomeUnknownError(
      `the ${response.status} response body could not be read (${describeTransportFailure(err, timeoutMs)})`
    );
  }
  if (
    typeof tokens?.access_token !== "string" ||
    tokens.access_token.length === 0 ||
    typeof tokens.expires_in !== "number" ||
    !Number.isFinite(tokens.expires_in) ||
    tokens.expires_in <= 0
  ) {
    throw new ExchangeOutcomeUnknownError(
      `the ${response.status} response carried no usable token pair`
    );
  }
  const accountId = accountIdFromIdToken(
    typeof tokens.id_token === "string" ? tokens.id_token : undefined
  );
  return {
    accessToken: tokens.access_token,
    expiresAt: now() + tokens.expires_in * 1000,
    ...(typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0
      ? { refreshToken: tokens.refresh_token }
      : {}),
    ...(accountId ? { accountId } : {}),
  };
}

/** The production Codex exchange. */
export const codexTokenExchange: TokenExchange = createCodexTokenExchange();

/**
 * Claude's exchange does not exist yet.
 *
 * claudish's own PKCE login, its client id and its token URL are Phase 3, and
 * they are gated on the Phase V spike (D1 rotation, D2 `.oauth_refresh.lock`
 * interop; see ai-docs/architecture/accounts.md). A stub that guessed the
 * endpoint would be a plausible-looking request to a real vendor with a real
 * credential, so this refuses loudly instead.
 */
export const unimplementedTokenExchange: TokenExchange = {
  async refresh(_record: StoredTokenRecord, ref: AccountRef): Promise<TokenExchangeResult> {
    throw new Error(
      `No token exchange is built for ${ref.provider} yet (the Claude pool is Phase 3).`
    );
  },
};

/** The exchange for one provider. */
export function exchangeFor(provider: AccountProvider): TokenExchange {
  return provider === "openai-codex" ? codexTokenExchange : unimplementedTokenExchange;
}
