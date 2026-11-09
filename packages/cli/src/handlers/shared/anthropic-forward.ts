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
 * Exact names Claude Code sends on `POST /v1/messages`, besides the prefixed
 * families below (measured from Claude Code 2.1.319, API-key and OAuth runs).
 */
const ALLOWED_NAMES = new Set([
  "authorization",
  "x-api-key",
  "content-type",
  "accept",
  "accept-encoding",
  "user-agent",
  "x-app",
]);

/** Header families Claude Code sends (`anthropic-beta`, `x-stainless-lang`, `x-claude-code-session-id`). */
const ALLOWED_PREFIXES = ["anthropic-", "x-stainless-", "x-claude-code-"] as const;

function isAllowed(name: string): boolean {
  return ALLOWED_NAMES.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
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
    if (!isAllowed(key)) return;
    if (HOP_BY_HOP.has(key) || named.has(key) || key.startsWith(INTERNAL_PREFIX)) return;
    out[key] = value;
  });
  return out;
}

/** The inbound query string with its leading `?` (`?beta=true`), or "" when there is none. */
export function forwardedSearch(c: Context): string {
  const url = c.req.url;
  if (typeof url !== "string" || url.length === 0) return "";
  try {
    return new URL(url).search;
  } catch {
    return "";
  }
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
