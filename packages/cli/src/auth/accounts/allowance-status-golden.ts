/**
 * The golden `allowance_status` answers (allowance architecture §3.4, §6 step
 * 5): what claudish answers the mod, written down before the tool exists so the
 * magus plugin's `fake-claudish.ts` can answer exactly this and its tests
 * cannot drift from the server. magus copies the TEXTS verbatim, as it copies
 * `GOLDEN_LIST`; a contract test here validates each against
 * `allowanceStatusAnswerSchema`.
 *
 * Three answers, one per mod state:
 * - `GOLDEN_ALLOWANCE_WARN`: supported, a WARN alert → the band shows.
 * - `GOLDEN_ALLOWANCE_NO_EVIDENCE`: supported, `insufficient-evidence` → band
 *   hidden, poll backs off to 5 min.
 * - `GOLDEN_ALLOWANCE_UNAVAILABLE`: supported, `allowance: null` with a reason
 *   (no account pool) → band hidden.
 *
 * An UNSUPPORTED claudish is not an answer of ours: it is the MCP client's
 * unknown-tool error, or a list answer whose `capabilities` lacks `allowance`.
 * Session ids are 8 characters, as on every model-visible surface.
 */

import type { AllowanceStatusAnswer } from "./allowance-report-schema.js";

/** Mod contract v1's capabilities once `allowance_status` ships (§6 step 14). */
export const GOLDEN_ALLOWANCE_CAPABILITIES = [
  "list",
  "status",
  "cancel",
  "capture",
  "capture_since_seq",
  "capture_spans",
  "resize",
  "allowance",
];

/** Monday 2026-10-26 09:00 UTC. The gap runs Thu 14:00 → Sat 09:00 (43 h). */
export const GOLDEN_ALLOWANCE_AT = "2026-10-26T09:00:00.000Z";

export const GOLDEN_ALLOWANCE_WARN_ANSWER = {
  contract_version: 1,
  capabilities: GOLDEN_ALLOWANCE_CAPABILITIES,
  allowance: {
    schema: "claudish.allowance.v1",
    generatedAt: GOLDEN_ALLOWANCE_AT,
    forecastAt: "2026-10-26T08:57:12.000Z",
    provider: "openai-codex",
    strategy: "lookahead",
    alertModel: "ebr",
    evidence: "full",
    unit: "cu",
    assumption: null,
    horizonHours: 168,
    accounts: [
      {
        label: "work",
        id: "aaaaaaaaaaaa",
        planClass: "pro",
        deliverable: 0.52,
        binding: "len:10080",
        windows: [
          {
            key: "len:10080",
            displayId: "7d",
            usedFraction: 0.48,
            resetAt: "2026-10-31T09:00:00.000Z",
            provenance: "observed",
            semantics: "fixed-start",
          },
        ],
        lambda: null,
        calibration: { beta: "calibrated", kappa: null },
        active: true,
        order: 0,
      },
      {
        label: "home",
        id: "bbbbbbbbbbbb",
        planClass: "plus",
        deliverable: 0.32,
        binding: "len:300",
        windows: [
          {
            key: "len:10080",
            displayId: "7d",
            usedFraction: 0.36,
            resetAt: "2026-11-01T06:00:00.000Z",
            provenance: "observed",
            semantics: "fixed-start",
          },
          {
            key: "len:300",
            displayId: "5h",
            usedFraction: 0.81,
            resetAt: "2026-10-26T11:00:00.000Z",
            provenance: "observed",
            semantics: "sliding",
          },
        ],
        lambda: null,
        calibration: { beta: "coarse", kappa: "calibrated" },
        active: false,
        order: 1,
      },
    ],
    combined: { remainingNow: 58_000_000, capacity: 100_000_000 },
    // Under the cut-60 alert the safe pace is the remedy's: 0.60 × 410_000 (cutToPercent / 100 × long).
    burn: { long: 410_000, short: 520_000, sustainable: 246_000, unit: "cu/h" },
    alerts: [
      {
        level: "warn",
        since: "2026-10-26T08:15:00.000Z",
        gapStartEpoch: 1_793_282_400_000,
        gapStart: {
          p10: "2026-10-29T08:00:00.000Z",
          p25: "2026-10-29T11:00:00.000Z",
          p50: "2026-10-29T14:00:00.000Z",
          p75: "2026-10-29T17:00:00.000Z",
          p90: "2026-10-29T20:00:00.000Z",
        },
        gapEnd: {
          p10: "2026-10-31T09:00:00.000Z",
          p25: "2026-10-31T09:00:00.000Z",
          p50: "2026-10-31T09:00:00.000Z",
          p75: "2026-10-31T09:00:00.000Z",
          p90: "2026-10-31T09:00:00.000Z",
        },
        gapHours: { p10: 31, p25: 37, p50: 43, p75: 49, p90: 55 },
        pGap: 0.86,
        binding: [
          { account: "work", window: "7d" },
          { account: "home", window: "7d" },
        ],
        remedy: {
          kind: "cut",
          cutToPercent: 60,
          until: "2026-10-31T09:00:00.000Z",
          pauseHours: 14,
          reason: null,
          text: "cut to 60 % of current rate until Sat 09:00, or pause 14 h",
        },
      },
    ],
    blockedNow: false,
    status: "ok",
    trajectory: {
      history: [
        { at: "2026-10-26T06:00:00.000Z", remaining: 0.61, provenance: "observed" },
        { at: "2026-10-26T07:00:00.000Z", remaining: 0.6, provenance: "observed" },
        { at: "2026-10-26T08:00:00.000Z", remaining: 0.59, provenance: "observed" },
        { at: "2026-10-26T09:00:00.000Z", remaining: 0.58, provenance: "observed" },
      ],
      forecast: [
        { at: "2026-10-27T09:00:00.000Z", p10: 0.38, p50: 0.45, p90: 0.5, pBlocked: 0 },
        { at: "2026-10-28T09:00:00.000Z", p10: 0.16, p50: 0.27, p90: 0.36, pBlocked: 0.02 },
        { at: "2026-10-29T09:00:00.000Z", p10: 0, p50: 0.08, p90: 0.21, pBlocked: 0.31 },
        { at: "2026-10-30T09:00:00.000Z", p10: 0, p50: 0, p90: 0.04, pBlocked: 0.86 },
        { at: "2026-10-31T09:00:00.000Z", p10: 0.48, p50: 0.5, p90: 0.5, pBlocked: 0 },
      ],
      resets: [
        { at: "2026-10-31T09:00:00.000Z", account: "work", window: "7d", projected: false },
        { at: "2026-11-01T06:00:00.000Z", account: "home", window: "7d", projected: false },
      ],
      blocked: [
        {
          from: "2026-10-29T14:00:00.000Z",
          to: "2026-10-31T09:00:00.000Z",
          kind: "7d",
          probability: 0.86,
        },
      ],
      spark48: "▇▇▇▆▆▆▅▅▅▄▄▄▃▃▃▂▂▂▁▁▁   ▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒┊▁▁▁",
    },
    sessions: [
      {
        session: "1a2b3c4d",
        account: "work",
        window: "7d",
        share: 0.38,
        usedFraction: 0.19,
        cu: 19_000_000,
        tokens: { in: 41_200_000, out: 900_000, cacheRead: 35_000_000, cacheWrite: 0 },
        models: { "gpt-6-astra": 412 },
        exactness: "pro-rata",
        firstAt: "2026-10-26T01:12:00.000Z",
        lastAt: "2026-10-26T08:55:00.000Z",
      },
      {
        session: "9f8e7d6c",
        account: "work",
        window: "7d",
        share: 0.21,
        usedFraction: 0.11,
        cu: 11_000_000,
        tokens: { in: 22_000_000, out: 400_000, cacheRead: 18_500_000, cacheWrite: 0 },
        models: { "gpt-6-astra": 230 },
        exactness: "pro-rata",
        firstAt: "2026-10-25T13:40:00.000Z",
        lastAt: "2026-10-26T07:30:00.000Z",
      },
      {
        session: "unattributed",
        account: "all",
        window: "7d",
        share: 0.12,
        usedFraction: 0.06,
        cu: 6_000_000,
        tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
        models: {},
        exactness: "external-unidentified",
        firstAt: "2026-10-24T09:00:00.000Z",
        lastAt: "2026-10-26T09:00:00.000Z",
      },
    ],
  },
} satisfies AllowanceStatusAnswer;

export const GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER = {
  contract_version: 1,
  capabilities: GOLDEN_ALLOWANCE_CAPABILITIES,
  allowance: {
    schema: "claudish.allowance.v1",
    generatedAt: GOLDEN_ALLOWANCE_AT,
    forecastAt: null,
    provider: "openai-codex",
    strategy: "sticky",
    alertModel: "sticky",
    evidence: "none",
    unit: "account-fraction",
    assumption: "equal-capacity",
    horizonHours: 168,
    accounts: [],
    combined: { remainingNow: null, capacity: null },
    burn: { long: null, short: null, sustainable: null, unit: "account-fraction/h" },
    alerts: [],
    blockedNow: false,
    status: "insufficient-evidence",
    trajectory: { history: [], forecast: [], resets: [], blocked: [], spark48: "" },
    sessions: [],
  },
} satisfies AllowanceStatusAnswer;

export const GOLDEN_ALLOWANCE_UNAVAILABLE_ANSWER = {
  contract_version: 1,
  capabilities: GOLDEN_ALLOWANCE_CAPABILITIES,
  allowance: null,
  reason: "no account pool is configured for openai-codex",
} satisfies AllowanceStatusAnswer;

/** The MCP text content of each answer, as the mod receives it. */
export const GOLDEN_ALLOWANCE_WARN = JSON.stringify(GOLDEN_ALLOWANCE_WARN_ANSWER);
export const GOLDEN_ALLOWANCE_NO_EVIDENCE = JSON.stringify(GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER);
export const GOLDEN_ALLOWANCE_UNAVAILABLE = JSON.stringify(GOLDEN_ALLOWANCE_UNAVAILABLE_ANSWER);
