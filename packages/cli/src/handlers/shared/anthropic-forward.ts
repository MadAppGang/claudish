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
