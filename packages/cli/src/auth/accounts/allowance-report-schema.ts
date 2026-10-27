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

const trajectorySchema = z.object({
  history: z.array(
    z.object({
      at: iso,
      remaining: finite,
      provenance: z.enum(["observed", "reset-inferred"]),
    })
  ),
  forecast: z.array(
    z.object({ at: iso, p10: finite, p50: finite, p90: finite, pBlocked: fraction })
  ),
  resets: z.array(
    z.object({ at: iso, account: z.string(), window: z.string(), projected: z.boolean() })
  ),
  blocked: z.array(z.object({ from: iso, to: iso, kind: gapKind, probability: fraction })),
  /** The server-rendered sparkline: only the closed glyph set, so a reader can draw it verbatim. */
  spark48: z.string().regex(/^[▁▂▃▄▅▆▇█▒▓┊ ]*$/u),
});

const sessionSchema = z.object({
  /** The first 8 characters of a Claude Code session id, or `unattributed`. Local data. */
  session: z.union([z.string().max(8), z.literal("unattributed")]),
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
    sustainable: nonNegative.nullable(),
    unit: z.string(),
  }),
  alerts: z.array(alertSchema),
  blockedNow: z.boolean(),
  status: z.enum(["ok", "insufficient-evidence"]),
  trajectory: trajectorySchema,
  sessions: z.array(sessionSchema),
});

export type AllowanceReport = z.infer<typeof allowanceReportSchema>;

/**
 * The `allowance_status` MCP answer (§3.4): the mod contract's version and
 * capabilities, then the report, or null with a one-line reason (no account
 * pool for the provider, the service could not load). Mod contract v1 is NOT
 * bumped: `allowance` is an additive capability, and mod 2.10.x declines any
 * other version.
 */
export const allowanceStatusAnswerSchema = z.object({
  contract_version: z.literal(1),
  capabilities: z.array(z.string()),
  allowance: allowanceReportSchema.nullable(),
  reason: z.string().optional(),
});

export type AllowanceStatusAnswer = z.infer<typeof allowanceStatusAnswerSchema>;
