/**
 * Contributions (architecture §1.10): which sessions spent a window, and how
 * much of it nobody in claudish did.
 *
 * The default window is each account's governing window over its current epoch
 * (`R_g − L_g → now`; the last L for a sliding one); `"binding"` takes the
 * account's binding window, a key that window. A span runs between two
 * consecutive OBSERVED readings inside the epoch (as calibration's spans do:
 * never from an assumed 0), with `d = max(0, Δu)`:
 *
 * ```
 * p_j          = β̂·cu_j                  per session j in the span
 * s            = min(1, d / Σ p_j)        sessions never exceed what was observed
 * d̃_j          = p_j·s
 * unattributed = d − Σ d̃_j               external use, cost-model error, quantization
 * ```
 *
 * `cu_j` in a span: the state keeps a session's cu per (hour, account), so each
 * hour's cell is the session's share of that hour, applied to the account's
 * served cu (exact times) that falls inside the span. With one session in an
 * hour this is exact.
 *
 * Rows are summed per session and ranked by `usedFraction`, then cu; the last
 * row is always `unattributed`. Conservation: `Σ rows + unattributed = Σ d`
 * within 1e-9. `exactness`: `uncalibrated` (β a prior or absent: shares from cu
 * alone, `usedFraction` null), `external-unidentified` (β at least coarse but η
 * not identifiable: the unattributed row is a lower bound), else
 * `single-session` when every span of the row had one session, `pro-rata`
 * otherwise.
 */

import { calibration, isStrong } from "./calibrate.js";
import { accountViews } from "./capacity.js";
import type {
  AccountId,
  AccountView,
  AllowanceConfig,
  AllowanceState,
  Contribution,
  Ms,
  SessionKey,
  TokenCounts,
  WindowKey,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const EPS = 1e-12;

interface Row {
  session: SessionKey;
  accounts: Set<AccountId>;
  window: WindowKey;
  /** Σ d̃_j in window fractions (null once a span had no usable β). */
  fraction: number;
  cu: number;
  firstAt: Ms;
  lastAt: Ms;
  multi: boolean;
}

interface Spent {
  account: AccountId;
  window: WindowKey;
  /** Σ d over the spans. */
  observed: number;
  unattributedFraction: number;
  unattributedCu: number;
  firstAt: Ms | null;
  lastAt: Ms | null;
  calibrated: boolean;
  etaIdentified: boolean;
}

/** cu served by the account in (t0, t1]. */
function servedIn(s: AllowanceState, account: AccountId, t0: Ms, t1: Ms): number {
  let cu = 0;
  for (const x of s.accounts[account]?.served ?? []) if (x.at > t0 && x.at <= t1) cu += x.cu;
  return cu;
}

/** Each session's cu on `account` in (t0, t1]. */
function sessionsIn(
  s: AllowanceState,
  account: AccountId,
  t0: Ms,
  t1: Ms
): Map<SessionKey, number> {
  const out = new Map<SessionKey, number>();
  const hourTotals = new Map<Ms, number>();
  for (const [key, track] of Object.entries(s.sessions)) {
    for (const cell of track.hours) {
      if (cell.account !== account || cell.hour + HOUR_MS <= t0 || cell.hour > t1) continue;
      let total = hourTotals.get(cell.hour);
      if (total === undefined) {
        total = servedIn(s, account, cell.hour - 1, cell.hour + HOUR_MS - 1);
        hourTotals.set(cell.hour, total);
      }
      if (!(total > 0)) continue;
      const inside = servedIn(
        s,
        account,
        Math.max(t0, cell.hour - 1),
        Math.min(t1, cell.hour + HOUR_MS - 1)
      );
      const cu = (cell.cu / total) * inside;
      if (cu > EPS) out.set(key, (out.get(key) ?? 0) + cu);
    }
  }
  return out;
}

function windowFor(view: AccountView, q: WindowKey | "binding" | undefined): WindowKey | null {
  if (q === undefined) return view.governing;
  if (q === "binding") return view.binding;
  return view.windows.some((w) => w.key === q) ? q : null;
}

/** The current epoch's start for a window, or null when it is unknown (every reading counts). */
function epochStart(view: AccountView, key: WindowKey, now: Ms): Ms | null {
  const w = view.windows.find((x) => x.key === key);
  if (!w || w.lengthMinutes === null) return null;
  const L = w.lengthMinutes * MINUTE_MS;
  if (w.semantics === "sliding") return now - L;
  return w.resetAt === null ? null : w.resetAt - L;
}

function spend(
  s: AllowanceState,
  view: AccountView,
  key: WindowKey,
  now: Ms,
  rows: Map<SessionKey, Row>,
  cfg: AllowanceConfig
): Spent {
  const beta = view.beta[key];
  const calibrated = isStrong(beta) && beta.value > 0;
  const cal = calibration(s, view.account, cfg);
  const spent: Spent = {
    account: view.account,
    window: key,
    observed: 0,
    unattributedFraction: 0,
    unattributedCu: 0,
    firstAt: null,
    lastAt: null,
    calibrated,
    etaIdentified: cal.windows[key]?.etaIdentified ?? false,
  };
  const from = epochStart(view, key, now);
  const readings = (s.accounts[view.account]?.windows[key]?.readings ?? []).filter(
    (r) => r.at <= now && (from === null || r.at >= from)
  );
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    if (!a || !b || b.at <= a.at) continue;
    const d = Math.max(0, b.usedFraction - a.usedFraction);
    const sessions = sessionsIn(s, view.account, a.at, b.at);
    if (d <= 0 && sessions.size === 0) continue;
    spent.observed += d;
    spent.firstAt = spent.firstAt === null ? a.at : Math.min(spent.firstAt, a.at);
    spent.lastAt = spent.lastAt === null ? b.at : Math.max(spent.lastAt, b.at);
    const sumP = calibrated ? [...sessions.values()].reduce((x, cu) => x + beta.value * cu, 0) : 0;
    const scale = calibrated ? (sumP > 0 ? Math.min(1, d / sumP) : 1) : 0;
    let attributed = 0;
    for (const [session, cu] of sessions) {
      const share = calibrated ? beta.value * cu * scale : 0;
      attributed += share;
      let row = rows.get(session);
      if (!row) {
        row = {
          session,
          accounts: new Set(),
          window: key,
          fraction: 0,
          cu: 0,
          firstAt: a.at,
          lastAt: b.at,
          multi: false,
        };
        rows.set(session, row);
      }
      row.accounts.add(view.account);
      row.fraction += share;
      row.cu += calibrated ? cu * scale : cu;
      row.firstAt = Math.min(row.firstAt, a.at);
      row.lastAt = Math.max(row.lastAt, b.at);
      row.multi ||= sessions.size > 1;
    }
    const left = calibrated ? d - attributed : 0;
    spent.unattributedFraction += left;
    if (calibrated) spent.unattributedCu += left / beta.value;
  }
  return spent;
}

const ZERO: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export function contributions(
  s: AllowanceState,
  q: { now: Ms; account?: AccountId; window?: WindowKey | "binding" },
  cfg: AllowanceConfig
): Contribution[] {
  const views = accountViews(s, q.now, cfg).filter(
    (v) => q.account === undefined || v.account === q.account
  );
  const rows = new Map<SessionKey, Row>();
  const spent: Spent[] = [];
  for (const v of views) {
    const key = windowFor(v, q.window);
    if (key === null) continue;
    spent.push(spend(s, v, key, q.now, rows, cfg));
  }
  if (spent.length === 0) return [];

  const single = spent.length === 1 ? spent[0] : undefined;
  const account: AccountId | "all" = single ? single.account : "all";
  const window = single ? single.window : (q.window ?? "governing");
  const calibrated = spent.every((x) => x.calibrated);
  const base: Contribution["exactness"] | null = !calibrated
    ? "uncalibrated"
    : spent.some((x) => !x.etaIdentified)
      ? "external-unidentified"
      : null;
  const observed = spent.reduce((a, x) => a + x.observed, 0);
  const totalCu = [...rows.values()].reduce((a, r) => a + r.cu, 0);

  const out: Contribution[] = [...rows.values()].map((r) => {
    const track = s.sessions[r.session];
    const share = calibrated
      ? observed > 0
        ? r.fraction / observed
        : 0
      : totalCu > 0
        ? r.cu / totalCu
        : 0;
    return {
      session: r.session,
      account: r.accounts.size === 1 && single ? single.account : account,
      window: r.window,
      usedFraction: calibrated && single ? r.fraction : null,
      cu: r.cu,
      share,
      tokens: track ? { ...track.tokens } : { ...ZERO },
      models: track ? { ...track.models } : {},
      firstAt: r.firstAt,
      lastAt: r.lastAt,
      exactness: base ?? (r.multi ? "pro-rata" : "single-session"),
    };
  });
  out.sort(
    (a, b) =>
      (b.usedFraction ?? 0) - (a.usedFraction ?? 0) ||
      b.cu - a.cu ||
      (a.session < b.session ? -1 : 1)
  );

  const unattributed = spent.reduce((a, x) => a + x.unattributedFraction, 0);
  const firsts = spent.map((x) => x.firstAt).filter((t): t is Ms => t !== null);
  const lasts = spent.map((x) => x.lastAt).filter((t): t is Ms => t !== null);
  out.push({
    session: "unattributed",
    account,
    window,
    usedFraction: calibrated && single ? unattributed : null,
    cu: calibrated ? spent.reduce((a, x) => a + x.unattributedCu, 0) : 0,
    share: calibrated && observed > 0 ? unattributed / observed : 0,
    tokens: { ...ZERO },
    models: {},
    firstAt: firsts.length > 0 ? Math.min(...firsts) : q.now,
    lastAt: lasts.length > 0 ? Math.max(...lasts) : q.now,
    exactness: base ?? "pro-rata",
  });
  return out;
}
