/**
 * Abort a Responses leg that produces no output item for too long.
 *
 * ── THE FAILURE ──────────────────────────────────────────────────────────────
 *
 * About 1% of ChatGPT Codex turns stall: the backend sends `response.created`
 * and keepalives only, for 361-484 s, and then the degenerate `parallel`
 * wrapper arrives in one burst (see parallel-wrapper.ts). claudish's own 1 s
 * pings keep Claude Code waiting the whole time, and `API_TIMEOUT_MS` does not
 * bound a flushed, pinging stream (the leak ran 472 s). The guard turns that
 * wait into a retry of the same body (`responses-turn.ts`).
 *
 * ── THE DATA (all `openai-codex`, ChatGPT backend) ───────────────────────────
 *
 *   | sample                                 | n     | headers → first output item   |
 *   |----------------------------------------|-------|-------------------------------|
 *   | real sessions, 19 debug logs           | 8,239 | p50 1.2 s, p90 3.6 s,         |
 *   |   2026-07-15 .. 2026-10-16             |       | p99 8.5 s, p99.9 28.3 s,      |
 *   |                                        |       | healthy max 61.7 s            |
 *   | B experiment, healthy legs             | 297   | max 7.38 s (from created)     |
 *   | leaks (B experiment + the leak log)    | 4     | 361 s, 456 s, 484.5 s, >150 s |
 *
 * In the 61.7 s legs `response.created` arrived together with the first item
 * (the backend holds the head), so the clock starts at the RESPONSE HEADERS,
 * never at `response.created`. It is armed where the leg's fetch resolved, so
 * the 7b sniff window (up to 12 s) counts against it rather than adding to it.
 *
 * ── THE THRESHOLDS ───────────────────────────────────────────────────────────
 *
 * Attempts 1..n-1: 150 s, 2.4x the healthy max and 2.4x below the fastest
 * leak. Final attempt: 300 s (2x), 4.9x the healthy max and still below the
 * fastest leak, so the last attempt keeps room for an unusually long reasoning
 * phase without waiting out a whole leak. No attempt is unbounded. Not derived
 * from `API_TIMEOUT_MS`, which does not bound a pinging stream.
 *
 * ── THE SCOPE ────────────────────────────────────────────────────────────────
 *
 * The data is from the ChatGPT Codex backend only, so the default scope is
 * exactly that: claudish provider `openai-codex` on the OAuth (subscription)
 * arm. Native `openai@`, the `openai-codex` api-key arm and custom `responses`
 * endpoints are unarmed unless `CLAUDISH_RESPONSES_STALL_MS` is set: a value
 * > 0 arms it everywhere with that threshold (final attempt 2x), `0` disarms it
 * everywhere.
 */

import { log } from "../../../../logger.js";

/** Default threshold for attempts 1..n-1. */
export const DEFAULT_STALL_THRESHOLD_MS = 150_000;

/** Armed: a threshold per attempt, the last attempt's longer. Unarmed: `thresholdMs: 0`. */
export type StallPolicy = { thresholdMs: number; finalThresholdMs: number } | { thresholdMs: 0 };

export const STALL_ENV_VAR = "CLAUDISH_RESPONSES_STALL_MS";

/**
 * The stall policy for one request's connection. `arm` is the credential arm
 * of THIS request (`"oauth"` for the subscription).
 */
export function resolveStallPolicy(i: {
  env?: Record<string, string | undefined>;
  providerName: string;
  arm?: string;
}): StallPolicy {
  const raw = i.env?.[STALL_ENV_VAR];
  if (raw !== undefined && raw.trim() !== "") {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms >= 0) {
      return ms > 0 ? { thresholdMs: ms, finalThresholdMs: 2 * ms } : { thresholdMs: 0 };
    }
    log(`[ResponsesTurn] ignoring ${STALL_ENV_VAR}=${raw}: not a non-negative number`);
  }
  if (i.providerName === "openai-codex" && i.arm === "oauth") {
    return {
      thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
      finalThresholdMs: 2 * DEFAULT_STALL_THRESHOLD_MS,
    };
  }
  return { thresholdMs: 0 };
}

/** The clock a guard runs on. Tests inject a fake one. */
export interface StallClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemStallClock: StallClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Is this Responses event output-bearing? The first one disarms the guard:
 * `output_item.added` of any type, or any `*.delta`. `response.created`,
 * `in_progress`, keepalives and metadata do not count.
 */
export function isOutputBearingEvent(type: unknown): boolean {
  return (
    typeof type === "string" && (type === "response.output_item.added" || type.endsWith(".delta"))
  );
}

/**
 * One leg's guard: fires `onFire(afterMs)` once, `thresholdMs` after
 * `headersAt`, unless `disarm()` ran first.
 */
export class StallGuard {
  private handle: unknown;
  private done = false;

  constructor(
    thresholdMs: number,
    private readonly headersAt: number,
    private readonly onFire: (afterMs: number) => void,
    private readonly clock: StallClock = systemStallClock
  ) {
    if (thresholdMs <= 0) {
      this.done = true;
      return;
    }
    const remaining = Math.max(0, headersAt + thresholdMs - clock.now());
    this.handle = clock.setTimeout(() => this.fire(), remaining);
  }

  get armed(): boolean {
    return !this.done;
  }

  disarm(): void {
    if (this.done) return;
    this.done = true;
    this.clock.clearTimeout(this.handle);
  }

  private fire(): void {
    if (this.done) return;
    this.done = true;
    this.onFire(this.clock.now() - this.headersAt);
  }
}
