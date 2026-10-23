/**
 * Every adversarial trace found so far, as DATA (architecture §4, §6 step 2).
 * They exist before the code they judge: the oracle re-derives each served
 * figure now, `simulate` is held to the sticky/ebr columns at step 4, the
 * lookahead column at step 7, the alert traces at step 8, and the tournament
 * reruns all of them at step 10. A trace found later is APPENDED here.
 *
 * Units are abstract cu. In the served traces one task costs 1 cu in every
 * window it touches and a window's capacity is in tasks (§1.8 "worked by
 * hand"), so β of a window is exactly 1/capacity, readings are exact
 * (`quantum: 0`), external use is 0 and admission is `fits`. In the alert
 * traces a governing window holds 100 cu, so β = 0.01 W/cu and "0.21 W/h" is
 * 21 cu/h.
 *
 * Time: `T0` is Monday 00:00 UTC (§5 conventions); `h(n)` is n hours after it.
 * Every reset is a whole number of hours unless stated, and a reset due at R
 * applies before a request at R (§1.6's bucket boundary rule; the vendor
 * applies it at the exact instant, which agrees on whole hours).
 */

import type { AccountId, AllowanceEvent, Ms, WindowReading } from "../types.js";
import type { VendorAccountSpec, VendorWindowSpec } from "./vendor.js";

export const T0: Ms = Date.UTC(2026, 9, 26);
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export function h(hours: number): Ms {
  return T0 + hours * HOUR_MS;
}

/** The lengths every trace uses, in minutes. */
export const LEN = { "1h": 60, "5h": 300, "7d": 10_080 } as const;

/** A fixed-start window with `remaining` of `capacity` tasks left and its reset `resetH` hours after T0. */
function fixed(
  len: keyof typeof LEN,
  capacity: number,
  remaining: number,
  resetH: number
): VendorWindowSpec {
  return {
    slot: len,
    lengthMinutes: LEN[len],
    capacityCu: capacity,
    semantics: "fixed-start",
    usedCu: capacity - remaining,
    resetAt: h(resetH),
  };
}

/** A unit-task account: exact readings, no external use, `fits` admission. */
function taskAccount(id: AccountId, windows: VendorWindowSpec[]): VendorAccountSpec {
  return { id, windows, quantum: 0, admission: "fits", externalCuPerHour: 0 };
}

/** One task per listed hour. */
function tasksAt(...hours: number[]): { at: Ms; cu: number }[] {
  return hours.map((n) => ({ at: h(n), cu: 1 }));
}

/** The contestants a served figure is promised for (§4 table). */
export type Contestant = "sticky" | "ebr" | "lookahead" | "governing-fefo";

/** The §1.8 search parameters the hand figures were worked with. */
export interface TraceParams {
  sessionTailH: number;
  lookaheadHorizonH: number;
  lookaheadDepth: number;
  /** c_s in cu (so k_h·c_s with k_h = 2 is twice this). */
  switchCostCu: number;
  switchHysteresis: number;
}

const HAND_PARAMS: TraceParams = {
  sessionTailH: 3,
  lookaheadHorizonH: 24,
  lookaheadDepth: 4,
  switchCostCu: 0.05,
  switchHysteresis: 2,
};

/** A trace scored by tasks served. Accounts are listed in CONFIG order. */
export interface ServedTrace {
  kind: "served";
  name: string;
  source: string;
  start: Ms;
  accounts: VendorAccountSpec[];
  requests: { at: Ms; cu: number }[];
  params: TraceParams;
  expected: {
    /** The oracle's maximum; the yardstick every promoted default must reach on R1, gpt #1, opus H1. */
    oracle: number;
    /** Promised figures per contestant; absent = no figure is promised. */
    served: Partial<Record<Contestant, number>>;
    /** Alert expectations under a strategy, for the traces that carry one (opus H1). */
    gaps?: Partial<Record<"ebr" | "lookahead", { startH: number; endH: number }[]>>;
  };
  /** Hand-derived figures that are NOT gates, recorded so a later disagreement is visible. */
  notes: string;
}

export const R1: ServedTrace = {
  kind: "served",
  name: "R1",
  source: "plan review round 1, R1 (§1.8)",
  start: T0,
  accounts: [
    taskAccount("bbbbbbbbbbbb", [fixed("7d", 2, 2, 20), fixed("5h", 1, 1, 1)]),
    taskAccount("aaaaaaaaaaaa", [fixed("7d", 2, 2, 10), fixed("5h", 1, 1, 5)]),
  ],
  requests: tasksAt(0, 2, 3),
  params: HAND_PARAMS,
  expected: {
    oracle: 3,
    served: { sticky: 3, ebr: 3, lookahead: 3, "governing-fefo": 2 },
  },
  notes:
    "Oracle: B h0, B h2 (B's 5h refilled at h1), A h3. governing-fefo takes A first (7d resets h10 " +
    "before h20), A's 5h is then spent until h5, B serves h2, and h3 is blocked.",
};

export const GPT_1: ServedTrace = {
  kind: "served",
  name: "gpt #1",
  source: "plan review round 2, gpt #1, hand-checked by the orchestrator (§1.8)",
  start: T0,
  accounts: [
    taskAccount("bbbbbbbbbbbb", [fixed("7d", 20, 2.2, 20), fixed("5h", 1, 1, 1)]),
    taskAccount("aaaaaaaaaaaa", [
      fixed("7d", 2, 2, 10),
      fixed("5h", 1, 1, 2),
      fixed("1h", 1, 1, 0.5),
    ]),
  ],
  requests: tasksAt(0, 1, 2, 3),
  params: HAND_PARAMS,
  expected: {
    oracle: 4,
    served: { sticky: 4, ebr: 3, lookahead: 4, "governing-fefo": 3 },
  },
  notes:
    "Oracle and lookahead: B h0, A h1, A h2 (A's 1h and 5h refilled at h1.5/h2), B h3 (B's 5h refilled " +
    "at h1, unused). Every A-first sequence serves at most 3. lookahead decisions: B initial, A switch, " +
    "A sticky, B forced (§5 case 1c).",
};

export const OPUS_H1: ServedTrace = {
  kind: "served",
  name: "opus H1",
  source: "plan review round 2, opus H1: rev 1's alert model and its selection disagreed (§1.8)",
  start: T0,
  accounts: [
    taskAccount("aaaaaaaaaaaa", [fixed("7d", 2, 1, 100), fixed("5h", 1, 1, 1)]),
    taskAccount("bbbbbbbbbbbb", [fixed("7d", 2, 2, 5)]),
  ],
  // "3 at h50" is three one-task requests: a request is indivisible, a bucket is not.
  requests: tasksAt(0, 1, 50, 50, 50),
  params: HAND_PARAMS,
  expected: {
    oracle: 5,
    served: { sticky: 4, ebr: 4, lookahead: 5, "governing-fefo": 5 },
    gaps: { lookahead: [], ebr: [{ startH: 50, endH: 100 }] },
  },
  notes:
    "B serves h0 and h1 and refills to 2 at h5 with no waste; at h50 B 2 + A 1. EBR spends A's only " +
    "weekly unit at h0 (A's 5h binds at h1, before B's h5) and has a 50 h 7d gap h50→h100.",
};

export const OPUS_CHOOSE: ServedTrace = {
  kind: "served",
  name: "opus choose",
  source:
    "plan review round 2, opus response-03 ('three accounts with old units about to expire', given " +
    "without numbers); numbers built and pinned at §6 step 2",
  start: T0,
  accounts: [
    taskAccount("xxxxxxxxxxxx", [fixed("7d", 1, 1, 1)]),
    taskAccount("yyyyyyyyyyyy", [fixed("7d", 1, 1, 2)]),
    taskAccount("zzzzzzzzzzzz", [fixed("7d", 1, 1, 3)]),
  ],
  requests: tasksAt(0, 1, 2, 10, 10, 10),
  params: HAND_PARAMS,
  expected: {
    oracle: 6,
    served: {},
  },
  notes:
    "Each account holds one unit that expires at its reset (X h1, Y h2, Z h3) and one fresh unit after " +
    "it. The only 6-task schedule is X h0, Y h1, Z h2, then X, Y, Z at h10. Rev 1's rule (one first " +
    "account fixed for the SESSION_TAIL_H = 3 prefix, leftover spilled in EBR order, EBR after it) " +
    "serves 5 for every first account: X-first spends X's fresh unit at h1 and lets Y's old unit " +
    "expire; Y-first and Z-first let X's old unit expire. Plain EBR re-decided per request serves 6. " +
    "Hand figures, not gates: sticky 4 (X h0, X h1, Y h2, then only Z at h10), ebr 6.",
};

/** The served traces, in the §4 table's order. */
export const SERVED_TRACES: readonly ServedTrace[] = [R1, GPT_1, OPUS_H1, OPUS_CHOOSE];

/** Per-bucket demand (cu per hour from `start`), the form `simulate` takes. */
export function bucketDemandOf(
  trace: Pick<ServedTrace, "start" | "requests">,
  buckets: number
): number[] {
  const demand: number[] = new Array(buckets).fill(0);
  for (const r of trace.requests) {
    const k = Math.floor((r.at - trace.start) / HOUR_MS);
    if (k >= 0 && k < buckets) demand[k] = (demand[k] ?? 0) + r.cu;
  }
  return demand;
}

// ---------------------------------------------------------------------------
// Alert traces (§1.9). A governing window holds 100 cu: β = 0.01 W/cu.

const WEEK_CU = 100;

/** A Codex-like 7d-only account at `used` fraction with its reset `resetH` hours after T0. */
function weekly(
  id: AccountId,
  used: number,
  resetH: number,
  externalCuPerHour = 0
): VendorAccountSpec {
  return {
    id,
    windows: [
      {
        slot: "primary",
        lengthMinutes: LEN["7d"],
        capacityCu: WEEK_CU,
        semantics: "fixed-start",
        usedCu: used * WEEK_CU,
        resetAt: h(resetH),
      },
    ],
    quantum: 0.01,
    admission: "below-cap",
    externalCuPerHour,
  };
}

/** A trace whose expectation is the set of gaps `gaps()` finds, and the alert it raises. */
export interface GapTrace {
  kind: "gaps";
  name: string;
  source: string;
  start: Ms;
  accounts: VendorAccountSpec[];
  /** Local demand at a constant rate per scenario (cu/h); 0 = none. */
  scenarios: {
    rateCuPerHour: number;
    /** Every 7d-kind gap, in hours from T0, with the accepted range for the second endpoint. */
    gaps: {
      startH: number;
      endH: number;
      startRangeH?: [number, number];
      lengthRangeH?: [number, number];
    }[];
    level: "warn" | "critical" | null;
    remedy?: {
      kind: "cut" | "pause" | "not-addressable";
      reason?: "external-use" | "no-grid-point";
    };
  }[];
  /** Under which deployable strategies the same gaps hold. */
  strategies: ("sticky" | "ebr" | "lookahead")[];
  notes: string;
}

export const R2: GapTrace = {
  kind: "gaps",
  name: "R2",
  source: "plan review round 1, R2 (§1.9, §5 case 22b)",
  start: T0,
  accounts: [weekly("aaaaaaaaaaaa", 0, 10), weekly("bbbbbbbbbbbb", 0, 100)],
  scenarios: [
    {
      rateCuPerHour: 21,
      gaps: [
        { startH: 9, endH: 10 },
        { startH: 14, endH: 100, lengthRangeH: [84, 87] },
      ],
      level: "critical",
    },
    {
      rateCuPerHour: 15,
      gaps: [{ startH: 20, endH: 100, lengthRangeH: [79, 81] }],
      level: "critical",
    },
  ],
  strategies: ["sticky", "ebr", "lookahead"],
  notes:
    "At 21 cu/h: 200 cu lasts buckets 0–8 and part of 9, A's reset at h10 applies BEFORE bucket 10 " +
    "(a 1 h gap, not 2 h), A's fresh 100 cu lasts buckets 10–13, then nothing until B's h100. The 4 h " +
    "of service between the gaps is over GAP_MERGE_H, so they stay two gaps, and the CRITICAL is on " +
    "the second. At 15 cu/h A is empty before h10, B still has 50 at h10, and 150 cu last exactly " +
    "buckets 10–19.",
};

export const GPT_8: GapTrace = {
  kind: "gaps",
  name: "gpt #8",
  source:
    "plan review round 2, gpt #8: a gap caused by external use alone (§1.9 remedy step 1, §5 case 22c)",
  start: T0,
  accounts: [weekly("aaaaaaaaaaaa", 0.9, 100, 2)],
  scenarios: [
    {
      rateCuPerHour: 0,
      gaps: [{ startH: 5, endH: 100, startRangeH: [4, 6], lengthRangeH: [94, 96] }],
      level: "critical",
      remedy: { kind: "not-addressable", reason: "external-use" },
    },
  ],
  strategies: ["sticky", "ebr", "lookahead"],
  notes:
    "10 cu left, external drift 2 cu/h (0.02 W/h, η identified): empty at h5, blocked until h100 with " +
    "zero local demand, so no cut or pause of claudish work can help.",
};

/** One evaluation of a level, as `alertStep` receives it (gaps in hours from T0). */
export interface EvaluationStep {
  atMinutes: number;
  long: { startH: number; lengthH: number }[];
  short: { startH: number; lengthH: number }[];
  blockedNow: boolean;
}

/** A trace whose expectation is the transitions `alertStep` emits over an evaluation sequence. */
export interface EpisodeTrace {
  kind: "episode";
  name: string;
  source: string;
  start: Ms;
  level: "warn";
  steps: EvaluationStep[];
  expected: {
    /** Transitions in order, by the step's minute. */
    transitions: { atMinutes: number; to: "raised" | "cleared" | "escalated" | "deescalated" }[];
    episodes: number;
  };
  notes: string;
}

const GAP_X = { startH: 20, lengthH: 30 };
const GAP_X_LONG = { startH: 20, lengthH: 31 };
const GAP_Y = { startH: 60, lengthH: 31 };
const GAP_Y_SHORT = { startH: 60, lengthH: 30 };

function opusM4Steps(): EvaluationStep[] {
  const steps: EvaluationStep[] = [];
  // Entry: X alone at 0 and 15 min raises the WARN at 15 (ENTRY_HOLD 15 min).
  for (const atMinutes of [0, 5, 10, 15]) {
    steps.push({ atMinutes, long: [GAP_X], short: [GAP_X], blockedNow: false });
  }
  // Then every 5 min for 2 h the two disjoint gaps alternate which is longest.
  for (let i = 0; i < 24; i++) {
    const atMinutes = 20 + i * 5;
    const gaps = i % 2 === 0 ? [GAP_Y, GAP_X] : [GAP_X_LONG, GAP_Y_SHORT];
    steps.push({ atMinutes, long: gaps, short: gaps, blockedNow: false });
  }
  return steps;
}

export const OPUS_M4: EpisodeTrace = {
  kind: "episode",
  name: "opus M4",
  source:
    "plan review round 2, opus M4: episodes flip between two disjoint gaps (§1.9, §5 case 24c)",
  start: T0,
  level: "warn",
  steps: opusM4Steps(),
  expected: { transitions: [{ atMinutes: 15, to: "raised" }], episodes: 1 },
  notes:
    "Gaps X (h20, 30–31 h) and Y (h60, 30–31 h) never overlap and start 40 h apart. Matching the " +
    "prior episode against EVERY qualifying gap keeps X's episode; matching only the longest opens a " +
    "new episode on every flip.",
};

/** A decision trace: one decision, an account it must not move onto, and a display figure. */
export interface DecisionTrace {
  kind: "decision";
  name: string;
  source: string;
  start: Ms;
  accounts: VendorAccountSpec[];
  /** The thread's current account (a0). */
  threadAccount: AccountId;
  demandCuPerHour: number;
  params: TraceParams;
  expected: {
    account: AccountId;
    neverOnto: AccountId;
    deliverable: { account: AccountId; value: number; tolerance: number };
  };
  notes: string;
}

export const R3: DecisionTrace = {
  kind: "decision",
  name: "R3",
  source:
    "plan review round 1, R3: a 5h reset one minute before the weekly reset (§1.5, §5 case 5b)",
  start: T0,
  accounts: [
    {
      id: "aaaaaaaaaaaa",
      windows: [
        { ...fixed("7d", 100, 50, 10), slot: "primary" },
        {
          slot: "secondary",
          lengthMinutes: LEN["5h"],
          capacityCu: 10,
          semantics: "fixed-start",
          usedCu: 5,
          resetAt: h(9) + 59 * MINUTE_MS,
        },
      ],
      quantum: 0,
      admission: "below-cap",
    },
    {
      id: "bbbbbbbbbbbb",
      windows: [{ ...fixed("7d", 100, 60, 120), slot: "primary" }],
      quantum: 0,
      admission: "below-cap",
    },
  ],
  threadAccount: "bbbbbbbbbbbb",
  demandCuPerHour: 1,
  params: { ...HAND_PARAMS, switchCostCu: 5 },
  expected: {
    account: "bbbbbbbbbbbb",
    neverOnto: "aaaaaaaaaaaa",
    deliverable: { account: "aaaaaaaaaaaa", value: 0.0503, tolerance: 0.0005 },
  },
  notes:
    "κ = 10 (C7/C5 = 100/10). deliverable(A) = (0.5 + 1/300)/10 = 0.0503 W: the 5h window that opens " +
    "at 9:59 is credited for 1 minute of 300, not as a whole window (ceil gave 0.15). Using A before " +
    "h10 saves at most its 5 cu of 5h capacity, below k_h·c_s = 10; crediting a whole fresh 5h window " +
    "would make it 15 and move the thread.",
};

/** A trace of raw events and what the model must conclude from them. */
export interface ObservationTrace {
  kind: "observation";
  name: string;
  source: string;
  start: Ms;
  events: AllowanceEvent[];
  expected: Record<string, number | string | boolean>;
  notes: string;
}

function codexReading(key: "len:300" | "len:10080", used: number, resetAt: Ms): WindowReading {
  return {
    key,
    slot: key === "len:300" ? "secondary" : "primary",
    lengthMinutes: key === "len:300" ? LEN["5h"] : LEN["7d"],
    usedFraction: used,
    resetAt,
    rejected: false,
    quantum: 0.01,
  };
}

const ZERO_TOKENS = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

function response(
  id: string,
  at: Ms,
  windows: WindowReading[] | null,
  cu = 0
): Extract<AllowanceEvent, { kind: "response" }> {
  return {
    kind: "response",
    id,
    at,
    account: "aaaaaaaaaaaa",
    session: null,
    model: "gpt-6-astra",
    tokens: { ...ZERO_TOKENS, input: cu },
    finalInput: cu,
    windows,
    outcome: "ok",
  };
}

/** `simulate` over one sliding 5h window (§5 case 14). */
export interface SlidingTrace {
  kind: "sliding";
  name: string;
  source: string;
  start: Ms;
  account: VendorAccountSpec;
  demand: number[];
  expected: { remainingAtBucket: number; remaining: number; tolerance: number };
  notes: string;
}

export const SLIDING_RELEASE: SlidingTrace = {
  kind: "sliding",
  name: "sliding release",
  source: "rev 1 trace (§5 case 14)",
  start: T0,
  account: {
    id: "aaaaaaaaaaaa",
    windows: [{ slot: "secondary", lengthMinutes: LEN["5h"], capacityCu: 5, semantics: "sliding" }],
    quantum: 0,
    admission: "below-cap",
  },
  demand: [1, 1, 1],
  expected: { remainingAtBucket: 5, remaining: 0.6, tolerance: 1e-9 },
  notes:
    "β = 0.2 W/cu. 0.6 W served over buckets 0–2; bucket 0's 0.2 is released L = 5 h after it was " +
    "served, at the start of bucket 5, so r = 1 − 0.6 + 0.2 = 0.6, not a full reset to 1.0.",
};

export const WINDOW_RETIRED: ObservationTrace = {
  kind: "observation",
  name: "window retired by complete snapshots",
  source: "rev 1 trace (§1.4 Absence, §5 case 13c)",
  start: T0,
  events: [
    response("r1:0:aaaaaaaaaaaa", h(0), [
      codexReading("len:10080", 0.2, h(100)),
      codexReading("len:300", 0.1, h(3)),
    ]),
    response("r2:0:aaaaaaaaaaaa", h(1), null),
    response("r3:0:aaaaaaaaaaaa", h(2), null),
    response("r4:0:aaaaaaaaaaaa", h(3) + 30 * MINUTE_MS, [codexReading("len:10080", 0.25, h(100))]),
    response("r5:0:aaaaaaaaaaaa", h(4), [codexReading("len:10080", 0.3, h(100))]),
  ],
  expected: {
    liveAfterEvent3: "len:300",
    retiredAfterEvent5: "len:300",
    liveAfterEvent4: "len:300",
  },
  notes:
    "Two `windows: null` responses are no information: the 5h window stays live. ONE complete " +
    "snapshot without it does not retire it; the second consecutive one does.",
};

export const STRIPPED_HEADERS: ObservationTrace = {
  kind: "observation",
  name: "stripped headers",
  source: "rev 1 trace (§1.4: no usable snapshot vs window omitted)",
  start: T0,
  events: [
    response("s1:0:aaaaaaaaaaaa", h(0), [codexReading("len:10080", 0.4, h(100))], 1000),
    response("s2:0:aaaaaaaaaaaa", h(1), null, 1000),
  ],
  expected: {
    headUsedFraction: 0.4,
    headAt: h(0),
    windowLive: "len:10080",
    tokensCounted: 2000,
  },
  notes:
    "A response whose headers were stripped still billed its tokens (they count toward demand), but " +
    "its `windows: null` neither moves the head reading nor retires any window.",
};

/** Every non-served trace, in the §4 table's order. */
export const ALERT_TRACES: readonly (
  | GapTrace
  | EpisodeTrace
  | DecisionTrace
  | SlidingTrace
  | ObservationTrace
)[] = [R2, R3, GPT_8, OPUS_M4, SLIDING_RELEASE, WINDOW_RETIRED, STRIPPED_HEADERS];

/** Every trace, served first. The tournament (§4) reruns all of them. */
export const ADVERSARIAL_TRACES = [...SERVED_TRACES, ...ALERT_TRACES] as const;
