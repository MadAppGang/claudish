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

function bypassesProxy(host: string): boolean {
  const list = envValue("NO_PROXY", "no_proxy");
  if (!list) return false;
  const name = host.toLowerCase();
  return list.split(",").some((raw) => {
    const entry = raw
      .trim()
      .toLowerCase()
      .replace(/^\*?\./, "");
    if (!entry) return false;
    return entry === "*" || name === entry || name.endsWith(`.${entry}`);
  });
}

/** The proxy the environment names for this URL, or null. */
function proxyFor(target: URL): URL | null {
  if (bypassesProxy(target.hostname)) return null;
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

/** `fetch` for the Antigravity backend, with the Antigravity CLI's request head. */
export async function antigravityFetch(
  url: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  if (process.env[ANTIGRAVITY_PLAIN_FETCH_ENV] === "1") return fetch(url, init);

  const target = new URL(url);
  const secure = target.protocol === "https:";
  // Behind a proxy the runtime's `fetch` sends the request: it owns the tunnel
  // and its TLS, and the request head is then the runtime's.
  if (proxyFor(target)) return fetch(url, init);
  if (init.body != null && typeof init.body !== "string") return fetch(url, init);

  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw signal.reason;

  const method = (init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? Buffer.from(init.body, "utf8") : null;
  const chunked = body !== null && sendsChunked(target);

  return new Promise<Response>((resolve, reject) => {
    // One connection per request: a pooled socket the server has closed answers
    // the next request with a reset, which would read as an unreachable network.
    const request = (secure ? https : http).request(target, { method, agent: false });
    request.removeHeader("Connection");
    for (const [name, value] of antigravityHeaderLines(
      init.headers,
      body?.length ?? null,
      chunked
    )) {
      request.setHeader(name, value);
    }

    let incoming: http.IncomingMessage | undefined;
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
