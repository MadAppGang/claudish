/**
 * The Muse Code key mint: a Meta `dca:` access token in, a short-lived `LLM|`
 * API key out — and the ENTITLEMENT evidence that decides whether claudish may
 * bill that key as a subscription.
 *
 * ## The wire (captured 2026-10-16, muse-wire.md §8)
 *
 * ```
 * POST https://api.meta.ai/muse-code/key
 * authorization: Bearer dca:…            (282 chars)
 * x-api-version: 1.0.0
 * content-type: application/json
 * {"onboard":false}
 * → 200 {"api_key":"LLM|…"(49), "base_url":"https://api.meta.ai/v1",
 *        "is_subs_active":true, "require_payment":false, "action_url":null,
 *        "subs_tier_id":"…", "subs_tier_name":"Muse Code Power Usage", …}
 * ```
 *
 * The Muse Code CLI calls it at start and again on a 401 from `/v1/responses`;
 * the `dca:` token is the durable credential and the `LLM|` key rotates.
 *
 * ## What "confirmed" means
 *
 * A mint is CONFIRMED only when `is_subs_active === true` AND
 * `require_payment === false`, both present as booleans. Anything else —
 * missing, `"true"`, `null` — is unconfirmed: a key minted for an account with
 * no active subscription would otherwise be signed, labelled `SUB` and billed
 * $0 while Meta charges or refuses it. Unconfirmed is terminal, with the
 * subscribe link Meta returned (`action_url`) or its known landing page.
 *
 * ## How it fails (`handlers/shared/auth-failure.ts` reads exactly these fields)
 *
 * - 401/403 → `MuseLoginExpiredError` (`terminal`, `upstreamStatus`): the
 *   `dca:` login is dead; only a new login fixes it.
 * - 429 or 5xx → `{ upstreamStatus, transient: true }`: retrying works.
 * - 2xx whose body is not a JSON object → transient too (upstreamStatus 502).
 * - network fault → rethrown with `{ cause }` (timeout marked as claudish's
 *   own) and `claudishEndpoint`, so connection recovery classifies it.
 * - a local fetch error that is no network fault (an invalid header value) →
 *   rethrown with `{ cause }`, unclassified, and NOT described as unreachable.
 * - a readable 200 without a usable key, or any other status → terminal
 *   protocol error.
 *
 * Nothing here caches, logs or persists a secret; the caller owns the state.
 */

import {
  classifyConnectionError,
  markOwnTimeout,
} from "../../handlers/shared/connection-error.js";
import { VERSION } from "../../version.js";

/**
 * The ONLY host the Muse Code login, the minted key and Muse requests go to.
 *
 * Fixed, with no environment override. Bun loads the cwd `.env` before any
 * claudish code runs (measured on Bun 1.4.0), so a variable that redirected
 * this host — or one that opted into redirecting it — could be set by any
 * repository the user runs claudish in, and would send the durable `dca:`
 * login (possibly the one copied from the Muse Code CLI's Keychain item) to
 * that repository's server. Tests use the injected `fetch` seam instead.
 */
export const MUSE_CODE_BASE_URL = "https://api.meta.ai";

/** Meta's subscribe page, used when the mint names no `action_url` of its own. */
export const MUSE_CODE_SUBSCRIBE_URL = "https://accountscenter.meta.com/muse_code/?ep=no_payg";

/**
 * A rule, not a vendor value: the mint is one small JSON exchange, and a hang
 * here holds a request. Long enough for a slow network, short enough that the
 * caller's own deadline is not the only bound.
 */
const MINT_TIMEOUT_MS = 15_000;

/** The `x-api-version` the Muse Code CLI sends; the endpoint is versioned by it. */
const MINT_API_VERSION = "1.0.0";

/** A confirmed mint. `apiKey` is the bearer for `/v1/responses`. */
export interface MuseMint {
  apiKey: string;
  /** Meta's `base_url` for the minted key, when it names one. */
  baseUrl?: string;
  subsTierId?: string;
  subsTierName?: string;
}

/** The `dca:` login is dead (401/403 from the mint). */
export class MuseLoginExpiredError extends Error {
  readonly terminal = true;
  constructor(readonly upstreamStatus: number) {
    super("Your Muse Code login has expired: run `claudish login muse` (or `muse login`).");
    this.name = "MuseLoginExpiredError";
  }
}

/** The login works but the account has no active Muse Code subscription. */
export class MuseSubscriptionRequiredError extends Error {
  readonly terminal = true;
  constructor(readonly actionUrl: string) {
    // Deliberately no login hint: logging in again changes nothing here.
    super(
      `Your Meta account has no active Muse Code subscription (or needs a payment method): subscribe at ${actionUrl}.`
    );
    this.name = "MuseSubscriptionRequiredError";
  }
}

/** The mint answered something this build cannot read. */
export class MuseMintProtocolError extends Error {
  readonly terminal = true;
  constructor(
    message: string,
    readonly upstreamStatus?: number
  ) {
    super(message);
    this.name = "MuseMintProtocolError";
  }
}

/**
 * The mint failed in a way that retrying fixes: a 429 or 5xx, or a 2xx whose
 * body is not readable JSON (carried as 502, an invalid answer from upstream).
 */
export class MuseMintTransientError extends Error {
  readonly transient = true;
  constructor(
    readonly upstreamStatus: number,
    message?: string
  ) {
    super(
      message ??
        `Muse Code key service unavailable (HTTP ${upstreamStatus}); retrying will usually work.`
    );
    this.name = "MuseMintTransientError";
  }
}

/** The mint endpoint (fixed: see {@link MUSE_CODE_BASE_URL}). */
export const MUSE_MINT_URL = `${MUSE_CODE_BASE_URL}/muse-code/key`;

/** Injectable `fetch`, so the mint is testable without a network. */
export interface MuseMintDeps {
  fetch: typeof fetch;
}

/**
 * Mint an `LLM|` key from a `dca:` access token. Resolves only with a
 * CONFIRMED mint; every other outcome throws one of the classified errors
 * above (or a network fault, classified by connection recovery).
 */
export async function mintMuseApiKey(
  accessToken: string,
  deps: Partial<MuseMintDeps> = {}
): Promise<MuseMint> {
  const doFetch = deps.fetch ?? fetch;
  const url = MUSE_MINT_URL;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-api-version": MINT_API_VERSION,
        "Content-Type": "application/json",
        "User-Agent": `claudish/${VERSION}`,
      },
      body: JSON.stringify({ onboard: false }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch (error) {
    throw describeFetchFailure(markOwnTimeout(error), url);
  }

  if (response.status === 401 || response.status === 403) {
    throw new MuseLoginExpiredError(response.status);
  }
  if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
    throw new MuseMintTransientError(response.status);
  }
  if (!response.ok) {
    throw new MuseMintProtocolError(
      `The Muse Code key service answered HTTP ${response.status}; claudish cannot mint a key.`,
      response.status
    );
  }

  // Two different failures, read apart. `fetch` resolves on the HEADERS, so a
  // connection reset or our own timeout can still fail the BODY read: that is
  // a network fault and keeps its cause, timeout mark and endpoint, exactly as
  // the fetch catch above, so connection recovery sees it. A body that arrived
  // and does not parse is TRANSIENT (D10): a proxy or gateway page answering
  // for the host says nothing about the login, and the login is never deleted.
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw Object.assign(
      new Error(
        `Lost the connection to ${url} while reading the Muse Code key: ${(error as Error).message}`,
        {
          cause: markOwnTimeout(error),
        }
      ),
      { claudishEndpoint: url }
    );
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    throw new MuseMintTransientError(
      502,
      `The Muse Code key service answered HTTP ${response.status} with a body claudish cannot read; retrying will usually work.`
    );
  }

  return interpretMint(body);
}

/**
 * The error for a mint `fetch` that threw. Either way it is not terminal and
 * keeps the original as `cause`, so classification is unchanged: a connection
 * fault is recovered, anything else is D10's unclassified answer (a retryable
 * 503 on a subscription).
 *
 * Only the MESSAGE differs. "Could not reach" is said only of what
 * `classifyConnectionError` recognises as a connection fault, including our
 * own timeout (`markOwnTimeout`); `claudishEndpoint` names the mint host for
 * that report. Anything else is reported as what it is, an error claudish does
 * not recognise as a network fault. Often it was raised locally before a socket
 * existed: Bun's `Header 'Authorization' has invalid value`
 * for a stored token holding a control or non-Latin-1 character is the measured
 * case. Calling that a network outage sent the user to check a network that
 * was fine, while the corrupt login retried forever.
 */
function describeFetchFailure(error: unknown, url: string): Error {
  const detail = (error as Error | undefined)?.message ?? String(error);
  if (classifyConnectionError(error)) {
    return Object.assign(
      new Error(`Could not reach ${url} to mint a Muse Code key: ${detail}`, { cause: error }),
      { claudishEndpoint: url }
    );
  }
  // Bun's header error QUOTES the value: `Header 'Authorization' has invalid
  // value: 'Bearer dca:…'`, the durable login itself. It is replaced, never
  // echoed into a message that reaches the chat and the debug log, and the
  // original is not kept as `cause` either: nothing classifies it (it is no
  // connection fault), so the only thing it could still carry is the token.
  if (/authorization/i.test(detail)) {
    return new Error(
      `The Muse Code key request to ${url} was not sent: the stored Muse Code login is not a valid Authorization header value (value withheld). Run \`claudish login muse\` to replace it.`
    );
  }
  return new Error(
    `The Muse Code key request to ${url} failed before any answer, with an error claudish does not recognise as a network fault: ${detail}`,
    { cause: error }
  );
}

/**
 * The mint response → a confirmed mint, or the classified refusal. Exported
 * separately so the entitlement rule is testable on a captured body alone.
 */
export function interpretMint(body: Record<string, unknown>): MuseMint {
  if (!(body.is_subs_active === true && body.require_payment === false)) {
    const actionUrl =
      typeof body.action_url === "string" && /^https:\/\//i.test(body.action_url)
        ? body.action_url
        : MUSE_CODE_SUBSCRIBE_URL;
    throw new MuseSubscriptionRequiredError(actionUrl);
  }
  const apiKey = body.api_key;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new MuseMintProtocolError("The Muse Code key service returned an empty API key.");
  }
  return {
    apiKey,
    ...(typeof body.base_url === "string" && body.base_url ? { baseUrl: body.base_url } : {}),
    ...(typeof body.subs_tier_id === "string" ? { subsTierId: body.subs_tier_id } : {}),
    ...(typeof body.subs_tier_name === "string" ? { subsTierName: body.subs_tier_name } : {}),
  };
}
