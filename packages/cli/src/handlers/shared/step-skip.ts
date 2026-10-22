/**
 * Step-skip signal — #431: how a cascade step says "I cannot take THIS request".
 *
 * Two measured shapes, one wire: a vLLM-style endpoint REFUSES a prompt whose
 * `prompt + max_tokens` exceeds `--max-model-len` (measured on the Swift lane,
 * v0.31: HTTP 400 "maximum context length", never trims), and a saturated
 * `ConcurrencyLimiter` holds the turn in an unbounded FIFO before any fetch —
 * the first-event watchdog never sees it. Both used to surface as the client's
 * answer: the overflow as a recovery turn (the compaction notice read as the
 * model's own words), the busy wait as a hang.
 *
 * The signal is a response header, `x-claudish-step-skip`, set by
 * ComposedHandler on exactly those three responses:
 *   - `context` on the overflow recovery turn (classified from upstream OR
 *     short-circuited by the learned cap), with `est=`/`cap=` detail for the
 *     countable marker;
 *   - `busy` on the bounded 529 the handler answers when the step attempt's
 *     concurrency wait expires, with `wait=`/`label=` detail;
 *   - `media` on the engine's per-prompt image cap (#575 — vLLM refuses "At
 *     most N image(s)"), with `images=`/`cap=`/`param=` detail. The status
 *     stays 400: nothing about the prompt's SIZE is wrong, so the #79
 *     recoverable turn (whose whole job is to advance the context gauge)
 *     would be a false signal — but the step is healthy and must advance.
 *
 * Only `handleWithCascade` ACTS on it, and only for a non-last cascade step
 * with a successor: advance (skip), no failure mark, no dwell pin on the
 * skipped step. Everywhere else — nominal, last step, non-cascade path,
 * keyless — the response surfaces unchanged, header and all (same doctrine as
 * `x-claudish-failover-notice`, #229: a namespaced diagnostic header is
 * harmless to a client that ignores it, and greppable for one that looks).
 */

export const STEP_SKIP_HEADER = "x-claudish-step-skip";

export type StepSkipReason = "context" | "busy" | "media";

/** Every reason the loop will act on. A producer adding one must extend this
 *  AND `readStepSkip` together — a header the reader drops is a silent no-op. */
const STEP_SKIP_REASONS: readonly StepSkipReason[] = ["context", "busy", "media"];

export interface StepSkipInfo {
  reason: StepSkipReason;
  /** Free-form `key=value` tokens for the marker, e.g. `est=280123; cap=262144`. */
  detail?: string;
}

export function encodeStepSkipHeader(reason: StepSkipReason, detail?: string): string {
  return detail ? `${reason}; ${detail}` : reason;
}

/**
 * Parse-tolerant reader. Unknown reasons read as null (the loop never acts on
 * a value it does not understand — a future producer adding a reason must
 * extend the reason union AND the loop's handling together).
 */
export function readStepSkip(response: Response): StepSkipInfo | null {
  let raw: string | null = null;
  try {
    raw = response.headers.get(STEP_SKIP_HEADER);
  } catch {
    return null; // exotic Response — never act on what cannot be read
  }
  if (!raw) return null;
  const semi = raw.indexOf(";");
  const reason = (semi === -1 ? raw : raw.slice(0, semi)).trim();
  // Membership in ONE list: a reason added to the union but not here reads as
  // null and the loop silently ignores its header — the failure mode this
  // constant exists to make impossible to write twice, in two spellings.
  if (!STEP_SKIP_REASONS.includes(reason as StepSkipReason)) return null;
  const detail = semi === -1 ? undefined : raw.slice(semi + 1).trim() || undefined;
  return { reason: reason as StepSkipReason, detail };
}

// ── Kill switch + busy-wait knob (both re-read per request) ────────────────────

/** `CLAUDISH_FAILOVER_STEP_SKIP=0` restores today's behavior for the whole
 * feature: no skip-advance, no bounded busy wait (the loop stops marking step
 * attempts, so the limiter keeps its unbounded FIFO). Only an explicit "0"
 * disarms — the same convention as every house kill switch. */
export function stepSkipDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDISH_FAILOVER_STEP_SKIP || "").trim() === "0";
}

export const STEP_BUSY_WAIT_DEFAULT_MS = 2_000;

/**
 * `CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS` — how long a CASCADE STEP attempt
 * waits for a concurrency slot before skipping forward (#431 AC3: "a few
 * seconds at most"). `0` disables the bound (unbounded FIFO, today's
 * behavior). Applies only to attempts the loop marked as cascade steps; the
 * nominal path never reads it.
 */
export function readStepBusyWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  // CR minor: STRICT integer parse. `Number.parseInt("2s")` is 2 — two
  // MILLISECONDS, not two seconds — so a unit-suffixed value silently armed a
  // bound tighter than any real queue wait, and every marked attempt skipped.
  // Reject anything that is not all digits, then clamp: an operator typing
  // 300000 (minutes-as-milliseconds) should not get a five-minute client stall.
  const raw = (env.CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS || "").trim();
  if (!/^\d+$/.test(raw)) return STEP_BUSY_WAIT_DEFAULT_MS;
  return Math.min(Number.parseInt(raw, 10), 60_000);
}

// ── Per-attempt busy budget, request-scoped ────────────────────────────────────

/**
 * The busy bound is REQUEST-scoped, not transport-scoped: the same cached
 * handler serves nominal and step attempts, and AC3 pins "the nominal path
 * keeps its current behavior" — an unbounded FIFO wait. So the cascade loop
 * marks the Hono Context of a step attempt with the budget it wants, and
 * ComposedHandler reads it at its `enqueueRequest` call. A WeakMap keyed by
 * the context object: no leak across requests, no Hono Env typing, and an
 * unmarked context (nominal, walk, non-cascade, tests) reads undefined —
 * which the transports treat as "no bound".
 */
const busyBudgets = new WeakMap<object, number>();

export function markCascadeStepAttempt(c: object, busyWaitMs: number): void {
  if (busyWaitMs > 0) busyBudgets.set(c, busyWaitMs);
  else busyBudgets.delete(c); // 0 = off — make the absence explicit
}

export function cascadeStepBusyWaitMs(c: object): number | undefined {
  return busyBudgets.get(c);
}
