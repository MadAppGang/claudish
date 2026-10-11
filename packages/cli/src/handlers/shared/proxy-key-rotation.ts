/**
 * Previous-key hit tracking during a proxy-key rotation window (#439).
 *
 * `CLAUDISH_PROXY_KEY_PREVIOUS` (be940b2d) keeps a retiring key accepted so
 * seats can be repointed one at a time — but nothing recorded WHICH key
 * authenticated a request, so closing the window (unset + recreate) was a
 * blind cut: every missed holder of the old key learned it by 401.
 *
 * This module counts, per bucket, the requests authenticated by the PREVIOUS
 * key. A bucket is the `X-Claudish-Machine` header when present, else the
 * User-Agent product token — never an IP, never a key-derived value (the
 * bucket string reaches /health and the docker log; both are readable by
 * anyone with hub access, and a bucket must not become a key oracle).
 *
 * Deliberately a leaf module (same rule as proxy-keys.ts): needed by the fork
 * middleware, NativeHandler and proxy-server's count_tokens swap, and the
 * fork layer imports core — never the reverse.
 *
 * State is in-memory: a restart resets the counters. The rate-limited
 * forceConsole marker is what survives a restart in `docker logs`.
 */

import { logStderr } from "../../logger.js";

/** At most one marker per bucket per hour — the log must count, not echo. */
const MARKER_INTERVAL_MS = 60 * 60 * 1000;

/** Buckets reach /health JSON keys and log lines: keep them inert strings. */
const BUCKET_SAFE = /^[A-Za-z0-9._-]{1,32}$/;

interface BucketHit {
  count: number;
  lastAt: number;
  lastMarkerAt: number;
}

let previousKey: string | null = null;
let buckets: Map<string, BucketHit> | null = null;

/**
 * Requests already counted, keyed by the raw Request object (same identity
 * from the fork middleware to the handler — Hono threads one Context, one
 * `c.req.raw`, through `next()`). One authentication, one count: the
 * middleware marks what it counted and both native swap sites skip a marked
 * request instead of counting the same authentication twice.
 */
const countedRequests = new WeakSet<object>();

/**
 * Activate (or deactivate) tracking. Called once at proxy startup, right
 * where `resolveProxyKeys()` runs. An empty/unset previous key leaves the
 * tracker inert — /health then omits the fields entirely, which is itself
 * the readable signal "no rotation window open".
 */
export function initProxyKeyRotationTracking(previous: string | undefined): void {
  previousKey = previous && previous.length > 0 ? previous : null;
  buckets = previousKey ? new Map() : null;
}

/**
 * Bucket for a hit: the machine header when the client sends one (fleet
 * seats do), else the User-Agent product token (`claude-cli/2.1.293` →
 * `claude-cli`, `AsyncOpenAI/Python 3.24.0` → `AsyncOpenAI`). Anything that
 * is not a short inert token collapses to `unknown` — a hostile UA must not
 * smuggle control characters into a JSON key or a log line.
 */
export function proxyKeyAuthBucket(headers: Record<string, string | undefined>): string {
  const machine = headers["x-claudish-machine"];
  if (machine && BUCKET_SAFE.test(machine)) return machine;
  const ua = headers["user-agent"];
  if (ua) {
    const token = ua.split("/")[0].trim();
    if (BUCKET_SAFE.test(token)) return token;
  }
  return "unknown";
}

/**
 * Record an authentication event. No-op unless a rotation window is open AND
 * the provided credential is exactly the retiring key — primary-key hits and
 * keyless traffic stay invisible on every surface (a rotation instrument
 * that counts everything measures nothing).
 *
 * Called at every site that ACCEPTS a proxy key: the fork auth middleware
 * (BOTH branches — the native exemption branch decides the keyless mark
 * through `matchesProxyKey` on this very key, and a bare `claude-*` remapped
 * by modelMap to a remote lane never reaches any swap site, so the
 * middleware is the ONLY site that can count it) and the two native
 * proxyKey→Anthropic swaps (/v1/messages in NativeHandler, count_tokens in
 * proxy-server). A request can now cross several of those sites, so callers
 * that hold the raw request pass it: a request already counted (marked) is
 * skipped — one authentication, one count.
 */
export function noteProxyKeyAuthentication(
  provided: string | undefined,
  headers: Record<string, string | undefined>,
  raw?: object
): void {
  if (!previousKey || !buckets || provided === undefined || provided !== previousKey) return;
  if (raw !== undefined) {
    if (countedRequests.has(raw)) return;
    countedRequests.add(raw);
  }
  const bucket = proxyKeyAuthBucket(headers);
  const now = Date.now();
  const hit = buckets.get(bucket) ?? { count: 0, lastAt: now, lastMarkerAt: 0 };
  hit.count += 1;
  hit.lastAt = now;
  buckets.set(bucket, hit);
  if (now - hit.lastMarkerAt >= MARKER_INTERVAL_MS) {
    hit.lastMarkerAt = now;
    logStderr(`[ProxyKey] previous key used by ${bucket} (n=${hit.count})`);
  }
}

/**
 * /health snapshot, or null when no rotation window is open (field omitted).
 * Counts and ISO timestamps only — no key material, no fingerprint, no IP.
 */
export function previousKeyHitsSnapshot(): {
  proxyKeyPreviousHits: Record<string, number>;
  proxyKeyPreviousLastAt: Record<string, string>;
} | null {
  if (!previousKey || !buckets) return null;
  const proxyKeyPreviousHits: Record<string, number> = {};
  const proxyKeyPreviousLastAt: Record<string, string> = {};
  for (const [bucket, hit] of buckets) {
    proxyKeyPreviousHits[bucket] = hit.count;
    proxyKeyPreviousLastAt[bucket] = new Date(hit.lastAt).toISOString();
  }
  return { proxyKeyPreviousHits, proxyKeyPreviousLastAt };
}
