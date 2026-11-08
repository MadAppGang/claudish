/**
 * The tournament's scenarios (architecture §4 `scenarios.ts`): a NAMED list,
 * never a Cartesian matrix (R21). Every adversarial trace runs separately
 * (`tournament.ts`); the scenarios here run through `run.ts` on matched seeds.
 *
 * - each profile on `2× offset 26 h`;
 * - `steady` and `weekday-heavy` on `1×`, `2× balanced`, `2× one at 0.6`, `3×`
 *   and `2× unequal 1:2`;
 * - `over-subscribed` and `external-drift` on `2× offset 26 h` with a sliding
 *   5h window, with a first-use 7d window, and with quantum 0.001;
 * - `over-subscribed recovery` (§5 case 38b): a vendor-side reset of every
 *   window after the first WARN, then demand at 0.3× weekly capacity.
 *
 * Accounts are Codex-shaped: a 7d window of WEEK_CU and a 5h window of WEEK_CU/8
 * (`primary`/`secondary`), reported in whole percent, floored, `below-cap`
 * admission. Each account starts mid-epoch, used as far as the scenario's load
 * would have taken it.
 */

import { PROFILE_EXTERNAL, PROFILE_LOAD, type TraceProfile } from "./traces.js";
import type { VendorAccountSpec, VendorSemantics } from "./vendor.js";

const HOUR_MS = 3_600_000;
const WEEK_H = 168;
/** One account's weekly capacity in cu: about 900 typical agent turns. */
export const WEEK_CU = 20_000_000;
const FIVE_HOUR_SHARE = 1 / 8;
const IDS = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"] as const;

export interface Scenario {
  name: string;
  profile: TraceProfile;
  /** The accounts at `start`. */
  accounts: (start: number) => VendorAccountSpec[];
  /** Step alerts every EVAL_CADENCE and report the alert metrics. */
  alerts: boolean;
  /** §5 case 38b: after the first WARN, reset every window and drop demand to 0.3×. */
  recovery?: boolean;
}

interface AccountShape {
  /** The 7d reset, hours after start. */
  resetH: number;
  /** Capacity multiple of WEEK_CU. */
  size?: number;
  /** Used share of the 7d window at start; default the load times the elapsed share. */
  used?: number;
}

interface Variant {
  fiveHour?: VendorSemantics;
  weekly?: VendorSemantics;
  quantum?: number;
}

function accounts(
  shapes: readonly AccountShape[],
  profile: TraceProfile,
  variant: Variant = {}
): (start: number) => VendorAccountSpec[] {
  const load = PROFILE_LOAD[profile];
  const perAccountExternal = PROFILE_EXTERNAL[profile] * load;
  return (start) =>
    shapes.map((shape, i) => {
      const size = shape.size ?? 1;
      const week = WEEK_CU * size;
      const five = week * FIVE_HOUR_SHARE;
      const elapsed = (WEEK_H - shape.resetH) / WEEK_H;
      const used = Math.min(0.95, shape.used ?? load * elapsed);
      const weekly = variant.weekly ?? "fixed-start";
      const fiveHour = variant.fiveHour ?? "fixed-start";
      return {
        id: IDS[i] ?? `acct${i}`.padEnd(12, "x"),
        windows: [
          {
            slot: "primary",
            lengthMinutes: 10_080,
            capacityCu: week,
            semantics: weekly,
            usedCu: weekly === "sliding" ? 0 : used * week,
            resetAt: start + shape.resetH * HOUR_MS,
          },
          {
            slot: "secondary",
            lengthMinutes: 300,
            capacityCu: five,
            semantics: fiveHour,
            usedCu: fiveHour === "sliding" ? 0 : 0.3 * five,
            ...(fiveHour === "sliding"
              ? { history: [{ at: start - 2 * HOUR_MS, cu: 0.3 * five }] }
              : { resetAt: start + (2 + i) * HOUR_MS }),
          },
        ],
        quantum: variant.quantum ?? 0.01,
        rounding: "floor",
        admission: "below-cap",
        externalCuPerHour: (perAccountExternal * week) / WEEK_H,
      } satisfies VendorAccountSpec;
    });
}

const OFFSET_26: AccountShape[] = [{ resetH: 30 }, { resetH: 56 }];
const ONE: AccountShape[] = [{ resetH: 30 }];
const BALANCED: AccountShape[] = [{ resetH: 30 }, { resetH: 114 }];
const ONE_AT_06: AccountShape[] = [{ resetH: 30 }, { resetH: 56, used: 0.6 }];
const THREE: AccountShape[] = [{ resetH: 30 }, { resetH: 86 }, { resetH: 142 }];
const UNEQUAL: AccountShape[] = [{ resetH: 30 }, { resetH: 56, size: 2 }];

const PROFILES: TraceProfile[] = [
  "steady",
  "bursty",
  "weekday-heavy",
  "refactor-day",
  "over-subscribed",
  "external-drift",
];

function build(): Scenario[] {
  const out: Scenario[] = [];
  for (const profile of PROFILES) {
    out.push({
      name: `${profile} · 2× offset 26 h`,
      profile,
      accounts: accounts(OFFSET_26, profile),
      alerts: profile === "over-subscribed",
    });
  }
  for (const profile of ["steady", "weekday-heavy"] as const) {
    const shapes: [string, AccountShape[]][] = [
      ["1×", ONE],
      ["2× balanced", BALANCED],
      ["2× one at 0.6", ONE_AT_06],
      ["3×", THREE],
      ["2× unequal 1:2", UNEQUAL],
    ];
    for (const [label, shape] of shapes) {
      out.push({
        name: `${profile} · ${label}`,
        profile,
        accounts: accounts(shape, profile),
        alerts: false,
      });
    }
  }
  for (const profile of ["over-subscribed", "external-drift"] as const) {
    const variants: [string, Variant][] = [
      ["sliding 5h", { fiveHour: "sliding" }],
      ["first-use 7d", { weekly: "first-use" }],
      ["quantum 0.001", { quantum: 0.001 }],
    ];
    for (const [label, variant] of variants) {
      out.push({
        name: `${profile} · 2× offset 26 h · ${label}`,
        profile,
        accounts: accounts(OFFSET_26, profile, variant),
        alerts: profile === "over-subscribed",
      });
    }
  }
  out.push({
    name: "over-subscribed recovery · 2× offset 26 h",
    profile: "over-subscribed",
    accounts: accounts(OFFSET_26, "over-subscribed"),
    alerts: true,
    recovery: true,
  });
  return out;
}

export const SCENARIOS: readonly Scenario[] = build();

/** Scenarios whose name contains `filter` (case-insensitive); all when it is empty. */
export function scenariosMatching(filter: string | undefined): Scenario[] {
  if (!filter) return [...SCENARIOS];
  const lower = filter.toLowerCase();
  return SCENARIOS.filter((s) => s.name.toLowerCase().includes(lower));
}
