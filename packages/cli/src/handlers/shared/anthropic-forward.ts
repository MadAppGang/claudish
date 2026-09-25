/**
 * Forwarding for requests claudish passes on to api.anthropic.com as Claude Code
 * sent them.
 *
 * Hop-by-hop fields, and any field a `Connection` header names, describe one
 * connection rather than the message and are not forwarded
 * (https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1). `content-length` is set
 * again for whatever body goes out, and `content-encoding` is dropped from a
 * response because fetch has already decoded the body it returns.
 */

import type { Context } from "hono";

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

function connectionNamed(headers: Headers): Set<string> {
  const named = new Set<string>();
  for (const token of (headers.get("connection") ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) named.add(name);
  }
  return named;
}

/** Inbound request headers to send on, keyed by lowercase name. */
export function requestHeadersToForward(incoming: Headers): Record<string, string> {
  const named = connectionNamed(incoming);
  const out: Record<string, string> = {};
  incoming.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name) && !named.has(name)) out[name] = value;
  });
  return out;
}

/** Upstream response headers to hand back to Claude Code. */
export function responseHeadersToReturn(upstream: Headers): Headers {
  const named = connectionNamed(upstream);
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || named.has(name) || name === "content-encoding") return;
    out.append(name, value);
  });
  return out;
}

/** The inbound query string, `?beta=true` included, or "" when there is none. */
export function forwardedSearch(c: Context): string {
  return new URL(c.req.url).search;
}

export const INBOUND_BODY_KEY = "inboundBody" as const;

interface InboundBody {
  raw: string;
  /** The serialisation of `raw`'s parse, taken before any handler reads it. */
  canonical: string;
}

/** Record the body as it arrived, before anything can change the parsed copy. */
export function recordInboundBody(c: Context, raw: string, parsed: unknown): void {
  c.set(INBOUND_BODY_KEY, { raw, canonical: JSON.stringify(parsed) } satisfies InboundBody);
}

/**
 * The body to send for `payload`: the inbound bytes while the payload still
 * serialises to what arrived, and the new serialisation once something changed
 * it. Claude Code completes part of a first-party request after serialising it,
 * so an unchanged request has to reach Anthropic as the bytes Claude Code sent.
 */
export function bodyToForward(c: Context, payload: unknown): string {
  const serialized = JSON.stringify(payload);
  const inbound = c.get(INBOUND_BODY_KEY) as InboundBody | undefined;
  return inbound !== undefined && inbound.canonical === serialized ? inbound.raw : serialized;
}
