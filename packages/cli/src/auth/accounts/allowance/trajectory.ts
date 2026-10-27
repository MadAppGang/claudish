/**
 * Trajectory (architecture §1.10): what the pool had, and what it will have.
 *
 * - **History** is one point per hour back to `min(the oldest current
 *   governing-epoch start, now − 7 d)`. Each point is `Σ_a deliverable_a` from
 *   each account's latest reading at that time, in the unit (`/β_g` in `cu`, as
 *   is in `account-fraction`); a window whose reset had passed by then counts
 *   as refilled and the point carries `reset-inferred`.
 * - **The band** runs the alerts' path count — a demand path of the forecast's
 *   own model plus capacity draws (§1.7), seeded from the same `seed` as the
 *   alerts' gap quantiles — through `simulate` with the alerts' strategy
 *   (`alertModelConfig`: `ebr` when `lookahead` is configured, so the graph and
 *   the alert line on one screen come from one model), and takes per-bucket
 *   quantiles of the combined remaining plus `pBlocked`. The band samples the
 *   model, never a memoized forecast.
 * - **Resets** are each `R_w` within the horizon, `projected` after each
 *   window's first; a reset is a step, never interpolated. **Blocked** entries
 *   are the maximal runs where `pBlocked ≥ 0.5`.
 * - **Switches** read the same paths' `decisions`: a takeover is the first
 *   serving decision on an account other than the previous server, starting
 *   from the pool's active account (when the paths simulate it; else the
 *   first server is not a switch). Each account's first takeover per path,
 *   inside the horizon, gives its time quantiles and the share of paths.
 * - **Loss at a reset** reads the same paths' `leftoverAtReset`: the share of
 *   each account's governing window still unused at its next governing reset.
 *   The grid always reaches that reset + 24 h, so it does not depend on the
 *   horizon's length (only on the rng draws a longer grid consumes).
 * - **`sparkline`** is the ONE compact renderer (R21): history then p50, `▒`
 *   where p90 − p10 exceeds 15 % of the scale, `▓` on a projected block, `┊`
 *   at a reset, from a closed glyph set.
 */

import { drawCapacity, inFractions } from "./alerts.js";
import { isStrong } from "./calibrate.js";
import { accountViews, finishView, isRead, strongBetas } from "./capacity.js";
import { MIN_PATH_SHARE, alertModelConfig, trajPaths } from "./constants.js";
import { seedOf } from "./digest.js";
import { demandModel, quantilesOf, sampleDemandPath } from "./forecast.js";
import { mulberry32 } from "./prng.js";
import { type SimResult, gridBuckets, simulate } from "./simulate.js";
import { evidenceOf } from "./state.js";
import { hourStart } from "./step.js";
import { STRATEGIES } from "./strategies/strategy.js";
import type {
  AccountId,
  AccountView,
  AllowanceConfig,
  AllowanceState,
  Calendar,
  ForecastUnit,
  Ms,
  Trajectory,
  ViewWindow,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** A run is a projected block where at least this share of paths is blocked. */
const BLOCKED_SHARE = 0.5;
/** `▒` where the band is wider than this share of the sparkline's scale. */
const WIDE_BAND = 0.15;
const LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

// ---------------------------------------------------------------------------
// History

/** The newest reading of a window at or before `t`, or null. */
function readingAt(s: AllowanceState, account: string, key: string, t: Ms) {
  const list = s.accounts[account]?.windows[key]?.readings ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r && r.at <= t) return r;
  }
  return null;
}

/** The first reset strictly after `t` of a window that reset at `passed ≤ t`. */
function nextAfter(passed: Ms, lengthMinutes: number | null, t: Ms): Ms | null {
  if (lengthMinutes === null || lengthMinutes <= 0) return null;
  const L = lengthMinutes * MINUTE_MS;
  return passed + L * (Math.floor((t - passed) / L) + 1);
}

/**
 * One account at time `t`, from its latest readings then, with today's
 * estimates. null when its governing window had no reading yet.
 */
function viewAt(
  s: AllowanceState,
  view: AccountView,
  t: Ms
): { view: AccountView; inferred: boolean } | null {
  let inferred = false;
  const windows: ViewWindow[] = [];
  for (const w of view.windows) {
    const r = readingAt(s, view.account, w.key, t);
    if (!r) continue;
    if (w.semantics !== "sliding" && r.resetAt !== null && r.resetAt <= t) {
      inferred = true;
      windows.push({
        ...w,
        remaining: 1,
        resetAt: nextAfter(r.resetAt, w.lengthMinutes, t),
        provenance: "reset-inferred",
        rejected: false,
        releases: [],
      });
    } else {
      windows.push({
        ...w,
        remaining: 1 - r.usedFraction,
        resetAt: r.resetAt,
        provenance: "observed",
        rejected: r.rejected,
        releases: [],
      });
    }
  }
  if (!windows.some((w) => w.key === view.governing)) return null;
  return { view: finishView({ ...view, windows, observedAt: t }, t), inferred };
}

/** A view's deliverable in the unit: governing fraction, or cu through β_g. */
function deliverableIn(view: AccountView, unit: ForecastUnit): number {
  const d = view.deliverable ?? 0;
  if (unit === "account-fraction") return d;
  const beta = view.governing === null ? undefined : view.beta[view.governing];
  return isStrong(beta) && beta.value > 0 ? d / beta.value : d;
}

function historyOf(
  s: AllowanceState,
  views: readonly AccountView[],
  now: Ms,
  unit: ForecastUnit
): Trajectory["history"] {
  let from = now - WEEK_MS;
  for (const v of views) {
    const g = v.windows.find((w) => w.key === v.governing);
    if (g?.resetAt == null || g.lengthMinutes === null) continue;
    from = Math.min(from, g.resetAt - g.lengthMinutes * MINUTE_MS);
  }
  const out: Trajectory["history"] = [];
  for (let t = now; t >= from; t -= HOUR_MS) {
    let remaining = 0;
    let any = false;
    let inferred = false;
    for (const v of views) {
      const at = viewAt(s, v, t);
      if (!at) continue;
      any = true;
      inferred ||= at.inferred;
      remaining += deliverableIn(at.view, unit);
    }
    if (any) out.push({ at: t, remaining, provenance: inferred ? "reset-inferred" : "observed" });
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Resets, band, blocked runs

function resetsOf(views: readonly AccountView[], now: Ms, end: Ms): Trajectory["resets"] {
  const out: Trajectory["resets"] = [];
  for (const v of views) {
    for (const w of v.windows) {
      if (w.remaining === null || w.semantics === "sliding" || w.resetAt === null) continue;
      const L = w.lengthMinutes === null ? null : w.lengthMinutes * MINUTE_MS;
      let projected = false;
      for (let at = w.resetAt; at > now && at <= end; at += L ?? Number.POSITIVE_INFINITY) {
        out.push({ at, account: v.account, window: w.key, projected });
        projected = true;
        if (L === null || L <= 0) break;
      }
    }
  }
  return out.sort(
    (a, b) => a.at - b.at || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0)
  );
}

/** Each path's gap overlapping [from, to), if any. */
function overlapping(r: SimResult, from: Ms, to: Ms) {
  return r.gaps.find((g) => g.start < to && g.end > from) ?? null;
}

function blockedRuns(
  results: readonly SimResult[],
  forecast: Trajectory["forecast"]
): Trajectory["blocked"] {
  const out: Trajectory["blocked"] = [];
  let k = 0;
  while (k < forecast.length) {
    if ((forecast[k]?.pBlocked ?? 0) < BLOCKED_SHARE) {
      k++;
      continue;
    }
    const first = k;
    while (k < forecast.length && (forecast[k]?.pBlocked ?? 0) >= BLOCKED_SHARE) k++;
    const from = forecast[first]?.at ?? 0;
    const to = from + (k - first) * HOUR_MS;
    const gaps = results.map((r) => overlapping(r, from, to)).filter((g) => g !== null);
    if (gaps.length === 0) continue;
    const long = gaps.filter((g) => g.kind === "7d").length;
    out.push({
      from: quantilesOf(gaps.map((g) => g.start)),
      to: quantilesOf(gaps.map((g) => g.end)),
      kind: long * 2 >= gaps.length ? "7d" : "5h",
      probability: gaps.length / results.length,
    });
  }
  return out;
}

/**
 * One path's first takeover per account inside [now, end]: a serving decision
 * (`cu > 0`) on an account other than the previous server. With `from` null
 * the first server sets the previous one without counting.
 */
function firstTakeovers(
  r: SimResult,
  from: AccountId | null,
  now: Ms,
  end: Ms
): Map<AccountId, Ms> {
  const taken = new Map<AccountId, Ms>();
  let prev = from;
  for (const d of r.decisions) {
    if (d.account === null || d.cu <= 0 || d.account === prev) continue;
    const switched = prev !== null;
    prev = d.account;
    if (!switched) continue;
    const t = Math.max(now, r.start + d.k * HOUR_MS);
    if (t > end) break;
    if (!taken.has(d.account)) taken.set(d.account, t);
  }
  return taken;
}

/**
 * Each account's first takeover per path inside [now, end] (see the header),
 * kept when at least MIN_PATH_SHARE of the paths have one; ordered by p50,
 * then by the views' (account) order. No simulation: the paths are reused.
 */
function switchesOf(
  results: readonly SimResult[],
  views: readonly AccountView[],
  poolActive: AccountId | null,
  now: Ms,
  end: Ms
): Trajectory["switches"] {
  const order = new Map(views.map((v, i) => [v.account, i]));
  // An active account the paths do not simulate (unread) has no decision to switch from.
  const from = poolActive !== null && order.has(poolActive) ? poolActive : null;
  const times = new Map<AccountId, number[]>();
  for (const r of results) {
    for (const [account, t] of firstTakeovers(r, from, now, end)) {
      const list = times.get(account) ?? [];
      list.push(t);
      times.set(account, list);
    }
  }
  const paths = Math.max(1, results.length);
  const out: Trajectory["switches"] = [];
  for (const [account, list] of times) {
    const probability = list.length / paths;
    if (probability < MIN_PATH_SHARE) continue;
    out.push({ account, q: quantilesOf(list), probability: Math.min(1, probability) });
  }
  return out.sort(
    (a, b) => a.q.p50 - b.q.p50 || (order.get(a.account) ?? 0) - (order.get(b.account) ?? 0)
  );
}

/**
 * Each read account's governing-window share left unused at its next fixed
 * governing reset, over the paths (see the header). An account whose
 * governing window is sliding or has no reset time, or whose reset lies past
 * the grid on too many paths, has no entry. No simulation: the paths are reused.
 */
function lostAtResetOf(
  results: readonly SimResult[],
  views: readonly AccountView[]
): Trajectory["lostAtReset"] {
  const out: Trajectory["lostAtReset"] = {};
  const paths = Math.max(1, results.length);
  for (const v of views) {
    const g = v.windows.find((w) => w.key === v.governing);
    if (!g || g.remaining === null || g.resetAt === null || g.semantics === "sliding") continue;
    const values: number[] = [];
    for (const r of results) {
      const left = r.leftoverAtReset[v.account];
      if (left !== null && left !== undefined && Number.isFinite(left)) {
        values.push(Math.min(1, Math.max(0, left)));
      }
    }
    if (values.length === 0 || values.length < MIN_PATH_SHARE * paths) continue;
    out[v.account] = { at: g.resetAt, q: quantilesOf(values) };
  }
  return out;
}

export function trajectory(
  s: AllowanceState,
  now: Ms,
  horizonMs: Ms,
  cal: Calendar,
  cfg: AllowanceConfig
): Trajectory {
  const all = accountViews(s, now, cfg).filter(isRead);
  const unit: ForecastUnit = strongBetas(all) ? "cu" : "account-fraction";
  const history = historyOf(s, all, now, unit);
  const end = now + Math.max(0, horizonMs);
  const resets = resetsOf(all, now, end);
  const empty: Trajectory = {
    unit,
    history,
    forecast: [],
    resets,
    blocked: [],
    switches: [],
    lostAtReset: {},
  };
  if (evidenceOf(s, now) === "none" || all.length === 0) return empty;

  const views = unit === "cu" ? all : all.map(inFractions);
  const buckets = gridBuckets(views, now, horizonMs, cfg);
  const model = demandModel(s, now, buckets * HOUR_MS, cal, cfg);
  if (model === null || model.unit !== unit || buckets === 0) return empty;

  const rng = mulberry32(seedOf(s, now, cfg));
  const alertCfg = alertModelConfig(cfg);
  const paths = trajPaths(alertCfg);
  const results: SimResult[] = [];
  for (let p = 0; p < paths; p++) {
    const demand = sampleDemandPath(model, rng);
    const drawn = views.map((v) => drawCapacity(v, rng));
    results.push(
      simulate(drawn, demand, cfg, {
        now,
        strategy: STRATEGIES[alertCfg.strategy],
        thread: { account: null, lastSwitchAt: null, contextTokens: null },
        poolActive: s.poolActive ?? null,
        horizonMs,
      })
    );
  }

  const h0 = hourStart(now);
  const forecast: Trajectory["forecast"] = [];
  for (let k = 0; k < buckets; k++) {
    const at = h0 + k * HOUR_MS;
    if (at > end) break;
    let blocked = 0;
    const values: number[] = [];
    for (const r of results) {
      values.push(r.remainingCombined[k] ?? 0);
      if (r.blocked[k]?.blocked) blocked++;
    }
    forecast.push({ at, q: quantilesOf(values), pBlocked: blocked / paths });
  }
  return {
    unit,
    history,
    forecast,
    resets,
    blocked: blockedRuns(results, forecast),
    switches: switchesOf(results, views, s.poolActive ?? null, now, end),
    lostAtReset: lostAtResetOf(results, views),
  };
}

// ---------------------------------------------------------------------------
// sparkline

interface Cell {
  value: number | null;
  wide: boolean;
  block: boolean;
  reset: boolean;
}

/**
 * The trajectory in `cells` characters from the closed set `▁▂▃▄▅▆▇█▒▓┊` and
 * space: history then the forecast p50, each cell the latest point inside its
 * time slot, scaled to the largest value shown. Precedence per cell: `┊` at a
 * reset, `▓` on a projected block, `▒` on a wide band, else the level; a cell
 * with no point, or a zero value, is a space.
 */
export function sparkline(t: Trajectory, cells: number): string {
  const n = Math.max(0, Math.floor(cells));
  if (n === 0) return "";
  const points: {
    at: Ms;
    value: number;
    lo: number | null;
    hi: number | null;
    forecast: boolean;
  }[] = [
    ...t.history.map((h) => ({
      at: h.at,
      value: h.remaining,
      lo: null,
      hi: null,
      forecast: false,
    })),
    ...t.forecast
      .filter((f) => t.history.length === 0 || f.at > (t.history.at(-1)?.at ?? 0))
      .map((f) => ({ at: f.at, value: f.q.p50, lo: f.q.p10, hi: f.q.p90, forecast: true })),
  ];
  if (points.length === 0) return " ".repeat(n);
  const start = points[0]?.at ?? 0;
  const last = points[points.length - 1]?.at ?? start;
  const span = Math.max(HOUR_MS, last - start + HOUR_MS);
  const slot = (at: Ms) => Math.min(n - 1, Math.max(0, Math.floor(((at - start) / span) * n)));
  const scale = Math.max(...points.map((p) => Math.max(p.value, p.hi ?? 0)), 0);

  const grid: Cell[] = Array.from({ length: n }, () => ({
    value: null,
    wide: false,
    block: false,
    reset: false,
  }));
  for (const p of points) {
    const cell = grid[slot(p.at)];
    if (!cell) continue;
    cell.value = p.value;
    cell.wide = p.lo !== null && p.hi !== null && scale > 0 && p.hi - p.lo > WIDE_BAND * scale;
  }
  for (const b of t.blocked) {
    for (let i = slot(b.from.p50); i <= slot(Math.max(b.from.p50, b.to.p50 - 1)); i++) {
      const cell = grid[i];
      if (cell) cell.block = true;
    }
  }
  for (const r of t.resets) {
    if (r.at < start || r.at > start + span) continue;
    const cell = grid[slot(r.at)];
    if (cell) cell.reset = true;
  }

  return grid
    .map((c) => {
      if (c.reset) return "┊";
      if (c.block) return "▓";
      if (c.wide) return "▒";
      if (c.value === null || !(scale > 0) || c.value <= 0) return " ";
      const level = Math.min(LEVELS.length - 1, Math.floor((c.value / scale) * LEVELS.length));
      return LEVELS[Math.max(0, level)] ?? " ";
    })
    .join("");
}
