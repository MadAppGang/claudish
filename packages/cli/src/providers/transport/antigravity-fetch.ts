/**
 * The HTTP client for the Antigravity backend: it writes the request head the
 * Antigravity CLI writes.
 *
 * Bun's `fetch` cannot: it always adds an `Accept` header (any type) and `Connection:
 * keep-alive`, offers `gzip, deflate, br, zstd`, and orders the headers its own
 * way. `node:http` writes the headers in the order they were set and adds only
 * `Host`, so the head here is, in order:
 *
 *   Host, User-Agent, Content-Length | Transfer-Encoding, Authorization,
 *   Content-Type, Accept-Encoding: gzip
 *
 * with `Transfer-Encoding: chunked` on `streamGenerateContent` and
 * `Content-Length` on every other call. Rationale and the recording:
 * ai-docs/architecture/providers/antigravity.md.
 */

import http from "node:http";
import https from "node:https";
import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";

/** Set to `1` to send Antigravity requests with the runtime's `fetch` instead. */
export const ANTIGRAVITY_PLAIN_FETCH_ENV = "CLAUDISH_ANTIGRAVITY_PLAIN_FETCH";

/** The first Bun whose `node:http` was measured to write the head it is given. */
const FIRST_BUN_WITH_OWN_HTTP_HEAD = "1.4.0";

/**
 * Whether this runtime's `node:http` writes the request head it is given.
 * Bun 1.3.10 sends a `node:http` request through its `fetch`: the head is the
 * runtime's, an abort before the response never rejects and a socket timeout
 * never fires. On such a runtime the request goes to `fetch`. `bunVersion` is
 * `process.versions.bun`, absent on Node.
 */
export function nodeHttpWritesOwnHead(bunVersion: string | undefined): boolean {
  if (!bunVersion) return true;
  const part = (version: string) => version.split("-")[0].split(".").map(Number);
  const have = part(bunVersion);
  const need = part(FIRST_BUN_WITH_OWN_HTTP_HEAD);
  for (let i = 0; i < need.length; i++) {
    const n = have[i];
    if (!Number.isFinite(n)) return false;
    if (n !== need[i]) return n > need[i];
  }
  return true;
}

/** Headers this client writes itself; a caller's value for one of them is not sent. */
const OWN_HEADERS = new Set([
  "host",
  "accept",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "user-agent",
  "authorization",
  "content-type",
]);

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      out[name] = value;
    });
    return out;
  }
  for (const [name, value] of Array.isArray(headers) ? headers : Object.entries(headers)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** True for the one call the Antigravity CLI sends with a chunked body. */
function sendsChunked(target: URL): boolean {
  return target.pathname.includes(":streamGenerateContent");
}

/**
 * The request headers after `Host`, in the Antigravity CLI's order. A header
 * the caller did not give is left out; any other caller header follows the
 * fixed ones in the caller's order.
 */
export function antigravityHeaderLines(
  headers: RequestInit["headers"],
  bodyBytes: number | null,
  chunked: boolean
): Array<[string, string]> {
  const given = headerRecord(headers);
  const find = (lower: string) => {
    for (const [name, value] of Object.entries(given)) {
      if (name.toLowerCase() === lower) return value;
    }
    return undefined;
  };
  const lines: Array<[string, string]> = [];
  const userAgent = find("user-agent");
  if (userAgent !== undefined) lines.push(["User-Agent", userAgent]);
  if (bodyBytes !== null) {
    lines.push(chunked ? ["Transfer-Encoding", "chunked"] : ["Content-Length", String(bodyBytes)]);
  }
  const authorization = find("authorization");
  if (authorization !== undefined) lines.push(["Authorization", authorization]);
  const contentType = find("content-type");
  if (contentType !== undefined) lines.push(["Content-Type", contentType]);
  lines.push(["Accept-Encoding", "gzip"]);
  for (const [name, value] of Object.entries(given)) {
    if (!OWN_HEADERS.has(name.toLowerCase())) lines.push([name, value]);
  }
  return lines;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/** Whether `NO_PROXY` names the target. An entry may end in `:port`, which then has to match too. */
function bypassesProxy(target: URL): boolean {
  const list = envValue("NO_PROXY", "no_proxy");
  if (!list) return false;
  const name = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return list.split(",").some((raw) => {
    let entry = raw.trim().toLowerCase();
    const withPort = entry.match(/^(.*[^:]):(\d+)$/);
    if (withPort) {
      if (withPort[2] !== port) return false;
      entry = withPort[1];
    }
    entry = entry.replace(/^\*?\./, "");
    if (!entry) return false;
    return entry === "*" || name === entry || name.endsWith(`.${entry}`);
  });
}

/** The proxy the environment names for this URL, or null. */
function proxyFor(target: URL): URL | null {
  if (bypassesProxy(target)) return null;
  const value =
    target.protocol === "https:"
      ? envValue("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
      : envValue("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * How long a connection may stay silent before the request fails. The
 * runtime's `fetch` ends an idle request after five minutes; `node:http` never
 * does, and three of the callers pass no signal.
 */
export const ANTIGRAVITY_IDLE_TIMEOUT_MS = 300_000;

/** Redirects followed before the last answer is returned as it is. */
const MAX_REDIRECTS = 5;

function idleTimeoutError(ms: number): Error {
  return Object.assign(new Error(`The Antigravity backend sent nothing for ${ms} ms`), {
    code: "ETIMEDOUT",
  });
}

/**
 * `fetch` for the Antigravity backend, with the Antigravity CLI's request head.
 * A 307 or 308 answer is followed with the same method and body, as `fetch`
 * follows it, unless `init.redirect` is "manual"; the `Authorization` header is
 * not sent to another origin.
 */
export async function antigravityFetch(
  url: string | URL,
  init: RequestInit = {},
  idleTimeoutMs: number = ANTIGRAVITY_IDLE_TIMEOUT_MS
): Promise<Response> {
  // These four hand the whole request to the runtime's `fetch`, redirects included.
  if (process.env[ANTIGRAVITY_PLAIN_FETCH_ENV] === "1") return fetch(url, init);
  if (!nodeHttpWritesOwnHead(process.versions.bun)) return fetch(url, init);
  if (init.body != null && typeof init.body !== "string") return fetch(url, init);
  let target = new URL(url);
  // Behind a proxy the runtime's `fetch` sends the request: it owns the tunnel
  // and its TLS, and the request head is then the runtime's.
  if (proxyFor(target)) return fetch(url, init);
  let current = init;
  for (let hop = 0; ; hop++) {
    const response = await sendOnce(target, current, idleTimeoutMs);
    const location = response.headers.get("location");
    const redirected = (response.status === 307 || response.status === 308) && location;
    if (!redirected || init.redirect === "manual" || hop >= MAX_REDIRECTS) return response;
    await response.body?.cancel().catch(() => {});
    if (init.redirect === "error") {
      throw new TypeError(`The Antigravity backend answered ${response.status} with a redirect`);
    }
    const next = new URL(location, target);
    if (next.origin !== target.origin) {
      const kept: Record<string, string> = {};
      const sent = new Headers(current.headers as ConstructorParameters<typeof Headers>[0]);
      sent.forEach((value, name) => {
        if (name.toLowerCase() !== "authorization") kept[name] = value;
      });
      current = { ...current, headers: kept };
    }
    target = next;
    if (proxyFor(target)) return fetch(target.href, current);
  }
}

/** One request over `node:http`, with a string body or none. */
async function sendOnce(target: URL, init: RequestInit, idleTimeoutMs: number): Promise<Response> {
  const secure = target.protocol === "https:";
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw signal.reason;

  const method = (init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? Buffer.from(init.body, "utf8") : null;
  const chunked = body !== null && sendsChunked(target);

  return new Promise<Response>((resolve, reject) => {
    // One connection per request: a pooled socket the server has closed answers
    // the next request with a reset, which would read as an unreachable network.
    const request = (secure ? https : http).request(target, { method, agent: false });
    try {
      request.removeHeader("Connection");
      for (const [name, value] of antigravityHeaderLines(
        init.headers,
        body?.length ?? null,
        chunked
      )) {
        request.setHeader(name, value);
      }
    } catch (error) {
      // A header value the runtime refuses (a line break): nothing was sent.
      request.once("error", () => {});
      request.destroy();
      reject(error);
      return;
    }

    let incoming: http.IncomingMessage | undefined;
    request.setTimeout(idleTimeoutMs, () => {
      const error = idleTimeoutError(idleTimeoutMs);
      request.destroy(error);
      incoming?.destroy(error);
    });
    const onAbort = () => {
      request.destroy(signal?.reason);
      incoming?.destroy(signal?.reason);
    };
    const release = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });

    request.once("error", (error) => {
      release();
      reject(error);
    });
    request.once("response", (res) => {
      incoming = res;
      res.once("close", release);
      const status = res.statusCode ?? 0;
      const headers = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      }
      let source: Readable = res;
      if (/\bgzip\b/i.test(headers.get("content-encoding") ?? "")) {
        // The body handed on is decoded, so the headers that describe the
        // encoded bytes go with the encoding.
        source = pipeline(res, createGunzip(), () => {});
        headers.delete("content-encoding");
        headers.delete("content-length");
      }
      const bodiless = method === "HEAD" || status === 204 || status === 304;
      if (bodiless) res.resume();
      try {
        resolve(
          new Response(bodiless ? null : (Readable.toWeb(source) as unknown as ReadableStream), {
            status,
            statusText: res.statusMessage ?? "",
            headers,
          })
        );
      } catch (error) {
        res.destroy();
        reject(error);
      }
    });

    if (body === null) request.end();
    else if (chunked) {
      request.write(body);
      request.end();
    } else request.end(body);
  });
}
