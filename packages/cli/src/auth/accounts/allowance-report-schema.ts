/**
 * `claudish.allowance.v1`: the allowance report's wire schema (allowance
 * architecture §3.1), and the `allowance_status` answer that carries it to the
 * Claude Code mod (§3.4).
 *
 * ## One schema, three readers
 *
 * `claudish account forecast --json`, the MCP tool `allowance_status` and the
 * magus mod's `allowance-source.ts` all read this shape. Fields are only ever
 * ADDED within v1: a renamed or removed field breaks a script or blanks the mod
 * band with no error on our side. Times are ISO strings for scripts; the pure
 * core uses ms and the shell converts.
 *
 * The objects are not strict, so a reader built against an older v1 keeps
 * parsing a newer report and drops what it does not know.
 *
 * ## Model-visible
 *
 * The MCP answer reaches the model: it carries no project, and a session id is
 * at most 8 characters (`sessions[].session`). Both are checked here, so a
 * builder that leaks a full id fails validation instead of shipping it.
 */

import { z } from "zod";

export const ALLOWANCE_REPORT_SCHEMA = "claudish.allowance.v1";

/** The closed glyph set of the one sparkline renderer (`sparkline`, §1.10), and space. */
export const SPARKLINE_GLYPHS = "▁▂▃▄▅▆▇█▒▓┊ ";

const iso = z.iso.datetime({ offset: true });
const fraction = z.number().min(0).max(1);
const finite = z.number().finite();
const nonNegative = z.number().finite().min(0);

const quantilesOf = <T extends z.ZodType>(t: T) =>
  z.object({ p10: t, p25: t, p50: t, p75: t, p90: t });

const alertLevel = z.enum(["warn", "critical"]);
const strategyName = z.enum(["sticky", "ebr", "lookahead"]);
const evidence = z.enum(["none", "window-only", "partial", "full"]);
const unit = z.enum(["cu", "account-fraction"]);
const provenance = z.enum(["observed", "reset-inferred", "unknown"]);
const semantics = z.enum(["fixed-start", "sliding", "unknown"]);
const gapKind = z.enum(["7d", "5h"]);
const exactness = z.enum(["single-session", "pro-rata", "external-unidentified", "uncalibrated"]);

const accountSchema = z.object({
  label: z.string(),
  id: z.string(),
  planClass: z.string().nullable(),
  /** Governing-window fraction deliverable before the governing reset. */
  deliverable: fraction.nullable(),
  binding: z.string().nullable(),
  windows: z.array(
    z.object({
      key: z.string(),
      displayId: z.string(),
      usedFraction: fraction,
      resetAt: iso.nullable(),
      provenance,
      semantics,
    })
  ),
  /**
   * λ is an output of a `lookahead` plan's stay simulation (types.ts
   * `Plan.lambda`). The report never computes it, so null means NOT COMPUTED;
   * it never means "no switch".
   */
  lambda: z.union([z.literal(0), z.literal(1)]).nullable(),
  /** The quality of each estimate: `prior`, `coarse` or `calibrated`. */
  calibration: z.object({ beta: z.string(), kappa: z.string().nullable() }),
  /**
   * The account the pool is on: `state.json` `active` read at report time, the
   * same predicate as `account list`. At most one is true; all are false when
   * no account is active or the active one is disabled or removed (it is then
   * not in `accounts[]`). Added within v1; absent from a report of an older
   * claudish.
   */
  active: z.boolean().optional(),
  /**
   * The 0-based position in `account list`, disabled accounts counted.
   * `accounts[]` holds only ENABLED accounts, so an index into it is not the
   * profile number; the number is `order + 1`. Added within v1; absent from a
   * report of an older claudish.
   */
  order: z.number().int().min(0).optional(),
  /**
   * The share of the account's GOVERNING window expected to expire unused at
   * its next governing reset `at`, as p10 / p50 / p90 over the trajectory's
   * paths (a fraction of the window, the same in both units). Independent of
   * `horizonHours`: the simulation always reaches that reset. Resets apply at
   * hour starts, so demand between `at` and the next hour counts as spent (a
   * slight under-statement). Null for an unread account, a sliding governing
   * window or one without a reset time, a reset past the simulation grid, or
   * no evidence. Added within v1; absent from a report of an older claudish.
   */
  lostAtReset: z
    .object({ at: iso, p10: fraction, p50: fraction, p90: fraction })
    .nullable()
    .optional(),
});

const remedySchema = z.object({
  kind: z.enum(["cut", "pause", "not-addressable"]),
  cutToPercent: z.number().min(0).max(100).nullable(),
  until: iso.nullable(),
  pauseHours: nonNegative.nullable(),
  reason: z.enum(["external-use", "no-grid-point"]).nullable(),
  /** The one line every surface prints. */
  text: z.string(),
});

const alertSchema = z.object({
  level: alertLevel,
  since: iso,
  /** Absolute, so a reader formats it at render time (R19): ms since the Unix epoch, the median start. */
  gapStartEpoch: nonNegative,
  gapStart: quantilesOf(iso).nullable(),
  gapEnd: quantilesOf(iso).nullable(),
  gapHours: quantilesOf(nonNegative).nullable(),
  pGap: fraction,
  binding: z.array(z.object({ account: z.string(), window: z.string() })),
  remedy: remedySchema,
});

/** One hour of `trajectory.history`, and of each account's `historyByAccount` series. */
const historyPoint = z.object({
  at: iso,
  remaining: finite,
  provenance: z.enum(["observed", "reset-inferred"]),
});

/** One predicted switch (`trajectory.switches[]`, `trajectory.slower.switches[]`). */
const switchSchema = z.object({
  accountId: z.string(),
  soonest: iso,
  usual: iso,
  latest: iso,
  probability: fraction,
  /**
   * The relative likelihood of this takeover per hour: `p[i]` covers the
   * hour starting at `start + i × stepHours`, `start` on the forecast's
   * hourly grid. Peak-normalised (the largest entry is 1, 3 decimals); the
   * total mass is `probability`. A Gaussian kernel over the paths' takeover
   * times, except a takeover too tight to smooth (at a fixed reset): then
   * the per-hour count, often a single `[1]`. Leading and trailing zeros
   * are trimmed. `p` is shape only: the hour to show is `usual`, never the
   * argmax. A smoothed hill has a flat top (within 5 % of 1 for 15-20 h on a
   * real pool), and the highest hour inside it is sampling noise; two
   * switches' argmaxes can even swap order while their medians do not.
   * Added within v1; absent from a report of an older claudish.
   */
  likelihood: z
    .object({
      start: iso,
      stepHours: z.literal(1),
      p: z.array(z.number().min(0).max(1)).min(1),
    })
    .optional(),
});

/** One projected blocked run (`trajectory.blocked[]`, `trajectory.slower.blocked[]`). */
const blockedSchema = z.object({ from: iso, to: iso, kind: gapKind, probability: fraction });

const trajectorySchema = z.object({
  history: z.array(historyPoint),
  /**
   * `history` split per read account, in `accounts[]` order, for the LAST 24 h
   * only (at ≥ generatedAt − 24 h, at most 25 points each): each point is that
   * account's own term at the same `at`, so the accounts' `remaining` at one
   * `at` sum to `history`'s. `accountId` is `accounts[].id`. Empty with no
   * evidence. Added within v1; absent from a report of an older claudish.
   */
  historyByAccount: z
    .array(z.object({ accountId: z.string(), history: z.array(historyPoint) }))
    .optional(),
  forecast: z.array(
    z.object({ at: iso, p10: finite, p50: finite, p90: finite, pBlocked: fraction })
  ),
  resets: z.array(
    z.object({ at: iso, account: z.string(), window: z.string(), projected: z.boolean() })
  ),
  blocked: z.array(blockedSchema),
  /**
   * When each account takes over, over the trajectory's simulated paths:
   * `soonest` / `usual` / `latest` are the p10 / p50 / p90 of its FIRST
   * takeover on the paths where it has one inside the horizon, `probability`
   * the share of paths that have one (entries under 0.1 are dropped). The
   * active account appears too once it takes back over (after its reset).
   * `accountId` is `accounts[].id`; map it to `accounts[].order + 1` for the
   * profile number. Ordered by `usual`. Empty with one account, no evidence, or
   * no takeover inside the horizon. Added within v1; absent from a report of
   * an older claudish.
   */
  switches: z.array(switchSchema).optional(),
  /**
   * The same simulated paths again with every hour's demand × `factor` (0.667,
   * "a third less busy"), each on its own capacity draw: `switches` and
   * `blocked` by exactly the rules above. The forecast panel draws its `slower`
   * row from them ("no gap" when `blocked` is empty) and its "slow down and it
   * lasts" time from the first switch's `usual`; an empty `switches` means no
   * takeover inside the horizon at that pace. The slower scenario is NOT
   * guaranteed better, under any strategy: after a short-window reset the two
   * runs can drain different accounts, so a slower switch or gap can come
   * earlier. Compare the two; never assume. Added within v1; absent from a
   * report of an older claudish.
   */
  slower: z
    .object({
      factor: z.number().gt(0).lt(1),
      switches: z.array(switchSchema),
      blocked: z.array(blockedSchema),
    })
    .optional(),
  /** The server-rendered sparkline: only the closed glyph set, so a reader can draw it verbatim. */
  spark48: z.string().regex(/^[▁▂▃▄▅▆▇█▒▓┊ ]*$/u),
});

/**
 * claudish cu each account served per hour over the last 14 days (MTL-297).
 * `cu[i]` covers the UTC hour starting at `start + i × stepHours`; the last
 * cell is the current, partial hour. Every `accounts[]` entry comes first, in
 * that order and all zeros when unused, then any other account (disabled or
 * removed) that served in the span. A positive cell is at least 1, so an hour
 * an account served never reads as idle. `unit` is always cu, whatever the
 * report's `unit`. `censored` lists `[cell, minutes]` (ascending, minutes
 * 1–60) when the POOL had no eligible account: such a cell's cu is what was
 * served, so a zero there means blocked, not idle. `coveredFrom` is the first
 * hour the ledger has a row for, clamped to `start`; an earlier zero means
 * claudish was not recording yet. Added within v1; absent from a report of an
 * older claudish.
 */
const usageSchema = z.object({
  start: iso,
  stepHours: z.literal(1),
  hours: z.literal(336),
  unit: z.literal("cu"),
  coveredFrom: iso.nullable(),
  accounts: z.array(
    z.object({
      accountId: z.string(),
      cu: z.array(z.number().int().min(0)).length(336),
    })
  ),
  censored: z.array(z.tuple([z.number().int().min(0).max(335), z.number().int().min(1).max(60)])),
});

const sessionSchema = z.object({
  /** The first 8 characters of a Claude Code session id, or `unattributed`. Local data. */
  session: z.union([z.string().max(8), z.literal("unattributed")]),
  /**
   * The first 8 characters of the Claude Code conversation that delegated this
   * session through the claudish MCP server (`create_session`, `team`), so a
   * reader can sum a conversation's children. It is the conversation live in the
   * calling window when the call ran; a later `/clear` there does not move it.
   * Null for a session claudish did not spawn from MCP (interactive claudish, CLI
   * `team`, `serve`, `run_prompt`), one recorded by an older claudish, and
   * `unattributed`. Local data. Added within v1; absent from a report of an older
   * claudish.
   */
  parent: z.union([z.string().max(8), z.null()]).optional(),
  account: z.string(),
  window: z.string(),
  share: fraction,
  usedFraction: fraction.nullable(),
  cu: nonNegative,
  tokens: z.object({
    in: nonNegative,
    out: nonNegative,
    cacheRead: nonNegative,
    cacheWrite: nonNegative,
  }),
  models: z.record(z.string(), nonNegative),
  exactness,
  firstAt: iso,
  lastAt: iso,
});

export const allowanceReportSchema = z.object({
  schema: z.literal(ALLOWANCE_REPORT_SCHEMA),
  generatedAt: iso,
  /** When the forecast behind the report was computed; null with no forecast yet. */
  forecastAt: iso.nullable(),
  provider: z.literal("openai-codex"),
  strategy: strategyName,
  /**
   * The strategy the alerts and the trajectory simulate (`alertStrategy`):
   * `ebr` while `strategy` is `lookahead`. Added within v1; absent from a report
   * of an older claudish, where it equals `strategy`.
   */
  alertModel: strategyName.optional(),
  evidence,
  unit,
  assumption: z.literal("equal-capacity").nullable(),
  horizonHours: z.number().min(1).max(168),
  accounts: z.array(accountSchema),
  combined: z.object({ remainingNow: finite.nullable(), capacity: finite.nullable() }),
  burn: z.object({
    /**
     * Null while the ledger covers less than the rate's half-life (24 h long,
     * 2 h short): a decayed mean of a few minutes reads as a sustained rate.
     */
    long: nonNegative.nullable(),
    short: nonNegative.nullable(),
    /**
     * The safe pace in `unit` (cu/h): the highest burn rate at which no 7d gap
     * of 1 h or more is projected over the alert simulation horizon (to the
     * latest governing reset + 24 h, at least 96 h; NOT `horizonHours`), with
     * the forecast's hour-of-week profile and the alert model. Under an active
     * alert it is the top alert's remedy: `cutToPercent / 100 × burn.long` for a
     * cut, 0 for a pause or a not-addressable gap. Otherwise it is scanned
     * (resolution about 6 %; a lower bound when capped at 64 × the refill
     * throughput). Reported whenever `status` is `ok`, also while `long` is null
     * (the ledger is shorter than its half-life); null under
     * `insufficient-evidence`, or in `account-fraction` without a ledger rate.
     * Before this widening it was set only under an active alert, and in
     * `account-fraction` it was in window fractions per hour.
     */
    sustainable: nonNegative.nullable(),
    unit: z.string(),
  }),
  alerts: z.array(alertSchema),
  blockedNow: z.boolean(),
  status: z.enum(["ok", "insufficient-evidence"]),
  trajectory: trajectorySchema,
  sessions: z.array(sessionSchema),
  usage: usageSchema.optional(),
});

export type AllowanceReport = z.infer<typeof allowanceReportSchema>;

/**
 * The report's top-level parts an `allowance_status` caller may ask for alone
 * (`sections`). Every other key is the header and is always sent.
 */
export const ALLOWANCE_REPORT_SECTIONS = [
  "accounts",
  "alerts",
  "burn",
  "combined",
  "sessions",
  "trajectory",
  "usage",
] as const;

export type AllowanceReportSection = (typeof ALLOWANCE_REPORT_SECTIONS)[number];

/**
 * The sections every full answer carries, from the first v1 on. A section
 * added later (`usage`) is absent from an older claudish's full answer, so a
 * full answer is checked against these only; a section named in `sections` is
 * required whatever its age.
 */
export const ALLOWANCE_REPORT_SECTIONS_V1_BASE = [
  "accounts",
  "alerts",
  "burn",
  "combined",
  "sessions",
  "trajectory",
] as const satisfies readonly AllowanceReportSection[];

const partialReport = allowanceReportSchema.partial({
  accounts: true,
  alerts: true,
  burn: true,
  combined: true,
  sessions: true,
  trajectory: true,
  usage: true,
});

/**
 * The `allowance_status` MCP answer (§3.4): the mod contract's version and
 * capabilities, then the report, or null with a one-line reason (no account
 * pool for the provider, the service could not load). Mod contract v1 is NOT
 * bumped: `allowance` is an additive capability, and mod 2.10.x declines any
 * other version.
 *
 * `sections` (added within v1) marks a PARTIAL report: the caller asked for
 * those sections, sorted, and `allowance` carries the header plus only them,
 * each of which must be present. Without it, the V1_BASE sections must be
 * present; `usage` may be absent (an older claudish).
 */
export const allowanceStatusAnswerSchema = z
  .object({
    contract_version: z.literal(1),
    capabilities: z.array(z.string()),
    sections: z.array(z.enum(ALLOWANCE_REPORT_SECTIONS)).min(1).optional(),
    allowance: partialReport.nullable(),
    reason: z.string().optional(),
  })
  .superRefine((answer, ctx) => {
    if (answer.allowance === null) return;
    const wanted: readonly AllowanceReportSection[] =
      answer.sections ?? ALLOWANCE_REPORT_SECTIONS_V1_BASE;
    for (const section of wanted) {
      if (answer.allowance[section] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["allowance", section],
          message: `section ${section} is missing`,
        });
      }
    }
  });

export type AllowanceStatusAnswer = z.infer<typeof allowanceStatusAnswerSchema>;
