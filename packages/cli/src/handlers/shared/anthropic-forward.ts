/**
 * The request side of forwarding a Claude Code request to api.anthropic.com
 * as Claude Code sent it: its own headers, its query string and its body bytes.
 *
 * Headers are an ALLOWLIST of what Claude Code itself sends to Anthropic. The
 * native path's upstream is fixed, whatever base URL Claude Code was configured
 * for, so a header Claude Code was told to send to another destination (a
 * gateway token from `ANTHROPIC_CUSTOM_HEADERS`, a cookie) must never be
 * carried there. Every other inbound header is dropped.
 *
 * Hop-by-hop fields, and any field a `Connection` header names, describe one
 * connection rather than the message and are not forwarded even when allowed
 * (RFC 9110 section 7.6.1). `host` names this proxy, and `content-length` is
 * set again by fetch for whatever body goes out.
 */

import type { Context } from "hono";
import { addSigningSecrets, credentialValuesFromRequest } from "./call-context.js";

/**
 * Every name Claude Code sends on `POST /v1/messages`, matched exactly
 * (measured from Claude Code 2.1.319, API-key and OAuth runs). No prefix is
 * matched: a custom header can carry any name, `anthropic-` or `x-stainless-`
 * ones included.
 */
const ALLOWED_NAMES = new Set([
  "authorization",
  "x-api-key",
  "content-type",
  "accept",
  "accept-encoding",
  "user-agent",
  "x-app",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "x-claude-code-session-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
]);

/** The inbound request's credential headers, exactly as they arrived. */
export function inboundAuthHeaders(incoming: Headers): {
  authorization?: string;
  "x-api-key"?: string;
} {
  const out: { authorization?: string; "x-api-key"?: string } = {};
  const authorization = incoming.get("authorization");
  const apiKey = incoming.get("x-api-key");
  if (authorization) out.authorization = authorization;
  if (apiKey) out["x-api-key"] = apiKey;
  return out;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** claudish's internal signals between its own components, never part of the request to Anthropic. */
const INTERNAL_PREFIX = "x-claudish-";

/** The lowercase field names a `Connection` header lists. */
function connectionNamed(headers: Headers): Set<string> {
  const named = new Set<string>();
  for (const token of (headers.get("connection") ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) named.add(name);
  }
  return named;
}

/**
 * The inbound request headers to send on, keyed by lowercase name: the allowed
 * ones, less any that describe the connection. `Headers` already lowercases
 * its names, so a header can appear under one key only.
 */
export function requestHeadersToForward(incoming: Headers): Record<string, string> {
  const named = connectionNamed(incoming);
  const out: Record<string, string> = {};
  incoming.forEach((value, name) => {
    const key = name.toLowerCase();
    if (!ALLOWED_NAMES.has(key)) return;
    if (HOP_BY_HOP.has(key) || named.has(key) || key.startsWith(INTERNAL_PREFIX)) return;
    out[key] = value;
  });
  return out;
}

/**
 * The query parameters Claude Code sends on `POST /v1/messages` (measured from
 * Claude Code 2.1.319). Like the headers, the query is an allowlist: a
 * parameter meant for another destination (an `access_token` for a gateway)
 * must never be carried to the fixed upstream.
 */
const ALLOWED_QUERY_NAMES = new Set(["beta"]);

/** The name of one raw `name=value` query segment, decoded; null when it is malformed. */
function querySegmentName(segment: string): string | null {
  const eq = segment.indexOf("=");
  const rawName = eq < 0 ? segment : segment.slice(0, eq);
  try {
    return decodeURIComponent(rawName.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * The inbound query string reduced to its allowed parameters, each segment
 * byte for byte as sent, with its leading `?` (`?beta=true`); "" when none is
 * left.
 */
export function forwardedSearch(c: Context): string {
  const url = c.req.url;
  if (typeof url !== "string" || url.length === 0) return "";
  let search: string;
  try {
    search = new URL(url).search;
  } catch {
    return "";
  }
  const kept = search
    .slice(1)
    .split("&")
    .filter((segment) => {
      const name = querySegmentName(segment);
      return name !== null && ALLOWED_QUERY_NAMES.has(name);
    });
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

/** The Context key the inbound body is recorded under. */
export const INBOUND_BODY_KEY = "inboundBody" as const;

interface InboundBody {
  /** The body text exactly as it arrived. */
  raw: string;
  /** `JSON.stringify` of `raw`'s parse, taken before any handler could change it. */
  canonical: string;
}

/**
 * Record the body as it arrived, before anything reads or changes the parsed
 * copy. Call it right after parsing, with the text that was parsed.
 */
export function recordInboundBody(c: Context, raw: string, parsed: unknown): void {
  c.set(INBOUND_BODY_KEY, { raw, canonical: JSON.stringify(parsed) } satisfies InboundBody);
}

/**
 * The body to send for `payload`: the inbound bytes while the payload still
 * serialises to exactly what the inbound body parsed to, and the payload's own
 * serialisation once something changed it (or when no body was recorded).
 * Serialises `payload` once per call, so call it once and reuse the result.
 */
export function bodyToForward(c: Context, payload: unknown): string {
  const serialized = JSON.stringify(payload);
  const inbound = c.get(INBOUND_BODY_KEY) as InboundBody | undefined;
  return inbound !== undefined && inbound.canonical === serialized ? inbound.raw : serialized;
}

/**
 * A Claude login's bearer, recognised by its token class: `sk-ant-oat`, a
 * version number and a hyphen (`sk-ant-oat01-…`), the class of the bearer
 * Claude Code sends for its keychain login. The `oauth-2025-04-20` beta cannot
 * say this: any client can declare it on any bearer. Everything else in
 * `authorization` is not matched: a gateway token, even one that begins with
 * the same letters, or an api key helper's value, which Claude Code sends in
 * both headers.
 */
export const CLAUDE_LOGIN_BEARER = /^Bearer\s+sk-ant-oat\d+-/i;

/**
 * Who signs one native request, decided by the launch and the request's route:
 *
 * - `inbound`: the credentials the request arrived with; `fallbackKey` only when
 *   it arrived with neither `authorization` nor `x-api-key`.
 * - `login-only`: the Claude subscription. Only a Claude login bearer is sent; an
 *   inbound `x-api-key` and any other bearer are dropped, and nothing is ever
 *   signed with an API key. A request with no login is refused.
 * - `launch-key`: the Claude API launch. Every inbound credential is dropped and
 *   the request is signed with the key the launch resolved.
 */
export type NativeSigning =
  | { kind: "inbound"; fallbackKey: () => Promise<string | undefined> }
  | { kind: "login-only" }
  | { kind: "launch-key"; key: () => string };

/** The Claude subscription's signing, shared because it carries no state. */
export const LOGIN_ONLY_SIGNING: NativeSigning = { kind: "login-only" };

/** Why a `login-only` request with no Claude login is answered 401 by claudish. */
export const CLAUDE_SUBSCRIPTION_NO_LOGIN =
  "Claude subscription session: this request carries no Claude Code login, and claudish never " +
  "signs a Claude subscription request with an API key. Sign in with /login, or use " +
  "anthropic@<id> for the Claude API.";

/**
 * Why a `login-only` request that carries an API key (`x-api-key`) and no
 * Claude login is answered 401: Claude Code's own credential is a key (a
 * stored Console key, or one the user approved), so /login is not the fix.
 */
export const CLAUDE_SUBSCRIPTION_API_KEY_REQUEST =
  "Claude subscription session: this request carries an API key (x-api-key), not a Claude Code " +
  "login, and claudish never signs a Claude subscription request with an API key. Use " +
  "anthropic@<id> for the Claude API, or, for a bare Claude model name, pass " +
  "--anthropic-api-billing to bill the key.";

/** The Context key the request's signing is set under, for the native handler. */
export const NATIVE_SIGNING_KEY = "nativeSigning" as const;

/** Set the signing the native handler uses for the request on `c`. */
export function setNativeSigning(c: Context, signing: NativeSigning): void {
  c.set(NATIVE_SIGNING_KEY, signing);
}

/** The signing set on `c` for this request, if any. */
export function nativeSigningOf(c: Context): NativeSigning | undefined {
  return c.get(NATIVE_SIGNING_KEY) as NativeSigning | undefined;
}

/** One request to send to Anthropic, ready for `fetch`. */
export interface ForwardRequest {
  /** Keyed by lowercase name, so an override replaces a header rather than adding a spelling. */
  headers: Record<string, string>;
  url: string;
  body: string;
}

/**
 * The request to send to `endpoint` (an absolute URL with no query) for the
 * inbound request on `c`: Claude Code's own headers, the credentials `signing`
 * allows, its allowed query parameters and its body bytes while `payload` is
 * unchanged. `{refused}` when `signing` is `login-only` and the request carries
 * no Claude login: the caller answers it without any upstream call.
 *
 * The credential pair is read from the headers AS THEY ARRIVED: a `Connection`
 * header naming one must not make an authenticated request look
 * unauthenticated, or the fallback would swap the user's own login for a
 * metered key. On `inbound`, `fallbackKey` is called only when the request
 * arrived with neither `authorization` nor `x-api-key`, and an `x-api-key`
 * beside a Claude login bearer is not sent: the login signs the request alone.
 *
 * Every credential value the request sends, in its headers or its URL, is
 * registered on the request's signing lease before this returns.
 */
export async function buildForwardRequest(
  c: Context,
  payload: unknown,
  endpoint: string,
  signing: NativeSigning
): Promise<ForwardRequest | { refused: string }> {
  const inbound = inboundAuthHeaders(c.req.raw.headers);
  const headers: Record<string, string> = requestHeadersToForward(c.req.raw.headers);
  // The allowlist carries both credential names; which of them go out is
  // decided below, from the pair as it arrived.
  delete headers.authorization;
  delete headers["x-api-key"];
  const isLogin =
    inbound.authorization !== undefined && CLAUDE_LOGIN_BEARER.test(inbound.authorization);
  switch (signing.kind) {
    case "inbound": {
      Object.assign(headers, inbound);
      if (isLogin) delete headers["x-api-key"];
      if (!headers.authorization && !headers["x-api-key"]) {
        const key = await signing.fallbackKey();
        if (key) headers["x-api-key"] = key;
      }
      break;
    }
    case "login-only": {
      if (!isLogin || inbound.authorization === undefined) {
        const carriesKey =
          inbound["x-api-key"] !== undefined && inbound.authorization === undefined;
        return {
          refused: carriesKey ? CLAUDE_SUBSCRIPTION_API_KEY_REQUEST : CLAUDE_SUBSCRIPTION_NO_LOGIN,
        };
      }
      headers.authorization = inbound.authorization;
      break;
    }
    case "launch-key": {
      headers["x-api-key"] = signing.key();
      break;
    }
  }
  headers["content-type"] = "application/json";
  if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
  const url = `${endpoint}${forwardedSearch(c)}`;
  addSigningSecrets(c, credentialValuesFromRequest(headers, url));
  return { headers, url, body: bodyToForward(c, payload) };
}
