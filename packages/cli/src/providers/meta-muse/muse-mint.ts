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
 * - network fault → rethrown with `{ cause }` (timeout marked as claudish's
 *   own) and `claudishEndpoint`, so connection recovery classifies it.
 * - 200 without a usable key, or any other status → terminal protocol error.
 *
 * Nothing here caches, logs or persists a secret; the caller owns the state.
 */

import { markOwnTimeout } from "../../handlers/shared/connection-error.js";
import { VERSION } from "../../version.js";

/** The default base host. `MUSE_CODE_BASE_URL` overrides it (the provider's `baseUrlEnvVars`). */
export const MUSE_CODE_DEFAULT_BASE_URL = "https://api.meta.ai";

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

/** The mint failed in a way that retrying fixes (429 or 5xx). */
export class MuseMintTransientError extends Error {
  readonly transient = true;
  constructor(readonly upstreamStatus: number) {
    super(
      `Muse Code key service unavailable (HTTP ${upstreamStatus}); retrying will usually work.`
    );
    this.name = "MuseMintTransientError";
  }
}

/** The mint endpoint for the configured base host. */
export function museMintUrl(env: Record<string, string | undefined> = process.env): string {
  const base = (env.MUSE_CODE_BASE_URL?.trim() || MUSE_CODE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/muse-code/key`;
}

/** Injectable `fetch`, so the mint is testable without a network. */
export interface MuseMintDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
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
  const url = museMintUrl(deps.env ?? process.env);

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
    // Not terminal: a network fault can heal. `{ cause }` keeps the syscall code
    // findable, `markOwnTimeout` marks the ceiling above as ours, and
    // `claudishEndpoint` names the host that failed (the mint, not the model).
    throw Object.assign(
      new Error(`Could not reach ${url} to mint a Muse Code key: ${(error as Error).message}`, {
        cause: markOwnTimeout(error),
      }),
      { claudishEndpoint: url }
    );
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
  // the fetch catch above, so connection recovery sees it. Only a body that
  // arrived and does not parse is a protocol error (terminal).
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
    throw new MuseMintProtocolError(
      "The Muse Code key service answered with a body claudish cannot read.",
      response.status
    );
  }

  return interpretMint(body);
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
