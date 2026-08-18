/**
 * Durable capture of upstream error bodies.
 *
 * A non-ok upstream response short-circuits before the stream parser, so
 * `response-capture` never sees it. The body is read once in ComposedHandler,
 * handed to the classifier, and then dropped:
 *
 *     const errorText = await response.text();
 *     log(`[${this.provider.displayName}] Error: ${errorText}`);
 *
 * `log()` persists nothing unless `--debug` set a log file, so on a normal run
 * that body is gone the instant it has been classified. That is the one piece
 * of evidence that distinguishes a rate limit you should retry from a hard
 * quota wall you should not, and by the time anyone wants to look at it there
 * is nothing to look at.
 *
 * Reported by @jsboige in #184, from a real incident: a GLM coding-plan 5h cap
 * saturated, the shape was reconstructable from request counts, and the literal
 * 429 body was unrecoverable.
 *
 * Opt-in, because this writes provider error text — which can carry account
 * identifiers — to a path the user names. Off by default, no directory is ever
 * created, and nothing here can throw into the request path.
 */

import { appendFileSync } from "node:fs";

/** Env var naming the capture file. Unset = feature off. */
export const UPSTREAM_ERROR_LOG_ENV = "CLAUDISH_UPSTREAM_ERROR_LOG";

/**
 * Bytes of upstream body kept per record.
 *
 * An error body is normally a short JSON object, but a misconfigured gateway
 * can return a full HTML page, and this file is appended to on every failure.
 * 2KB keeps the useful head of any real error while bounding a pathological
 * one. Truncation is marked so a reader never mistakes a cut body for the
 * whole of it.
 */
export const MAX_CAPTURED_BODY_BYTES = 2048;

export interface UpstreamErrorRecord {
  provider: string;
  model: string;
  status: number;
  body: string;
  /** ISO timestamp; injectable so tests need no clock control. */
  at?: string;
}

/**
 * Append one JSON line describing a failed upstream response.
 *
 * Returns true when a record was written, false when the feature is off or the
 * write failed. The boolean is for tests and callers that want to log their own
 * diagnostic — nothing in the request path should branch on it.
 *
 * NEVER THROWS. A capture facility that can break a request is worse than no
 * capture facility, and this runs on the error path, where the process is
 * already handling something going wrong.
 */
export function captureUpstreamError(record: UpstreamErrorRecord): boolean {
  const path = process.env[UPSTREAM_ERROR_LOG_ENV];
  if (!path) return false;

  try {
    const raw = record.body ?? "";
    const truncated = raw.length > MAX_CAPTURED_BODY_BYTES;
    const line = JSON.stringify({
      at: record.at ?? new Date().toISOString(),
      provider: record.provider,
      model: record.model,
      status: record.status,
      body: truncated ? raw.slice(0, MAX_CAPTURED_BODY_BYTES) : raw,
      // Present only when it happened, so a reader who does not see the key can
      // trust the body is complete.
      ...(truncated ? { truncated: true, original_bytes: raw.length } : {}),
    });
    appendFileSync(path, `${line}\n`);
    return true;
  } catch {
    // Unwritable path, full disk, permissions — all of which mean the user does
    // not get their capture, and none of which mean the request should fail.
    return false;
  }
}
