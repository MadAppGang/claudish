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

import { readBodyWithDeadline } from "../../providers/transport/quota-wall.js";

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

// ── #679 — z.ai plan request-concurrency refusal (429, code 1302) ─────────────

/**
 * The GLM Coding plan's REQUEST-concurrency limit, on the wire: HTTP 429 with
 * `error.code 1302`. Two measured wordings exist ("Rate limit reached for
 * requests", "rate limit (concurrency/RPM). Please try again later.") — the
 * CODE is the contract, so it is the only thing matched. The 5-hour usage
 * wall (1308) is a different code and a different contract: it stays
 * `isQuotaExhaustion`'s, and this predicate must never match it.
 *
 * Deliberately a `busy` skip, not a step failure (#679): the plan is shared
 * with the sonnet nominal, contention is normal operation, and the very next
 * request often fits — but the non-quota failure path benches the step for
 * `[10m…24h]` after a few episodes, exiling the fleet's free big-context tier
 * (measured: glm served ~6 % of haiku while accepting 283k-token prompts).
 * The in-stream variant (HTTP 200 + SSE error 1302) is NOT this predicate's
 * business: it keeps its patient backoff, and only its persistence surfaces.
 */
export function classifyConcurrencyRefusal(status: number, bodyText: string): boolean {
  if (status !== 429) return false;
  try {
    const code = (JSON.parse(bodyText) as any)?.error?.code;
    return code === "1302" || code === 1302;
  } catch {
    return false; // non-JSON body — the code cannot be read, never guess
  }
}

/** Skip detail for a concurrency refusal — the countable marker's payload. */
export const CONCURRENCY_REFUSAL_SKIP_DETAIL = "code=1302";

/** How long the 1302 check may spend reading a 429 body (see the call site). */
const CONCURRENCY_BODY_READ_MS = 300;

/**
 * Response-shaped wrapper for the transports' 429 ladders: a 1302 must give
 * up on the ladder IMMEDIATELY, exactly like `isQuotaWall` — but for the
 * opposite reason. A wall stays a wall however long you sleep; a concurrency
 * slot frees in seconds, and the ladder's `2s..30s` sleeps burn the client's
 * deadline against a SHARED plan that is simply busy right now (measured:
 * attempt 3 dies to the 30 s fetch abort and surfaces as a synthesized
 * connection 400, at which point the refusal's own body — the thing the
 * cascade needs to skip on — no longer exists). Clone-and-read, like
 * isQuotaWall: the caller still returns this Response, its body must stay
 * unconsumed.
 */
export async function isConcurrencyRefusalResponse(response: Response): Promise<boolean> {
  try {
    // Bounded read, same discipline as isQuotaWall: nothing else bounds this on
    // the OpenAI transport path (no AbortSignal there), and a body that simply
    // never arrives must degrade to the ladder — measured: an unbounded
    // clone().text() hung the transport suite's "body that never ARRIVES" pin.
    // Shorter than the wall check's 2s because that check has already spent its
    // budget on the same response; a 1302 body is a tiny JSON that rides the
    // headers, so 300ms is ample and the worst case stays under any client deadline.
    const body = await readBodyWithDeadline(response.clone(), CONCURRENCY_BODY_READ_MS);
    if (body === null) return false; // body did not arrive — retry as before, never guess
    return classifyConcurrencyRefusal(response.status, body);
  } catch {
    return false; // unreadable body — never guess, let the ladder retry as before
  }
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

// ── Step-eligibility marker, request-scoped (#679) ────────────────────────────

/**
 * "This attempt is a NON-LAST cascade step under live skip machinery" — set by
 * the loop at the same site as the busy budget, but as its own predicate: the
 * budget is cleared by `CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS=0` (an operator
 * tuning the LIMITER wait), and that must not silently restore the ~5-minute
 * patient backoff for a concurrency-refused step (#679 — the step's whole job
 * is to yield in seconds so the successor serves).
 *
 * Distinct from the budget on purpose: `cascadeStepBusyWaitMs` answers "how
 * long may the limiter hold this attempt", this answers "may the skip wires
 * treat this attempt as a step". Nominal, last-step, keyless and non-cascade
 * attempts are never eligible — their overload patience is the designed
 * behavior and stays exactly as it is.
 */
const stepSkipEligibleContexts = new WeakSet<object>();

export function markStepSkipEligible(c: object, on: boolean): void {
  if (on) stepSkipEligibleContexts.add(c);
  else stepSkipEligibleContexts.delete(c);
}

export function isStepSkipEligible(c: object): boolean {
  return stepSkipEligibleContexts.has(c);
}
