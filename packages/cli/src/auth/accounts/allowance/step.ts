/**
 * ONE bucket of the simulated world (architecture §1.6), used by `simulate`
 * and by the lookahead search, so both roll the world forward identically.
 *
 * **The bucket boundary rule (opus M7).** Bucket k is `[h_k, h_{k+1})` with
 * `h_k = floor(now/1h) + k·1h`, and its demand is served at `h_k`. A reset due
 * at R applies at the first boundary `h_k ≥ R`, BEFORE bucket k is served: R =
 * +10 h applies before bucket 10, and R = +9 h 30 min also applies at h10.
 *
 * `stepBucket`, in this order:
 * 1. **Resets** due by `h_k` apply: `r := 1`, then `R += L` (fixed-start and
 *    unknown). A sliding window releases each served amount L after it was
 *    served. A governing reset first books its leftover as waste.
 * 2. **External drift:** `r −= e·β·1h`.
 * 3. **Serve, one decision at a time:** the chosen account takes
 *    `x = min(demand left, min_w r_w/β_w)` and `x·β_w` leaves every live window.
 *    While demand is left the decider is asked again over the usable accounts
 *    not yet tried in this bucket, as a pooled request's rotation does.
 * 4. **Blocked** ⇔ demand left unserved, or no account usable at the end. The
 *    kind is `5h` when every blocking window is at most SHORT_WINDOW_MAX_MIN
 *    long, else `7d`. Whether a blocked RUN is a gap is `simulate`'s call: it
 *    needs demand in the run (orchestrator decision 1), which one bucket
 *    cannot see.
 *
 * Demand is in cu. A window with no β of its own takes κ·β_governing, else 1
 * (the demand is then read in that window's fractions).
 */

import { finishView, usable, windowBlocks } from "./capacity.js";
import type {
  AccountId,
  AccountView,
  AllowanceConfig,
  Ms,
  ViewWindow,
  WindowKey,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const EPS = 1e-9;

/** The simulated world: its own copies of the views, mutated bucket by bucket. */
export interface SimWorld {
  /** h_0 = floor(now/1h). */
  start: Ms;
  views: AccountView[];
  /** cu lost at governing resets applied so far. */
  waste: number;
  /** Each account's governing remaining (window fraction) just before its FIRST governing reset in the grid. */
  leftoverAtReset: Record<AccountId, number | null>;
}

export interface BucketOutcome {
  k: number;
  at: Ms;
  served: number;
  unserved: number;
  blocked: boolean;
  kind: "7d" | "5h" | null;
  /** The windows that left the bucket blocked; empty when it was not. */
  blocking: { account: AccountId; window: WindowKey }[];
  /** Every read window's remaining after step 1 (resets), before drift and service. */
  remainingAtStart: Record<AccountId, Record<WindowKey, number>>;
  servedBy: { account: AccountId; cu: number }[];
  /** The bucket's claudish demand, in cu. */
  demand: number;
  /** Σ external drift over the hour across the accounts, in cu: use outside claudish. */
  external: number;
  /** Some account was usable after the bucket's resets, before its drift and service. */
  usableAtStart: boolean;
}

/** Choose among the usable accounts not yet tried in this bucket; null declines. */
export type DecideFn = (candidates: AccountView[], world: SimWorld, k: number) => AccountId | null;

export function hourStart(now: Ms): Ms {
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

/**
 * A view's own copy of what `stepBucket` mutates: its windows and their release
 * lists. β, κ and the drift estimate are only read, so they are shared. Much
 * cheaper than `structuredClone`, which the search paid once per node (40 % of
 * a lookahead plan's time in the step 10 profile).
 */
function copyView(v: AccountView): AccountView {
  return {
    ...v,
    windows: v.windows.map((w) => (w.releases ? { ...w, releases: [...w.releases] } : { ...w })),
  };
}

export function createWorld(views: readonly AccountView[], now: Ms): SimWorld {
  const copies = views.map(copyView);
  const leftoverAtReset: Record<AccountId, number | null> = {};
  for (const v of copies) leftoverAtReset[v.account] = null;
  return { start: hourStart(now), views: copies, waste: 0, leftoverAtReset };
}

/** An independent copy of a world: the search branches one per node. */
export function cloneWorld(world: SimWorld): SimWorld {
  return {
    start: world.start,
    views: world.views.map(copyView),
    waste: world.waste,
    leftoverAtReset: { ...world.leftoverAtReset },
  };
}

/** β of a window in the simulation: its own, else κ·β_governing, else 1. */
export function simBeta(view: AccountView, key: WindowKey): number {
  const own = view.beta[key]?.value;
  if (own !== undefined && own > 0) return own;
  const kappa = view.kappa[key]?.value;
  const governing = view.governing === null ? undefined : view.beta[view.governing]?.value;
  if (kappa !== undefined && kappa > 0 && governing !== undefined && governing > 0)
    return kappa * governing;
  return 1;
}

/** cu the account can take now: `min_w r_w/β_w` over its read windows. */
export function capacityCu(view: AccountView): number {
  let cap = Number.POSITIVE_INFINITY;
  for (const w of view.windows) {
    if (w.remaining === null) continue;
    cap = Math.min(cap, w.remaining / simBeta(view, w.key));
  }
  return Number.isFinite(cap) ? Math.max(0, cap) : 0;
}

/** Apply the resets due by `at`; true when a window changed. */
function applyResets(world: SimWorld, view: AccountView, at: Ms): boolean {
  let changed = false;
  for (const w of view.windows) {
    if (w.remaining === null) continue;
    if (w.semantics === "sliding") {
      const due = (w.releases ?? []).filter((r) => r.at <= at);
      if (due.length > 0) {
        w.remaining = Math.min(1, w.remaining + due.reduce((a, r) => a + r.amount, 0));
        w.releases = (w.releases ?? []).filter((r) => r.at > at);
        w.rejected = false;
        changed = true;
      }
      w.resetAt = w.releases?.[0]?.at ?? null;
      continue;
    }
    while (w.resetAt !== null && w.resetAt <= at) {
      changed = true;
      if (w.key === view.governing) {
        world.waste += w.remaining / simBeta(view, w.key);
        if (world.leftoverAtReset[view.account] === null)
          world.leftoverAtReset[view.account] = w.remaining;
      }
      w.remaining = 1;
      w.rejected = false;
      w.provenance = "reset-inferred";
      w.resetAt =
        w.lengthMinutes !== null && w.lengthMinutes > 0
          ? w.resetAt + w.lengthMinutes * MINUTE_MS
          : null;
    }
  }
  return changed;
}

function charge(view: AccountView, cu: number, at: Ms): void {
  for (const w of view.windows) {
    if (w.remaining === null) continue;
    spend(w, cu * simBeta(view, w.key), at);
  }
}

/**
 * Take `used` from a window at `at`. On a sliding window the amount returns one
 * window length later, local service and external use alike: external use
 * below the window's sustainable rate then reaches a rolling equilibrium
 * instead of accumulating.
 */
function spend(w: ViewWindow, used: number, at: Ms): void {
  if (w.remaining === null) return;
  w.remaining = Math.max(0, w.remaining - used);
  if (w.semantics === "sliding" && w.lengthMinutes !== null) {
    const releases = w.releases ?? [];
    releases.push({ at: at + w.lengthMinutes * MINUTE_MS, amount: used });
    releases.sort((a, b) => a.at - b.at);
    w.releases = releases;
    w.resetAt = releases[0]?.at ?? null;
  }
}

function remainingOf(views: readonly AccountView[]): Record<AccountId, Record<WindowKey, number>> {
  const out: Record<AccountId, Record<WindowKey, number>> = {};
  for (const v of views) {
    const windows: Record<WindowKey, number> = {};
    for (const w of v.windows) if (w.remaining !== null) windows[w.key] = w.remaining;
    out[v.account] = windows;
  }
  return out;
}

function blockingWindows(view: AccountView): ViewWindow[] {
  const blocking = view.windows.filter(windowBlocks);
  if (blocking.length > 0) return blocking;
  const binding = view.windows.find((w) => w.key === view.binding);
  return binding ? [binding] : [];
}

export function stepBucket(
  world: SimWorld,
  k: number,
  demand: number,
  decideFn: DecideFn,
  cfg: Pick<AllowanceConfig, "SHORT_WINDOW_MAX_MIN">
): BucketOutcome {
  const at = world.start + k * HOUR_MS;

  // 1. Resets due by h_k, before the bucket is served. A view is re-finished only
  // when it changed: binding and governing depend on nothing else, and no
  // decision in a simulation reads `deliverable`.
  world.views = world.views.map((v) => (applyResets(world, v, at) ? finishView(v, at) : v));
  const remainingAtStart = remainingOf(world.views);
  const usableAtStart = world.views.some(usable);

  // 2. External drift over the hour.
  let external = 0;
  world.views = world.views.map((v) => {
    const e = v.externalPerHour.value;
    if (!(e > 0)) return v;
    external += e;
    for (const w of v.windows) {
      if (w.remaining !== null) spend(w, Math.min(w.remaining, e * simBeta(v, w.key)), at);
    }
    return finishView(v, at);
  });

  // 3. Serve, one decision at a time.
  let left = Math.max(0, demand);
  // Relative: at Mcu scale the float residue of a window drained exactly is far above 1e-9 cu.
  const slack = EPS * Math.max(1, left);
  const tried = new Set<AccountId>();
  const servedBy: { account: AccountId; cu: number }[] = [];
  while (left > slack) {
    const candidates = world.views.filter((v) => usable(v) && !tried.has(v.account));
    if (candidates.length === 0) break;
    const id = decideFn(candidates, world, k);
    const index = id === null ? -1 : world.views.findIndex((v) => v.account === id);
    const view = world.views[index];
    if (!view || !candidates.includes(view)) break;
    tried.add(view.account);
    const x = Math.min(left, capacityCu(view));
    if (x > 0) {
      charge(view, x, at);
      left -= x;
    }
    servedBy.push({ account: view.account, cu: x });
    world.views[index] = finishView(view, at);
  }
  const served = Math.max(0, demand) - left;
  const unserved = left > slack ? left : 0;

  // 4. Blocked, and by which windows.
  const blocked = unserved > 0 || !world.views.some(usable);
  let blocking: { account: AccountId; window: WindowKey }[] = [];
  let kind: "7d" | "5h" | null = null;
  if (blocked) {
    const servedOut = new Set(servedBy.filter((s) => s.cu > 0).map((s) => s.account));
    const stuck = world.views.filter((v) => !usable(v) || !servedOut.has(v.account));
    const windows = stuck.flatMap((v) => blockingWindows(v).map((w) => ({ v, w })));
    blocking = windows.map(({ v, w }) => ({ account: v.account, window: w.key }));
    const short =
      windows.length > 0 &&
      windows.every(
        ({ w }) => w.lengthMinutes !== null && w.lengthMinutes <= cfg.SHORT_WINDOW_MAX_MIN
      );
    kind = short ? "5h" : "7d";
  }

  return {
    k,
    at,
    served,
    unserved,
    blocked,
    kind,
    blocking,
    remainingAtStart,
    servedBy: servedBy,
    demand: Math.max(0, demand),
    external,
    usableAtStart,
  };
}
