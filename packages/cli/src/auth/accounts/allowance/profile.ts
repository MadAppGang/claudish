/**
 * The demand profile and the burn rates (architecture §1.7).
 *
 * - **Local time.** Hour-of-week `h ∈ 0..167` (0 = Monday 00:00 local) comes
 *   from the `Calendar`, so DST moves the hour, never the reset (resets stay UTC).
 * - **Closed hours only.** The profile reads every hour from the ledger's first
 *   to the one before the open hour, an hour with no bucket being a 0. The open
 *   hour never enters, so the profile, like the forecast's seed, is stable for
 *   the hour.
 * - **Censoring (§1.4).** An hour with ≥ 30 censored minutes is left out of every
 *   statistic; one with fewer counts with weight `1 − c/60`. A censored interval
 *   still open (a `no-eligible` with no success since) censors the closed hours
 *   it covers.
 * - **Profile.** `f̂_h` is the weighted mean of `d_k / (ℓ_k/24)`, divided by the
 *   LEVEL and never by the day's own total, so a zero day is no division by
 *   zero. Each factor shrinks to its parent: hour-of-week → (weekday|weekend,
 *   hour of day) → hour of day → 1. Then renormalized to mean 1.
 * - **Level.** ℓ is the EWMA of deseasonalized daily totals, kept as a ratio of
 *   two EWMAs, `Σ w_d·D_d / Σ w_d·F_d` with `w_d = (1 − α)^age`: a day whose
 *   expected demand is small (a weekend) moves it little, and a partial or
 *   censored day counts with its uncensored share of `F_d`.
 * - **Burn rates (R5, R6).** `ρ_X = Σ w_k·d_k / Σ w_k·f_{h(k)}`, one half-life per
 *   rate, ages from the END of each hour. `ρ_L` reads closed hours only; `ρ_S`
 *   adds the open hour with its observed d (NOT scaled) over `e·f`. Computed on
 *   every call and never memoized: the open hour moves it.
 */

import { evidenceOf, hourOf } from "./state.js";
import type {
  AllowanceConfig,
  AllowanceState,
  BurnRates,
  Calendar,
  DemandProfile,
  Ms,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
export const HOURS_PER_WEEK = 168;
/** An hour censored this long is out of every demand statistic (§1.4). */
const CENSOR_DROP_MIN = 30;
/** Below this many active hours ν_m keeps its default. */
const SHAPE_MIN_HOURS = 3;
const SHAPE_DEFAULT = 2;
const SHAPE_MIN = 0.5;
const SHAPE_MAX = 10;
/** π is kept off 0 so μ = m/π stays finite. */
const ACTIVE_MIN = 0.01;

// ---------------------------------------------------------------------------
// Local time

/** The UTC offset in effect at a time: the last `from ≤ t`, else the earliest entry, else 0. */
export function offsetFn(cal: Calendar): (t: Ms) => number {
  const offsets = [...cal.offsets].sort((a, b) => a.from - b.from);
  return (t) => {
    if (offsets.length === 0) return 0;
    let lo = 0;
    let hi = offsets.length - 1;
    if (t < (offsets[0]?.from ?? 0)) return (offsets[0]?.offsetMinutes ?? 0) * MINUTE_MS;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid]?.from ?? 0) <= t) lo = mid;
      else hi = mid - 1;
    }
    return (offsets[lo]?.offsetMinutes ?? 0) * MINUTE_MS;
  };
}

/** Where an instant falls in local time. */
export interface LocalHour {
  /** 0..167, Monday 00:00 local = 0. */
  how: number;
  /** Hour of day, 0..23. */
  hod: number;
  weekend: boolean;
  /** Local day number since the Unix epoch. */
  day: number;
}

export function localHourFn(cal: Calendar): (t: Ms) => LocalHour {
  const offset = offsetFn(cal);
  return (t) => {
    const local = t + offset(t);
    const day = Math.floor(local / DAY_MS);
    const hod = Math.floor((local - day * DAY_MS) / HOUR_MS);
    // 1970-01-01 was a Thursday: Monday = 0.
    const weekday = (((day + 3) % 7) + 7) % 7;
    return { how: weekday * 24 + hod, hod, weekend: weekday >= 5, day };
  };
}

// ---------------------------------------------------------------------------
// The hour series

/** One hour of the ledger as the statistics read it. */
export interface HourPoint extends LocalHour {
  hour: Ms;
  cu: number;
  /** 1 − censored/60; 0 at ≥ 30 censored minutes. */
  weight: number;
}

function censorWeight(minutes: number): number {
  return minutes >= CENSOR_DROP_MIN ? 0 : 1 - minutes / 60;
}

/** Censored minutes of `[from, to)` inside a still-open interval. */
function openCensorMinutes(s: AllowanceState, from: Ms, to: Ms): number {
  if (s.censorOpenAt === null) return 0;
  const start = Math.max(from, s.censorOpenAt);
  return to > start ? (to - start) / MINUTE_MS : 0;
}

/** Every hour from the ledger's first to the one before `hourOf(now)`, zero-filled. */
export function closedHours(s: AllowanceState, now: Ms, cal: Calendar): HourPoint[] {
  const first = s.demand[0];
  if (!first) return [];
  const local = localHourFn(cal);
  const end = hourOf(now);
  const byHour = new Map(s.demand.map((b) => [b.hour, b]));
  const out: HourPoint[] = [];
  for (let hour = first.hour; hour < end; hour += HOUR_MS) {
    const b = byHour.get(hour);
    const minutes = Math.min(
      60,
      Math.max(b?.censoredMinutes ?? 0, openCensorMinutes(s, hour, hour + HOUR_MS))
    );
    out.push({ hour, cu: b?.cu ?? 0, weight: censorWeight(minutes), ...local(hour) });
  }
  return out;
}

/** The open hour so far: its cu, its elapsed share e and its uncensored weight. */
function openHour(s: AllowanceState, now: Ms, cal: Calendar): HourPoint & { elapsed: number } {
  const hour = hourOf(now);
  const b = s.demand.find((x) => x.hour === hour);
  const minutes = Math.min(60, Math.max(b?.censoredMinutes ?? 0, openCensorMinutes(s, hour, now)));
  return {
    hour,
    cu: b?.cu ?? 0,
    weight: censorWeight(minutes),
    elapsed: (now - hour) / HOUR_MS,
    ...localHourFn(cal)(hour),
  };
}

// ---------------------------------------------------------------------------
// The profile

interface Acc {
  sum: number;
  weight: number;
}

const acc = (): Acc => ({ sum: 0, weight: 0 });

function shrink(a: Acc, tau: number, parent: number): number {
  return a.weight + tau > 0 ? (a.sum + tau * parent) / (a.weight + tau) : parent;
}

/** The daily totals of uncensored demand and expected share, in day order. */
interface DayTotal {
  day: number;
  /** Σ weight·cu. */
  demand: number;
  /** Σ weight·f/24: the uncensored expected share of an average day. */
  expected: number;
  /** Σ f/24 over the day's hours read, censored or not. */
  full: number;
  /** The day's hours read (a partial day has fewer than 24). */
  hours: number;
}

function dayTotals(points: readonly HourPoint[], factors: readonly number[]): DayTotal[] {
  const days: DayTotal[] = [];
  for (const p of points) {
    let d = days[days.length - 1];
    if (!d || d.day !== p.day) {
      d = { day: p.day, demand: 0, expected: 0, full: 0, hours: 0 };
      days.push(d);
    }
    const f = (factors[p.how] ?? 1) / 24;
    d.demand += p.weight * p.cu;
    d.expected += p.weight * f;
    d.full += f;
    d.hours++;
  }
  return days;
}

/** The running level after each day: Σ w·D / Σ w·F with w = (1 − α)^age, null before any expected share. */
function runningLevels(days: readonly DayTotal[], alpha: number): (number | null)[] {
  let sd = 0;
  let sf = 0;
  return days.map((d) => {
    sd = (1 - alpha) * sd + d.demand;
    sf = (1 - alpha) * sf + d.expected;
    return sf > 0 ? sd / sf : null;
  });
}

/**
 * The ledger's demand profile at `now` (§1.7), from closed hours only. Two
 * passes: running levels under a flat profile give `ℓ_k` for the factors, then
 * the level, its weight and the day variance are recomputed under those factors.
 */
export function demandProfile(
  s: AllowanceState,
  now: Ms,
  cal: Calendar,
  cfg: AllowanceConfig
): DemandProfile {
  const points = closedHours(s, now, cal);
  const flat = new Array<number>(HOURS_PER_WEEK).fill(1);
  const nowH = hourOf(now);
  const forget = (hour: Ms) => cfg.CAL_FORGET ** ((nowH - (hour + HOUR_MS)) / WEEK_MS);

  // Pass 1: ℓ_k under a flat profile.
  const days1 = dayTotals(points, flat);
  const levels1 = runningLevels(days1, cfg.LEVEL_ALPHA);
  const levelOfDay = new Map(days1.map((d, i) => [d.day, levels1[i] ?? null]));

  // Factors: hour-of-week → (class, hour of day) → hour of day → 1.
  const byHow = Array.from({ length: HOURS_PER_WEEK }, acc);
  const byClass = Array.from({ length: 48 }, acc);
  const byHod = Array.from({ length: 24 }, acc);
  const activeHow = Array.from({ length: HOURS_PER_WEEK }, acc);
  const activeClass = Array.from({ length: 48 }, acc);
  const activeHod = Array.from({ length: 24 }, acc);
  const activeAll = acc();
  for (const p of points) {
    if (p.weight <= 0) continue;
    const w = forget(p.hour) * p.weight;
    const cls = (p.weekend ? 24 : 0) + p.hod;
    const on = p.cu > 0 ? 1 : 0;
    for (const a of [activeHow[p.how], activeClass[cls], activeHod[p.hod], activeAll]) {
      if (!a) continue;
      a.sum += w * on;
      a.weight += w;
    }
    const level = levelOfDay.get(p.day) ?? null;
    if (level === null || level <= 0) continue;
    const x = p.cu / (level / 24);
    for (const a of [byHow[p.how], byClass[cls], byHod[p.hod]]) {
      if (!a) continue;
      a.sum += w * x;
      a.weight += w;
    }
  }
  const raw = flat.map((_, h) => {
    const hod = h % 24;
    const cls = (h >= 120 ? 24 : 0) + hod;
    const fHod = shrink(byHod[hod] ?? acc(), cfg.PROFILE_TAU_DAYS, 1);
    const fClass = shrink(byClass[cls] ?? acc(), cfg.PROFILE_TAU_DAYS, fHod);
    return shrink(byHow[h] ?? acc(), cfg.PROFILE_TAU_WEEKS, fClass);
  });
  const mean = raw.reduce((a, b) => a + b, 0) / HOURS_PER_WEEK;
  const factors = mean > 0 ? raw.map((f) => f / mean) : flat;

  // Activity: a Beta(1, 1) pool, then each level shrunk to its parent with PI_TAU.
  const piAll = (activeAll.sum + 1) / (activeAll.weight + 2);
  const active = flat.map((_, h) => {
    const hod = h % 24;
    const cls = (h >= 120 ? 24 : 0) + hod;
    const pHod = shrink(activeHod[hod] ?? acc(), cfg.PI_TAU, piAll);
    const pClass = shrink(activeClass[cls] ?? acc(), cfg.PI_TAU, pHod);
    return Math.min(1, Math.max(ACTIVE_MIN, shrink(activeHow[h] ?? acc(), cfg.PI_TAU, pClass)));
  });

  // Pass 2: the level, its weight and the day variance under the factors.
  const days = dayTotals(points, factors);
  const levels = runningLevels(days, cfg.LEVEL_ALPHA);
  const level = levels[levels.length - 1] ?? null;
  let levelWeight = 0;
  for (const [i, d] of days.entries()) {
    const share = d.full > 0 ? d.expected / d.full : 0;
    levelWeight += (1 - cfg.LEVEL_ALPHA) ** (days.length - 1 - i) * share;
  }
  const dayVariance = dayVarianceOf(days, levels, level, cfg);
  const magnitudeShape = magnitudeShapeOf(points, levelOfDay, factors, active, forget);

  return {
    factors,
    active,
    magnitudeShape,
    level,
    dayVariance,
    levelWeight,
    hours: points.length,
  };
}

/**
 * σ² = (ν0·σ0² + Σ_d log²((D_d + c)/(E_d + c))) / (ν0 + n_d), c = 0.05·ℓ, over
 * complete days with at least half their expected share uncensored. `E_d` is
 * the level BEFORE day d times its expected share: an out-of-sample error.
 */
function dayVarianceOf(
  days: readonly DayTotal[],
  levels: readonly (number | null)[],
  level: number | null,
  cfg: AllowanceConfig
): number {
  const prior = cfg.NU0 * cfg.SIGMA0 ** 2;
  if (level === null) return prior / cfg.NU0;
  const c = 0.05 * level;
  let sum = 0;
  let n = 0;
  for (const [i, d] of days.entries()) {
    if (d.hours < 24 || d.full <= 0 || d.expected / d.full < 0.5) continue;
    const before = (i > 0 ? levels[i - 1] : levels[i]) ?? null;
    if (before === null) continue;
    const expected = before * d.expected;
    if (!(d.demand + c > 0) || !(expected + c > 0)) continue;
    sum += Math.log((d.demand + c) / (expected + c)) ** 2;
    n++;
  }
  return (prior + sum) / (cfg.NU0 + n);
}

/** ν_m by the method of moments of d/μ over active uncensored hours, clamped to [0.5, 10]; 2 with too few. */
function magnitudeShapeOf(
  points: readonly HourPoint[],
  levelOfDay: ReadonlyMap<number, number | null>,
  factors: readonly number[],
  active: readonly number[],
  forget: (hour: Ms) => number
): number {
  let w = 0;
  let s1 = 0;
  let s2 = 0;
  let n = 0;
  for (const p of points) {
    const level = levelOfDay.get(p.day) ?? null;
    if (p.weight <= 0 || p.cu <= 0 || level === null || level <= 0) continue;
    const mu = ((level / 24) * (factors[p.how] ?? 1)) / (active[p.how] ?? 1);
    if (!(mu > 0)) continue;
    const y = p.cu / mu;
    const wi = forget(p.hour) * p.weight;
    w += wi;
    s1 += wi * y;
    s2 += wi * y * y;
    n++;
  }
  if (n < SHAPE_MIN_HOURS || w <= 0) return SHAPE_DEFAULT;
  const mean = s1 / w;
  const variance = s2 / w - mean * mean;
  if (!(variance > 1e-12)) return SHAPE_MAX;
  return Math.min(SHAPE_MAX, Math.max(SHAPE_MIN, (mean * mean) / variance));
}

/** The profile a forecast or a burn rate reads: the ledger's, or flat below one day of it. */
export function profileFor(
  s: AllowanceState,
  now: Ms,
  cal: Calendar,
  cfg: AllowanceConfig
): DemandProfile {
  const profile = demandProfile(s, now, cal, cfg);
  const evidence = evidenceOf(s, now);
  if (evidence === "partial" || evidence === "full") return profile;
  return {
    ...profile,
    factors: new Array<number>(HOURS_PER_WEEK).fill(1),
    dayVariance: cfg.SIGMA0 ** 2,
  };
}

// ---------------------------------------------------------------------------
// Burn rates

/**
 * ρ_L and ρ_S in claudish cu per hour. Each hour counts in proportion to its
 * expected demand, so an empty night (d ≈ 0 where f ≈ 0) moves neither rate.
 * Never memoized (§1.1).
 */
export function burnRates(
  s: AllowanceState,
  now: Ms,
  cal: Calendar,
  cfg: AllowanceConfig
): BurnRates {
  const { factors } = profileFor(s, now, cal, cfg);
  const points = closedHours(s, now, cal);
  let longNum = 0;
  let longDen = 0;
  let shortNum = 0;
  let shortDen = 0;
  for (const p of points) {
    if (p.weight <= 0) continue;
    const age = (now - (p.hour + HOUR_MS)) / HOUR_MS;
    const f = factors[p.how] ?? 1;
    const wl = 2 ** (-age / cfg.BURN_LONG_HL_H) * p.weight;
    const ws = 2 ** (-age / cfg.BURN_SHORT_HL_H) * p.weight;
    longNum += wl * p.cu;
    longDen += wl * f;
    shortNum += ws * p.cu;
    shortDen += ws * f;
  }
  const open = openHour(s, now, cal);
  if (open.weight > 0) {
    // Age 0; the observed d so far over its elapsed share of the expected f.
    shortNum += open.weight * open.cu;
    shortDen += open.weight * open.elapsed * (factors[open.how] ?? 1);
  }
  return {
    long: longDen > 0 ? longNum / longDen : 0,
    short: shortDen > 0 ? shortNum / shortDen : 0,
  };
}
