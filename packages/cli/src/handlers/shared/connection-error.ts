/**
 * Connection-error classification.
 *
 * Distinguishes a LOCAL network failure (DNS can't resolve, connection refused,
 * host unreachable) from an upstream HTTP error. When claudish's proxy can't
 * even REACH the provider, that's the user's machine/network — reporting it as a
 * generic 500 sends people hunting for a claudish or provider bug. Tagging these
 * as connection errors lets both Claude Code and the config probe show an honest
 * "can't reach host — check your network/DNS" instead.
 */

export type ConnectionErrorKind = "dns" | "refused" | "unreachable" | "closed";

/** Node/undici syscall codes we treat as a failure to REACH the host. */
const CODE_KIND: Record<string, ConnectionErrorKind> = {
  ENOTFOUND: "dns", // getaddrinfo: host not found
  EAI_AGAIN: "dns", // getaddrinfo: temporary DNS failure
  ECONNREFUSED: "refused", // nothing listening at the endpoint
  ETIMEDOUT: "unreachable", // connect timed out
  ENETUNREACH: "unreachable", // network unreachable
  EHOSTUNREACH: "unreachable", // host unreachable
  UND_ERR_CONNECT_TIMEOUT: "unreachable", // undici connect timeout

  // Reached, then the connection died before a response: the peer (or a proxy
  // in between) closed it — a TLS reject, an upstream that cuts. Kept separate
  // from "unreachable" because blaming the user's network for a peer-side reset
  // is a misdiagnosis; retry semantics are identical either way.
  ECONNRESET: "closed", // connection reset before response
  EPIPE: "closed", // broken pipe
  UND_ERR_SOCKET: "closed", // undici socket closed
  ConnectionClosed: "closed", // Bun: peer closed mid-connect
  ERR_SOCKET_CLOSED: "closed", // Bun: socket closed before response

  // --- Bun runtime codes ---------------------------------------------------
  // claudish RUNS on Bun, and Bun's fetch does NOT use Node's errno names and
  // does NOT populate `.cause` — it throws a flat Error carrying its own `code`
  // plus `path`/`errno` own-properties. Without these entries every real-world
  // connect failure fell through classification into a raw 500. Note Bun
  // reports a DNS failure as ConnectionRefused too — see
  // buildConnectionErrorMessage for how that ambiguity is resolved.
  ConnectionRefused: "refused", // Bun: refused OR unresolvable host
  FailedToOpenSocket: "unreachable", // Bun: could not open the socket
};

/**
 * Bun's single phrasing for every connect-level failure. Bun sets a `code` in
 * current releases, but older/compiled builds surface only this message, so we
 * match it as a fallback.
 */
const BUN_CONNECT_MESSAGE = /unable to connect\. is the computer able to access the url\?/i;

/**
 * Walk an error and its `cause` chain (undici's `TypeError: fetch failed` wraps
 * the real syscall error in `.cause`) and return the first known connection
 * code. Falls back to a message match for the macOS getaddrinfo phrasing that
 * some runtimes surface without a `.code`.
 */
function findConnectionCode(error: unknown): string | null {
  let e: any = error;
  const seen = new Set<unknown>();
  for (let depth = 0; e && typeof e === "object" && depth < 8 && !seen.has(e); depth++) {
    seen.add(e);
    if (typeof e.code === "string" && e.code in CODE_KIND) return e.code;
    e = e.cause;
  }
  const msg = String((error as any)?.message ?? error ?? "");
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|nodename nor servname/i.test(msg)) return "ENOTFOUND";
  if (BUN_CONNECT_MESSAGE.test(msg)) return "ConnectionRefused";
  return null;
}

/**
 * Classify a thrown fetch/connect error. Returns `null` when the error is NOT a
 * reach-the-host failure (the caller should rethrow and let normal HTTP-error
 * handling apply).
 */
export function classifyConnectionError(
  error: unknown
): { kind: ConnectionErrorKind; code: string } | null {
  const code = findConnectionCode(error);
  if (!code) return null;
  return { kind: CODE_KIND[code] ?? "unreachable", code };
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

/** True when the endpoint points at this machine (loopback / unspecified). */
function isLoopback(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i.test(hostname);
  } catch {
    return false;
  }
}

/** Build the user-facing, actionable message for a connection failure. */
export function buildConnectionErrorMessage(
  kind: ConnectionErrorKind,
  displayName: string,
  endpoint: string
): string {
  const host = hostOf(endpoint);
  switch (kind) {
    case "dns":
      return `Cannot resolve ${host} for ${displayName}. This is a DNS/network problem on your machine — check your internet connection, VPN, or DNS resolver (e.g. Tailscale MagicDNS) — not ${displayName}.`;
    case "refused":
      // "Refused" is only unambiguous for a local endpoint. Bun reports an
      // unresolvable REMOTE host as ConnectionRefused too, so "make sure the
      // server is running" would send the user to restart chatgpt.com. For a
      // remote host, give the DNS/network wording instead — that is the far
      // likelier cause, and the advice is right either way.
      if (isLoopback(endpoint)) {
        return `Cannot connect to ${displayName} at ${endpoint}. Make sure the server is running.`;
      }
      return `Cannot reach ${host} for ${displayName}. This is a network problem on your machine — check your internet connection, VPN, or DNS resolver (e.g. Tailscale MagicDNS) — not ${displayName}.`;
    case "unreachable":
      return `Cannot reach ${displayName} at ${endpoint}. Check your network connection.`;
    case "closed":
      // The host was reached and then dropped the connection — that points at
      // the provider or a proxy in between, not at the user's network.
      return `The connection to ${displayName} at ${endpoint} was closed before a response arrived. This is usually the provider or a proxy in between, not your network.`;
  }
}
