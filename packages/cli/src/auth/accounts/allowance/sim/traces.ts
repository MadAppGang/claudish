/**
 * Synthetic demand traces for the tournament (architecture §4 `traces.ts`).
 *
 * `generateTrace(seed, profile, days, accounts)` returns every request of the
 * run BEFORE any strategy runs, so account choice can never change a later
 * arrival. Every random draw is keyed by a counter-based PRNG `(seed, user,
 * intent, attribute)`: the n-th thread's turn count is the same whatever came
 * before it.
 *
 * - **Threads.** Turns ~ lognormal (median 10), a few minutes apart; the
 *   context grows about 8k tokens per turn; the cache-read share comes from the
 *   turn index (0 on the first turn, then the previous context, up to 95 %);
 *   output ~ lognormal (median 1.5k). 30 % of threads spawn one or two subagent
 *   threads that share the parent's session id.
 * - **Load.** Each profile targets a share of the accounts' combined weekly
 *   capacity (PROFILE_LOAD); the thread arrival rate is that target over the
 *   mean thread cost at the vendor's default hidden weights.
 * - **Profiles.** `steady` (flat); `weekday-heavy` (09–19 Mon–Fri local carry
 *   10× the night and weekend rate, same weekly mean); `bursty` (Hawkes, base
 *   0.2/h, α 0.6, decay 1 h, rescaled to steady's weekly mean); `refactor-day`
 *   (one day at 6×, parallel threads); `over-subscribed` (1.4× capacity);
 *   `external-drift` (steady, plus external use at 20 % of demand, applied by
 *   the scenario's vendor accounts).
 *
 * Time is UTC (the tournament's calendar is offset 0), from `start`.
 */

import { fnv1a32, mulberry32, sampleLognormal, sampleNormal } from "../prng.js";
import type { Ms, TokenCounts } from "../types.js";
import { DEFAULT_HIDDEN_WEIGHTS, type VendorAccountSpec, costOf } from "./vendor.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MINUTES = 7 * 24 * 60;

export type TraceProfile =
  | "steady"
  | "bursty"
  | "weekday-heavy"
  | "refactor-day"
  | "over-subscribed"
  | "external-drift";

/** Weekly demand as a share of the combined weekly capacity. */
export const PROFILE_LOAD: Readonly<Record<TraceProfile, number>> = {
  steady: 0.9,
  bursty: 0.9,
  "weekday-heavy": 0.9,
  "refactor-day": 0.9,
  "over-subscribed": 1.4,
  "external-drift": 0.9,
};

/** External use (not routed by claudish) as a share of claudish demand. */
export const PROFILE_EXTERNAL: Readonly<Record<TraceProfile, number>> = {
  steady: 0,
  bursty: 0,
  "weekday-heavy": 0,
  "refactor-day": 0,
  "over-subscribed": 0,
  "external-drift": 0.2,
};

/** One request of the trace, at the cache state of an unswitched thread. */
export interface Demand {
  at: Ms;
  session: string;
  thread: string;
  /** 1-based turn index within the thread. */
  turn: number;
  tokens: TokenCounts;
  model: string;
}

const MODEL = "gpt-6-astra";
const TURNS_MEDIAN = 10;
const TURNS_SIGMA = 0.7;
const TURNS_MAX = 60;
const SUBAGENT_TURNS_MEDIAN = 5;
const TURN_GAP_MEAN_MIN = 3;
const CONTEXT_BASE = 15_000;
const CONTEXT_PER_TURN = 8_000;
const CONTEXT_MAX = 400_000;
const OUTPUT_MEDIAN = 1_500;
const SUBAGENT_SHARE = 0.3;
const CACHE_SHARE_MAX = 0.95;
const WEEKDAY_HIGH_TO_LOW = 10;
const REFACTOR_FACTOR = 6;
const HAWKES_BASE = 0.2;
const HAWKES_ALPHA = 0.6;
const HAWKES_DECAY_PER_H = 1;

/** A fresh stream for one `(seed, user, intent, attribute)` counter. */
export function keyed(seed: number, user: string, intent: string, attribute: string | number) {
  return mulberry32(fnv1a32(`${seed}|${user}|${intent}|${attribute}`));
}

/** The combined weekly capacity in cu: each account's governing window scaled to a week. */
export function weeklyCapacityCu(accounts: readonly VendorAccountSpec[]): number {
  let total = 0;
  for (const a of accounts) {
    let governing = a.windows[0];
    for (const w of a.windows)
      if (governing && w.lengthMinutes > governing.lengthMinutes) governing = w;
    if (governing) total += (governing.capacityCu * WEEK_MINUTES) / governing.lengthMinutes;
  }
  return total;
}

function poisson(rng: () => number, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) return Math.max(0, Math.round(sampleNormal(rng, lambda, Math.sqrt(lambda))));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rng();
  while (p > limit) {
    k++;
    p *= rng();
  }
  return k;
}

interface ThreadSpec {
  session: string;
  thread: string;
  start: Ms;
  seed: number;
  /** Counter for this thread's draws. */
  key: string;
  subagent: boolean;
}

/** The requests of one thread (and of its subagents, which share the session). */
function threadRequests(t: ThreadSpec): Demand[] {
  const rng = keyed(t.seed, "user0", "thread", t.key);
  const median = t.subagent ? SUBAGENT_TURNS_MEDIAN : TURNS_MEDIAN;
  const turns = Math.max(
    1,
    Math.min(TURNS_MAX, Math.round(sampleLognormal(rng, Math.log(median), TURNS_SIGMA)))
  );
  const out: Demand[] = [];
  let at = t.start;
  let context = CONTEXT_BASE * (0.6 + 0.8 * rng());
  let previous = 0;
  for (let turn = 1; turn <= turns; turn++) {
    const output = Math.round(sampleLognormal(rng, Math.log(OUTPUT_MEDIAN), 0.6));
    const input = Math.round(Math.min(CONTEXT_MAX, context));
    const share = turn === 1 ? 0 : Math.min(CACHE_SHARE_MAX, previous / Math.max(1, input));
    out.push({
      at: Math.round(at),
      session: t.session,
      thread: t.thread,
      turn,
      tokens: { input, cacheRead: Math.round(share * input), cacheWrite: 0, output },
      model: MODEL,
    });
    previous = input;
    context += CONTEXT_PER_TURN * (0.75 + 0.5 * rng()) + output;
    at += Math.max(20_000, -Math.log(1 - rng()) * TURN_GAP_MEAN_MIN * MINUTE_MS);
  }
  if (!t.subagent && rng() < SUBAGENT_SHARE) {
    const count = rng() < 0.5 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const at0 = out[Math.floor(rng() * out.length)]?.at ?? t.start;
      out.push(
        ...threadRequests({
          ...t,
          thread: `${t.thread}.sub${i}`,
          start: at0 + 30_000,
          key: `${t.key}.sub${i}`,
          subagent: true,
        })
      );
    }
  }
  return out;
}

let meanThreadCu: number | null = null;

/** The mean cost of one thread, subagents included, at the default hidden weights (fixed draws). */
export function meanThreadCost(): number {
  if (meanThreadCu !== null) return meanThreadCu;
  const n = 4000;
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (const r of threadRequests({
      session: "m",
      thread: "m",
      start: 0,
      seed: 0x5eed,
      key: `mean${i}`,
      subagent: false,
    })) {
      total += costOf({ id: "m", windows: [], weights: DEFAULT_HIDDEN_WEIGHTS }, r);
    }
  }
  meanThreadCu = total / n;
  return meanThreadCu;
}

/** The profile's relative rate at `at` (weekly mean 1), UTC. */
function factorAt(profile: TraceProfile, at: Ms, start: Ms, refactorDay: number): number {
  if (profile === "weekday-heavy") {
    // 1970-01-01 was a Thursday (4); 0 = Sunday.
    const day = (Math.floor(at / DAY_MS) + 4) % 7;
    const hour = Math.floor(at / HOUR_MS) % 24;
    const busy = day >= 1 && day <= 5 && hour >= 9 && hour < 19;
    const high = (7 * 24) / (50 + (7 * 24 - 50) / WEEKDAY_HIGH_TO_LOW);
    return busy ? high : high / WEEKDAY_HIGH_TO_LOW;
  }
  if (profile === "refactor-day") {
    return Math.floor((at - start) / DAY_MS) === refactorDay ? REFACTOR_FACTOR : 1;
  }
  return 1;
}

/** Thread starts of a Hawkes process (Ogata thinning) whose mean rate is `meanPerHour`. */
function hawkesStarts(seed: number, start: Ms, end: Ms, meanPerHour: number): Ms[] {
  const rng = keyed(seed, "user0", "hawkes", 0);
  const scale = meanPerHour / (HAWKES_BASE / (1 - HAWKES_ALPHA));
  const mu = HAWKES_BASE * scale;
  const out: Ms[] = [];
  let t = 0;
  let excite = 0;
  const horizon = (end - start) / HOUR_MS;
  while (t < horizon) {
    const bound = mu + excite;
    const dt = -Math.log(1 - rng()) / bound;
    excite *= Math.exp(-HAWKES_DECAY_PER_H * dt);
    t += dt;
    if (t >= horizon) break;
    if (rng() * bound <= mu + excite) {
      out.push(start + t * HOUR_MS);
      excite += HAWKES_ALPHA * HAWKES_DECAY_PER_H;
    }
  }
  return out;
}

export interface TraceOptions {
  start: Ms;
  /** Overrides PROFILE_LOAD[profile]. */
  load?: number;
}

/**
 * Every request of `days` days, sorted by time. The arrivals depend only on the
 * seed, the profile, the days and the accounts' capacity, never on any choice
 * made while serving them.
 */
export function generateTrace(
  seed: number,
  profile: TraceProfile,
  days: number,
  accounts: readonly VendorAccountSpec[],
  opts: TraceOptions
): Demand[] {
  const start = opts.start;
  const end = start + days * DAY_MS;
  const load = opts.load ?? PROFILE_LOAD[profile];
  const threadsPerHour = (load * weeklyCapacityCu(accounts)) / (7 * 24) / meanThreadCost();
  const refactorDay = Math.min(Math.max(0, days - 1), 7 + (Math.abs(seed) % 7));

  const starts: { at: Ms; key: string }[] = [];
  if (profile === "bursty") {
    hawkesStarts(seed, start, end, threadsPerHour).forEach((at, i) => {
      starts.push({ at, key: `h${i}` });
    });
  } else {
    for (let hour = start; hour < end; hour += HOUR_MS) {
      const rng = keyed(seed, "user0", "arrivals", hour);
      const n = poisson(rng, threadsPerHour * factorAt(profile, hour, start, refactorDay));
      for (let j = 0; j < n; j++) starts.push({ at: hour + rng() * HOUR_MS, key: `${hour}.${j}` });
    }
  }

  const out: Demand[] = [];
  for (const s of starts) {
    for (const r of threadRequests({
      session: `s${fnv1a32(`${seed}|${s.key}`).toString(16)}`,
      thread: `t${s.key}`,
      start: s.at,
      seed,
      key: s.key,
      subagent: false,
    })) {
      if (r.at < end) out.push(r);
    }
  }
  return out.sort((a, b) => a.at - b.at || (a.thread < b.thread ? -1 : 1));
}
