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
