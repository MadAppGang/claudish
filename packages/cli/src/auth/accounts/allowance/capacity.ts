/**
 * Remaining capacity (architecture §1.4, §1.5, §1.8 step 2): the account view
 * every strategy, the search and the simulator read, and the shared tests
 * that are never written per strategy — *usable*, *hard-full* against THIS
 * request's cost, and *read* or *unread*.
 *
 * - **A passed reset is not an observed 0 %.** After `resetAt` passes with no
 *   newer reading, the window is `1 − e·β·Δt`, provenance `reset-inferred`
 *   (e·β taken as 0 while β is a prior or null). Such an account is READ.
 * - **A stale reading whose reset is still ahead is used as is**, however old:
 *   no decay, as in `policy.ts`.
 * - **Never read** ⇒ provenance `unknown`, `remaining: null`: the account is
 *   unread, simulated by nothing, and counted as no capacity.
 * - **Deliverable** before the governing reset T credits a fresh shorter window
 *   only for the share of its length before T (R3: floor plus the residual,
 *   never `ceil`), and only through a calibrated κ.
 * - **Combined immediate capacity** sums across accounts, never across nested
 *   windows; units never mix (`cu` only when every β is at least coarse).
 * - **The overlay** puts fresh readings over the views without folding or
 *   cloning the state on the request path (opus M2).
 */

import { calibration, isStrong, liveTracks } from "./calibrate.js";
import { costPriorsFor } from "./constants.js";
import { classifySemantics } from "./semantics.js";
import type {
  AccountId,
  AccountTrack,
  AccountView,
  AllowanceConfig,
  AllowanceState,
  Estimate,
  Ms,
  ViewWindow,
  WindowKey,
  WindowReading,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const EPS = 1e-9;

function lengthMs(w: Pick<ViewWindow, "lengthMinutes">): number | null {
  return w.lengthMinutes === null ? null : w.lengthMinutes * MINUTE_MS;
}

/** The first reset strictly after `now` of a window that last reset at `resetAt ≤ now`. */
function nextReset(resetAt: Ms, lengthMinutes: number | null, now: Ms): Ms | null {
  if (lengthMinutes === null || lengthMinutes <= 0) return null;
  const L = lengthMinutes * MINUTE_MS;
  return resetAt + L * (Math.floor((now - resetAt) / L) + 1);
}

/** e·β per hour for a window, 0 unless both are at least coarse. */
function driftPerHour(beta: Estimate | undefined, external: Estimate): number {
  return isStrong(beta) && isStrong(external) ? external.value * beta.value : 0;
}

/**
 * A window after its reset passed: refilled at the latest reset ≤ now, then
 * drifted by external use since. `resetAt` becomes the next one.
 */
function resetInferred(
  base: Omit<ViewWindow, "remaining" | "resetAt" | "provenance" | "rejected">,
  passedAt: Ms,
  now: Ms,
  drift: number
): ViewWindow {
  const next = nextReset(passedAt, base.lengthMinutes, now);
  const L = lengthMs(base);
  const refilledAt = next !== null && L !== null ? next - L : passedAt;
  const remaining = Math.max(0, Math.min(1, 1 - (drift * (now - refilledAt)) / HOUR_MS));
  return { ...base, remaining, resetAt: next, provenance: "reset-inferred", rejected: false };
}

/**
 * A sliding window's remaining at `now` and its future releases: the claudish
 * cu inside the head reading releases L after it was served (β·cu each); the
 * rest of `u` (external) is spread uniformly over the window and releases
 * hourly. Without β everything is spread uniformly.
 */
function slidingWindow(
  track: AccountTrack,
  base: Omit<ViewWindow, "remaining" | "resetAt" | "provenance" | "rejected" | "releases">,
  head: { at: Ms; usedFraction: number; rejected: boolean },
  beta: Estimate | undefined,
  now: Ms
): ViewWindow {
  const L = lengthMs(base);
  const observed = 1 - head.usedFraction;
  if (L === null) {
    return {
      ...base,
      remaining: observed,
      resetAt: null,
      provenance: "observed",
      rejected: head.rejected,
    };
  }
  const releases: { at: Ms; amount: number }[] = [];
  let local = 0;
  if (beta) {
    for (const s of track.served) {
      if (s.at <= head.at - L || s.at > head.at) continue;
      const amount = beta.value * s.cu;
      local += amount;
      releases.push({ at: s.at + L, amount });
    }
  }
  const external = Math.max(0, head.usedFraction - local);
  if (external > EPS) {
    const chunks = Math.max(1, Math.ceil(L / HOUR_MS));
    for (let j = 1; j <= chunks; j++) {
      releases.push({ at: head.at + (j * L) / chunks, amount: external / chunks });
    }
  }
  releases.sort((a, b) => a.at - b.at);
  const released = releases.filter((r) => r.at <= now).reduce((a, r) => a + r.amount, 0);
  const pending = releases.filter((r) => r.at > now);
  return {
    ...base,
    remaining: Math.max(0, Math.min(1, observed + released)),
    resetAt: pending[0]?.at ?? null,
    provenance: "observed",
    rejected: released > EPS ? false : head.rejected,
    releases: pending,
  };
}

/** The view of one account at `now`, from the state alone. */
export function accountView(
  state: AllowanceState,
  account: AccountId,
  now: Ms,
  cfg: AllowanceConfig
): AccountView {
  const track = state.accounts[account];
  const cal = calibration(state, account, cfg);
  const windows: ViewWindow[] = [];
  let observedAt: Ms | null = null;
  for (const w of track ? liveTracks(track) : []) {
    const head = w.readings[w.readings.length - 1];
    if (!head || !track) continue;
    observedAt = observedAt === null ? head.at : Math.max(observedAt, head.at);
    const semantics = cal.windows[w.key]?.semantics ?? classifySemantics(w.readings, cfg);
    const base = {
      key: w.key,
      slot: w.slot,
      lengthMinutes: w.lengthMinutes,
      semantics,
      quantum: w.quantum,
    };
    const beta = cal.beta[w.key];
    if (semantics === "sliding") {
      windows.push(slidingWindow(track, base, head, beta, now));
    } else if (head.resetAt !== null && head.resetAt <= now) {
      windows.push(resetInferred(base, head.resetAt, now, driftPerHour(beta, cal.externalPerHour)));
    } else {
      windows.push({
        ...base,
        remaining: 1 - head.usedFraction,
        resetAt: head.resetAt,
        provenance: "observed",
        rejected: head.rejected,
      });
    }
  }
  return finishView(
    {
      account,
      order: track?.order ?? 0,
      windows,
      beta: cal.beta,
      kappa: cal.kappa,
      externalPerHour: cal.externalPerHour,
      observedAt,
    },
    now
  );
}

/** Every known account's view, in config order. */
export function accountViews(state: AllowanceState, now: Ms, cfg: AllowanceConfig): AccountView[] {
  return Object.values(state.accounts)
    .filter((a) => a.enabled)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
    .map((a) => accountView(state, a.id, now, cfg));
}

type ViewCore = Omit<AccountView, "binding" | "governing" | "deliverable">;

/** Binding, governing and deliverable recomputed from a view's windows. */
export function finishView(view: ViewCore, now: Ms): AccountView {
  const live = view.windows.filter((w) => w.remaining !== null);
  let governing: ViewWindow | null = null;
  for (const w of view.windows) {
    if (governing === null || (w.lengthMinutes ?? -1) > (governing.lengthMinutes ?? -1))
      governing = w;
  }
  const allStrong = live.every(
    (w) => isStrong(view.beta[w.key]) && (view.beta[w.key]?.value ?? 0) > 0
  );
  let binding: ViewWindow | null = null;
  let bindingScore = Number.POSITIVE_INFINITY;
  for (const w of live) {
    const r = w.remaining ?? 0;
    const score = allStrong ? r / (view.beta[w.key]?.value ?? 1) : r;
    const earlier =
      (w.resetAt ?? Number.POSITIVE_INFINITY) < (binding?.resetAt ?? Number.POSITIVE_INFINITY);
    if (score < bindingScore - EPS || (Math.abs(score - bindingScore) <= EPS && earlier)) {
      binding = w;
      bindingScore = score;
    }
  }
  const out: AccountView = {
    ...view,
    governing: governing?.key ?? null,
    binding: binding?.key ?? null,
    deliverable: null,
  };
  out.deliverable = deliverable(out, now);
  return out;
}

/**
 * Governing-window fraction deliverable before the governing reset T (§1.5):
 * `min(r_g, min_s (r_s + fresh_s)/κ_s)` over shorter windows with a calibrated
 * κ. Fixed-start/unknown s: whole fresh windows from its next reset t0 plus the
 * residual share before T. Sliding s: what ages out before T plus the windows
 * that fit after it. null when the governing window was never read.
 */
export function deliverable(view: AccountView, now: Ms): number | null {
  const g = view.windows.find((w) => w.key === view.governing);
  if (!g || g.remaining === null) return null;
  const T = g.resetAt;
  let out = g.remaining;
  if (T === null) return out;
  for (const s of view.windows) {
    if (s.key === g.key || s.remaining === null) continue;
    const kappa = view.kappa[s.key];
    if (kappa?.quality !== "calibrated" || !(kappa.value > 0)) continue;
    const L = lengthMs(s);
    if (L === null) continue;
    let fresh: number;
    if (s.semantics === "sliding") {
      const released = (s.releases ?? [])
        .filter((r) => r.at <= T)
        .reduce((a, r) => a + r.amount, 0);
      fresh = released + Math.max(0, T - now - L) / L;
    } else {
      const t0 = s.resetAt !== null && s.resetAt > now ? s.resetAt : null;
      if (t0 === null || t0 >= T) fresh = 0;
      else fresh = Math.floor((T - t0) / L) + ((T - t0) % L) / L;
    }
    out = Math.min(out, (s.remaining + fresh) / kappa.value);
  }
  return out;
}

export function isRead(view: AccountView): boolean {
  return view.windows.length > 0 && view.windows.every((w) => w.remaining !== null);
}

/** Every live window above its quantum and none rejected. An unread window does not block. */
export function usable(view: AccountView): boolean {
  return !view.windows.some(windowBlocks);
}

/** A read window at or below its quantum, or rejected: it blocks its account until it resets. */
export function windowBlocks(w: ViewWindow): boolean {
  return w.remaining !== null && (w.remaining <= Math.max(w.quantum, EPS) || w.rejected);
}

/**
 * ĉ_req in cu: this request's cost if its whole context is written, the worst
 * case — `(contextTokens ?? REQ_CTX_DEFAULT)·ω_w + REQ_OUTPUT_EST·ω_o`.
 */
export function requestCostCu(
  contextTokens: number | null,
  cfg: Pick<AllowanceConfig, "provider" | "REQ_CTX_DEFAULT" | "REQ_OUTPUT_EST">
): number {
  const w = costPriorsFor(cfg);
  return (contextTokens ?? cfg.REQ_CTX_DEFAULT) * w.cacheWrite + cfg.REQ_OUTPUT_EST * w.output;
}

/**
 * Hard-full (opus M3): some live window has `r < β·ĉ_req` when its β is at
 * least coarse, or `r < HARD_MIN_REMAINING` when its β is a prior or null.
 */
export function hardFull(
  view: AccountView,
  contextTokens: number | null,
  cfg: Pick<
    AllowanceConfig,
    "provider" | "REQ_CTX_DEFAULT" | "REQ_OUTPUT_EST" | "HARD_MIN_REMAINING"
  >
): boolean {
  const cost = requestCostCu(contextTokens, cfg);
  return view.windows.some((w) => {
    if (w.remaining === null) return false;
    const beta = view.beta[w.key];
    return isStrong(beta) ? w.remaining < beta.value * cost : w.remaining < cfg.HARD_MIN_REMAINING;
  });
}

/** Feasible: usable and not hard-full for this request (§1.8 step 2). */
export function feasible(
  view: AccountView,
  contextTokens: number | null,
  cfg: Pick<
    AllowanceConfig,
    "provider" | "REQ_CTX_DEFAULT" | "REQ_OUTPUT_EST" | "HARD_MIN_REMAINING"
  >
): boolean {
  return usable(view) && !hardFull(view, contextTokens, cfg);
}

/** True when every live window of every read view has β at least coarse: the unit is `cu`. */
export function strongBetas(views: readonly AccountView[]): boolean {
  return views
    .filter(isRead)
    .every((v) =>
      v.windows.every((w) => isStrong(v.beta[w.key]) && (v.beta[w.key]?.value ?? 0) > 0)
    );
}

export interface Combined {
  value: number;
  unit: "cu" | "account-fraction";
  assumption: "equal-capacity" | null;
}

/**
 * Combined immediate capacity: `Σ_a min_w r_{a,w}/β_{a,w}` in cu, summed across
 * accounts and never across nested windows. With any β below coarse the unit is
 * `account-fraction` for EVERY account (`Σ_a min_w r_{a,w}`), assuming
 * equal-size accounts. Unread accounts count nothing.
 */
export function combinedNow(views: readonly AccountView[]): Combined {
  const read = views.filter(isRead);
  const cu = strongBetas(read);
  let value = 0;
  for (const v of read) {
    let least = Number.POSITIVE_INFINITY;
    for (const w of v.windows) {
      const r = w.remaining ?? 0;
      least = Math.min(least, cu ? r / (v.beta[w.key]?.value ?? 1) : r);
    }
    if (Number.isFinite(least)) value += least;
  }
  return cu
    ? { value, unit: "cu", assumption: null }
    : { value, unit: "account-fraction", assumption: "equal-capacity" };
}

/** A window from a fresh reading: observed, or reset-inferred when its reset has already passed. */
function windowFromReading(
  r: WindowReading,
  prior: ViewWindow | undefined,
  view: AccountView,
  now: Ms
): ViewWindow {
  const base = {
    key: r.key,
    slot: r.slot,
    lengthMinutes: r.lengthMinutes ?? prior?.lengthMinutes ?? null,
    semantics: prior?.semantics ?? "unknown",
    quantum: r.quantum,
  };
  if (base.semantics !== "sliding" && r.resetAt !== null && r.resetAt <= now) {
    return resetInferred(
      base,
      r.resetAt,
      now,
      driftPerHour(view.beta[r.key], view.externalPerHour)
    );
  }
  const releases = prior?.releases?.filter((x) => x.at > now);
  return {
    ...base,
    remaining: 1 - r.usedFraction,
    resetAt: r.resetAt,
    provenance: "observed",
    rejected: r.rejected,
    ...(releases ? { releases } : {}),
  };
}

export interface FreshReading {
  id: AccountId;
  order: number;
  at: Ms | null;
  readings: WindowReading[] | null;
}

/**
 * Fresh snapshots over the views (§1.8 `decide` step 1): a NEW view object only
 * for an account whose snapshot is newer than its view's head, O(accounts ×
 * windows); every other view is returned as is. A window the snapshot omits is
 * kept (absence on one snapshot is not retirement). An eligible account with no
 * view gets one from its snapshot, with no estimates.
 */
export function overlayReadings(
  views: readonly AccountView[],
  fresh: readonly FreshReading[],
  now: Ms
): AccountView[] {
  const out = views.map((view) => {
    const f = fresh.find((x) => x.id === view.account);
    if (!f || f.readings === null || f.at === null) return view;
    if (view.observedAt !== null && f.at <= view.observedAt) return view;
    const byKey = new Map(view.windows.map((w) => [w.key, w]));
    for (const r of f.readings) byKey.set(r.key, windowFromReading(r, byKey.get(r.key), view, now));
    return finishView(
      { ...view, windows: [...byKey.values()].sort(byWindowKey), observedAt: f.at },
      now
    );
  });
  for (const f of fresh) {
    if (out.some((v) => v.account === f.id)) continue;
    const empty: AccountView = {
      account: f.id,
      order: f.order,
      windows: [],
      binding: null,
      governing: null,
      deliverable: null,
      beta: {},
      kappa: {},
      externalPerHour: { value: 0, relSd: 1, quality: "prior" },
      observedAt: null,
    };
    if (f.readings === null || f.at === null) {
      out.push(empty);
      continue;
    }
    const windows = f.readings
      .map((r) => windowFromReading(r, undefined, empty, now))
      .sort(byWindowKey);
    out.push(finishView({ ...empty, windows, observedAt: f.at }, now));
  }
  return out.sort((a, b) => a.order - b.order || (a.account < b.account ? -1 : 1));
}

function byWindowKey(a: { key: WindowKey }, b: { key: WindowKey }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * The window rates of §1.7 (`window-only` evidence), from each account's
 * governing window: `u_g / elapsed`, elapsed = now − (R_g − L_g) in hours (at
 * least 15 min). `frac` in W/h with no β; `cu` in cu/h only when every β is at
 * least coarse, else null.
 */
export function windowRates(
  views: readonly AccountView[],
  now: Ms
): { frac: number; cu: number | null } {
  let frac = 0;
  let cu: number | null = strongBetas(views) ? 0 : null;
  for (const v of views.filter(isRead)) {
    const g = v.windows.find((w) => w.key === v.governing);
    const L = g ? lengthMs(g) : null;
    if (!g || g.remaining === null || g.resetAt === null || L === null) continue;
    const elapsedH = Math.max(0.25, (now - (g.resetAt - L)) / HOUR_MS);
    const used = 1 - g.remaining;
    frac += used / elapsedH;
    if (cu !== null) cu += used / (v.beta[g.key]?.value ?? 1) / elapsedH;
  }
  return { frac, cu };
}
