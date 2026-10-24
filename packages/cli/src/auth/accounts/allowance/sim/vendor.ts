/**
 * The vendor emulator (architecture §4): the HIDDEN truth of each account's
 * allowance, which the simulator charges and which emits exactly the
 * `response` events production would see.
 *
 * Minimal by design (§6 step 2): fixed-start, first-use and sliding windows,
 * per-window capacity in cu, hidden cost weights, a reported `u` quantised by
 * flooring or rounding, deterministic external drift, a header-before/after
 * flag, stripped-header responses (`windows: null`) and window-set changes.
 * Poisson and bursty external use arrive with the seeded PRNG (step 3).
 *
 * `u` of a window is OBSERVABLE only through a served request's response, as in
 * production. {@link Vendor.truth} exists for the oracle and the metrics; a
 * strategy must never see it (§5 case 37).
 *
 * All state is plain JSON, and every step function is pure on a copy, so the
 * oracle can branch a world with `structuredClone`.
 */

import type { AccountId, AllowanceEvent, Ms, TokenCounts, WindowReading } from "../types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Float slack for "fits": capacities and costs are sums of decimal fractions. */
const EPS = 1e-9;

/**
 * How a window's epoch runs. `fixed-start`: epochs of length L from a known
 * reset, whatever the use. `first-use`: an epoch starts at the first charge
 * after the last one expired. `sliding`: no epochs; a charge counts for L.
 */
export type VendorSemantics = "fixed-start" | "first-use" | "sliding";

export interface VendorWindowSpec {
  /** The header slot (`primary`/`secondary`) or the window's name. */
  slot: string;
  lengthMinutes: number;
  capacityCu: number;
  semantics: VendorSemantics;
  /** cu already used at the emulator's start (fixed-start/first-use). Default 0. */
  usedCu?: number;
  /**
   * fixed-start: the current epoch's end (default start + L). first-use: the
   * active epoch's end, or null/absent for an epoch not yet started.
   */
  resetAt?: Ms | null;
  /** sliding: charges still inside the window at the start. */
  history?: { at: Ms; cu: number }[];
}

/** cu = uncached·w_u + cacheRead·w_r + cacheWrite·w_w + output·w_o. Hidden from every strategy. */
export interface CostWeights {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export const DEFAULT_HIDDEN_WEIGHTS: CostWeights = {
  uncached: 1,
  cacheRead: 0.1,
  cacheWrite: 1,
  output: 4,
};

export interface VendorAccountSpec {
  id: AccountId;
  windows: VendorWindowSpec[];
  weights?: CostWeights;
  /** The reported `u`'s quantum: 0.01 (Codex whole percent), 0.001, or 0 (exact). Default 0.01. */
  quantum?: number;
  /** How `u` is quantised. Default `floor`. */
  rounding?: "floor" | "round";
  /** `after` (default): the reading includes this request's charge. `before`: it does not. */
  headerTiming?: "after" | "before";
  /** External use (not routed by claudish), cu per hour, spread evenly. Default 0. */
  externalCuPerHour?: number;
  /**
   * `below-cap` (default, as Codex behaves): a request is accepted while every
   * live window is under its capacity, and may overrun it. `fits`: only when its
   * whole cost fits every live window (the unit-task traces of §1.8).
   */
  admission?: "below-cap" | "fits";
  /** 0-based indices of this account's served requests whose response carries no usable snapshot. */
  strippedResponses?: number[];
  /** Windows the vendor removes or restores without notice (a 5h window gone on day 10, back on day 18). */
  windowSetChanges?: { at: Ms; remove?: string[]; restore?: string[] }[];
  /** Report windows keyed by length (`positional`, Codex, default) or by slot name (`named`). */
  naming?: "positional" | "named";
}

export interface VendorRequest {
  id: string;
  at: Ms;
  account: AccountId;
  session: string | null;
  model: string;
  tokens: TokenCounts;
  finalInput?: number;
  /** A cost in cu that overrides the hidden weights (the unit-task traces). */
  cu?: number;
}

interface WindowState {
  spec: VendorWindowSpec;
  active: boolean;
  usedCu: number;
  /** fixed-start: always set; first-use: null while no epoch runs; sliding: unused. */
  epochEnd: Ms | null;
  charges: { at: Ms; cu: number }[];
}

interface AccountState {
  spec: VendorAccountSpec;
  windows: WindowState[];
  /** Served (accepted) requests so far, for `strippedResponses`. */
  served: number;
  /** Window-set changes already applied. */
  changesApplied: number;
}

/** The whole hidden world: plain JSON, cloneable. */
export interface VendorWorld {
  now: Ms;
  accounts: AccountState[];
}

export function initialWorld(accounts: VendorAccountSpec[], start: Ms): VendorWorld {
  return {
    now: start,
    accounts: accounts.map((spec) => ({
      spec,
      served: 0,
      changesApplied: 0,
      windows: spec.windows.map((w) => ({
        spec: w,
        active: true,
        usedCu: w.semantics === "sliding" ? 0 : (w.usedCu ?? 0),
        epochEnd:
          w.semantics === "fixed-start"
            ? (w.resetAt ?? start + w.lengthMinutes * MINUTE_MS)
            : w.semantics === "first-use"
              ? (w.resetAt ?? null)
              : null,
        charges: w.semantics === "sliding" ? [...(w.history ?? [])] : [],
      })),
    })),
  };
}

function accountOf(world: VendorWorld, id: AccountId): AccountState {
  const account = world.accounts.find((a) => a.spec.id === id);
  if (!account) throw new RangeError(`vendor: unknown account ${id}`);
  return account;
}

function lengthMs(w: WindowState): number {
  return w.spec.lengthMinutes * MINUTE_MS;
}

function usedOf(w: WindowState): number {
  return w.spec.semantics === "sliding" ? w.charges.reduce((s, c) => s + c.cu, 0) : w.usedCu;
}

function addUse(w: WindowState, cu: number, at: Ms): void {
  if (cu <= 0) return;
  if (w.spec.semantics === "sliding") {
    w.charges.push({ at, cu });
    return;
  }
  if (w.spec.semantics === "first-use" && w.epochEnd === null) w.epochEnd = at + lengthMs(w);
  w.usedCu += cu;
}

/** The first epoch end or sliding release in (from, to], or null. */
function nextBoundary(account: AccountState, from: Ms, to: Ms): Ms | null {
  let next: Ms | null = null;
  for (const w of account.windows) {
    if (!w.active) continue;
    let b: Ms | null = null;
    if (w.spec.semantics === "sliding") {
      for (const c of w.charges) {
        const release = c.at + lengthMs(w);
        if (release > from && release <= to && (b === null || release < b)) b = release;
      }
    } else if (w.epochEnd !== null && w.epochEnd > from && w.epochEnd <= to) {
      b = w.epochEnd;
    }
    if (b !== null && (next === null || b < next)) next = b;
  }
  return next;
}

/** Apply every reset or release due at exactly `at` (a reset at R applies before a request at R). */
function applyBoundary(account: AccountState, at: Ms): void {
  for (const w of account.windows) {
    if (w.spec.semantics === "sliding") {
      w.charges = w.charges.filter((c) => c.at + lengthMs(w) > at);
    } else if (w.epochEnd !== null && w.epochEnd <= at) {
      w.usedCu = 0;
      if (w.spec.semantics === "fixed-start") {
        while (w.epochEnd <= at) w.epochEnd += lengthMs(w);
      } else {
        w.epochEnd = null;
      }
    }
  }
}

function applyWindowSetChanges(account: AccountState, at: Ms): void {
  const changes = account.spec.windowSetChanges ?? [];
  while (account.changesApplied < changes.length) {
    const change = changes[account.changesApplied];
    if (!change || change.at > at) return;
    for (const w of account.windows) {
      if (change.remove?.includes(w.spec.slot)) w.active = false;
      if (change.restore?.includes(w.spec.slot) && !w.active) {
        w.active = true;
        w.usedCu = 0;
        w.charges = [];
        w.epochEnd = w.spec.semantics === "fixed-start" ? change.at + lengthMs(w) : null;
      }
    }
    account.changesApplied++;
  }
}

/**
 * Move one account to `to`: resets and releases at their exact times, and
 * external drift accrued piecewise between them (in segments of at most one
 * hour, so a sliding window's drift ages out close to when it was spent).
 */
function advanceAccount(account: AccountState, from: Ms, to: Ms): void {
  const rate = account.spec.externalCuPerHour ?? 0;
  let cur = from;
  while (cur < to) {
    applyWindowSetChanges(account, cur);
    const boundary = nextBoundary(account, cur, to);
    const step = Math.min(boundary ?? to, cur + HOUR_MS, to);
    if (rate > 0) {
      const cu = (rate * (step - cur)) / HOUR_MS;
      for (const w of account.windows) if (w.active) addUse(w, cu, step);
    }
    cur = step;
    applyBoundary(account, cur);
  }
  applyWindowSetChanges(account, to);
  applyBoundary(account, to);
}

/** Move the whole world to `at`. Throws when time would go backwards. */
export function advanceWorld(world: VendorWorld, at: Ms): void {
  if (at < world.now) throw new RangeError("vendor: time moves forward only");
  for (const account of world.accounts) advanceAccount(account, world.now, at);
  world.now = at;
}

/** The cost of a request in cu, at the account's HIDDEN weights. */
export function costOf(spec: VendorAccountSpec, req: Pick<VendorRequest, "tokens" | "cu">): number {
  if (req.cu !== undefined) return req.cu;
  const w = spec.weights ?? DEFAULT_HIDDEN_WEIGHTS;
  const t = req.tokens;
  const uncached = Math.max(0, t.input - t.cacheRead - t.cacheWrite);
  return (
    uncached * w.uncached +
    t.cacheRead * w.cacheRead +
    t.cacheWrite * w.cacheWrite +
    t.output * w.output
  );
}

/** The live windows that would refuse a request of `cu` now (empty ⇔ admissible). */
export function refusingWindows(world: VendorWorld, id: AccountId, cu: number): string[] {
  const account = accountOf(world, id);
  const fits = account.spec.admission === "fits";
  return account.windows
    .filter((w) => w.active)
    .filter((w) => {
      const remaining = w.spec.capacityCu - usedOf(w);
      return fits ? remaining + EPS < cu : remaining <= EPS;
    })
    .map((w) => w.spec.slot);
}

export function admissible(world: VendorWorld, id: AccountId, cu: number): boolean {
  return refusingWindows(world, id, cu).length === 0;
}

/** Charge an accepted request to every live window of the account. */
export function chargeWorld(world: VendorWorld, id: AccountId, cu: number): void {
  const account = accountOf(world, id);
  for (const w of account.windows) if (w.active) addUse(w, cu, world.now);
}

function quantise(fraction: number, quantum: number, rounding: "floor" | "round"): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  if (quantum <= 0) return clamped;
  const steps =
    rounding === "round" ? Math.round(clamped / quantum) : Math.floor(clamped / quantum + EPS);
  return Math.min(1, Number((steps * quantum).toFixed(6)));
}

/** What the response headers would report for this account right now. */
export function readingsNow(
  world: VendorWorld,
  id: AccountId,
  rejected: string[] = []
): WindowReading[] {
  const account = accountOf(world, id);
  const quantum = account.spec.quantum ?? 0.01;
  const rounding = account.spec.rounding ?? "floor";
  return account.windows
    .filter((w) => w.active)
    .map((w) => {
      const len = w.spec.lengthMinutes;
      const resetAt =
        w.spec.semantics === "sliding"
          ? w.charges.length > 0
            ? Math.min(...w.charges.map((c) => c.at)) + lengthMs(w)
            : null
          : w.epochEnd;
      return {
        key: account.spec.naming === "named" ? w.spec.slot : `len:${len}`,
        slot: w.spec.slot,
        lengthMinutes: len,
        usedFraction: quantise(usedOf(w) / w.spec.capacityCu, quantum, rounding),
        resetAt,
        rejected: rejected.includes(w.spec.slot),
        quantum,
      };
    });
}

/** The hidden remaining capacity per window, for the oracle and the metrics only. */
export interface WindowTruth {
  slot: string;
  lengthMinutes: number;
  semantics: VendorSemantics;
  active: boolean;
  capacityCu: number;
  remainingCu: number;
  resetAt: Ms | null;
}

export type ResponseEvent = Extract<AllowanceEvent, { kind: "response" }>;

export interface ServeResult {
  event: ResponseEvent;
  accepted: boolean;
  /** The request's cost at the hidden weights. */
  cu: number;
}

export interface Vendor {
  /** Serve one request at `req.at` (non-decreasing). Emits the response event production would see. */
  serve(req: VendorRequest): ServeResult;
  /** Hidden truth at `at` (advances the world). NEVER handed to a strategy. */
  truth(at: Ms): Record<AccountId, WindowTruth[]>;
  /** What a usage poll (`state.json`) would report for one account at `at`: observable, like a response. */
  poll(id: AccountId, at: Ms): WindowReading[];
  /**
   * A vendor-side reset at `at` (§5 case 38b): every window of every account
   * starts a fresh epoch, unannounced; the next response reports it.
   */
  resetAll(at: Ms): void;
}

export function createVendor(accounts: VendorAccountSpec[], start: Ms): Vendor {
  const world = initialWorld(accounts, start);
  return {
    serve(req) {
      advanceWorld(world, req.at);
      const account = accountOf(world, req.account);
      const cu = costOf(account.spec, req);
      const refusing = refusingWindows(world, req.account, cu);
      const accepted = refusing.length === 0;
      const before = readingsNow(world, req.account, refusing);
      let stripped = false;
      if (accepted) {
        stripped = (account.spec.strippedResponses ?? []).includes(account.served);
        account.served++;
        chargeWorld(world, req.account, cu);
      }
      const reading =
        accepted && (account.spec.headerTiming ?? "after") === "after"
          ? readingsNow(world, req.account)
          : before;
      const zero: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      return {
        accepted,
        cu,
        event: {
          kind: "response",
          id: req.id,
          at: req.at,
          account: req.account,
          session: req.session,
          model: req.model,
          tokens: accepted ? req.tokens : zero,
          finalInput: accepted ? (req.finalInput ?? req.tokens.input) : 0,
          windows: stripped ? null : reading,
          outcome: accepted ? "ok" : "quota",
        },
      };
    },
    poll(id, at) {
      advanceWorld(world, at);
      return readingsNow(world, id);
    },
    resetAll(at) {
      advanceWorld(world, at);
      for (const account of world.accounts) {
        for (const w of account.windows) {
          w.usedCu = 0;
          w.charges = [];
          if (w.spec.semantics === "fixed-start") w.epochEnd = at + lengthMs(w);
          else if (w.spec.semantics === "first-use") w.epochEnd = null;
        }
      }
    },
    truth(at) {
      advanceWorld(world, at);
      const out: Record<AccountId, WindowTruth[]> = {};
      for (const account of world.accounts) {
        out[account.spec.id] = account.windows.map((w) => ({
          slot: w.spec.slot,
          lengthMinutes: w.spec.lengthMinutes,
          semantics: w.spec.semantics,
          active: w.active,
          capacityCu: w.spec.capacityCu,
          remainingCu: w.spec.capacityCu - usedOf(w),
          resetAt: w.spec.semantics === "sliding" ? null : w.epochEnd,
        }));
      }
      return out;
    },
  };
}
