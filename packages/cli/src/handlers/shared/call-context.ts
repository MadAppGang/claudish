/**
 * Call-scoped state carried on a Hono `Context`.
 *
 * A leaf: it imports only `redact.ts` (itself import-free) and Hono's types,
 * so the handlers, the proxy and the logger can all read it without a cycle.
 *
 * Context variables rather than wrappers, because `FallbackHandler` tests
 * `instanceof ComposedHandler` on its candidates: a decorated candidate loses
 * its fallback metadata with no error. Every candidate of a chain receives the
 * same `c`, so a value set here spans every hop of one inbound request.
 */

import type { Context } from "hono";
import type { CredentialArm } from "../../auth/credentials/types.js";
import { type SigningLease, acquireSigningLease } from "../../redact.js";

// ─── Signing secrets ─────────────────────────────────────────────────────────

/**
 * The Context key of a request's signing secrets. Installed by the session
 * app's lease middleware on every inbound request (`proxy-server.ts`).
 */
export const SIGNING_SECRETS_KEY = "claudishSigningSecrets" as const;

/**
 * The credential values one request signed with: kept on the Context for a
 * by-value pass over text this request returns, and held in the process-wide
 * registry (`redact.ts`) through `lease` so every log sink redacts them while
 * the request's work is alive.
 */
export interface SigningSecrets {
  values: Set<string>;
  lease: SigningLease;
}

declare module "hono" {
  interface ContextVariableMap {
    /** This request's signing secrets; see `SIGNING_SECRETS_KEY`. */
    claudishSigningSecrets: SigningSecrets;
  }
}

/** A fresh, empty set with its own registry lease. The caller releases it. */
export function createSigningSecrets(): SigningSecrets {
  return { values: new Set<string>(), lease: acquireSigningLease() };
}

/**
 * The secrets installed on `c`, or a lazily created set when nothing installed
 * one. Every production request path installs one (the session app's
 * middleware); the lazy set exists for callers that build a Context of their
 * own, such as tests. Its lease is never released: there is no point at which
 * such a caller's work is known to have ended, and a fixed timer could expire
 * under a stream that is still logging. Retention costs redaction, never
 * exposure.
 */
export function signingSecretsOf(c: Context): SigningSecrets {
  const installed = readCallVar<SigningSecrets>(c, SIGNING_SECRETS_KEY);
  if (installed) return installed;
  const lazy = createSigningSecrets();
  writeCallVar(c, SIGNING_SECRETS_KEY, lazy);
  return lazy;
}

// ─── Context variable access ─────────────────────────────────────────────────

/**
 * Variables of a context that has no `get`/`set` of its own: a hand-built
 * stand-in for Hono's `Context` (tests pass `{ req, json }` objects). Keyed
 * weakly by the object, so nothing outlives it. A real Context always uses its
 * own variable store.
 */
const detachedCallVars = new WeakMap<object, Map<string, unknown>>();

interface ContextVarStore {
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
}

/** Read a call-scoped variable; `undefined` when unset or `c` is not an object. */
export function readCallVar<T>(c: Context | undefined, key: string): T | undefined {
  if (!c || typeof c !== "object") return undefined;
  const store = c as unknown as ContextVarStore;
  if (typeof store.get === "function") return store.get(key) as T | undefined;
  return detachedCallVars.get(c)?.get(key) as T | undefined;
}

/** Write a call-scoped variable; a no-op when `c` is not an object. */
export function writeCallVar(c: Context | undefined, key: string, value: unknown): void {
  if (!c || typeof c !== "object") return;
  const store = c as unknown as ContextVarStore;
  if (typeof store.set === "function") {
    store.set(key, value);
    return;
  }
  let vars = detachedCallVars.get(c);
  if (!vars) {
    vars = new Map();
    detachedCallVars.set(c, vars);
  }
  vars.set(key, value);
}

/** Register `values` on `c`'s set AND its registry lease. */
export function addSigningSecrets(c: Context, values: Iterable<string>): void {
  const secrets = signingSecretsOf(c);
  const list = [...values].filter((v) => typeof v === "string" && v.length > 0);
  for (const value of list) secrets.values.add(value);
  secrets.lease.add(list);
}

/** Header names whose whole value is a credential. Compared lowercase. */
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "cookie",
]);

/** Fragments that mark any other header as credential-bearing. */
const CREDENTIAL_HEADER_FRAGMENTS = ["token", "secret", "key"];

/** Query parameters that carry a credential (Gemini's `?key=`). */
const CREDENTIAL_QUERY_NAMES = new Set(["key", "api_key", "token", "access_token"]);

/** An auth scheme word in front of a credential. Not global: no `lastIndex`. */
const AUTH_SCHEME_PREFIX = /^(?:Bearer|Basic|Token)\s+/i;

function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_HEADER_NAMES.has(lower)) return true;
  return CREDENTIAL_HEADER_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/** The secret parts of one credential header value. */
function credentialPartsOf(name: string, value: string): string[] {
  const parts = [value];
  const bare = value.replace(AUTH_SCHEME_PREFIX, "");
  if (bare !== value) parts.push(bare);
  if (name.toLowerCase() === "cookie") {
    for (const pair of value.split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) parts.push(pair.slice(eq + 1).trim());
    }
  }
  return parts;
}

/**
 * The credential values in one signed request: every credential-bearing
 * header (scheme word removed as well as kept) and the endpoint's credential
 * query parameters. Values only; names never leave this function.
 */
export function credentialValuesFromRequest(
  headers: Record<string, string> | undefined,
  endpoint?: string
): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== "string" || !value || !isCredentialHeader(name)) continue;
    out.push(...credentialPartsOf(name, value));
  }
  if (endpoint) {
    try {
      for (const [name, value] of new URL(endpoint).searchParams) {
        if (value && CREDENTIAL_QUERY_NAMES.has(name.toLowerCase())) out.push(value);
      }
    } catch {
      // Not an absolute URL: no query to read.
    }
  }
  return out;
}

/**
 * Call `release` once `response`'s body has been fully read, cancelled or has
 * errored; at once when there is no body. The returned Response carries the
 * same status, headers and bytes, pulled through one chunk at a time
 * (`highWaterMark: 0`), so nothing is buffered ahead of the consumer.
 *
 * A cancel is forwarded to the source reader FIRST, so an upstream still
 * generating stops, and whatever it logs while stopping is still redacted.
 */
export function releaseWhenBodyEnds(response: Response, release: () => void): Response {
  const source = response.body;
  if (!source) {
    release();
    return response;
  }
  const reader = source.getReader();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            release();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          release();
          controller.error(err);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {
          // The source is already gone; the release below is what matters.
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ─── Call abort ──────────────────────────────────────────────────────────────

/**
 * The Context key of an internal call's abort signal. Installed ONLY by a
 * caller that issues requests of its own with a deadline (the advisor panel
 * gateway); never on a request from Claude Code. Every reach point reads it
 * through `callAbortSignal`, which returns `undefined` for a main request, so
 * each composition below collapses to the code that ran before it existed.
 *
 * A Context variable, not `c.req.raw.signal`: the inbound request's signal is
 * the CLIENT going away, which the recovery ladder already reads with its own
 * meaning, and a main request must not acquire a second one.
 */
export const CALL_ABORT_SIGNAL_KEY = "claudishCallAbortSignal" as const;

/** Header on the answer to an aborted call. Produced, never compared by status. */
export const CALL_ABORTED_HEADER = "x-claudish-call-aborted";

declare module "hono" {
  interface ContextVariableMap {
    /** An internal call's deadline; see `CALL_ABORT_SIGNAL_KEY`. */
    claudishCallAbortSignal: AbortSignal;
  }
}

/** The call's abort signal, or `undefined` (every main request). */
export function callAbortSignal(c: Context | undefined): AbortSignal | undefined {
  return readCallVar<AbortSignal>(c, CALL_ABORT_SIGNAL_KEY);
}

/** True once the call's deadline has passed. Always false on a main request. */
export function callAborted(c: Context | undefined): boolean {
  return callAbortSignal(c)?.aborted === true;
}

/** The error a stopped reach point rejects with: a DOM `AbortError`. */
export function callAbortError(): Error {
  return new DOMException("the call's deadline passed; claudish stopped its work", "AbortError");
}

/**
 * Stop WAITING for `p` once `signal` aborts; `p` itself is not cancelled. For
 * work that is shared or unbilled (a single-flight token refresh, a quota
 * read), where cancelling would hurt other requests and waiting would hold
 * this one past its deadline. Without a signal, `p` is returned unchanged.
 *
 * The losing promise's rejection is owned here (a no-op `catch`), so a refresh
 * that fails after the abort won never surfaces as an unhandled rejection.
 */
export function raceCallAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  p.catch(() => {});
  if (signal.aborted) return Promise.reject(callAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(callAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Wait `ms`, or less if `signal` aborts first. Resolves `true` when it was
 * aborted. The timer is cleared on abort and the listener removed on expiry,
 * so neither outlives the wait.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `sig` composed with the call's signal; either alone when the other is absent. */
export function withCallSignal(
  sig: AbortSignal | undefined,
  callSignal: AbortSignal | undefined
): AbortSignal | undefined {
  if (!callSignal) return sig;
  if (!sig) return callSignal;
  return AbortSignal.any([sig, callSignal]);
}

/**
 * The answer to a call whose deadline passed: 408 with `CALL_ABORTED_HEADER`.
 * Its caller has already stopped waiting; this exists so every path returns a
 * Response instead of throwing, and so nothing downstream classifies it.
 */
export function abortedResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "timeout_error",
        message: "claudish stopped this call: its deadline passed",
      },
    }),
    {
      status: 408,
      headers: { "content-type": "application/json", [CALL_ABORTED_HEADER]: "1" },
    }
  );
}

// ─── Hop log ─────────────────────────────────────────────────────────────────

/**
 * The Context key of an internal call's hop log. Installed ONLY by a caller
 * that needs to know which hop served it and on which credential arm (the
 * advisor panel gateway); a main request has none and records nothing.
 */
export const HOP_LOG_KEY = "claudishHopLog" as const;

/** How a hop bills: by the provider's subscription status right after signing. */
export type HopBilling = "subscription" | "metered";

/**
 * One `handle()` entry of one hop. A closed set of non-secret fields: no
 * header, no credential, no request body, so a log of these can be printed
 * or serialised as it is.
 */
export interface HopAttempt {
  /** The handler's claudish provider (`provider.name`). */
  provider: string;
  /** The model id this hop sends upstream. */
  wireModel: string;
  /** The arm that signed (`RequestAuth.arm`); null until signed, or when the transport names none. */
  arm: CredentialArm | null;
  /** `isSubscriptionProvider(provider)` right after signing; null until signed. */
  billing: HopBilling | null;
}

declare module "hono" {
  interface ContextVariableMap {
    /** An internal call's hop log; see `HOP_LOG_KEY`. */
    claudishHopLog: HopAttempt[];
  }
}

/** The installed hop log, or `undefined` (every main request). */
export function hopLogOf(c: Context | undefined): HopAttempt[] | undefined {
  return readCallVar<HopAttempt[]>(c, HOP_LOG_KEY);
}

/**
 * Append an unsigned entry for a hop whose `handle()` was just entered, and
 * return it so the handler can fill `arm` and `billing` once it has signed.
 * `undefined`, and nothing recorded, when no hop log is installed.
 */
export function recordHopEntry(
  c: Context | undefined,
  provider: string,
  wireModel: string
): HopAttempt | undefined {
  const hops = hopLogOf(c);
  if (!hops) return undefined;
  const entry: HopAttempt = { provider, wireModel, arm: null, billing: null };
  hops.push(entry);
  return entry;
}
