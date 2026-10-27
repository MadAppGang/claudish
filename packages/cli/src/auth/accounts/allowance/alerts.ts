/**
 * Gap alerts (architecture §1.9). Every simulation here goes through
 * `simulate` with `STRATEGIES[alertStrategy(cfg.strategy)]`: the alert model IS
 * the deployed strategy, so opus H1 and gpt #2 cannot arise by construction
 * (revision 2 item 3) — except under `lookahead`, whose alerts simulate `ebr`
 * until its cold evaluation fits the budget (`alertStrategy`, disclosed in
 * `account forecast`).
 *
 * - **`gaps`** simulates demand `d_k = ρ·f_{h(k)}` over `H = min(max(max_a R_g
 *   + 24h, now + 96h), now + SIM_MAX_STEPS h)` and returns EVERY blocked run,
 *   each ending when some account is usable again (every binding window, not
 *   only the earliest weekly reset). Two 7d runs separated by at most
 *   GAP_MERGE_H of service are one gap. `5h` gaps are returned and never alert.
 *   ρ is in the simulation's unit: cu/h when every β is at least coarse, else
 *   W/h with every window read in governing-window fractions.
 * - **Levels.** CRITICAL: `G_{CRIT_LEAD}(ρ_L) ≥ CRIT_GAP ∧ G_{CRIT_LEAD}(ρ_S) ≥
 *   CRIT_GAP`; WARN likewise with WARN_LEAD and WARN_GAP. `G_Λ` is the longest
 *   7d gap starting within `now + Λ`, so a short first gap never hides a long
 *   later one (R2).
 * - **`alertStep`** is the pure hysteresis: entry over ≥ 2 consecutive true
 *   evaluations spanning ENTRY_HOLD..ENTRY_STALE; exit over ≥ 2 evaluations
 *   for EXIT_HOLD (long rate) or EXIT_HOLD_SHORT (short rate) below the clear
 *   threshold, an evaluation gap over EVAL_GAP_BREAK restarting the exit chain;
 *   no force-clear; held while blocked inside the episode; the refire guard
 *   keyed on the gap at RAISE; episodes matched against EVERY gap (opus M4).
 * - **`alerts`** computes the burn rates fresh, reuses the last `GapEval` while
 *   its `inputsKey` holds, steps WARN then CRITICAL, and fills the payload:
 *   Monte Carlo gap quantiles and `pGap` from `alertPaths(cfg)` demand paths of
 *   the forecast's model with capacity draws (one path set for every level),
 *   and the remedy grid scanned once for every level. `alertsSliced` is the
 *   same evaluation as a generator that yields after each simulation, with
 *   the payload reused while its key holds. `payload:
 *   false` (the simulator's 5-minute steps) returns the transitions and no
 *   `active` alert, which is what the hysteresis needs.
 * - **Remedy** (no monotonicity assumed): not addressable when zero local
 *   demand still has a 7d gap ≥ 1 h inside the level's lead (external use,
 *   gpt #8); else the largest cut φ on {0.9 … 0.1} with no 7d gap ≥ 1 h at φ
 *   and at every grid point below it; the smallest pause on {1 … 12 h, every 6 h
 *   to 48 h, then every 12 h to H} (both coarser than §1.9: the 0.5 s budget).
 * - **Safe pace** (`paceScan`, only when `opts.pace` asks and no alert is
 *   active): the highest tested ρ whose `ρ·f` has no 7d gap ≥ 1 h over H, the
 *   remedy's criterion and its no-monotonicity rule. A gap at ρ_L scans the
 *   remedy's own cut grid on ρ_L (`cutScan`), so the value does not jump when
 *   the alert is raised. Otherwise the anchor is max(ρ_L, ρ_C), ρ_C the pool's
 *   refill throughput, so a light user's decayed rate cannot pull the answer
 *   down: a clean anchor is doubled up to PACE_MAX_MULT × until a rate gaps,
 *   then bisected PACE_BISECT_STEPS times; a gapping one is bisected down
 *   towards ρ_L. At most 11 `gapsOn`, reused while `inputsKey` holds.
 */

import { accountViews, isRead, strongBetas, usable, windowRates } from "./capacity.js";
import {
  MIN_PATH_SHARE,
  PACE_BISECT_STEPS,
  PACE_MAX_MULT,
  alertStrategy,
  trajPaths,
} from "./constants.js";
import { seedOf, viewsDigest } from "./digest.js";
import { type DemandModel, demandModel, quantilesOf, sampleDemandPath } from "./forecast.js";
import { fnvHex, mulberry32, sampleLognormal } from "./prng.js";
import { burnRates, localHourFn, profileFor } from "./profile.js";
import { simulate } from "./simulate.js";
import { evidenceOf } from "./state.js";
import { hourStart } from "./step.js";
import { STRATEGIES } from "./strategies/strategy.js";
import type {
  AccountId,
  AccountView,
  Alert,
  AlertLevel,
  AlertMemory,
  AlertsResult,
  AllowanceConfig,
  AllowanceState,
  BurnRates,
  Calendar,
  Forecast,
  ForecastUnit,
  Gap,
  GapEval,
  LevelMemory,
  Ms,
  PaceResult,
  Quantiles,
  Remedy,
  Transition,
} from "./types.js";

const HOUR_MS = 3_600_000;
/** A remedy closes every 7d gap of at least this length. */
const REMEDY_MIN_GAP_MS = HOUR_MS;
/**
 * The cut grid, ascending: 0.1 … 0.9. Coarser than §1.9's 0.05 steps to fit
 * the 0.5 s evaluation budget (step 12 bench): the remedy is read as "about
 * 60 %", and a 5-point step never changes which advice is printed.
 */
const CUT_GRID = Array.from({ length: 9 }, (_, i) => Number(((i + 1) * 0.1).toFixed(1)));
const EPISODE_BUCKET_MS = 6 * HOUR_MS;

// ---------------------------------------------------------------------------
// The gap simulation

/** What every gap evaluation of one `now` shares. */
interface GapContext {
  now: Ms;
  unit: ForecastUnit;
  /** The views as the simulation reads them (fractions in `account-fraction`). */
  views: AccountView[];
  /** f_{h(k)} per bucket from `floor(now/1h)`. */
  factors: number[];
  horizonMs: Ms;
  /** Where the simulation starts: the pool's real active account. */
  poolActive: AccountId | null;
}

/**
 * A view read in governing-window fractions: no β, no κ (every window takes the
 * demand as its own fraction), external drift as e·β_g in W/h.
 */
export function inFractions(v: AccountView): AccountView {
  const g = v.governing === null ? undefined : v.beta[v.governing];
  return {
    ...v,
    beta: {},
    kappa: {},
    externalPerHour: { ...v.externalPerHour, value: g ? v.externalPerHour.value * g.value : 0 },
  };
}

function gapContext(s: AllowanceState, now: Ms, cal: Calendar, cfg: AllowanceConfig): GapContext {
  const all = accountViews(s, now, cfg);
  const unit: ForecastUnit = strongBetas(all) ? "cu" : "account-fraction";
  const views = unit === "cu" ? all : all.map(inFractions);
  let end = now + 96 * HOUR_MS;
  for (const v of all) {
    const g = v.windows.find((w) => w.key === v.governing);
    if (g?.resetAt != null) end = Math.max(end, g.resetAt + 24 * HOUR_MS);
  }
  end = Math.min(end, now + cfg.SIM_MAX_STEPS * HOUR_MS);
  const horizonMs = end - now;
  const h0 = hourStart(now);
  const { factors } = profileFor(s, now, cal, cfg);
  const local = localHourFn(cal);
  const buckets = Math.min(cfg.SIM_MAX_STEPS, Math.ceil((end - h0) / HOUR_MS));
  const f = Array.from({ length: buckets }, (_, k) => factors[local(h0 + k * HOUR_MS).how] ?? 1);
  return { now, unit, views, factors: f, horizonMs, poolActive: s.poolActive ?? null };
}

/** Two 7d runs separated by at most GAP_MERGE_H of service are one gap. */
function mergeGaps(gaps: readonly Gap[], cfg: Pick<AllowanceConfig, "GAP_MERGE_H">): Gap[] {
  const out: Gap[] = [];
  let last7d: Gap | null = null;
  for (const g of gaps) {
    if (g.kind === "7d" && last7d !== null && g.start - last7d.end <= cfg.GAP_MERGE_H * HOUR_MS) {
      const seen = new Set(last7d.binding.map((b) => `${b.account}\u0000${b.window}`));
      last7d.binding = [
        ...last7d.binding,
        ...g.binding.filter((b) => !seen.has(`${b.account}\u0000${b.window}`)),
      ];
      last7d.end = g.end;
      last7d.lengthMs = last7d.end - last7d.start;
      continue;
    }
    const copy: Gap = { ...g, binding: [...g.binding] };
    out.push(copy);
    if (copy.kind === "7d") last7d = copy;
  }
  return out;
}

/** The Monte Carlo path count of the strategy the alerts simulate. */
function alertPaths(cfg: AllowanceConfig): number {
  return trajPaths({ strategy: alertStrategy(cfg.strategy), TRAJ_PATHS: cfg.TRAJ_PATHS });
}

function gapsOn(
  ctx: GapContext,
  demand: readonly number[],
  cfg: AllowanceConfig,
  views: readonly AccountView[] = ctx.views
): Gap[] {
  const r = simulate(views, demand, cfg, {
    now: ctx.now,
    strategy: STRATEGIES[alertStrategy(cfg.strategy)],
    thread: { account: null, lastSwitchAt: null, contextTokens: null },
    poolActive: ctx.poolActive,
    horizonMs: ctx.horizonMs,
  });
  return mergeGaps(r.gaps, cfg);
}

/**
 * Every gap of the deployed strategy at rate ρ (in the simulation's unit per
 * hour), chronological, 7d and 5h kinds both.
 */
export function gaps(
  s: AllowanceState,
  now: Ms,
  ratePerHour: number,
  cal: Calendar,
  cfg: AllowanceConfig
): Gap[] {
  const ctx = gapContext(s, now, cal, cfg);
  return gapsOn(
    ctx,
    ctx.factors.map((f) => Math.max(0, ratePerHour) * f),
    cfg
  );
}

/** 7d gaps, longest first (the earlier start on a tie). */
function longestFirst(gs: readonly Gap[]): Gap[] {
  return gs
    .filter((g) => g.kind === "7d")
    .sort((a, b) => b.lengthMs - a.lengthMs || a.start - b.start);
}

/**
 * The burn rates in the simulation's unit. In `cu` they are the ledger's. In
 * `account-fraction` the ledger's cu cannot be put into W, so the long rate is
 * the window rate ρ_win^frac (the forecast's level, §1.7) and the short rate
 * scales it by the ledger's short/long ratio.
 */
function simRates(
  s: AllowanceState,
  now: Ms,
  cal: Calendar,
  cfg: AllowanceConfig,
  unit: ForecastUnit
): BurnRates {
  const burn = burnRates(s, now, cal, cfg);
  if (unit === "cu") return burn;
  const frac = windowRates(accountViews(s, now, cfg), now).frac;
  return { long: frac, short: burn.long > 0 ? (frac * burn.short) / burn.long : frac };
}

// ---------------------------------------------------------------------------
// alertStep: hysteresis as a pure function of (memory, evaluation)

function levelParams(level: AlertLevel, cfg: AllowanceConfig) {
  return level === "critical"
    ? {
        leadMs: cfg.CRIT_LEAD_H * HOUR_MS,
        gapMs: cfg.CRIT_GAP_H * HOUR_MS,
        clearMs: cfg.CRIT_DEESCALATE_H * HOUR_MS,
      }
    : {
        leadMs: cfg.WARN_LEAD_H * HOUR_MS,
        gapMs: cfg.WARN_GAP_H * HOUR_MS,
        clearMs: cfg.WARN_CLEAR_H * HOUR_MS,
      };
}

function initialLevel(): LevelMemory {
  return {
    raised: false,
    entryChain: [],
    exitSince: null,
    exitCount: 0,
    exitShortSince: null,
    exitShortCount: 0,
    raisedAt: null,
    gapAtRaise: null,
    episode: null,
    episodeGap: null,
    lastClearedAt: null,
    lastEvalAt: null,
  };
}

export function initialAlertMemory(): AlertMemory {
  return { version: 1, warn: initialLevel(), critical: initialLevel(), lastEval: null };
}

/** 7d gaps starting within `now + withinMs`. */
function startingWithin(gs: readonly Gap[], now: Ms, withinMs: Ms): Gap[] {
  return gs.filter((g) => g.kind === "7d" && g.start <= now + withinMs);
}

function longest(gs: readonly Gap[]): number {
  let max = 0;
  for (const g of gs) max = Math.max(max, g.lengthMs);
  return max;
}

export function episodeId(level: AlertLevel, gap: Gap): string {
  const binding = gap.binding
    .map((b) => `${b.account}:${b.window}`)
    .sort()
    .join(",");
  return fnvHex(`${level}|${binding}|${Math.floor(gap.start / EPISODE_BUCKET_MS)}`);
}

function transitionId(
  level: AlertLevel,
  to: Transition["to"],
  episode: string,
  raisedAt: Ms
): string {
  return fnvHex(`${level}|${to}|${episode}|${raisedAt}`);
}

/**
 * The gap that continues an episode: every candidate that overlaps the prior
 * gap or starts within EPISODE_MATCH of it; the largest overlap wins, the longer
 * on a tie. null when none matches.
 */
function matchEpisode(
  prior: { start: Ms; end: Ms },
  candidates: readonly Gap[],
  cfg: Pick<AllowanceConfig, "EPISODE_MATCH_MS">
): Gap | null {
  let best: Gap | null = null;
  let bestOverlap = -1;
  for (const g of candidates) {
    const overlap = Math.max(0, Math.min(g.end, prior.end) - Math.max(g.start, prior.start));
    const near = Math.abs(g.start - prior.start) <= cfg.EPISODE_MATCH_MS;
    if (overlap <= 0 && !near) continue;
    if (
      overlap > bestOverlap ||
      (overlap === bestOverlap && best !== null && g.lengthMs > best.lengthMs)
    ) {
      best = g;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Advance an exit chain: start it, extend it, or restart it after an evaluation gap. */
function chain(
  clearing: boolean,
  since: Ms | null,
  count: number,
  now: Ms,
  sinceLastEval: number,
  cfg: Pick<AllowanceConfig, "EVAL_GAP_BREAK_MS">
): { since: Ms | null; count: number } {
  if (!clearing) return { since: null, count: 0 };
  if (since === null || sinceLastEval > cfg.EVAL_GAP_BREAK_MS) return { since: now, count: 1 };
  return { since, count: count + 1 };
}

export function alertStep(
  prior: AlertMemory | null,
  ev: GapEval & { level: AlertLevel; now: Ms; blockedNow: boolean },
  cfg: AllowanceConfig
): { memory: AlertMemory; transition: Transition | null } {
  const memory: AlertMemory = structuredClone(prior ?? initialAlertMemory());
  const m = memory[ev.level];
  const { leadMs, gapMs, clearMs } = levelParams(ev.level, cfg);
  const now = ev.now;
  const sinceLastEval = m.lastEvalAt === null ? Number.POSITIVE_INFINITY : now - m.lastEvalAt;
  m.lastEvalAt = now;

  const entryLong = startingWithin(ev.long, now, leadMs);
  const gEntryL = longest(entryLong);
  const gEntryS = longest(startingWithin(ev.short, now, leadMs));
  const holdLong = startingWithin(ev.long, now, leadMs + 24 * HOUR_MS);
  const gHoldL = longest(holdLong);
  const gHoldS = longest(startingWithin(ev.short, now, leadMs + 24 * HOUR_MS));
  const qualifying = longestFirst(entryLong.filter((g) => g.lengthMs >= gapMs));

  if (!m.raised) {
    const guarded =
      m.lastClearedAt !== null &&
      now - m.lastClearedAt < cfg.REFIRE_GUARD_MS &&
      m.gapAtRaise !== null &&
      gEntryL < cfg.REFIRE_GROWTH * m.gapAtRaise;
    const holds = gEntryL >= gapMs && gEntryS >= gapMs && !guarded;
    if (!holds) {
      m.entryChain = [];
      return { memory, transition: null };
    }
    m.entryChain = [...m.entryChain, now].filter((t) => now - t <= cfg.ENTRY_STALE_MS);
    const first = m.entryChain[0];
    const gap = qualifying[0];
    if (m.entryChain.length < 2 || first === undefined || now - first < cfg.ENTRY_HOLD_MS || !gap) {
      return { memory, transition: null };
    }
    const episode = episodeId(ev.level, gap);
    Object.assign(m, {
      ...initialLevel(),
      raised: true,
      raisedAt: now,
      gapAtRaise: gEntryL,
      episode,
      episodeGap: { start: gap.start, end: gap.end },
      lastClearedAt: m.lastClearedAt,
      lastEvalAt: now,
    });
    const to = ev.level === "critical" && memory.warn.raised ? "escalated" : "raised";
    return {
      memory,
      transition: { id: transitionId(ev.level, to, episode, now), level: ev.level, to, at: now },
    };
  }

  // Raised: keep the episode on any matching gap, else adopt the longest qualifying one.
  const matched = m.episodeGap ? matchEpisode(m.episodeGap, holdLong, cfg) : null;
  if (matched) m.episodeGap = { start: matched.start, end: matched.end };
  else if (qualifying[0]) {
    m.episode = episodeId(ev.level, qualifying[0]);
    m.episodeGap = { start: qualifying[0].start, end: qualifying[0].end };
  }

  // While the pool is blocked inside the episode, the alert holds.
  const blocked = ev.blockedNow && m.episodeGap !== null && now >= m.episodeGap.start;
  const long = chain(
    !blocked && gHoldL < clearMs,
    m.exitSince,
    m.exitCount,
    now,
    sinceLastEval,
    cfg
  );
  const short = chain(
    !blocked && gHoldS < clearMs,
    m.exitShortSince,
    m.exitShortCount,
    now,
    sinceLastEval,
    cfg
  );
  m.exitSince = long.since;
  m.exitCount = long.count;
  m.exitShortSince = short.since;
  m.exitShortCount = short.count;
  const exit =
    (long.since !== null && long.count >= 2 && now - long.since >= cfg.EXIT_HOLD_MS) ||
    (short.since !== null && short.count >= 2 && now - short.since >= cfg.EXIT_HOLD_SHORT_MS);
  if (!exit) return { memory, transition: null };

  const to = ev.level === "critical" && memory.warn.raised ? "deescalated" : "cleared";
  const transition: Transition = {
    id: transitionId(ev.level, to, m.episode ?? "", m.raisedAt ?? now),
    level: ev.level,
    to,
    at: now,
  };
  Object.assign(m, {
    ...initialLevel(),
    gapAtRaise: m.gapAtRaise,
    lastClearedAt: now,
    lastEvalAt: now,
  });
  return { memory, transition };
}

// ---------------------------------------------------------------------------
// The payload: Monte Carlo gap quantiles and the remedy

/** A view with its β and its external drift drawn once (§1.7 capacity draws). */
export function drawCapacity(v: AccountView, rng: () => number): AccountView {
  const beta: AccountView["beta"] = {};
  for (const [key, e] of Object.entries(v.beta)) {
    beta[key] = { ...e, value: e.value * sampleLognormal(rng, 0, e.relSd) };
  }
  return {
    ...v,
    beta,
    externalPerHour: {
      ...v.externalPerHour,
      value: v.externalPerHour.value * sampleLognormal(rng, 0, 0.5),
    },
  };
}

interface PathGaps {
  pGap: number;
  start: Quantiles | null;
  end: Quantiles | null;
  lengthMs: Quantiles | null;
}

/**
 * `alertPaths(cfg)` joint paths: a demand path of the forecast's model plus
 * capacity draws, each through the deployed strategy, ONE path set for every
 * level (orchestrator decision 2 after step 12). `pGap` counts paths with a
 * qualifying WARN gap; each level's quantiles are of its longest qualifying
 * gap. Yields after every path, so a caller can slice the work.
 */
function* pathGaps(
  ctx: GapContext,
  model: DemandModel | null,
  levels: readonly AlertLevel[],
  seed: number,
  cfg: AllowanceConfig
): Generator<void, Partial<Record<AlertLevel, PathGaps>>> {
  const out: Partial<Record<AlertLevel, PathGaps>> = {};
  const empty: PathGaps = { pGap: 0, start: null, end: null, lengthMs: null };
  if (model === null || model.unit !== ctx.unit) {
    for (const level of levels) out[level] = empty;
    return out;
  }
  const rng = mulberry32(seed);
  const paths = alertPaths(cfg);
  const warn = levelParams("warn", cfg);
  let withWarn = 0;
  const found = new Map(
    levels.map((l) => [
      l,
      { starts: [] as number[], ends: [] as number[], lengths: [] as number[] },
    ])
  );
  for (let p = 0; p < paths; p++) {
    const demand = sampleDemandPath(model, rng);
    const views = ctx.views.map((v) => drawCapacity(v, rng));
    const gs = gapsOn(ctx, demand, cfg, views);
    const w = startingWithin(gs, ctx.now, warn.leadMs).filter((g) => g.lengthMs >= warn.gapMs);
    if (w.length > 0) withWarn++;
    for (const [level, acc] of found) {
      const own = levelParams(level, cfg);
      const mine = longestFirst(
        startingWithin(gs, ctx.now, own.leadMs).filter((g) => g.lengthMs >= own.gapMs)
      )[0];
      if (mine) {
        acc.starts.push(mine.start);
        acc.ends.push(mine.end);
        acc.lengths.push(mine.lengthMs);
      }
    }
    yield;
  }
  for (const [level, acc] of found) {
    const enough = acc.lengths.length >= MIN_PATH_SHARE * paths;
    out[level] = {
      pGap: withWarn / paths,
      start: enough ? quantilesOf(acc.starts) : null,
      end: enough ? quantilesOf(acc.ends) : null,
      lengthMs: enough ? quantilesOf(acc.lengths) : null,
    };
  }
  return out;
}

function hasGap(gs: readonly Gap[]): boolean {
  return gs.some((g) => g.kind === "7d" && g.lengthMs >= REMEDY_MIN_GAP_MS);
}

/**
 * The pause grid: 1 … 12 h hourly, every 6 h to 48 h, then every 12 h up to the
 * horizon (at most 32 points at 216 h, against §1.9's 76: the step 12 budget).
 */
function pauseGrid(horizonMs: Ms): Ms[] {
  const out: Ms[] = [];
  for (let hours = 1; hours <= 12; hours++) out.push(hours * HOUR_MS);
  for (let hours = 18; hours <= 48; hours += 6) out.push(hours * HOUR_MS);
  for (let hours = 60; hours * HOUR_MS <= horizonMs; hours += 12) out.push(hours * HOUR_MS);
  return out.filter((p) => p <= Math.max(horizonMs, HOUR_MS));
}

/** What every level's remedy shares: the external run and the two grid scans. */
interface RemedyScan {
  /** Start of each 7d gap ≥ 1 h at zero local demand. */
  externalStarts: Ms[];
  cut: number | null;
  pauseMs: Ms | null;
}

/**
 * The largest cut φ on CUT_GRID with no 7d gap ≥ 1 h at `φ·rate` and at every
 * grid point below it (ascending, stopping at the first gap); null when 0.1
 * already gaps. Shared by the remedy and the safe pace, so the two cannot
 * disagree on one input. Yields after every simulation.
 */
function* cutScan(
  ctx: GapContext,
  rate: number,
  cfg: AllowanceConfig
): Generator<void, number | null> {
  let cut: number | null = null;
  for (const phi of CUT_GRID) {
    const gs = gapsOn(
      ctx,
      ctx.factors.map((f) => phi * rate * f),
      cfg
    );
    yield;
    if (hasGap(gs)) break;
    cut = phi;
  }
  return cut;
}

/**
 * ρ_C, the pool's refill throughput in the simulation's unit per hour: Σ over
 * read accounts of the governing window's capacity (1/β_g in cu, 1 in
 * account-fraction) over its length in hours. An account whose governing
 * length is unknown adds nothing.
 */
function refillThroughput(ctx: GapContext): number {
  let total = 0;
  for (const v of ctx.views.filter(isRead)) {
    const g = v.windows.find((w) => w.key === v.governing);
    if (!g || g.lengthMinutes === null || g.lengthMinutes <= 0) continue;
    const beta = ctx.unit === "cu" ? v.beta[g.key]?.value : undefined;
    const capacity = beta !== undefined && beta > 0 ? 1 / beta : 1;
    total += capacity / (g.lengthMinutes / 60);
  }
  return total;
}

/**
 * The safe pace (see the header), in the simulation's unit per hour. `ev` is
 * the evaluation's own gap evaluation, so ρ_L's cleanliness costs nothing.
 * Every tested clean rate stays below every tested gapping one, so the
 * no-monotonicity rule holds over the tested set; a clean band above a
 * gapping point can be missed, which under-reports (the safe direction).
 * null when no positive anchor exists. Yields after every simulation.
 */
function* paceScan(
  ctx: GapContext,
  ev: GapEval,
  rates: BurnRates,
  cfg: AllowanceConfig
): Generator<void, { rate: number; basis: PaceResult["basis"] } | null> {
  const rhoL = Number.isFinite(rates.long) && rates.long > 0 ? rates.long : 0;
  if (rhoL > 0 && hasGap(ev.long)) {
    const cut = yield* cutScan(ctx, rhoL, cfg);
    return { rate: cut === null ? 0 : cut * rhoL, basis: "cut-scan" };
  }
  const anchor = Math.max(rhoL, refillThroughput(ctx));
  if (!(anchor > 0) || !Number.isFinite(anchor)) return null;
  const clean = (rho: number) =>
    !hasGap(
      gapsOn(
        ctx,
        ctx.factors.map((f) => rho * f),
        cfg
      )
    );
  // ρ_L is clean by `ev`; a refill anchor above it is tested first.
  if (anchor > rhoL) {
    const ok = clean(anchor);
    yield;
    if (!ok) return { rate: yield* bisect(rhoL, anchor, clean), basis: "bisect" };
  }
  const up = yield* bracketUp(anchor, clean);
  if (up.hi === null) return { rate: up.lo, basis: "capped" };
  return { rate: yield* bisect(up.lo, up.hi, clean), basis: "bracket" };
}

/** Double a clean `anchor` up to PACE_MAX_MULT ×: the last clean rate, and the first gapping one or null. */
function* bracketUp(
  anchor: number,
  clean: (rho: number) => boolean
): Generator<void, { lo: number; hi: number | null }> {
  let lo = anchor;
  for (let mult = 2; mult <= PACE_MAX_MULT; mult *= 2) {
    const ok = clean(mult * anchor);
    yield;
    if (!ok) return { lo, hi: mult * anchor };
    lo = mult * anchor;
  }
  return { lo, hi: null };
}

/** PACE_BISECT_STEPS halvings of [lo clean, hi gapping]; the highest clean rate tested. */
function* bisect(lo: number, hi: number, clean: (rho: number) => boolean): Generator<void, number> {
  let low = lo;
  let high = hi;
  for (let i = 0; i < PACE_BISECT_STEPS; i++) {
    const mid = (low + high) / 2;
    const ok = clean(mid);
    yield;
    if (ok) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * The safe pace in cu/h, the report's `burn.unit`: `φ × burnLong` (φ =
 * rate / ρ_L of the scan) when both are known, which also converts W/h in
 * account-fraction; else the rate itself in `cu`, where the simulation's unit
 * is the ledger's. null in account-fraction without a ledger rate: W/h has no
 * cu/h equivalent then.
 */
export function paceInCuPerHour(pace: PaceResult, burnLong: number): number | null {
  if (pace.phi !== null && Number.isFinite(burnLong) && burnLong > 0) {
    return Math.max(0, pace.phi * burnLong);
  }
  if (pace.unit === "cu") return Math.max(0, pace.rate);
  return null;
}

/**
 * The level-free part of §1.9's remedy, computed once per evaluation: the
 * zero-demand run (external use), the cut grid, then the pause grid. Yields
 * after every simulation.
 */
function* remedyScan(
  ctx: GapContext,
  rateLong: number,
  cfg: AllowanceConfig
): Generator<void, RemedyScan> {
  const zero = ctx.factors.map(() => 0);
  const externalStarts = gapsOn(ctx, zero, cfg)
    .filter((g) => g.kind === "7d" && g.lengthMs >= REMEDY_MIN_GAP_MS)
    .map((g) => g.start);
  yield;
  const cut = yield* cutScan(ctx, rateLong, cfg);
  let pauseMs: Ms | null = null;
  const h0 = hourStart(ctx.now);
  for (const p of pauseGrid(ctx.horizonMs)) {
    const demand = ctx.factors.map((f, k) => (h0 + k * HOUR_MS < ctx.now + p ? 0 : rateLong * f));
    const closed = !hasGap(gapsOn(ctx, demand, cfg));
    yield;
    if (closed) {
      pauseMs = p;
      break;
    }
  }
  return { externalStarts, cut, pauseMs };
}

/**
 * The remedy for one level (§1.9): not addressable by pausing claudish work
 * when zero local demand still has a 7d gap ≥ 1 h inside the level's lead;
 * else the cut grid, then the pause grid. `until` is the gap's end p50.
 */
function remedyOf(
  scan: RemedyScan,
  ctx: GapContext,
  level: AlertLevel,
  until: Ms,
  cfg: AllowanceConfig
): Remedy {
  const { leadMs } = levelParams(level, cfg);
  if (scan.externalStarts.some((start) => start <= ctx.now + leadMs)) {
    return { kind: "not-addressable", reason: "external-use" };
  }
  if (scan.cut !== null) {
    return { kind: "cut", cutToFraction: scan.cut, until, pauseMs: scan.pauseMs };
  }
  if (scan.pauseMs !== null) return { kind: "pause", pauseMs: scan.pauseMs, until };
  return { kind: "not-addressable", reason: "no-grid-point" };
}

/** Drive a generator to completion synchronously. */
function run<T>(gen: Generator<void, T>): T {
  for (;;) {
    const next = gen.next();
    if (next.done) return next.value;
  }
}

/**
 * The remedy for `level` at `now` on its own: the burn rates fresh, `until` the
 * end of the longest qualifying long-rate gap (the deterministic one; `alerts`
 * passes the Monte Carlo end p50 instead). null when no 7d gap exists at ρ_L.
 */
export function remedy(
  s: AllowanceState,
  now: Ms,
  level: AlertLevel,
  cal: Calendar,
  cfg: AllowanceConfig
): Remedy | null {
  const ctx = gapContext(s, now, cal, cfg);
  const rates = simRates(s, now, cal, cfg, ctx.unit);
  const { leadMs } = levelParams(level, cfg);
  const gap = longestFirst(
    startingWithin(
      gapsOn(
        ctx,
        ctx.factors.map((f) => rates.long * f),
        cfg
      ),
      now,
      leadMs
    )
  )[0];
  return gap ? remedyOf(run(remedyScan(ctx, rates.long, cfg)), ctx, level, gap.end, cfg) : null;
}

/**
 * The remedy as the shell words it (§1.9): `cut to 60 % of current rate until
 * <time>`; `pause 14 h` when φ < 0.2 or the kind is `pause`; the
 * not-addressable line. `formatTime` renders an absolute local time.
 */
export function remedyText(r: Remedy, gapStart: Ms, formatTime: (at: Ms) => string): string {
  if (r.kind === "not-addressable") {
    return r.reason === "external-use"
      ? `not addressable by pausing claudish work: use outside claudish spends the allowance by ${formatTime(gapStart)}`
      : "not addressable by pausing claudish work: no cut or pause inside the horizon closes the gap";
  }
  const pause = r.pauseMs === null ? null : `pause ${Math.round(r.pauseMs / HOUR_MS)} h`;
  if (r.kind === "pause") return pause ?? "";
  if (r.cutToFraction < 0.2 && pause) return pause;
  const cut = `cut to ${Math.round(r.cutToFraction * 100)} % of current rate until ${formatTime(r.until)}`;
  return pause ? `${cut}, or ${pause}` : cut;
}

// ---------------------------------------------------------------------------
// alerts

/**
 * A rate on a log grid of 1/8 octave (≈ 9 %), for `inputsKey`. The short burn
 * rate moves every minute inside the open hour (its age-0 term grows with the
 * elapsed share, and the closed hours age against it), so `sig2` moved the key
 * between two 5-minute steps on an unchanged state and §1.9's reuse never
 * happened (step 12 finding 3). A reused evaluation is then exact for a rate
 * within the same bin, which moves a gap by well under a bucket.
 */
function rateBin(n: number): string {
  return Number.isFinite(n) && n > 0 ? String(Math.round(8 * Math.log2(n))) : "0";
}

/**
 * The Monte Carlo quantiles and the remedy scans of one evaluation, reused
 * while `key` holds: the gap evaluation's `inputsKey`, the seed and the raised
 * levels. The caller keeps the last one and hands it back (`opts.reuse`).
 */
export interface AlertPayload {
  key: string;
  mc: Partial<Record<AlertLevel, PathGaps>>;
  scan: RemedyScan;
}

export interface AlertsOptions {
  /** `false`: transitions only, no `active` alert (the simulator's 5-minute steps). */
  payload?: boolean;
  /** The previous evaluation's payload; used when its key still holds. */
  reuse?: AlertPayload | null;
  /**
   * `true`: compute the safe pace when no alert is active (`paceScan`). Only the
   * report asks: no announce step reads it. Ignored under `payload: false`.
   */
  pace?: boolean;
  /** The previous evaluation's safe pace; used when its key still holds. */
  paceReuse?: PaceResult | null;
}

/** The safe pace for `opts`, reused while the evaluation's `inputsKey` holds. */
function* paceFor(
  ctx: GapContext,
  ev: GapEval,
  rates: BurnRates,
  inputsKey: string,
  cfg: AllowanceConfig,
  opts: AlertsOptions
): Generator<void, PaceResult | null> {
  if (!opts.pace || opts.payload === false) return null;
  const key = fnvHex([inputsKey, "pace"].join("|"));
  if (opts.paceReuse?.key === key) return opts.paceReuse;
  const found = yield* paceScan(ctx, ev, rates, cfg);
  if (found === null) return null;
  const simLong = rates.long;
  return {
    key,
    rate: found.rate,
    simLong,
    phi: Number.isFinite(simLong) && simLong > 0 ? found.rate / simLong : null,
    unit: ctx.unit,
    basis: found.basis,
  };
}

/** `alerts` plus the payload it computed or reused (absent when nothing is raised). */
export interface AlertsRun extends AlertsResult {
  payload?: AlertPayload;
}

/**
 * `alerts` as a generator that yields after every simulation, so the shell can
 * run it in slices (one `simulate` per synchronous run) and never hold the
 * event loop for the whole evaluation (orchestrator decision 3 after step 12).
 * The result is identical to `alerts`.
 */
export function* alertsSliced(
  s: AllowanceState,
  now: Ms,
  prior: AlertMemory | null,
  cal: Calendar,
  cfg: AllowanceConfig,
  fc?: Forecast,
  opts: AlertsOptions = {}
): Generator<void, AlertsRun> {
  const base = prior ?? initialAlertMemory();
  if (evidenceOf(s, now) === "none") {
    return {
      memory: base,
      active: [],
      transitions: [],
      blockedNow: false,
      status: "insufficient-evidence",
      pace: null,
    };
  }
  const ctx = gapContext(s, now, cal, cfg);
  const rates = simRates(s, now, cal, cfg, ctx.unit);
  const read = ctx.views.filter(isRead);
  const blockedNow = read.length > 0 && !read.some(usable);

  const inputsKey = fnvHex(
    [
      viewsDigest(ctx.views),
      rateBin(rates.long),
      rateBin(rates.short),
      fc?.key ?? "",
      Math.floor(now / HOUR_MS),
      cfg.strategy,
    ].join("|")
  );
  let ev: GapEval;
  if (base.lastEval?.inputsKey === inputsKey) ev = base.lastEval;
  else {
    const long = longestFirst(
      gapsOn(
        ctx,
        ctx.factors.map((f) => rates.long * f),
        cfg
      )
    );
    yield;
    const short = longestFirst(
      gapsOn(
        ctx,
        ctx.factors.map((f) => rates.short * f),
        cfg
      )
    );
    yield;
    ev = { at: now, inputsKey, long, short };
  }

  const transitions: Transition[] = [];
  let memory: AlertMemory = { ...base, lastEval: null };
  for (const level of ["warn", "critical"] as const) {
    const step = alertStep(memory, { ...ev, level, now, blockedNow }, cfg);
    memory = step.memory;
    if (step.transition) transitions.push(step.transition);
  }
  memory.lastEval = ev;

  const active: Alert[] = [];
  const raised = (["critical", "warn"] as const).filter((l) => memory[l].raised);
  // The simulator steps transitions every 5 minutes and reads no payload (§4 run.ts).
  if (raised.length === 0 || opts.payload === false) {
    const pace = yield* paceFor(ctx, ev, rates, inputsKey, cfg, opts);
    return { memory, active, transitions, blockedNow, status: "ok", pace };
  }
  const seed = seedOf(s, now, cfg);
  const key = fnvHex([inputsKey, seed, raised.join(","), alertPaths(cfg)].join("|"));
  let payload: AlertPayload;
  if (opts.reuse?.key === key) payload = opts.reuse;
  else {
    const model = demandModel(s, now, ctx.horizonMs, cal, cfg);
    const mc = yield* pathGaps(ctx, model, raised, seed, cfg);
    const scan = yield* remedyScan(ctx, rates.long, cfg);
    payload = { key, mc, scan };
  }
  for (const level of raised) {
    const m = memory[level];
    const { leadMs } = levelParams(level, cfg);
    const atLong =
      (m.episodeGap
        ? matchEpisode(m.episodeGap, startingWithin(ev.long, now, leadMs + 24 * HOUR_MS), cfg)
        : null) ?? longestFirst(startingWithin(ev.long, now, leadMs + 24 * HOUR_MS))[0];
    if (!atLong) continue;
    const atShort = longestFirst(startingWithin(ev.short, now, leadMs))[0] ?? null;
    const mc = payload.mc[level] ?? { pGap: 0, start: null, end: null, lengthMs: null };
    const r = remedyOf(payload.scan, ctx, level, mc.end?.p50 ?? atLong.end, cfg);
    active.push({
      level,
      raisedAt: m.raisedAt ?? now,
      episode: m.episode ?? episodeId(level, atLong),
      gap: {
        atLongRate: atLong,
        atShortRate: atShort,
        start: mc.start,
        end: mc.end,
        lengthMs: mc.lengthMs,
      },
      pGap: mc.pGap,
      burn: {
        long: rates.long,
        short: rates.short,
        sustainable: r.kind === "cut" ? r.cutToFraction * rates.long : 0,
      },
      remedy: r,
    });
  }
  // A raised level whose gap no longer shows at ρ_L leaves `active` empty: no remedy to agree with.
  const pace = active.length === 0 ? yield* paceFor(ctx, ev, rates, inputsKey, cfg, opts) : null;
  return { memory, active, transitions, blockedNow, status: "ok", payload, pace };
}

export function alerts(
  s: AllowanceState,
  now: Ms,
  prior: AlertMemory | null,
  cal: Calendar,
  cfg: AllowanceConfig,
  fc?: Forecast,
  opts: AlertsOptions = {}
): AlertsResult {
  const { payload: _payload, ...result } = run(alertsSliced(s, now, prior, cal, cfg, fc, opts));
  return result;
}
