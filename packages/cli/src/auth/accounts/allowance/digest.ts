/**
 * Seed and memo keys (architecture §1.1). **The seed and the memo key are
 * separate, and each is exact about its inputs.**
 *
 * - `seedKey = fnv1a32(closedHourDemandDigest + "|" + floor(now/1h))`, and
 *   `seed = seedKey ^ cfg.seed`. No reading enters the seed: a normal response
 *   moves a weekly reading by ≥ 1 pp, so a seed that included readings changed
 *   on nearly every request. This one is stable for the whole hour.
 * - `forecastKey` holds every input of the cached `Forecast` and nothing else:
 *   the seed key, the evidence inputs (empty under `full`; the window rate to 3
 *   significant digits plus the ledger's day count under `window-only`/
 *   `partial`, the only levels that read the readings), the horizon, the
 *   calendar and the config.
 */

import { accountViews, strongBetas, windowRates } from "./capacity.js";
import { fnv1a32, fnvHex } from "./prng.js";
import { evidenceOf, ledgerDays } from "./state.js";
import type {
  AccountView,
  AllowanceConfig,
  AllowanceState,
  Calendar,
  Ms,
  PlanInput,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** The step a remaining is quantised to when its window reports exactly. */
const EXACT_STEP = 0.001;

/**
 * The views as a plan or a gap evaluation reads them: each window's remaining
 * to its quantum (0.001 when exact) and its reset to the minute.
 */
export function viewsDigest(views: readonly AccountView[]): string {
  const parts: string[] = [];
  for (const v of views) {
    const windows = v.windows.map((w) => {
      const step = w.quantum > 0 ? w.quantum : EXACT_STEP;
      const r = w.remaining === null ? "-" : String(Math.round(w.remaining / step));
      const reset = w.resetAt === null ? "-" : String(Math.floor(w.resetAt / MINUTE_MS));
      return `${w.key}=${r}@${reset}${w.rejected ? "!" : ""}`;
    });
    parts.push(`${v.account}#${v.order}:${windows.join(",")}`);
  }
  return fnvHex(parts.join(";"));
}

/** `planKey(PlanInput)`: the quantised views, the thread, the pool's active account and the demand. */
export function planKey(input: PlanInput): string {
  const demand = (xs: readonly number[]) => xs.map(sig3).join(",");
  return fnvHex(
    [
      viewsDigest(input.views),
      input.thread.account ?? "-",
      input.thread.lastSwitchAt ?? "-",
      input.thread.contextTokens ?? "-",
      input.poolActive ?? "-",
      demand(input.demand.d75),
      demand(input.demand.d90),
    ].join("|")
  );
}

/**
 * Every CLOSED hour's demand (hour, cu, censored minutes), in order, and a
 * censored interval still open since before the open hour: it censors the
 * closed hours it covers.
 */
export function closedHourDemandDigest(s: AllowanceState, now: Ms): string {
  const parts: string[] = [];
  for (const b of s.demand) {
    if (b.hour + HOUR_MS > now) break;
    parts.push(`${b.hour}:${b.cu}:${b.censoredMinutes}`);
  }
  const openHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  if (s.censorOpenAt !== null && s.censorOpenAt < openHour) parts.push(`open:${s.censorOpenAt}`);
  return fnvHex(parts.join(","));
}

/** Stable for the hour, whatever the responses inside it do. Unsigned. */
export function seedKey(s: AllowanceState, now: Ms): number {
  return fnv1a32(`${closedHourDemandDigest(s, now)}|${Math.floor(now / HOUR_MS)}`);
}

/** The forecast's seed: `seedKey ^ cfg.seed`, unsigned. */
export function seedOf(s: AllowanceState, now: Ms, cfg: Pick<AllowanceConfig, "seed">): number {
  return (seedKey(s, now) ^ cfg.seed) >>> 0;
}

/** `n` to 3 significant digits, as a string. */
function sig3(n: number): string {
  return Number.isFinite(n) && n !== 0 ? n.toPrecision(3) : "0";
}

/**
 * What the forecast reads from the readings: nothing under `none`, nothing but
 * the unit under `full` in `cu`. In `account-fraction` the level is the window
 * rate at EVERY evidence level (§1.7), so the rate is in the key then too.
 */
export function evidenceInputs(s: AllowanceState, now: Ms, cfg: AllowanceConfig): string {
  const evidence = evidenceOf(s, now);
  if (evidence === "none") return evidence;
  const views = accountViews(s, now, cfg);
  const cu = strongBetas(views);
  if (evidence === "full" && cu) return "full:cu";
  const rates = windowRates(views, now);
  const rate = cu && rates.cu !== null ? `cu:${sig3(rates.cu)}` : `frac:${sig3(rates.frac)}`;
  return `${evidence}:${rate}:${Math.floor(ledgerDays(s, now))}`;
}

export function calendarDigest(cal: Calendar): string {
  return fnvHex(cal.offsets.map((o) => `${o.from}:${o.offsetMinutes}`).join(","));
}

/** The config's own digest: every field, in key order. */
export function cfgDigest(cfg: AllowanceConfig): string {
  const record = cfg as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return fnvHex(keys.map((k) => `${k}=${JSON.stringify(record[k])}`).join(";"));
}

export function forecastKey(
  s: AllowanceState,
  now: Ms,
  horizonMs: Ms,
  cal: Calendar,
  cfg: AllowanceConfig
): string {
  return fnvHex(
    [
      seedKey(s, now),
      evidenceInputs(s, now, cfg),
      horizonMs,
      calendarDigest(cal),
      cfgDigest(cfg),
    ].join("|")
  );
}
