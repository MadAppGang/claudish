/**
 * The tournament's measurements (architecture §4 `metrics.ts`) and the gate
 * that alone may promote a new default.
 *
 * Per run (`summarize`), from the run log and the hidden truth it recorded:
 * - `unservedCu`; `blockedHours` (every hour the pool was blocked, by the truth
 *   at its start or by an unserved request in it), split 7d/5h, and
 *   demand-weighted (each blocked hour weighs its demand over the run's mean
 *   hourly demand);
 * - `wastePct`: the governing windows' unused cu at their resets over the
 *   capacity bought in the run (sliding windows expire continuously and are
 *   not counted); `longestGapH`;
 * - `switchesPer100` (requests moved off the thread's account) and the rebuild
 *   cu they cost at the hidden weights; `staleShare` (requests decided by the
 *   sticky fallback); `plansPerDay`;
 * - `forecastServedError`: |served cu over the next 24 h as `simulate`
 *   forecast it − realized| / realized, median over the samples;
 *   `bandCoverage`: the share of samples whose realized 24 h demand fell inside
 *   the forecast's p10–p90 (target 0.80 ± 0.05);
 * - alerts (WARN): `leadTimeH` (gap start − the raise that was standing at it,
 *   for truth 7d gaps ≥ WARN_GAP_H starting at least 6 h into the run),
 *   `missedGaps` (lead < 6 h, or none), `falseAlarmRate` (raises with no truth
 *   gap ≥ 6 h overlapping the next WARN_LEAD + 24 h, among the raises whose
 *   look-ahead ends inside the run), `flaps` (a raise within 24 h of a clear)
 *   with `clears`,
 *   and the recovery clear time of §5 case 38b.
 *
 * `aggregate` takes medians and p95 over matched seeds, with paired
 * differences against `sticky`; `gate` applies §4's rule in order.
 */

import type { AllowanceConfig } from "../types.js";
import type { RunLog } from "./run.js";
import type { AdversarialReport, ContestantName } from "./tournament.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MISSED_LEAD_H = 6;
const FALSE_ALARM_GAP_H = 6;
const FLAP_WINDOW_MS = DAY_MS;

export interface RunSummary {
  scenario: string;
  contestant: ContestantName;
  seed: number;
  days: number;
  requests: number;
  demandCu: number;
  unservedCu: number;
  blockedHours: { all: number; d7: number; h5: number };
  demandWeightedBlockedHours: { all: number; d7: number; h5: number };
  wastePct: number;
  longestGapH: number;
  switchesPer100: number;
  switchesPerDay: number;
  rebuildCu: number;
  staleShare: number | null;
  plansPerDay: number;
  /** p95 of one `planFor`, when the caller timed them. */
  planMsP95: number | null;
  /** p95 of one alert step (no payload), when the caller timed them. */
  alertMsP95: number | null;
  forecastServedError: number | null;
  bandCoverage: number | null;
  alerts: AlertSummary | null;
}

export interface AlertSummary {
  raises: number;
  clears: number;
  flaps: number;
  /** Truth 7d gaps of at least WARN_GAP_H. */
  gaps: number;
  /** Median lead over those gaps that had a standing raise; null when none had one. */
  leadTimeH: number | null;
  missedGaps: number;
  falseAlarmRate: number | null;
  /** Minutes from the vendor-side reset to the next WARN clear (§5 case 38b); null when not applicable. */
  recoveryClearMin: number | null;
}

function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

export function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const x = (s.length - 1) * p;
  const lo = Math.floor(x);
  const hi = Math.min(s.length - 1, lo + 1);
  return (s[lo] ?? 0) + ((s[hi] ?? 0) - (s[lo] ?? 0)) * (x - lo);
}

interface TruthGap {
  start: number;
  end: number;
  kind: "7d" | "5h";
}

function truthGaps(log: RunLog): TruthGap[] {
  const out: TruthGap[] = [];
  let run: TruthGap | null = null;
  for (const h of log.hours) {
    if (h.blocked !== null) {
      if (run === null) run = { start: h.at, end: h.at + HOUR_MS, kind: h.blocked };
      else {
        run.end = h.at + HOUR_MS;
        if (h.blocked === "7d") run.kind = "7d";
      }
    } else if (run !== null) {
      out.push(run);
      run = null;
    }
  }
  if (run !== null) out.push(run);
  return out;
}

function alertSummary(log: RunLog, cfg: AllowanceConfig): AlertSummary {
  const warn = log.transitions.filter((t) => t.level === "warn");
  const raises = warn.filter((t) => t.to === "raised");
  const clears = warn.filter((t) => t.to === "cleared");
  let flaps = 0;
  for (const r of raises) {
    const lastClear = clears.filter((c) => c.at <= r.at).at(-1);
    if (lastClear && r.at - lastClear.at <= FLAP_WINDOW_MS) flaps++;
  }
  const gaps = truthGaps(log);
  // A gap that starts within MISSED_LEAD_H of the run's start cannot be warned 6 h ahead by any
  // rule: it is counted in `gaps` but neither as a lead nor as a miss.
  const long = gaps.filter(
    (g) =>
      g.kind === "7d" &&
      g.end - g.start >= cfg.WARN_GAP_H * HOUR_MS &&
      g.start >= log.start + MISSED_LEAD_H * HOUR_MS
  );
  const leads: number[] = [];
  let missed = 0;
  for (const g of long) {
    // The raise standing at the gap's start: the last raise before it with no clear in between.
    const before = warn.filter((t) => t.at <= g.start);
    const last = before.at(-1);
    const lead = last && last.to === "raised" ? (g.start - last.at) / HOUR_MS : null;
    if (lead !== null) leads.push(lead);
    if (lead === null || lead < MISSED_LEAD_H) missed++;
  }
  // A raise whose look-ahead runs past the run's end is censored, not judged.
  const judged = raises.filter((r) => r.at + (cfg.WARN_LEAD_H + 24) * HOUR_MS <= log.end);
  let falseAlarms = 0;
  for (const r of judged) {
    const until = r.at + (cfg.WARN_LEAD_H + 24) * HOUR_MS;
    const real = gaps.some(
      (g) => g.end - g.start >= FALSE_ALARM_GAP_H * HOUR_MS && g.start < until && g.end > r.at
    );
    if (!real) falseAlarms++;
  }
  let recoveryClearMin: number | null = null;
  if (log.recoveryAt !== null) {
    const clear = clears.find((c) => c.at >= (log.recoveryAt ?? 0));
    recoveryClearMin = clear
      ? (clear.at - (log.recoveryAt ?? 0)) / 60_000
      : Number.POSITIVE_INFINITY;
  }
  return {
    raises: raises.length,
    clears: clears.length,
    flaps,
    gaps: long.length,
    leadTimeH: leads.length > 0 ? median(leads) : null,
    missedGaps: missed,
    falseAlarmRate: judged.length > 0 ? falseAlarms / judged.length : null,
    recoveryClearMin,
  };
}

export function summarize(
  log: RunLog,
  cfg: AllowanceConfig,
  opts: { alerts: boolean; planMs?: readonly number[]; alertMs?: readonly number[] }
): RunSummary {
  const days = (log.end - log.start) / DAY_MS;
  const hours = log.hours.length;
  const demandByHour = new Array(hours).fill(0);
  const servedAt: { at: number; cu: number }[] = [];
  let demandCu = 0;
  let unservedCu = 0;
  let switches = 0;
  let rebuildCu = 0;
  let stale = 0;
  let rankedRequests = 0;
  let served = 0;
  for (const r of log.requests) {
    const k = Math.floor((r.at - log.start) / HOUR_MS);
    demandByHour[k] = (demandByHour[k] ?? 0) + r.cu;
    demandCu += r.cu;
    if (r.account === null) unservedCu += r.cu;
    else {
      served++;
      servedAt.push({ at: r.at, cu: r.cu });
    }
    if (r.switched) switches++;
    rebuildCu += r.rebuildCu;
    if (r.ranked) {
      rankedRequests++;
      if (r.stale) stale++;
    }
  }
  const meanHour = hours > 0 ? demandCu / hours : 0;
  const blocked = { all: 0, d7: 0, h5: 0 };
  const weighted = { all: 0, d7: 0, h5: 0 };
  log.hours.forEach((h, k) => {
    if (h.blocked === null) return;
    const w = meanHour > 0 ? (demandByHour[k] ?? 0) / meanHour : 0;
    blocked.all++;
    weighted.all += w;
    if (h.blocked === "7d") {
      blocked.d7++;
      weighted.d7 += w;
    } else {
      blocked.h5++;
      weighted.h5 += w;
    }
  });
  const gaps = truthGaps(log);
  const longestGapH = gaps.reduce((a, g) => Math.max(a, (g.end - g.start) / HOUR_MS), 0);

  // Capacity bought: every governing epoch that ran in the window, one per reset plus the first.
  const perAccount = new Map<string, { capacity: number; resets: number; left: number }>();
  for (const r of log.resets) {
    const e = perAccount.get(r.account) ?? { capacity: r.capacityCu, resets: 0, left: 0 };
    e.resets++;
    e.left += r.leftCu;
    perAccount.set(r.account, e);
  }
  let bought = 0;
  let wasted = 0;
  for (const e of perAccount.values()) {
    bought += e.capacity * (e.resets + 1);
    wasted += e.left;
  }

  servedAt.sort((a, b) => a.at - b.at);
  const servedIn = (from: number, to: number) =>
    servedAt.filter((x) => x.at >= from && x.at < to).reduce((a, x) => a + x.cu, 0);
  const demandIn = (from: number, to: number) =>
    log.requests.filter((x) => x.at >= from && x.at < to).reduce((a, x) => a + x.cu, 0);
  const errors: number[] = [];
  let covered = 0;
  let bands = 0;
  for (const f of log.forecasts) {
    if (f.at + DAY_MS > log.end) continue;
    const realized = servedIn(f.at, f.at + DAY_MS);
    if (f.servedCu !== null && realized > 0)
      errors.push(Math.abs(f.servedCu - realized) / realized);
    if (f.demandP10 !== null && f.demandP90 !== null && f.demandP90 > f.demandP10) {
      bands++;
      const d = demandIn(f.at, f.at + DAY_MS);
      if (d >= f.demandP10 && d <= f.demandP90) covered++;
    }
  }

  return {
    scenario: log.scenario,
    contestant: log.contestant as ContestantName,
    seed: log.seed,
    days,
    requests: log.requests.length,
    demandCu,
    unservedCu,
    blockedHours: blocked,
    demandWeightedBlockedHours: weighted,
    wastePct: bought > 0 ? (100 * wasted) / bought : 0,
    longestGapH,
    switchesPer100: served > 0 ? (100 * switches) / served : 0,
    switchesPerDay: days > 0 ? switches / days : 0,
    rebuildCu,
    staleShare: rankedRequests > 0 ? stale / rankedRequests : null,
    plansPerDay: days > 0 ? log.plans / days : 0,
    planMsP95: opts.planMs && opts.planMs.length > 0 ? quantile(opts.planMs, 0.95) : null,
    alertMsP95: opts.alertMs && opts.alertMs.length > 0 ? quantile(opts.alertMs, 0.95) : null,
    forecastServedError: errors.length > 0 ? median(errors) : null,
    bandCoverage: bands > 0 ? covered / bands : null,
    alerts: opts.alerts ? alertSummary(log, cfg) : null,
  };
}

// ---------------------------------------------------------------------------
// Aggregation over seeds

export interface Stat {
  median: number;
  p95: number;
}

export interface Aggregate {
  scenario: string;
  contestant: ContestantName;
  seeds: number;
  unservedCu: Stat;
  /** Paired median of (X − sticky) on the same seeds. */
  unservedVsSticky: number | null;
  demandWeightedBlockedHours: Stat;
  blockedVsSticky: number | null;
  blockedHours7d: Stat;
  blockedHours5h: Stat;
  wastePct: Stat;
  longestGapH: Stat;
  switchesPer100: Stat;
  switchesPerDay: Stat;
  rebuildCu: Stat;
  staleShare: number | null;
  plansPerDay: number;
  planMsP95: number | null;
  alertMsP95: number | null;
  forecastServedError: number | null;
  bandCoverage: number | null;
  alerts: {
    leadTimeH: number | null;
    falseAlarmRate: number | null;
    flaps: number;
    clears: number;
    missedGaps: number;
    raises: number;
    recoveryClearMin: number | null;
  } | null;
}

function stat(xs: readonly number[]): Stat {
  return { median: median(xs), p95: quantile(xs, 0.95) };
}

function maybeMedian(xs: readonly (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length > 0 ? median(v) : null;
}

function paired(
  mine: readonly RunSummary[],
  sticky: readonly RunSummary[],
  pick: (s: RunSummary) => number
): number | null {
  const bySeed = new Map(sticky.map((s) => [s.seed, s]));
  const diffs: number[] = [];
  for (const s of mine) {
    const base = bySeed.get(s.seed);
    if (base) diffs.push(pick(s) - pick(base));
  }
  return diffs.length > 0 ? median(diffs) : null;
}

export function aggregate(runs: readonly RunSummary[]): Aggregate[] {
  const out: Aggregate[] = [];
  const keys = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const key = `${r.scenario}\u0000${r.contestant}`;
    const list = keys.get(key) ?? [];
    list.push(r);
    keys.set(key, list);
  }
  for (const list of keys.values()) {
    const first = list[0];
    if (!first) continue;
    const sticky = runs.filter((r) => r.scenario === first.scenario && r.contestant === "sticky");
    const alerts = list.map((r) => r.alerts).filter((a): a is AlertSummary => a !== null);
    out.push({
      scenario: first.scenario,
      contestant: first.contestant,
      seeds: list.length,
      unservedCu: stat(list.map((r) => r.unservedCu)),
      unservedVsSticky: paired(list, sticky, (r) => r.unservedCu),
      demandWeightedBlockedHours: stat(list.map((r) => r.demandWeightedBlockedHours.all)),
      blockedVsSticky: paired(list, sticky, (r) => r.demandWeightedBlockedHours.all),
      blockedHours7d: stat(list.map((r) => r.blockedHours.d7)),
      blockedHours5h: stat(list.map((r) => r.blockedHours.h5)),
      wastePct: stat(list.map((r) => r.wastePct)),
      longestGapH: stat(list.map((r) => r.longestGapH)),
      switchesPer100: stat(list.map((r) => r.switchesPer100)),
      switchesPerDay: stat(list.map((r) => r.switchesPerDay)),
      rebuildCu: stat(list.map((r) => r.rebuildCu)),
      staleShare: maybeMedian(list.map((r) => r.staleShare)),
      plansPerDay: median(list.map((r) => r.plansPerDay)),
      planMsP95: maybeMedian(list.map((r) => r.planMsP95)),
      alertMsP95: maybeMedian(list.map((r) => r.alertMsP95)),
      forecastServedError: maybeMedian(list.map((r) => r.forecastServedError)),
      bandCoverage: maybeMedian(list.map((r) => r.bandCoverage)),
      alerts:
        alerts.length > 0
          ? {
              leadTimeH: maybeMedian(alerts.map((a) => a.leadTimeH)),
              falseAlarmRate: maybeMedian(alerts.map((a) => a.falseAlarmRate)),
              flaps: alerts.reduce((a, x) => a + x.flaps, 0),
              clears: alerts.reduce((a, x) => a + x.clears, 0),
              missedGaps: alerts.reduce((a, x) => a + x.missedGaps, 0),
              raises: alerts.reduce((a, x) => a + x.raises, 0),
              recoveryClearMin: maybeMedian(alerts.map((a) => a.recoveryClearMin)),
            }
          : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate (§4): the only path to a new default

export interface GateItem {
  item: number;
  pass: boolean;
  detail: string;
}

export interface GateResult {
  contestant: ContestantName;
  pass: boolean;
  items: GateItem[];
}

/** Scenarios where strictly lower unserved cu is required on at least one. */
const STRICT_SCENARIOS = ["steady · 2× offset 26 h", "weekday-heavy · 2× offset 26 h"];
/** The alert criteria are read on these (the over-subscribed family, recovery excluded). */
function alertScenario(name: string): boolean {
  return name.startsWith("over-subscribed · ");
}

export function gate(
  contestant: "ebr" | "lookahead",
  aggregates: readonly Aggregate[],
  adversarial: AdversarialReport
): GateResult {
  const items: GateItem[] = [];
  const mine = aggregates.filter((a) => a.contestant === contestant);
  const stickyOf = (scenario: string) =>
    aggregates.find((a) => a.scenario === scenario && a.contestant === "sticky");

  // 1. Every adversarial trace.
  const served = adversarial.served;
  const failures: string[] = [];
  for (const trace of new Set(served.map((s) => s.trace))) {
    const x = served.find((s) => s.trace === trace && s.contestant === contestant);
    const st = served.find((s) => s.trace === trace && s.contestant === "sticky");
    if (!x || !st) continue;
    if (x.served < st.served) failures.push(`${trace}: ${x.served} < sticky ${st.served}`);
    if (["R1", "gpt #1", "opus H1"].includes(trace) && x.served < x.oracle)
      failures.push(`${trace}: ${x.served} < oracle ${x.oracle}`);
    if (!x.pass) failures.push(`${trace}: expectation`);
  }
  for (const c of adversarial.checks) {
    if (c.under === contestant || !["sticky", "ebr", "lookahead"].includes(c.under)) {
      if (!c.pass) failures.push(`${c.trace} (${c.under})`);
    }
  }
  items.push({
    item: 1,
    pass: failures.length === 0,
    detail: failures.join("; ") || "every trace",
  });

  // 2. Unserved ≤ sticky at the median and p95; strictly lower on a named scenario.
  const worse2: string[] = [];
  let strictly = false;
  for (const a of mine) {
    const s = stickyOf(a.scenario);
    if (!s) continue;
    if (a.unservedCu.median > s.unservedCu.median || a.unservedCu.p95 > s.unservedCu.p95)
      worse2.push(a.scenario);
    if (STRICT_SCENARIOS.includes(a.scenario) && a.unservedCu.median < s.unservedCu.median)
      strictly = true;
  }
  items.push({
    item: 2,
    pass: worse2.length === 0 && strictly,
    detail:
      (worse2.length > 0 ? `more unserved on: ${worse2.join(", ")}` : "never more unserved") +
      (strictly
        ? "; strictly lower on a 2× offset 26 h scenario"
        : "; NOT strictly lower on steady/weekday-heavy 2× offset 26 h"),
  });

  // 3. Demand-weighted blocked hours ≤ sticky at the median and p95.
  const worse3 = mine
    .filter((a) => {
      const s = stickyOf(a.scenario);
      return (
        s !== undefined &&
        (a.demandWeightedBlockedHours.median > s.demandWeightedBlockedHours.median ||
          a.demandWeightedBlockedHours.p95 > s.demandWeightedBlockedHours.p95)
      );
    })
    .map((a) => a.scenario);
  items.push({
    item: 3,
    pass: worse3.length === 0,
    detail: worse3.length > 0 ? `more blocked on: ${worse3.join(", ")}` : "never more blocked",
  });

  // 4. Waste: a tie-break only.
  items.push({ item: 4, pass: true, detail: "reported, never a gate" });

  // 5. Switches ≤ 1.2 × sticky + 1 per day.
  const worse5 = mine
    .filter((a) => {
      const s = stickyOf(a.scenario);
      return s !== undefined && a.switchesPerDay.median > 1.2 * s.switchesPerDay.median + 1;
    })
    .map((a) => a.scenario);
  items.push({
    item: 5,
    pass: worse5.length === 0,
    detail:
      worse5.length > 0
        ? `too many switches on: ${worse5.join(", ")}`
        : "within 1.2× sticky + 1/day",
  });

  // 6. Alerts on over-subscribed.
  const alertRows = mine.filter((a) => alertScenario(a.scenario) && a.alerts !== null);
  const bad6: string[] = [];
  for (const a of alertRows) {
    const al = a.alerts;
    if (!al) continue;
    if (al.leadTimeH === null || al.leadTimeH < 24)
      bad6.push(`${a.scenario}: lead ${al.leadTimeH?.toFixed(1) ?? "none"} h`);
    if (al.falseAlarmRate !== null && al.falseAlarmRate > 0.1)
      bad6.push(`${a.scenario}: false alarms ${(100 * al.falseAlarmRate).toFixed(0)} %`);
    if (al.flaps > 0) bad6.push(`${a.scenario}: ${al.flaps} flaps`);
    if (al.clears === 0) bad6.push(`${a.scenario}: no clears`);
    if (al.missedGaps > 0) bad6.push(`${a.scenario}: ${al.missedGaps} missed gaps`);
  }
  items.push({
    item: 6,
    pass: alertRows.length > 0 && bad6.length === 0,
    detail: alertRows.length === 0 ? "no alert scenario ran" : bad6.join("; ") || "all hold",
  });

  // 7. Reported.
  items.push({ item: 7, pass: true, detail: "plan time p95 and staleDecisions reported" });

  return { contestant, pass: items.every((i) => i.pass), items };
}
