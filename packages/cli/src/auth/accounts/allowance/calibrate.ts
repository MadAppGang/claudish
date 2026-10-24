/**
 * Calibration (architecture §1.5): β (window fraction per cu), η (external
 * drift per hour) and κ (nesting ratio), each with an interval-aware
 * uncertainty and a quality.
 *
 * - **Fixed-start/unknown spans.** A span starts at a reading u₀, adds up the
 *   account's claudish cu, and closes at the first reading in the SAME epoch
 *   with u − u₀ ≥ CAL_MIN_DELTA. A reset or a new epoch discards the open span.
 *   Spans start only at OBSERVED readings, never at an assumed 0 when an epoch opens.
 * - **Sliding pairs.** Two readings whose OBSERVED |Δu| ≥ CAL_MIN_DELTA give
 *   `Δu = β·(cu(t₂−L, t₂] − cu(t₁−L, t₁])`: external use in steady state cancels
 *   in a rolling difference, and the filter needs no β (opus M6).
 * - **Fit.** Weighted by CAL_FORGET^(age in weeks): `Δu = β·cu + η·dur`, β, η ≥ 0.
 *   η is fitted only with ≥ 3 spans whose cu/dur has a coefficient of variation
 *   ≥ 0.2; otherwise η = 0 and β = ΣΔu/Σcu.
 * - **Quality.** `calibrated`: η identifiable or ≥ 3 spans. `coarse`: 1–2 closed
 *   spans, or an open span with Δu ≥ 2 quanta. `prior`: the pooled β of
 *   accounts with the same plan class; with none, no estimate at all.
 * - **Recalibrate.** A jump of u ≥ CAL_MIN_DELTA with no claudish cu in between
 *   that is more than 3× the fitted drift raises `recalibrate` and halves the
 *   weight of every span closed before it (a mid-week plan change).
 * - **κ** per shorter window s against the governing window g: ΣΔu_s / ΣΔu_g
 *   over readings taken together inside one epoch of each; `calibrated` once
 *   ΣΔu_g ≥ KAPPA_MIN_LONG and ΣΔu_s ≥ CAL_MIN_DELTA.
 */

import { classifySemantics, epochOf } from "./semantics.js";
import type {
  AccountId,
  AccountTrack,
  AllowanceConfig,
  AllowanceState,
  Estimate,
  Ms,
  ReadingPoint,
  Semantics,
  WindowKey,
  WindowTrack,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const EPS = 1e-9;
/** Below this coefficient of variation of cu/dur, β and η cannot be told apart. */
const ETA_MIN_CV = 0.2;
const ETA_MIN_SPANS = 3;
/** A jump this many times the fitted drift is a plan change, not noise. */
const RECALIBRATE_FACTOR = 3;
/** relSd floor while `coarse`; the spread of a pooled prior. */
const COARSE_MIN_RELSD = 0.5;
const PRIOR_RELSD = 1;

export interface Span {
  du: number;
  cu: number;
  /** Hours. */
  dur: number;
  /** When it closed. */
  at: Ms;
}

export interface WindowCalibration {
  semantics: Semantics;
  /** Absent when there is no estimate and no prior. */
  beta: Estimate | null;
  /** Fitted external drift in window fraction per hour; 0 when not identifiable. */
  eta: number;
  etaIdentified: boolean;
  spans: number;
}

export interface AccountCalibration {
  account: AccountId;
  windows: Record<WindowKey, WindowCalibration>;
  /** β per live window, only where an estimate exists. */
  beta: Record<WindowKey, Estimate>;
  /** κ per live window shorter than the governing one, only where an estimate exists. */
  kappa: Record<WindowKey, Estimate>;
  /** cu/h not routed by claudish: η/β on the governing window. */
  externalPerHour: Estimate;
  governing: WindowKey | null;
  recalibrate: boolean;
}

export function isStrong(e: Estimate | null | undefined): e is Estimate {
  return e !== null && e !== undefined && e.quality !== "prior";
}

/** The longest live window, by known length; a window of unknown length only when none is known. */
export function governingKey(track: AccountTrack): WindowKey | null {
  let best: WindowTrack | null = null;
  for (const w of liveTracks(track)) {
    if (best === null) best = w;
    else if ((w.lengthMinutes ?? -1) > (best.lengthMinutes ?? -1)) best = w;
  }
  return best?.key ?? null;
}

export function liveTracks(track: AccountTrack): WindowTrack[] {
  return Object.values(track.windows)
    .filter((w) => !w.retired && w.readings.length > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** cu served in (t0, t1], by prefix sums over the account's served list. */
function cuCounter(track: AccountTrack): (t0: Ms, t1: Ms) => number {
  const times = track.served.map((s) => s.at);
  const cum: number[] = [0];
  for (const s of track.served) cum.push((cum[cum.length - 1] ?? 0) + s.cu);
  // Number of entries with at ≤ t.
  const upTo = (t: Ms) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((times[mid] ?? 0) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (t0, t1) => (t1 <= t0 ? 0 : (cum[upTo(t1)] ?? 0) - (cum[upTo(t0)] ?? 0));
}

interface SpanScan {
  closed: Span[];
  open: { du: number; cu: number } | null;
  /** Times of jumps with no claudish cu, with their Δu and duration (hours). */
  jumps: { at: Ms; du: number; dur: number }[];
}

/** The readings of each epoch, with the implicit 0 at the epoch's start where it is known. */
function epochRuns(
  w: WindowTrack,
  semantics: Semantics,
  cfg: Pick<AllowanceConfig, "EPOCH_TOL_MS">
): ReadingPoint[][] {
  const epochs = epochOf(w.readings, semantics, w.quantum, cfg);
  const runs: ReadingPoint[][] = [];
  let current = -1;
  w.readings.forEach((r, i) => {
    const e = epochs[i] ?? 0;
    if (e !== current) {
      current = e;
      runs.push([]);
    }
    runs[runs.length - 1]?.push(r);
  });
  return runs;
}

function scanFixed(
  w: WindowTrack,
  semantics: Semantics,
  cuBetween: (t0: Ms, t1: Ms) => number,
  cfg: Pick<AllowanceConfig, "EPOCH_TOL_MS" | "CAL_MIN_DELTA">
): SpanScan {
  const scan: SpanScan = { closed: [], open: null, jumps: [] };
  for (const run of epochRuns(w, semantics, cfg)) {
    let start = run[0];
    if (!start) continue;
    let prev = start;
    for (const r of run.slice(1)) {
      const step = r.usedFraction - prev.usedFraction;
      if (step >= cfg.CAL_MIN_DELTA - EPS && cuBetween(prev.at, r.at) === 0) {
        scan.jumps.push({ at: r.at, du: step, dur: (r.at - prev.at) / HOUR_MS });
      }
      prev = r;
      const du = r.usedFraction - start.usedFraction;
      if (du >= cfg.CAL_MIN_DELTA - EPS) {
        scan.closed.push({
          du,
          cu: cuBetween(start.at, r.at),
          dur: (r.at - start.at) / HOUR_MS,
          at: r.at,
        });
        start = r;
      }
    }
    // Only the newest epoch's open span is still open; earlier ones were discarded by their reset.
    scan.open =
      prev.at > start.at
        ? { du: prev.usedFraction - start.usedFraction, cu: cuBetween(start.at, prev.at) }
        : null;
  }
  return scan;
}

function scanSliding(
  w: WindowTrack,
  cuBetween: (t0: Ms, t1: Ms) => number,
  cfg: Pick<AllowanceConfig, "CAL_MIN_DELTA">
): SpanScan {
  const scan: SpanScan = { closed: [], open: null, jumps: [] };
  if (w.lengthMinutes === null) return scan;
  const L = w.lengthMinutes * MINUTE_MS;
  const inWindow = (t: Ms) => cuBetween(t - L, t);
  let start = w.readings[0];
  if (!start) return scan;
  for (const r of w.readings.slice(1)) {
    const du = r.usedFraction - start.usedFraction;
    if (Math.abs(du) >= cfg.CAL_MIN_DELTA - EPS) {
      scan.closed.push({
        du,
        cu: inWindow(r.at) - inWindow(start.at),
        dur: (r.at - start.at) / HOUR_MS,
        at: r.at,
      });
      start = r;
    }
  }
  return scan;
}

interface Fit {
  beta: number;
  eta: number;
  etaIdentified: boolean;
  seRel: number;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return 0;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** Weighted non-negative least squares of `du = β·cu + η·dur` (η only when identifiable). */
function fitSpans(spans: Span[], weights: number[], sliding: boolean): Fit | null {
  let scc = 0;
  let scd = 0;
  let sdd = 0;
  let scu = 0;
  let sdu = 0;
  let su = 0;
  let sc = 0;
  spans.forEach((s, i) => {
    const w = weights[i] ?? 1;
    scc += w * s.cu * s.cu;
    scd += w * s.cu * s.dur;
    sdd += w * s.dur * s.dur;
    scu += w * s.cu * s.du;
    sdu += w * s.dur * s.du;
    su += w * s.du;
    sc += w * s.cu;
  });
  let beta: number;
  let eta = 0;
  let etaIdentified = false;
  const ratios = spans.filter((s) => s.dur > 0).map((s) => s.cu / s.dur);
  if (
    !sliding &&
    spans.length >= ETA_MIN_SPANS &&
    coefficientOfVariation(ratios) >= ETA_MIN_CV &&
    scc * sdd - scd * scd > EPS * scc * sdd
  ) {
    const det = scc * sdd - scd * scd;
    beta = (scu * sdd - scd * sdu) / det;
    eta = (scc * sdu - scd * scu) / det;
    if (beta < 0) {
      beta = 0;
      eta = sdd > 0 ? Math.max(0, sdu / sdd) : 0;
    } else if (eta < 0) {
      eta = 0;
      beta = scc > 0 ? Math.max(0, scu / scc) : 0;
    }
    etaIdentified = true;
  } else if (sliding) {
    if (scc <= 0) return null;
    beta = Math.max(0, scu / scc);
  } else {
    if (sc <= 0) return null;
    beta = Math.max(0, su / sc);
  }
  let seRel = 0;
  if (spans.length >= ETA_MIN_SPANS && beta > 0) {
    const p = etaIdentified ? 2 : 1;
    let rss = 0;
    spans.forEach((s, i) => {
      rss += (weights[i] ?? 1) * (s.du - beta * s.cu - eta * s.dur) ** 2;
    });
    // Weighted least squares: Var(β) ≈ σ̂² / Σw·cu², σ̂² = Σw·r² / (n − p).
    const n = spans.length;
    const sigma2 = n > p ? rss / (n - p) : 0;
    seRel = scc > 0 ? Math.sqrt(sigma2 / scc) / beta : 0;
  }
  return { beta, eta, etaIdentified, seRel };
}

function windowCalibration(
  w: WindowTrack,
  cuBetween: (t0: Ms, t1: Ms) => number,
  refAt: Ms,
  cfg: AllowanceConfig
): { cal: WindowCalibration; recalibrate: boolean } {
  const semantics = classifySemantics(w.readings, cfg);
  const sliding = semantics === "sliding";
  const scan = sliding ? scanSliding(w, cuBetween, cfg) : scanFixed(w, semantics, cuBetween, cfg);
  const empty: WindowCalibration = {
    semantics,
    beta: null,
    eta: 0,
    etaIdentified: false,
    spans: scan.closed.length,
  };
  const usable = scan.closed.filter((s) => (sliding ? s.cu !== 0 : s.cu > 0 || s.dur > 0));
  const weights = usable.map((s) => cfg.CAL_FORGET ** Math.max(0, (refAt - s.at) / WEEK_MS));
  let fit = usable.length > 0 ? fitSpans(usable, weights, sliding) : null;

  let recalibrate = false;
  if (fit && !sliding) {
    const drift = fit.etaIdentified ? fit.eta : 0;
    const jump = scan.jumps.filter((j) => j.du > RECALIBRATE_FACTOR * drift * j.dur).at(-1);
    if (jump) {
      recalibrate = true;
      usable.forEach((s, i) => {
        if (s.at < jump.at) weights[i] = (weights[i] ?? 1) / 2;
      });
      fit = fitSpans(usable, weights, sliding) ?? fit;
    }
  }

  const delta = w.quantum;
  if (fit && usable.length > 0) {
    const n = usable.length;
    const sumDu = usable.reduce((a, s) => a + Math.abs(s.du), 0);
    const quantRel = sumDu > 0 ? (n * delta * delta) / 6 / (sumDu * sumDu) : 0;
    const quality = fit.etaIdentified || n >= ETA_MIN_SPANS ? "calibrated" : "coarse";
    let relSd = Math.sqrt(fit.seRel ** 2 + quantRel);
    if (quality === "coarse") relSd = Math.max(COARSE_MIN_RELSD, relSd);
    return {
      cal: {
        ...empty,
        beta: { value: fit.beta, relSd, quality },
        eta: fit.etaIdentified ? fit.eta : 0,
        etaIdentified: fit.etaIdentified,
      },
      recalibrate,
    };
  }
  // No closed span: an open span with Δu ≥ 2 quanta is still coarse evidence.
  const open = scan.open;
  if (open && open.cu > 0 && open.du >= 2 * delta - EPS && open.du > 0) {
    return {
      cal: {
        ...empty,
        beta: { value: open.du / open.cu, relSd: COARSE_MIN_RELSD, quality: "coarse" },
      },
      recalibrate,
    };
  }
  return { cal: empty, recalibrate };
}

interface OwnCalibration {
  windows: Record<WindowKey, WindowCalibration>;
  recalibrate: boolean;
}

function ownCalibration(
  state: AllowanceState,
  track: AccountTrack,
  cfg: AllowanceConfig
): OwnCalibration {
  const cuBetween = cuCounter(track);
  const refAt = state.lastAt ?? 0;
  const windows: Record<WindowKey, WindowCalibration> = {};
  let recalibrate = false;
  for (const w of liveTracks(track)) {
    const r = windowCalibration(w, cuBetween, refAt, cfg);
    windows[w.key] = r.cal;
    recalibrate ||= r.recalibrate;
  }
  return { windows, recalibrate };
}

/** ΣΔu_s and ΣΔu_g over readings of s and g taken together, inside one epoch of each. */
function coObserved(
  s: WindowTrack,
  g: WindowTrack,
  semS: Semantics,
  semG: Semantics,
  cfg: Pick<AllowanceConfig, "EPOCH_TOL_MS">
): { dS: number; dG: number } {
  const epochS = epochOf(s.readings, semS, s.quantum, cfg);
  const epochG = epochOf(g.readings, semG, g.quantum, cfg);
  const gAt = new Map<Ms, { r: ReadingPoint; epoch: number }>();
  g.readings.forEach((r, i) => gAt.set(r.at, { r, epoch: epochG[i] ?? 0 }));
  let dS = 0;
  let dG = 0;
  for (let i = 1; i < s.readings.length; i++) {
    const a = s.readings[i - 1];
    const b = s.readings[i];
    if (!a || !b || epochS[i - 1] !== epochS[i]) continue;
    const ga = gAt.get(a.at);
    const gb = gAt.get(b.at);
    if (!ga || !gb || ga.epoch !== gb.epoch) continue;
    dS += b.usedFraction - a.usedFraction;
    dG += gb.r.usedFraction - ga.r.usedFraction;
  }
  return { dS, dG };
}

/** The mean of the strong estimates of `key` on other accounts of the same plan class. */
function pooled(
  state: AllowanceState,
  track: AccountTrack,
  pick: (other: AccountTrack) => Estimate | null
): Estimate | null {
  if (track.planClass === null) return null;
  const values: number[] = [];
  for (const other of Object.values(state.accounts)) {
    if (other.id === track.id || other.planClass !== track.planClass) continue;
    const e = pick(other);
    if (isStrong(e)) values.push(e.value);
  }
  if (values.length === 0) return null;
  return {
    value: values.reduce((a, b) => a + b, 0) / values.length,
    relSd: PRIOR_RELSD,
    quality: "prior",
  };
}

function kappaOf(
  track: AccountTrack,
  own: OwnCalibration,
  key: WindowKey,
  governing: WindowKey,
  cfg: AllowanceConfig
): Estimate | null {
  const s = track.windows[key];
  const g = track.windows[governing];
  const semS = own.windows[key]?.semantics;
  const semG = own.windows[governing]?.semantics;
  if (!s || !g || !semS || !semG) return null;
  const { dS, dG } = coObserved(s, g, semS, semG, cfg);
  if (!(dG > EPS) || !(dS > EPS)) return null;
  const calibrated = dG >= cfg.KAPPA_MIN_LONG - EPS && dS >= cfg.CAL_MIN_DELTA - EPS;
  return {
    value: dS / dG,
    relSd: calibrated ? Math.min(COARSE_MIN_RELSD, (2 * g.quantum) / dG) : COARSE_MIN_RELSD,
    quality: calibrated ? "calibrated" : "coarse",
  };
}

/** Is `key` a window strictly shorter than the governing one (both lengths known)? */
function isShorter(track: AccountTrack, key: WindowKey, governing: WindowKey): boolean {
  const s = track.windows[key]?.lengthMinutes;
  const g = track.windows[governing]?.lengthMinutes;
  return (
    key !== governing && s !== null && s !== undefined && g !== null && g !== undefined && s < g
  );
}

/** β, κ and external drift for one account, with pooled priors from its plan-class peers. */
export function calibration(
  state: AllowanceState,
  account: AccountId,
  cfg: AllowanceConfig
): AccountCalibration {
  const track = state.accounts[account];
  const none: Estimate = { value: 0, relSd: PRIOR_RELSD, quality: "prior" };
  if (!track) {
    return {
      account,
      windows: {},
      beta: {},
      kappa: {},
      externalPerHour: none,
      governing: null,
      recalibrate: false,
    };
  }
  const own = ownCalibration(state, track, cfg);
  const governing = governingKey(track);
  const peers = new Map<AccountId, OwnCalibration>();
  const peer = (other: AccountTrack) => {
    let cal = peers.get(other.id);
    if (!cal) {
      cal = ownCalibration(state, other, cfg);
      peers.set(other.id, cal);
    }
    return cal;
  };

  const beta: Record<WindowKey, Estimate> = {};
  for (const [key, cal] of Object.entries(own.windows)) {
    const estimate = isStrong(cal.beta)
      ? cal.beta
      : pooled(state, track, (other) => peer(other).windows[key]?.beta ?? null);
    if (estimate) beta[key] = estimate;
  }

  const kappa: Record<WindowKey, Estimate> = {};
  if (governing !== null) {
    for (const key of Object.keys(own.windows)) {
      if (!isShorter(track, key, governing)) continue;
      const k = kappaOf(track, own, key, governing, cfg);
      const estimate =
        k?.quality === "calibrated"
          ? k
          : (pooled(state, track, (other) => {
              const g = governingKey(other);
              return g === null || !isShorter(other, key, g)
                ? null
                : kappaOf(other, peer(other), key, g, cfg);
            }) ?? k);
      if (estimate) kappa[key] = estimate;
    }
  }

  let externalPerHour = none;
  const g = governing === null ? null : own.windows[governing];
  const gBeta = governing === null ? undefined : beta[governing];
  if (g?.etaIdentified && isStrong(gBeta) && gBeta.value > 0) {
    externalPerHour = { value: g.eta / gBeta.value, relSd: gBeta.relSd, quality: gBeta.quality };
  }

  return {
    account,
    windows: own.windows,
    beta,
    kappa,
    externalPerHour,
    governing,
    recalibrate: own.recalibrate,
  };
}
