/**
 * #317 (option B, arbitrated by ai-01 2026-10-11) — a per-session ceiling on
 * UPSTREAM output tokens, counted across every cascade step the request pays.
 *
 * The 27/09 swarm measured the gap: 2,274 subagents on one interactive session
 * → 43,479 requests / ~3.0 B tokens, zero throttle. Subagents SHARE the
 * parent's `session_id` (measured 2026-10-12 on the same corpus, positive
 * control session bc377615: 5 parent turns + 230 subagent reqs, same sid), so
 * the key `(X-Claudish-Machine, session_id)` — the same seam as the #91 dwell
 * — sees a whole swarm as ONE counter. No subagent detection is needed for the
 * ceiling itself; the counter aggregates parent + children by construction,
 * which is the point: it is the session's total cost.
 *
 * Unit = output tokens, not $: prices drift across PAYG / weekly pools / 5h
 * windows and the lanes share no denominator, while the token is the quantity
 * every seam already counts. Counting is UPSTREAM (each cascade attempt's
 * reported usage, including attempts that later fail — their tokens were paid)
 * on purpose: a 3-step cascade is one client response but three paid usages.
 *
 * Two bars on the same instrument, each INERT without its env knob (the
 * fleet-wide deployment pose is WARN-only until the user fixes the values):
 * - `CLAUDISH_SESSION_BUDGET_CEILING` — refusal bar, in output tokens. At the
 *   bar the request is answered locally with a labeled 429 + `retry-after` =
 *   the real remaining window, BEFORE any upstream is paid. The body wording
 *   is load-bearing: it must never contain a quota-class word ("quota",
 *   "credit", "balance", "weekly", "usage limit", "plan limit", "exhaust",
 *   "exceed your account") or `isQuotaExhaustion` would arm the budget
 *   failover off our own ceiling — pinned against the real predicate (pin 1).
 * - `CLAUDISH_SESSION_BUDGET_WARN` — WARN bar, in output tokens. At the bar a
 *   `[SessionBudgetCeiling] WARN` marker (forceConsole) fires once per
 *   crossing. When only the ceiling is armed, the WARN bar defaults to 80% of
 *   it (design: "WARN à 80 %, refus à 100 %").
 *
 * Sliding window: each usage report is a timestamped event; the consumed total
 * only counts events younger than SESSION_BUDGET_WINDOW_MS (24 h). Live
 * streams report into an in-flight slot (max of reported values — usage only
 * grows within one attempt) sealed into the event list once the attempt has
 * reported nothing for ATTEMPT_SETTLE_MS; a late report adjusts the sealed
 * event instead of double-counting. Entry TTL slides on activity, like the
 * dwell. All state is in-memory: a restart clears it, which is fine — the
 * window is shorter than any plausible hub uptime.
 */
import { log } from "../logger.js";
import { wrapAnthropicError } from "../handlers/shared/anthropic-error.js";

export const SESSION_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A stream that reported nothing for this long is done or dead — seal it. */
export const ATTEMPT_SETTLE_MS = 15 * 60 * 1000;
/** Hard cap on tracked sessions; over it, idle entries are swept eagerly. */
const MAX_TRACKED_SESSIONS = 8192;

export interface SessionBudgetEvent {
  ts: number;
  tokens: number;
}

interface InFlight {
  max: number;
  lastTouch: number;
}

interface SessionBudgetEntry {
  /** Sealed usage events, oldest first (pushed in time order). */
  events: SessionBudgetEvent[];
  /** Live attempts (one per in-flight cascade attempt) keyed by opaque token. */
  inFlight: Map<object, InFlight>;
  /** The sealed event of an attempt that settled, so late reports adjust it. */
  sealed: Map<object, SessionBudgetEvent>;
  lastActivity: number;
  /** WARN latch: set when the marker fired, reset when the total drops back under the bar. */
  warned: boolean;
}

const entries = new Map<string, SessionBudgetEntry>();

/** Opaque per-attempt token attached to the request's raw object. */
interface AttemptToken {
  key: string;
}

/**
 * raw request → the CURRENT attempt's token, replaced before every cascade
 * attempt: two paid attempts of one request must never share a slot, or the
 * max-per-attempt ledger would under-count them (attempt 1's 100 tokens would
 * mask attempt 2's 50). WeakMap: no leak from finished requests.
 */
const attempts = new WeakMap<object, AttemptToken>();

/** Clock seam so tests can slide the window without sleeping. */
let nowMs: () => number = () => Date.now();

export function setSessionBudgetClockForTests(fn?: () => number): void {
  nowMs = fn ?? (() => Date.now());
}

export function resetSessionBudgetForTests(): void {
  entries.clear();
}

/**
 * Bars are read as DIRECT `env.CLAUDISH_*` property accesses (not a helper
 * keyed by name string) so compose-env-coverage.test.ts's scanner sees them —
 * a name the scanner cannot see is a name the compose allowlist stops
 * enforcing (#304/#310).
 */
function readBarValue(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function sessionBudgetKey(machine: string | null, sessionKey: string | null): string | null {
  if (!sessionKey) return null; // no stable id → the instrument is blind for this request
  return `${machine ?? "(none)"}|${sessionKey}`;
}

function getOrCreateEntry(key: string, now: number): SessionBudgetEntry {
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= MAX_TRACKED_SESSIONS) sweepIdleEntries(now);
    entry = { events: [], inFlight: new Map(), sealed: new Map(), lastActivity: now, warned: false };
    entries.set(key, entry);
  }
  return entry;
}

function sweepIdleEntries(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.lastActivity < now - SESSION_BUDGET_WINDOW_MS) entries.delete(key);
  }
}

/** Drop expired events, seal stale attempts — the consumed total is correct
 *  after this pass (in-flight maxima are counted alongside sealed events). */
function maintainEntry(entry: SessionBudgetEntry, now: number): void {
  while (entry.events.length > 0 && entry.events[0].ts < now - SESSION_BUDGET_WINDOW_MS) {
    entry.events.shift();
  }
  for (const [token, slot] of entry.inFlight) {
    if (slot.lastTouch < now - ATTEMPT_SETTLE_MS) {
      const ev: SessionBudgetEvent = { ts: slot.lastTouch, tokens: slot.max };
      entry.events.push(ev);
      entry.sealed.set(token, ev);
      entry.inFlight.delete(token);
    }
  }
}

function consumedOf(entry: SessionBudgetEntry): number {
  let total = 0;
  for (const ev of entry.events) total += ev.tokens;
  for (const slot of entry.inFlight.values()) total += slot.max;
  return total;
}

/** Test/ops seam: the live consumed total for a (machine, session) pair. */
export function sessionBudgetConsumed(machine: string | null, sessionKey: string): number {
  const key = sessionBudgetKey(machine, sessionKey);
  if (!key) return 0;
  const entry = entries.get(key);
  if (!entry) return 0;
  maintainEntry(entry, nowMs());
  return consumedOf(entry);
}

export interface SessionBudgetAdmission {
  refused: boolean;
  /** Seconds until the window's oldest contributing events expire enough to
   *  bring the total back under the ceiling. 0 when not refused. */
  retryAfterSec: number;
  consumed: number;
  ceiling: number;
  warnAt: number;
  /** Ready-to-render refusal message (quota-class-word free — pin 1). */
  message: string;
}

/**
 * Request admission. Call ONCE per request, BEFORE any handler resolution
 * (a refused request pays nothing and writes no failover state — not even the
 * dwell pin a getHandlerForRequest call would write). Returns null when the
 * instrument is inert (no bar armed, or no session key) — the caller serves on.
 */
export function admitSessionBudget(
  machine: string | null,
  sessionKey: string | null,
  env: NodeJS.ProcessEnv
): SessionBudgetAdmission | null {
  const ceiling = readBarValue(env.CLAUDISH_SESSION_BUDGET_CEILING);
  const warnBar = readBarValue(env.CLAUDISH_SESSION_BUDGET_WARN);
  // Design: WARN at 80% of the ceiling when only the ceiling is armed; when
  // both are armed the explicit WARN bar wins if it is the lower one.
  const warnAt =
    warnBar > 0
      ? ceiling > 0
        ? Math.min(warnBar, Math.floor(ceiling * 0.8))
        : warnBar
      : ceiling > 0
        ? Math.floor(ceiling * 0.8)
        : 0;
  if (ceiling <= 0 && warnAt <= 0) return null; // inert: both bars off → byte-identical path
  if (!sessionKey) return null; // armed but no stable session id → blind for this request

  const key = sessionBudgetKey(machine, sessionKey);
  if (!key) return null;

  const now = nowMs();
  const entry = getOrCreateEntry(key, now);
  entry.lastActivity = now; // entry TTL slides on activity (#91 dwell semantics)
  maintainEntry(entry, now);
  const consumed = consumedOf(entry);

  const admission: SessionBudgetAdmission = {
    refused: false,
    retryAfterSec: 0,
    consumed,
    ceiling,
    warnAt,
    message: "",
  };

  // WARN bar — one marker per crossing, reset when the window slides back under.
  if (warnAt > 0) {
    if (consumed >= warnAt && !entry.warned) {
      entry.warned = true;
      log(
        `[SessionBudgetCeiling] WARN machine=${machine ?? "(none)"} session=…${sessionKey.slice(-8)} ` +
          `consumed ${consumed} output tokens in a 24h window (bar ${warnAt}` +
          (ceiling > 0 ? `, ceiling ${ceiling}` : "") + `)`,
        true
      );
    } else if (consumed < warnAt) {
      entry.warned = false;
    }
  }

  if (ceiling > 0 && consumed >= ceiling) {
    admission.refused = true;
    admission.retryAfterSec = remainingWindowSec(entry, consumed, ceiling, now);
    admission.message =
      `[SessionBudgetCeiling] session …${sessionKey.slice(-8)} consumed ${consumed} output tokens ` +
      `in a 24h sliding window (ceiling ${ceiling}) — retry after ${admission.retryAfterSec}s`;
    log(
      `[SessionBudgetCeiling] REFUSE machine=${machine ?? "(none)"} session=…${sessionKey.slice(-8)} ` +
        `consumed ${consumed} >= ${ceiling} (retry-after ${admission.retryAfterSec}s)`,
      true
    );
  }
  return admission;
}

/**
 * How long until enough of the oldest events expire for the total to drop
 * under the ceiling. Events expire when they leave the 24h window, so the
 * answer is the window remaining on the newest event of the MINIMAL oldest
 * prefix whose removal brings the total under the bar.
 */
function remainingWindowSec(
  entry: SessionBudgetEntry,
  consumed: number,
  ceiling: number,
  now: number
): number {
  const events = entry.events; // oldest first
  let prefix = 0;
  let horizonTs = 0;
  for (const ev of events) {
    prefix += ev.tokens;
    horizonTs = ev.ts;
    if (consumed - prefix < ceiling) break;
  }
  if (horizonTs <= 0) return 60; // nothing sealed (all in-flight): nominal short retry
  const ms = SESSION_BUDGET_WINDOW_MS - (now - horizonTs);
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Attach a FRESH attempt token to the request's raw object — called before
 * EVERY upstream attempt (cascade loop), so two paid attempts of one request
 * never share a slot: the max-per-attempt ledger would under-count them.
 * No-op (zero allocation) when the instrument is inert.
 */
export function openSessionBudgetAttempt(
  raw: object | undefined,
  machine: string | null,
  sessionKey: string | null,
  env: NodeJS.ProcessEnv
): void {
  if (!raw) return;
  const ceiling = readBarValue(env.CLAUDISH_SESSION_BUDGET_CEILING);
  const warnBar = readBarValue(env.CLAUDISH_SESSION_BUDGET_WARN);
  if (ceiling <= 0 && warnBar <= 0) return; // inert
  const key = sessionBudgetKey(machine, sessionKey);
  if (!key) return;
  attempts.set(raw, { key });
}

/**
 * Usage sink — called by the handlers whenever an upstream reports output
 * tokens (streaming parsers' terminal usage, native passthrough taps). Takes
 * the MAX per attempt: usage only grows within one attempt, and parsers may
 * report a zero block first (wire-openai). Never throws — a missed count is
 * cheaper than a broken stream.
 */
export function recordSessionBudgetOutput(raw: object | undefined, outputTokens: number): void {
  try {
    if (!raw || !Number.isFinite(outputTokens) || outputTokens <= 0) return;
    const token = attempts.get(raw);
    if (!token) return; // inert request, or an attempt that was never opened
    const now = nowMs();
    const entry = getOrCreateEntry(token.key, now);
    entry.lastActivity = now;
    const slot = entry.inFlight.get(token);
    if (slot) {
      if (outputTokens > slot.max) slot.max = outputTokens;
      slot.lastTouch = now;
      return;
    }
    const sealed = entry.sealed.get(token);
    if (sealed) {
      // Late report after a lazy seal: adjust the sealed event, never a second one.
      if (outputTokens > sealed.tokens) sealed.tokens = outputTokens;
      sealed.ts = now;
      return;
    }
    entry.inFlight.set(token, { max: outputTokens, lastTouch: now });
  } catch {
    // never throw from a sink
  }
}

/** The /v1/messages refusal response (Anthropic error envelope + retry-after). */
export function sessionBudgetRefusalAnthropic(admission: SessionBudgetAdmission): Response {
  const body = wrapAnthropicError(429, admission.message);
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "retry-after": String(admission.retryAfterSec),
    },
  });
}
