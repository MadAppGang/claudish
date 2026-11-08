/**
 * The demand forecast (architecture §1.7): Monte Carlo quantiles of claudish
 * demand from the open hour's start to the horizon.
 *
 * - **Demand only.** The result carries no per-account term and no burn rate,
 *   so everything it depends on is in `forecastKey` (§1.1) and it can be
 *   memoized under that key. It reads `now` only through `hourOf(now)` and the
 *   window rate only to 3 significant digits, exactly what the key holds.
 * - **Evidence.** `none`: empty buckets. `window-only` (under 1 day of ledger):
 *   the level is the window rate, the profile flat, σ = σ0 and the level's
 *   weight the governing window's elapsed days. `partial` (1–7 days): in `cu`,
 *   `ℓ = w·ℓ_hist + (1 − w)·24·ρ_win^cu`, `w = days/7`. `full`: `ℓ_hist`. In
 *   `account-fraction` the ledger's cu cannot be put into W, so at every level
 *   the ledger gives only the SHAPE and the level is `24·ρ_win^frac` (W/day).
 * - **Paths.** Each joint path draws a level multiplier `exp(N(−v/2, v))`, one
 *   day factor per local day `LogNormal(−σ²/2, σ²)`, and per hour `A ~ Bern(π_h)`
 *   and `M ~ Gamma(ν_m, mean μ_h)`, `μ_h = m_h/π_h`. The quantiles and the
 *   scales come from those joint paths, never from per-hour quantiles.
 */

import { accountViews, strongBetas, windowRates } from "./capacity.js";
import { forecastKey, seedOf } from "./digest.js";
import { type Rng, mulberry32, sampleBernoulli, sampleGamma, sampleLognormal } from "./prng.js";
import { localHourFn, profileFor } from "./profile.js";
import { evidenceOf, hourOf, ledgerDays } from "./state.js";
import type {
  AccountView,
  AllowanceConfig,
  AllowanceState,
  Calendar,
  Forecast,
  ForecastUnit,
  Ms,
  Quantiles,
} from "./types.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The checkpoints of `cumulative`, each reported when inside the horizon. */
const CHECKPOINTS_MS = [24 * HOUR_MS, 72 * HOUR_MS, 7 * DAY_MS];
/** The window-only level weight's floor, in days (§1.7). */
const MIN_LEVEL_WEIGHT = 0.25;

/** `n` rounded to 3 significant digits: the precision `forecastKey` holds. */
function sig3(n: number): number {
  return Number.isFinite(n) && n !== 0 ? Number(n.toPrecision(3)) : 0;
}

/** Linear interpolation between order statistics (type 7). */
function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const x = (sorted.length - 1) * p;
  const lo = Math.floor(x);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (x - lo);
}

export function quantilesOf(values: number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
  };
}

/** The shortest elapsed share of a read account's governing window, in days. */
function elapsedDays(views: readonly AccountView[], now: Ms): number | null {
  let min: number | null = null;
  for (const v of views) {
    const g = v.windows.find((w) => w.key === v.governing);
    if (!g || g.remaining === null || g.resetAt === null || g.lengthMinutes === null) continue;
    const days = (now - (g.resetAt - g.lengthMinutes * 60_000)) / DAY_MS;
    if (min === null || days < min) min = days;
  }
  return min;
}

/** Level (in `unit` per day), level weight n_eff, for the evidence level. */
function levelFor(
  evidence: Forecast["evidence"],
  unit: ForecastUnit,
  ledgerLevel: number | null,
  ledgerWeight: number,
  rate: { frac: number; cu: number | null },
  days: number,
  elapsed: number | null
): { level: number; weight: number } {
  const windowLevel = 24 * (unit === "cu" ? (rate.cu ?? 0) : rate.frac);
  if (evidence === "window-only") {
    return { level: windowLevel, weight: Math.max(MIN_LEVEL_WEIGHT, elapsed ?? 0) };
  }
  const weight = Math.max(MIN_LEVEL_WEIGHT, ledgerWeight);
  if (unit === "account-fraction") return { level: windowLevel, weight };
  const hist = ledgerLevel ?? windowLevel;
  if (evidence === "full" || rate.cu === null) return { level: hist, weight };
  const w = Math.min(1, days / 7);
  return { level: w * hist + (1 - w) * windowLevel, weight };
}

/**
 * The demand model a forecast samples (§1.7): per bucket from `hourOf(now)`
 * its mean, P(active) and local day, and the level and day-factor variances.
 * null under evidence `none`, or with no bucket. `alerts` draws its demand
 * paths from the same model with `sampleDemandPath`, so the gap quantiles and
 * the forecast read one model.
 */
export interface DemandModel {
  evidence: Forecast["evidence"];
  unit: ForecastUnit;
  hours: { start: Ms; day: number; mean: number; pi: number; mu: number }[];
  /** The level's log-variance v. */
  levelVariance: number;
  /** σ², the day factor's log-variance. */
  dayVariance: number;
  /** ν_m. */
  magnitudeShape: number;
}

export function demandModel(
  s: AllowanceState,
  now: Ms,
  horizonMs: Ms,
  cal: Calendar,
  cfg: AllowanceConfig
): DemandModel | null {
  const evidence = evidenceOf(s, now);
  const views = accountViews(s, now, cfg);
  const unit: ForecastUnit = evidence !== "none" && strongBetas(views) ? "cu" : "account-fraction";
  const steps = Math.ceil(horizonMs / HOUR_MS);
  if (evidence === "none" || !(steps > 0)) return null;

  const nowH = hourOf(now);
  const profile = profileFor(s, now, cal, cfg);
  const raw = windowRates(views, now);
  const rate = { frac: sig3(raw.frac), cu: raw.cu === null ? null : sig3(raw.cu) };
  const { level, weight } = levelFor(
    evidence,
    unit,
    profile.level,
    profile.levelWeight,
    rate,
    ledgerDays(s, nowH),
    elapsedDays(views, nowH)
  );
  const local = localHourFn(cal);
  const hours = Array.from({ length: steps }, (_, k) => {
    const start = nowH + k * HOUR_MS;
    const at = local(start);
    const mean = (level / 24) * (profile.factors[at.how] ?? 1);
    const pi = profile.active[at.how] ?? 1;
    return { start, day: at.day, mean, pi, mu: mean / pi };
  });
  return {
    evidence,
    unit,
    hours,
    levelVariance: profile.dayVariance / weight,
    dayVariance: profile.dayVariance,
    magnitudeShape: profile.magnitudeShape,
  };
}

/**
 * One joint demand path of the model, per bucket: a level multiplier
 * `exp(N(−v/2, v))`, one day factor per local day, and per hour `A ~ Bern(π_h)`
 * times `M ~ Gamma(ν_m, mean μ_h)`.
 */
export function sampleDemandPath(model: DemandModel, rng: Rng): number[] {
  const v = model.levelVariance;
  const sigma2 = model.dayVariance;
  const shape = model.magnitudeShape;
  const levelFactor = sampleLognormal(rng, -v / 2, Math.sqrt(v));
  const out: number[] = [];
  let day: number | null = null;
  let dayFactor = 1;
  for (const h of model.hours) {
    if (h.day !== day) {
      day = h.day;
      dayFactor = sampleLognormal(rng, -sigma2 / 2, Math.sqrt(sigma2));
    }
    out.push(
      h.mu > 0 && sampleBernoulli(rng, h.pi)
        ? levelFactor * dayFactor * sampleGamma(rng, shape, h.mu / shape)
        : 0
    );
  }
  return out;
}

/** Paths per slice of `forecastSliced`: 100 paths of up to SIM_MAX_STEPS (216) hourly draws each. */
const PATHS_PER_SLICE = 100;

/**
 * The demand forecast from `hourOf(now)` over `horizonMs` (§1.7). Seeded by
 * `seedOf(s, now, cfg)`; the same state, hour, horizon, calendar and config
 * give a deep-equal result.
 */
export function forecast(
  s: AllowanceState,
  now: Ms,
  horizonMs: Ms,
  cal: Calendar,
  cfg: AllowanceConfig
): Forecast {
  const gen = forecastSliced(s, now, horizonMs, cal, cfg);
  for (;;) {
    const next = gen.next();
    if (next.done) return next.value;
  }
}

/**
 * `forecast` as a generator that yields after the key, after the demand model
 * and after every PATHS_PER_SLICE paths, so the shell runs it in slices and no
 * synchronous run holds the event loop for the whole forecast. The result is
 * identical to `forecast`: one rng, drawn in the same order.
 */
export function* forecastSliced(
  s: AllowanceState,
  now: Ms,
  horizonMs: Ms,
  cal: Calendar,
  cfg: AllowanceConfig
): Generator<void, Forecast> {
  const key = forecastKey(s, now, horizonMs, cal, cfg);
  yield;
  const model = demandModel(s, now, horizonMs, cal, cfg);
  if (model === null) {
    const evidence = evidenceOf(s, now);
    const unit: ForecastUnit =
      evidence !== "none" && strongBetas(accountViews(s, now, cfg)) ? "cu" : "account-fraction";
    return { evidence, unit, buckets: [], cumulative: [], scale75: 1, scale90: 1, paths: 0, key };
  }
  yield;
  const steps = model.hours.length;
  const buckets = model.hours.map((h) => ({ start: h.start, mean: h.mean }));
  const totalMean = buckets.reduce((a, b) => a + b.mean, 0);

  const checkpoints = [...CHECKPOINTS_MS.filter((c) => c < horizonMs), horizonMs];
  const checkpointSteps = checkpoints.map((c) => Math.min(steps, Math.ceil(c / HOUR_MS)));
  const samples = checkpoints.map(() => [] as number[]);
  const rng = mulberry32(seedOf(s, now, cfg));
  const paths = Math.max(1, cfg.FORECAST_PATHS);
  for (let path = 0; path < paths; path++) {
    if (path > 0 && path % PATHS_PER_SLICE === 0) yield;
    const demand = sampleDemandPath(model, rng);
    let total = 0;
    let next = 0;
    for (let k = 0; k < steps; k++) {
      total += demand[k] ?? 0;
      while (next < checkpointSteps.length && checkpointSteps[next] === k + 1) {
        samples[next]?.push(total);
        next++;
      }
    }
  }

  const cumulative = checkpoints.map((c, i) => ({
    horizonMs: c,
    q: quantilesOf(samples[i] ?? []),
  }));
  const atHorizon = cumulative[cumulative.length - 1]?.q;
  return {
    evidence: model.evidence,
    unit: model.unit,
    buckets,
    cumulative,
    scale75: atHorizon && totalMean > 0 ? atHorizon.p75 / totalMean : 1,
    scale90: atHorizon && totalMean > 0 ? atHorizon.p90 / totalMean : 1,
    paths,
    key,
  };
}
