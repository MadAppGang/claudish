/**
 * The fold: `AllowanceEvent`s → `AllowanceState` (architecture §1.4, §1.1).
 *
 * - `observe` never mutates its input: it clones once and folds on the copy.
 *   `observeAll` clones once and folds every event in place on its own copy,
 *   so the shell's 30-day load costs O(events), not O(events × state).
 *   `observeAllInPlace` folds into the state it is given, for the shell's
 *   refresh, which owns its state.
 * - **Dedup and order.** A repeated event id is ignored. The current reading of
 *   a window is the one with the newest `at`; a late reading enters the
 *   history but never replaces the head.
 * - **Absence.** `windows: null` is no information. A window is retired only
 *   when two consecutive COMPLETE snapshots of its account omit it.
 * - **Censoring is pool-wide only.** A `no-eligible` opens a censored interval
 *   and the next successful response of ANY account closes it; one account's
 *   `quota` censors nothing. A rollup carries its hour's exact pool-wide figure
 *   (the same on every rollup of that hour), taken once, never summed.
 * - **Bounds.** 6 weeks of hourly demand, READINGS_MAX readings per window,
 *   sessions idle over SESSION_TTL_D dropped, at most SESSIONS_MAX sessions.
 *   Ages are measured from the newest event folded (`lastAt`), never a clock.
 */

import { cuOf } from "./constants.js";
import type {
  AccountId,
  AccountTrack,
  AllowanceConfig,
  AllowanceEvent,
  AllowanceState,
  HourBucket,
  Ms,
  TokenCounts,
  WindowReading,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** The dedup ring. */
const SEEN_MAX = 4096;

export function initialState(): AllowanceState {
  return {
    version: 1,
    accounts: {},
    demand: [],
    sessions: {},
    seen: [],
    censorOpenAt: null,
    lastAt: null,
  };
}

/** One event folded into a NEW state; the input is never mutated. */
export function observe(
  s: AllowanceState,
  e: AllowanceEvent,
  cfg: AllowanceConfig
): AllowanceState {
  return observeAll(s, [e], cfg);
}

/** Every event folded, in order, into ONE copy of `s`. */
export function observeAll(
  s: AllowanceState,
  es: readonly AllowanceEvent[],
  cfg: AllowanceConfig
): AllowanceState {
  return observeAllInPlace(structuredClone(s) as AllowanceState, es, cfg);
}

/**
 * Every event folded into `s` ITSELF, which is returned. For an owner that
 * holds the only reference (the I/O shell's refresh), so a 5-minute fold does
 * not copy six weeks of state.
 */
export function observeAllInPlace(
  s: AllowanceState,
  es: readonly AllowanceEvent[],
  cfg: AllowanceConfig
): AllowanceState {
  const seen = new Set(s.seen);
  for (const e of es) fold(s, e, cfg, seen);
  prune(s, cfg);
  return s;
}

/** The id an event is deduplicated by, or null for one that is idempotent anyway. */
function eventId(e: AllowanceEvent): string | null {
  switch (e.kind) {
    case "response":
    case "rollup":
      return e.id;
    case "snapshot":
      return `snapshot:${e.account}:${e.at}`;
    case "no-eligible":
      return `no-eligible:${e.at}`;
    case "accounts":
      return null;
  }
}

function remember(s: AllowanceState, seen: Set<string>, id: string): void {
  seen.add(id);
  s.seen.push(id);
  while (s.seen.length > SEEN_MAX) {
    const dropped = s.seen.shift();
    if (dropped !== undefined) seen.delete(dropped);
  }
}

function fold(s: AllowanceState, e: AllowanceEvent, cfg: AllowanceConfig, seen: Set<string>): void {
  const id = eventId(e);
  if (id !== null) {
    if (seen.has(id)) return;
    remember(s, seen, id);
  }
  switch (e.kind) {
    case "response": {
      const account = ensureAccount(s, e.account);
      const cu = cuOf(e.tokens, cfg);
      if (cu > 0) {
        insertServed(account, e.at, cu);
        addDemand(s, hourOf(e.at), cu, 1);
        if (e.session !== null) addSession(s, e.session, e.at, e.account, cu, e.tokens, e.model, 1);
      }
      if (e.outcome === "ok") closeCensor(s, e.at);
      if (e.windows !== null) applySnapshot(account, e.at, e.windows, cfg);
      touch(s, e.at);
      return;
    }
    case "snapshot":
      applySnapshot(ensureAccount(s, e.account), e.at, e.windows, cfg);
      touch(s, e.at);
      return;
    case "no-eligible":
      if (e.until === undefined) {
        if (s.censorOpenAt === null) s.censorOpenAt = e.at;
      } else {
        // A sealed interval: an interval still open (the previous day's `continues`) ends here.
        closeCensor(s, e.at);
        sealCensor(s, e.at, e.until);
        if (e.continues) s.censorOpenAt = e.until;
      }
      touch(s, e.at);
      return;
    case "accounts": {
      // The list is authoritative: an account absent from it was removed and gives no capacity.
      const listed = new Set(e.accounts.map((entry) => entry.id));
      for (const account of Object.values(s.accounts)) {
        if (!listed.has(account.id)) account.enabled = false;
      }
      for (const entry of e.accounts) {
        const account = ensureAccount(s, entry.id);
        account.order = entry.order;
        account.enabled = entry.enabled;
        account.planClass = entry.planClass;
      }
      if (e.active !== undefined) s.poolActive = e.active;
      touch(s, e.at);
      return;
    }
    case "rollup": {
      const account = ensureAccount(s, e.account);
      const cu = cuOf(e.tokens, cfg);
      const mid = e.hour + HOUR_MS / 2;
      if (cu > 0) {
        insertServed(account, mid, cu);
        if (e.session !== null)
          addSession(s, e.session, mid, e.account, cu, e.tokens, e.model, e.n);
      }
      const bucket = addDemand(s, e.hour, cu, e.n);
      bucket.censoredMinutes = Math.min(60, Math.max(bucket.censoredMinutes, e.censoredMinutes));
      // The first reading of the hour at its start, the last at its end: the
      // hour's served cu (placed at its middle) falls between them.
      if (e.first !== null) applySnapshot(account, e.hour, e.first, cfg);
      if (e.last !== null && e.n > 1) applySnapshot(account, e.hour + HOUR_MS - 1, e.last, cfg);
      touch(s, e.hour + HOUR_MS - 1);
      return;
    }
  }
}

function touch(s: AllowanceState, at: Ms): void {
  if (s.lastAt === null || at > s.lastAt) s.lastAt = at;
}

export function hourOf(at: Ms): Ms {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function ensureAccount(s: AllowanceState, id: AccountId): AccountTrack {
  let account = s.accounts[id];
  if (!account) {
    account = {
      id,
      order: Object.keys(s.accounts).length,
      enabled: true,
      planClass: null,
      windows: {},
      served: [],
      lastCompleteAt: null,
    };
    s.accounts[id] = account;
  }
  return account;
}

function insertServed(account: AccountTrack, at: Ms, cu: number): void {
  const served = account.served;
  let i = served.length;
  while (i > 0 && (served[i - 1]?.at ?? 0) > at) i--;
  served.splice(i, 0, { at, cu });
}

/** The hour's bucket, created in order when absent. */
function bucketFor(s: AllowanceState, hour: Ms): HourBucket {
  const demand = s.demand;
  let i = demand.length;
  while (i > 0 && (demand[i - 1]?.hour ?? 0) > hour) i--;
  const existing = demand[i - 1];
  if (existing && existing.hour === hour) return existing;
  const bucket: HourBucket = { hour, cu: 0, n: 0, censoredMinutes: 0 };
  demand.splice(i, 0, bucket);
  return bucket;
}

function addDemand(s: AllowanceState, hour: Ms, cu: number, n: number): HourBucket {
  const bucket = bucketFor(s, hour);
  bucket.cu += cu;
  bucket.n += n;
  return bucket;
}

/** Close an open censored interval at `at`, spreading its minutes over the hours it spans. */
function closeCensor(s: AllowanceState, at: Ms): void {
  const open = s.censorOpenAt;
  if (open === null) return;
  s.censorOpenAt = null;
  for (let hour = hourOf(open); hour < at; hour += HOUR_MS) {
    const from = Math.max(open, hour);
    const to = Math.min(at, hour + HOUR_MS);
    if (to <= from) continue;
    const bucket = bucketFor(s, hour);
    bucket.censoredMinutes = Math.min(60, bucket.censoredMinutes + (to - from) / MINUTE_MS);
  }
}

/**
 * Credit a sealed interval [from, to). Per hour it is the MAX with what the
 * hour holds, never a sum: the same day's rollups carry each hour's exact
 * total of every interval (taken once, by max), and an hour with no rollup is
 * touched by one interval only (any close is an `ok`, which makes a rollup).
 */
function sealCensor(s: AllowanceState, from: Ms, to: Ms): void {
  for (let hour = hourOf(from); hour < to; hour += HOUR_MS) {
    const overlap = Math.min(to, hour + HOUR_MS) - Math.max(from, hour);
    if (overlap <= 0) continue;
    const bucket = bucketFor(s, hour);
    bucket.censoredMinutes = Math.min(60, Math.max(bucket.censoredMinutes, overlap / MINUTE_MS));
  }
}

function addSession(
  s: AllowanceState,
  session: string,
  at: Ms,
  account: AccountId,
  cu: number,
  tokens: TokenCounts,
  model: string,
  n: number
): void {
  let track = s.sessions[session];
  if (!track) {
    track = {
      firstAt: at,
      lastAt: at,
      hours: [],
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      models: {},
    };
    s.sessions[session] = track;
  }
  track.firstAt = Math.min(track.firstAt, at);
  track.lastAt = Math.max(track.lastAt, at);
  const hour = hourOf(at);
  const cell = track.hours.find((h) => h.hour === hour && h.account === account);
  if (cell) cell.cu += cu;
  else track.hours.push({ hour, account, cu });
  track.tokens.input += tokens.input;
  track.tokens.cacheRead += tokens.cacheRead;
  track.tokens.cacheWrite += tokens.cacheWrite;
  track.tokens.output += tokens.output;
  track.models[model] = (track.models[model] ?? 0) + n;
}

/**
 * Fold one reading of an account. A snapshot with at least one window is
 * COMPLETE: a window it omits counts one miss, and two consecutive misses
 * retire the window. A late snapshot (older than the newest complete one)
 * enters each window's history but never counts a miss or revives a window.
 */
function applySnapshot(
  account: AccountTrack,
  at: Ms,
  readings: readonly WindowReading[],
  cfg: AllowanceConfig
): void {
  const current = account.lastCompleteAt === null || at >= account.lastCompleteAt;
  for (const r of readings) {
    let track = account.windows[r.key];
    if (!track) {
      track = {
        key: r.key,
        slot: r.slot,
        lengthMinutes: r.lengthMinutes,
        quantum: r.quantum,
        readings: [],
        missedComplete: 0,
        retired: false,
      };
      account.windows[r.key] = track;
    }
    const point = { at, usedFraction: r.usedFraction, resetAt: r.resetAt, rejected: r.rejected };
    const list = track.readings;
    let i = list.length;
    while (i > 0 && (list[i - 1]?.at ?? 0) > at) i--;
    const same = list[i - 1];
    const duplicate =
      same !== undefined &&
      same.at === at &&
      same.usedFraction === point.usedFraction &&
      same.resetAt === point.resetAt;
    if (!duplicate) list.splice(i, 0, point);
    while (list.length > cfg.READINGS_MAX) list.shift();
    if (current) {
      track.slot = r.slot;
      track.lengthMinutes = r.lengthMinutes ?? track.lengthMinutes;
      track.quantum = r.quantum;
      track.missedComplete = 0;
      track.retired = false;
    }
  }
  if (readings.length === 0 || !current) return;
  const present = new Set(readings.map((r) => r.key));
  for (const track of Object.values(account.windows)) {
    if (present.has(track.key)) continue;
    track.missedComplete++;
    if (track.missedComplete >= 2) track.retired = true;
  }
  account.lastCompleteAt = at;
}

function prune(s: AllowanceState, cfg: AllowanceConfig): void {
  if (s.lastAt === null) return;
  const horizon = s.lastAt - cfg.DEMAND_WEEKS * WEEK_MS;
  const firstHour = hourOf(horizon);
  while ((s.demand[0]?.hour ?? Number.POSITIVE_INFINITY) < firstHour) s.demand.shift();
  for (const account of Object.values(s.accounts)) {
    while ((account.served[0]?.at ?? Number.POSITIVE_INFINITY) < horizon) account.served.shift();
  }
  const ttl = s.lastAt - cfg.SESSION_TTL_D * DAY_MS;
  for (const [key, track] of Object.entries(s.sessions)) {
    if (track.lastAt < ttl) delete s.sessions[key];
  }
  const keys = Object.keys(s.sessions);
  if (keys.length > cfg.SESSIONS_MAX) {
    const oldest = keys
      .map((key) => ({ key, lastAt: s.sessions[key]?.lastAt ?? 0 }))
      .sort((a, b) => a.lastAt - b.lastAt || (a.key < b.key ? -1 : 1))
      .slice(0, keys.length - cfg.SESSIONS_MAX);
    for (const { key } of oldest) delete s.sessions[key];
  }
}

/** Days the ledger covers at `now`: from the first hour with demand, 0 with none. */
export function ledgerDays(s: AllowanceState, now: Ms): number {
  const first = s.demand[0];
  return first ? Math.max(0, (now - first.hour) / DAY_MS) : 0;
}

/** True when some account has ever been read. */
export function hasReadings(s: AllowanceState): boolean {
  return Object.values(s.accounts).some((a) =>
    Object.values(a.windows).some((w) => w.readings.length > 0)
  );
}

/**
 * The evidence level (§1.7): `none` with no reading of any account;
 * `window-only` under 1 day of ledger; `partial` for 1–7 days; `full` from 7.
 */
export function evidenceOf(
  s: AllowanceState,
  now: Ms
): "none" | "window-only" | "partial" | "full" {
  if (!hasReadings(s)) return "none";
  const days = ledgerDays(s, now);
  if (days < 1) return "window-only";
  return days < 7 ? "partial" : "full";
}
