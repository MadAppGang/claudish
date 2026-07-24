/**
 * Connection-error classification.
 *
 * Distinguishes a LOCAL network failure (DNS can't resolve, connection refused,
 * host unreachable) from an upstream HTTP error. When claudish's proxy can't
 * even REACH the provider, that's the user's machine/network — reporting it as a
 * generic 500 sends people hunting for a claudish or provider bug. (A Tailscale
 * MagicDNS outage making chatgpt.com unresolvable, which broke the Codex CLI,
 * the desktop app, and claudish identically, is what motivated this.) Tagging
 * these as connection errors lets both Claude Code and the config probe show an
 * honest "can't reach host — check your network/DNS" instead.
 */

export type ConnectionErrorKind = "dns" | "refused" | "unreachable";

/** Node/undici syscall codes we treat as a failure to REACH the host. */
const CODE_KIND: Record<string, ConnectionErrorKind> = {
  ENOTFOUND: "dns", // getaddrinfo: host not found
  EAI_AGAIN: "dns", // getaddrinfo: temporary DNS failure
  ECONNREFUSED: "refused", // nothing listening at the endpoint
  ETIMEDOUT: "unreachable", // connect timed out
  ECONNRESET: "unreachable", // connection reset before response
  ENETUNREACH: "unreachable", // network unreachable
  EHOSTUNREACH: "unreachable", // host unreachable
  EPIPE: "unreachable", // broken pipe during connect
  UND_ERR_CONNECT_TIMEOUT: "unreachable", // undici connect timeout
  UND_ERR_SOCKET: "unreachable", // undici socket closed
};

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
      return `Cannot connect to ${displayName} at ${endpoint}. Make sure the server is running.`;
    case "unreachable":
      return `Cannot reach ${displayName} at ${endpoint}. Check your network connection.`;
  }
}
