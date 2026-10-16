/**
 * One classifier for every failure that reaches a credential site, and one way
 * to answer it.
 *
 * ## The rule (project owner, 2026-10-16)
 *
 * - A TERMINAL credential failure of a SUBSCRIPTION provider answers 400 with
 *   its message, and the routing chain stops there. It never walks onto a
 *   metered provider: a user whose flat-rate login expired is told to log in,
 *   not silently billed per token by the next hop.
 * - A TRANSIENT failure (network fault, 5xx, 429) never becomes a 401. A 401 is
 *   the one status `FallbackHandler.isRetryableError` reads as "try another
 *   credential", so a blip answered 401 walked the chain mid-outage.
 *
 * ## Why a header carries the verdict
 *
 * The status alone cannot: a terminal failure is answered 400 so Claude Code
 * shows it inline instead of retrying it behind "API error · Retrying", and a
 * 400 carrying `upstream_status: 401` is exactly what `isRetryableError`'s
 * remap recovery reads as retryable. So the verdict rides
 * {@link AUTH_VERDICT_HEADER}, which `isRetryableError` reads BEFORE any status
 * or wording rule — the same structural pattern as the connection-fault marker
 * (`recovery-marker.ts`), and unforgeable for the same reason: every non-ok
 * response of `ComposedHandler` is a `c.json(...)` whose headers Hono builds
 * from nothing.
 *
 * ## The order of classification
 *
 * connection → terminal → transient → unknown. A connection fault is never
 * answered here at all: the caller runs connection recovery first, and only a
 * failure recovery could not place comes back. `unknown` on a SUBSCRIPTION is
 * answered as terminal, not transient: connection faults are classified first
 * and real transients carry `upstreamStatus` or `transient`, so what is left is
 * overwhelmingly a credential or configuration fault — Kimi's "No Kimi OAuth
 * credentials found. Please run `claudish login kimi` first." is a plain
 * `Error`. Answered 503 it would hide behind about two minutes of Claude Code's
 * silent retries; answered 400 it is read on the first attempt.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { wrapAnthropicError } from "./anthropic-error.js";
import { classifyConnectionError } from "./connection-error.js";

/** The header name. Referenced by name in no other file — import this. */
export const AUTH_VERDICT_HEADER = "x-claudish-auth-verdict";

/**
 * - `terminal`: the credential cannot succeed on retry; the chain must stop here.
 * - `transient`: retrying the SAME hop is the remedy; the chain must not walk.
 */
export type AuthVerdict = "terminal" | "transient";

/** The headers a response with this verdict carries. */
export function authVerdictHeaders(verdict: AuthVerdict): Record<string, string> {
  return { [AUTH_VERDICT_HEADER]: verdict };
}

/** The verdict a header bag carries, if any. Tolerates `undefined` and non-Headers values. */
export function authVerdict(headers: Headers | undefined | null): AuthVerdict | undefined {
  try {
    const value = headers?.get(AUTH_VERDICT_HEADER);
    return value === "terminal" || value === "transient" ? value : undefined;
  } catch {
    return undefined;
  }
}

export type AuthFailure =
  | { kind: "connection"; conn: NonNullable<ReturnType<typeof classifyConnectionError>> }
  | { kind: "transient"; status: number; message: string }
  | { kind: "terminal"; message: string; upstreamStatus?: number }
  | { kind: "unknown"; message: string };

/** The fields a credential path sets on what it throws. */
interface ErrorFields {
  message?: unknown;
  terminal?: unknown;
  transient?: unknown;
  upstreamStatus?: unknown;
}

/** The status a transient failure carries, from the fields a credential path sets. */
function transientStatus(e: ErrorFields | undefined): number | undefined {
  const status = typeof e?.upstreamStatus === "number" ? e.upstreamStatus : undefined;
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return status;
  if (e?.transient === true) return status ?? 503;
  return undefined;
}

/**
 * Classify a failure thrown at a credential site. ONE place, in one order:
 * connection → terminal → transient → unknown.
 *
 * Reads only fields a credential path sets on purpose: `classifyConnectionError`
 * for a network fault, `terminal: true`, `upstreamStatus` (429 or 5xx) or
 * `transient: true`. The message is never parsed.
 */
export function classifyAuthFailure(err: unknown): AuthFailure {
  const conn = classifyConnectionError(err);
  if (conn) return { kind: "connection", conn };
  const e = err as ErrorFields | undefined;
  const message = typeof e?.message === "string" && e.message ? e.message : String(err);
  if (e?.terminal === true) {
    const upstreamStatus = typeof e.upstreamStatus === "number" ? e.upstreamStatus : undefined;
    return {
      kind: "terminal",
      message,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    };
  }
  const status = transientStatus(e);
  if (status !== undefined) return { kind: "transient", status, message };
  return { kind: "unknown", message };
}

/**
 * Answer a classified credential failure. Never called for `connection`: the
 * caller recovers those first (and gets `null` back if it does not).
 *
 * - terminal → 400 `invalid_request_error`, verdict `terminal`. `upstream_status`
 *   is kept for probes.
 * - transient → 429 for a 429, 503 for any 5xx, verdict `transient`: Claude
 *   Code's own retry re-sends to the same hop. Never 401.
 * - unknown on a subscription → as terminal (see the module comment).
 * - unknown on a metered provider → 401 `authentication_error`, unchanged from
 *   before, so the chain may try a provider holding another credential. Only
 *   the two sites that already answered 401 (refreshAuth, forceRefreshAuth)
 *   may ask for this; every other site rethrows an unknown metered failure
 *   unchanged rather than invent a status.
 */
export function respondAuthFailure(
  c: Context,
  failure: AuthFailure,
  opts: { isSubscription: boolean; providerDisplayName: string }
): Response | null {
  switch (failure.kind) {
    case "connection":
      return null;
    case "terminal":
      return terminalResponse(c, failure.message, failure.upstreamStatus);
    case "transient": {
      const status = failure.status === 429 ? 429 : 503;
      return c.json(
        wrapAnthropicError(
          status,
          `${opts.providerDisplayName} could not confirm the credential (HTTP ${failure.status}): ${failure.message}`,
          status === 429 ? "rate_limit_error" : "overloaded_error",
          failure.status
        ),
        status as ContentfulStatusCode,
        authVerdictHeaders("transient")
      );
    }
    case "unknown":
      if (opts.isSubscription) return terminalResponse(c, failure.message);
      return c.json(wrapAnthropicError(401, failure.message, "authentication_error"), 401);
  }
}

function terminalResponse(c: Context, message: string, upstreamStatus?: number): Response {
  return c.json(
    wrapAnthropicError(400, message, "invalid_request_error", upstreamStatus),
    400,
    authVerdictHeaders("terminal")
  );
}
