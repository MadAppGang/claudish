/**
 * Per-account claudish usage by hour (MTL-297): the grid behind the report's
 * `usage` section, from which the forecast panel draws which account served
 * each hour of the last 14 days.
 *
 * - **Source.** `AccountTrack.served`, kept DEMAND_WEEKS; a rollup's cu sits
 *   at its hour's middle, so `hourOf` puts it in the right cell. Sessions are
 *   not the source: they are dropped after SESSION_TTL_D idle days and at
 *   SESSIONS_MAX, so they do not cover 14 days.
 * - **Censoring is pool-wide** (`state.ts`): a censored cell's cu is what was
 *   SERVED, so a zero there means blocked, not idle. An interval still open
 *   (`censorOpenAt`) is projected up to `now` here, never written to the
 *   state: it is disjoint from every sealed one, so the two add, capped at 60.
 * - **Coverage** starts at `recordedFrom`, the first hour any ledger row was
 *   folded for, zero cu included, so "idle" and "not recording yet" differ
 *   the same way for raw rows and their hourly rollups.
 * - **Raw sums.** Every account in the state, in no particular order and
 *   unrounded; ordering, dropping and rounding are the shell's.
 */

import { USAGE_HOURS } from "./constants.js";
import { hourOf } from "./state.js";
import type { AllowanceState, Ms, UsageGrid } from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The `hours` hours ending with the one holding `now`, cell by cell. */
export function usageByHour(s: AllowanceState, now: Ms, hours: number = USAGE_HOURS): UsageGrid {
  const cells = Math.max(1, Math.floor(hours));
  const start = hourOf(now) - (cells - 1) * HOUR_MS;
  const end = start + cells * HOUR_MS;
  const cellOf = (at: Ms) => Math.floor((at - start) / HOUR_MS);
  const accounts = Object.values(s.accounts).map((a) => {
    const cu = new Array<number>(cells).fill(0);
    for (const served of a.served) {
      if (served.at < start || served.at >= end) continue;
      const i = cellOf(served.at);
      cu[i] = (cu[i] ?? 0) + served.cu;
    }
    return { account: a.id, order: a.order, enabled: a.enabled, cu };
  });
  const censoredMinutes = new Array<number>(cells).fill(0);
  for (const bucket of s.demand) {
    if (bucket.hour < start || bucket.hour >= end || bucket.censoredMinutes <= 0) continue;
    const i = cellOf(bucket.hour);
    censoredMinutes[i] = Math.min(60, (censoredMinutes[i] ?? 0) + bucket.censoredMinutes);
  }
  const open = s.censorOpenAt;
  if (open !== null) {
    const until = Math.min(now, end);
    for (let hour = Math.max(hourOf(open), start); hour < until; hour += HOUR_MS) {
      const minutes = (Math.min(until, hour + HOUR_MS) - Math.max(open, hour)) / MINUTE_MS;
      if (minutes <= 0) continue;
      const i = cellOf(hour);
      censoredMinutes[i] = Math.min(60, (censoredMinutes[i] ?? 0) + minutes);
    }
  }
  const recorded = s.recordedFrom ?? s.demand[0]?.hour ?? null;
  return {
    start,
    hours: cells,
    accounts,
    censoredMinutes,
    coveredFrom: recorded === null ? null : Math.max(recorded, start),
  };
}
