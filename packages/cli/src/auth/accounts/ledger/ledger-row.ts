/**
 * The usage ledger's row schema, v1 (allowance architecture §2.1), and the only
 * way a row is built.
 *
 * ## A row holds numbers, closed sets and pattern-checked identifiers only
 *
 * The ledger is a sink of upstream data that bypasses `log`/`redactSecrets`, so
 * it may carry nothing a provider could have echoed: no body text, no header
 * text, no display label of the plan. Every string field is either a member of
 * a closed set (`planClass`, `reason`, `outcome`, `provider`) or matches a
 * pattern no secret survives (`session`, `model`, window keys). A value that
 * fails its guard is replaced (`"other"`, `null`) or its window dropped, never
 * stored. `x-codex-plan-type` is lower-cased and mapped into {@link PlanClass}
 * on the request path, so even a signing secret injected into that header
 * lands as `"other"`.
 *
 * `project` is deliberately absent: `basename(cwd)` is the wrong directory under
 * `serve` and MCP.
 *
 * `parent` (optional, `SESSION_PATTERN`) is the Claude Code conversation that
 * delegated the session through the claudish MCP server. The key is omitted when
 * there is none, so such a row is byte-identical to one from before the field; an
 * older reader strips it, a newer one reads its absence as null.
 */

import { z } from "zod";
import { readingsFromSnapshot, windowKey } from "../allowance/readings.js";
import type {
  AllowanceEvent,
  PlanClass,
  ResponseOutcome,
  TokenCounts,
  WindowReading,
} from "../allowance/types.js";
import type { SelectReason } from "../policy.js";
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_LABEL_PATTERN,
  type AccountProvider,
  LEGACY_CODEX_ACCOUNT_ID,
  type UsageSnapshot,
  type UsageWindow,
} from "../types.js";

export const LEDGER_ROW_VERSION = 1;

/** Each row is one `write()` under 4 KB, so concurrent appenders never interleave. */
export const MAX_ROW_BYTES = 4095;

export const PLAN_CLASSES = [
  "free",
  "plus",
  "pro",
  "team",
  "business",
  "enterprise",
  "other",
] as const satisfies readonly PlanClass[];

/** `SelectReason`, as a closed set the schema can check. */
export const SELECT_REASONS = [
  "pinned",
  "sticky",
  "first-under-threshold",
  "lowest-pressure",
  "ebr-initial",
  "ebr-sticky",
  "ebr-switch",
  "ebr-forced",
  "ebr-unknown-usage",
  "lookahead-initial",
  "lookahead-sticky",
  "lookahead-switch",
  "lookahead-forced",
  "lookahead-unknown-usage",
] as const satisfies readonly SelectReason[];

// A reason added to `SelectReason` must be listed above, or this stops compiling.
type UnlistedSelectReason = Exclude<SelectReason, (typeof SELECT_REASONS)[number]>;
const selectReasonsComplete: [UnlistedSelectReason] extends [never] ? true : never = true;
void selectReasonsComplete;

export const LEDGER_OUTCOMES = [
  "ok",
  "quota",
  "error",
  "cancelled",
] as const satisfies readonly ResponseOutcome[];

export const SESSION_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const MODEL_PATTERN = /^[A-Za-z0-9._:/@-]{1,80}$/;
/** A window's `slot` and a named window key. */
export const WINDOW_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,40}$/;

/** `used-percent` is a whole percent on Codex (#49645). */
export const CODEX_QUANTUM = 0.01;

const providerSchema = z.enum(["native-anthropic", "openai-codex"]);
const finiteNonNegative = z.number().finite().nonnegative();
const tokenCount = z.number().int().nonnegative();

const accountIdSchema = z
  .string()
  .refine((id) => ACCOUNT_ID_PATTERN.test(id) || id === LEGACY_CODEX_ACCOUNT_ID);

export const windowReadingSchema = z.object({
  key: z.string().regex(/^(len:\d{1,7}|slot:[A-Za-z0-9_.:-]{1,40}|[A-Za-z0-9_.:-]{1,40})$/),
  slot: z.string().regex(WINDOW_NAME_PATTERN),
  lengthMinutes: z.number().int().positive().nullable(),
  usedFraction: z.number().finite().min(0).max(1),
  resetAt: finiteNonNegative.nullable(),
  rejected: z.boolean(),
  quantum: z.number().finite().min(0).max(1),
});

export const responseRowSchema = z.object({
  v: z.literal(LEDGER_ROW_VERSION),
  kind: z.literal("response"),
  at: finiteNonNegative,
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}:\d{1,4}:[a-z0-9-]{1,32}$/),
  provider: providerSchema,
  accountId: accountIdSchema,
  label: z.string().regex(ACCOUNT_LABEL_PATTERN).nullable(),
  planClass: z.enum(PLAN_CLASSES).nullable(),
  session: z.string().regex(SESSION_PATTERN).nullable(),
  model: z.string().regex(MODEL_PATTERN),
  reason: z.enum(SELECT_REASONS).nullable(),
  outcome: z.enum(LEDGER_OUTCOMES),
  inTok: tokenCount,
  cacheReadTok: tokenCount,
  cacheWriteTok: tokenCount,
  outTok: tokenCount,
  finalInTok: tokenCount,
  windows: z.array(windowReadingSchema).max(16).nullable(),
  parent: z.string().regex(SESSION_PATTERN).nullable().optional(),
});

/**
 * A raw segment holds the bare row: it OPENS a censored interval. An hourly
 * file holds one row per interval, SEALED: `until` is where it closed (the
 * provider's next `ok`), and `continues` marks one still open at the day's end
 * (`until` is then that end), so the next day's replay keeps it open.
 */
export const noEligibleRowSchema = z.object({
  v: z.literal(LEDGER_ROW_VERSION),
  kind: z.literal("no-eligible"),
  at: finiteNonNegative,
  provider: providerSchema,
  until: finiteNonNegative.optional(),
  continues: z.literal(true).optional(),
});

const tokenCountsSchema = z.object({
  input: tokenCount,
  cacheRead: tokenCount,
  cacheWrite: tokenCount,
  output: tokenCount,
});

/**
 * One line of an hourly file: rows per (hour, account, session, model). Tokens
 * are the nested `tokens` object of allowance §2.1; {@link parseRow} also reads
 * the flat `inTok`/`cacheReadTok`/`cacheWriteTok`/`outTok` form that the first
 * writer published, so a rollup already on disk is never lost.
 */
export const rollupRowSchema = z.object({
  v: z.literal(LEDGER_ROW_VERSION),
  kind: z.literal("rollup"),
  id: z.string().max(256),
  hour: finiteNonNegative,
  provider: providerSchema,
  accountId: accountIdSchema,
  session: z.string().regex(SESSION_PATTERN).nullable(),
  model: z.string().regex(MODEL_PATTERN),
  n: z.number().int().nonnegative(),
  tokens: tokenCountsSchema,
  first: z.array(windowReadingSchema).max(16).nullable(),
  last: z.array(windowReadingSchema).max(16).nullable(),
  censoredMinutes: z.number().finite().min(0).max(60),
  /** The group's delegating conversation: the first non-null `parent` of its rows. */
  parent: z.string().regex(SESSION_PATTERN).nullable().optional(),
});

export const ledgerRowSchema = z.discriminatedUnion("kind", [
  responseRowSchema,
  noEligibleRowSchema,
  rollupRowSchema,
]);

export type ResponseRow = z.infer<typeof responseRowSchema>;
export type NoEligibleRow = z.infer<typeof noEligibleRowSchema>;
export type RollupRow = z.infer<typeof rollupRowSchema>;
export type LedgerRow = z.infer<typeof ledgerRowSchema>;

/** The upstream plan-type value, lower-cased into the closed set. Absent → null. */
export function planClassOf(raw: string | null | undefined): PlanClass | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return null;
  return (PLAN_CLASSES as readonly string[]).includes(value) ? (value as PlanClass) : "other";
}

/**
 * The window key (allowance §1.4), defined once in the model's `readings.ts`
 * so a ledger row and a state.json reading key the same window the same way.
 */
export function windowKeyFor(provider: AccountProvider, window: UsageWindow): string {
  return windowKey(provider, window);
}

/** A snapshot's windows as guarded readings; a window whose name fails its pattern is dropped. */
export function readingsOf(
  provider: AccountProvider,
  usage: UsageSnapshot | undefined
): WindowReading[] | null {
  const readings = (readingsFromSnapshot(provider, usage, CODEX_QUANTUM) ?? []).filter(
    (reading) => windowReadingSchema.safeParse(reading).success
  );
  return readings.length > 0 ? readings : null;
}

export interface ResponseRowInput {
  provider: AccountProvider;
  requestId: string;
  attempt: number;
  at: number;
  accountId: string;
  label: string;
  planClass: PlanClass | null;
  session: string | null | undefined;
  model: string;
  reason: SelectReason | undefined;
  outcome: ResponseOutcome;
  tokens: TokenCounts | null;
  finalInput: number | null;
  usage?: UsageSnapshot;
  /** The delegating conversation's session id; dropped unless it passes SESSION_PATTERN. */
  parent?: string | null;
}

function count(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/**
 * Build a response row through every guard, or null when an identifier that
 * cannot be replaced (the account id, the request id) fails its pattern, or the
 * row would not fit one write.
 */
export function buildResponseRow(input: ResponseRowInput): ResponseRow | null {
  const row: ResponseRow = {
    v: LEDGER_ROW_VERSION,
    kind: "response",
    at: input.at,
    id: `${input.requestId}:${input.attempt}:${input.accountId}`,
    provider: input.provider,
    accountId: input.accountId,
    label: ACCOUNT_LABEL_PATTERN.test(input.label) ? input.label : null,
    planClass: input.planClass,
    session: input.session && SESSION_PATTERN.test(input.session) ? input.session : null,
    model: MODEL_PATTERN.test(input.model) ? input.model : "other",
    reason:
      input.reason !== undefined && (SELECT_REASONS as readonly string[]).includes(input.reason)
        ? input.reason
        : null,
    outcome: input.outcome,
    inTok: count(input.tokens?.input),
    cacheReadTok: count(input.tokens?.cacheRead),
    cacheWriteTok: count(input.tokens?.cacheWrite),
    outTok: count(input.tokens?.output),
    finalInTok: count(input.finalInput),
    windows: readingsOf(input.provider, input.usage),
  };
  // A parent that fails its pattern, or names the row's own session, is dropped (the key
  // omitted), never the row: attribution is optional, the row is not.
  const parent = input.parent;
  if (parent && SESSION_PATTERN.test(parent) && parent !== row.session) row.parent = parent;
  return responseRowSchema.safeParse(row).success ? row : null;
}

export function buildNoEligibleRow(provider: AccountProvider, at: number): NoEligibleRow {
  return { v: LEDGER_ROW_VERSION, kind: "no-eligible", at, provider };
}

/** One serialized line, or null when it would not fit one atomic append. */
export function serializeRow(row: LedgerRow): string | null {
  const line = `${JSON.stringify(row)}\n`;
  return Buffer.byteLength(line, "utf8") <= MAX_ROW_BYTES ? line : null;
}

/**
 * A rollup in the first writer's flat token form, rewritten to the nested
 * `tokens` object. Anything else is returned as is. A row carrying both forms
 * keeps its nested `tokens`.
 */
function nestRollupTokens(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const row = value as Record<string, unknown>;
  if (row.kind !== "rollup" || "tokens" in row) return value;
  const { inTok, cacheReadTok, cacheWriteTok, outTok, ...rest } = row;
  return {
    ...rest,
    tokens: { input: inTok, cacheRead: cacheReadTok, cacheWrite: cacheWriteTok, output: outTok },
  };
}

/** Parse one line; null for anything that is not a valid v1 row. */
export function parseRow(line: string): LedgerRow | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = ledgerRowSchema.safeParse(nestRollupTokens(value));
  return parsed.success ? parsed.data : null;
}

function tokensOf(row: ResponseRow): TokenCounts {
  return {
    input: row.inTok,
    cacheRead: row.cacheReadTok,
    cacheWrite: row.cacheWriteTok,
    output: row.outTok,
  };
}

/** A row as the model's event. */
export function toEvent(row: LedgerRow): AllowanceEvent {
  switch (row.kind) {
    case "response":
      return {
        kind: "response",
        id: row.id,
        at: row.at,
        account: row.accountId,
        session: row.session,
        model: row.model,
        tokens: tokensOf(row),
        finalInput: row.finalInTok,
        windows: row.windows,
        outcome: row.outcome,
        parent: row.parent ?? null,
      };
    case "no-eligible":
      return row.until === undefined
        ? { kind: "no-eligible", at: row.at }
        : {
            kind: "no-eligible",
            at: row.at,
            until: row.until,
            ...(row.continues ? { continues: true } : {}),
          };
    case "rollup":
      return {
        kind: "rollup",
        id: row.id,
        hour: row.hour,
        account: row.accountId,
        session: row.session,
        model: row.model,
        n: row.n,
        tokens: { ...row.tokens },
        first: row.first,
        last: row.last,
        censoredMinutes: row.censoredMinutes,
        parent: row.parent ?? null,
      };
  }
}

/** `YYYY-MM-DD` of a UTC instant. */
export function utcDay(at: number): string {
  const d = new Date(at);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** The epoch ms of a `YYYY-MM-DD` UTC day's midnight, or NaN. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}
