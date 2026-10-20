/**
 * The Antigravity client version claudish presents, as captured from the
 * installed `agy` CLI.
 *
 * The Antigravity backend gates BOTH discovery and generation on the version in
 * the User-Agent (`antigravity/cli/<version>`). Measured 2026-10-14, same
 * token, project and host, only the version varying: at 1.1.9
 * `fetchAvailableModels` omits `gemini-4-argon-*` and
 * `gemini-3.8-flash-{high,medium,low}`, and generating with
 * `gemini-4-argon-low` answers 404; at 1.3.5 they are listed and generation
 * answers 200. agy auto-updates, so the only version that cannot drift is the
 * one read from agy itself — `antigravity-token.ts` reads it once per auth
 * session (once per access token) and records it here; `antigravity-user.ts`
 * reads it when it builds the User-Agent and when it decides whether its
 * served-models cache is still valid.
 *
 * A leaf module with no imports, so the writer and the reader depend on it
 * rather than on each other.
 */

/** The last good version, and the access token the last read was made for. */
let version: string | null = null;
let readForToken: string | null = null;

/** The version read from `agy --version`, or null when no read has ever succeeded. */
export function getAgyClientVersion(): string | null {
  return version;
}

/** True when a read was already made for this access token (successful or not). */
export function agyClientVersionReadFor(accessToken: string): boolean {
  return readForToken === accessToken;
}

/**
 * Record one read for one access token. A failed read (`null`) keeps the
 * previous good version — a transient agy failure must not demote a session
 * from the version agy last reported to the fallback floor — but still marks
 * the token as read, so the failure is not retried on every request.
 *
 * Returns true when the version in use changed.
 */
export function recordAgyClientVersionRead(read: string | null, accessToken: string): boolean {
  readForToken = accessToken;
  if (read === null || read === version) return false;
  version = read;
  return true;
}

/** Test seam: forget the captured version and the token it was read for. */
export function _resetAgyClientVersion(): void {
  version = null;
  readForToken = null;
}
