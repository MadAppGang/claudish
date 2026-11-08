/**
 * The per-class three-source check (rows-contract.md; architecture Revision 1 "H2").
 *
 * A row's sources are (1) the proxy's `accounts.jsonl`, (2) the fake upstream's
 * request log (what reached the wire), and (3) the third source: the Claude Code
 * transcript for a `session` row, the HTTP response for a `direct` row. "Agree"
 * is defined per class, because one rule cannot fit all of them:
 *
 * - switch rows: the account CHANGED inside one proxy request. The fake shows the
 *   same body (retry rows) or the same session id (threshold rows) with a new
 *   bearer; `accounts.jsonl` shows ONE `requestId` carrying the switch records
 *   (`reason: quota-switch`); the third source is a normal answer.
 * - no-switch rows: an attempt count, the ABSENCE of a switch record, and a
 *   pinned error text (or a normal answer).
 * - V17 (api key only): the canary records exactly one metered request and the
 *   third source shows the vendor error.
 *
 * Pure functions: no I/O, so a unit test can hand them a disagreeing set.
 */

import type { CanaryHit } from "./canary.ts";
import type { LoggedRequest } from "./fake-upstream.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** One line of `accounts.jsonl` as the built binary writes it (rows-contract.md convention). */
export interface AccountRecord {
  requestId: string;
  provider: string;
  accountId: string;
  label: string;
  reason?: string;
  outcome: string;
  resetAt?: number;
  estimated?: boolean;
  arm: string;
}

/** `label:reason:outcome`, the unit an expected record list is written in. */
export const sig = (r: AccountRecord): string => `${r.label}:${r.reason ?? "-"}:${r.outcome}`;

export const ok = (name: string, pass: boolean, detail: string): Check => ({
  name,
  ok: pass,
  detail,
});

export const requestIds = (recs: AccountRecord[]): string[] => [
  ...new Set(recs.map((r) => r.requestId)),
];

/**
 * The expected records, in order, as `label:reason:outcome`; `none` means no record at all.
 * `opts.singleRequestId` adds a check that passes only for EXACTLY ONE distinct
 * requestId, so an empty record list fails it.
 */
export function recordsCheck(
  name: string,
  recs: AccountRecord[],
  expected: string[] | "none",
  opts: { singleRequestId?: boolean } = {}
): Check[] {
  const got = recs.map(sig);
  const out: Check[] = [];
  if (expected === "none") {
    out.push(ok(`[accounts] ${name}: no record`, recs.length === 0, `${got.length} record(s)`));
    return out;
  }
  out.push(
    ok(
      `[accounts] ${name}: records`,
      got.length === expected.length && got.every((g, i) => g === expected[i]),
      `got [${got.join(", ")}] expected [${expected.join(", ")}]`
    )
  );
  if (opts.singleRequestId) {
    out.push(
      ok(
        `[accounts] ${name}: all records share one requestId`,
        recs.length > 0 && requestIds(recs).length === 1,
        `${requestIds(recs).length} requestId(s): ${requestIds(recs)
          .map((id) => id.slice(0, 8))
          .join(",")}`
      )
    );
  }
  return out;
}

export const bearerOf = (label: string): string => `Bearer access-${label}`;

const short = (r: LoggedRequest) => `${r.bearer ?? "-"}@${r.bodySha256.slice(0, 8)}`;

export interface SwitchInput {
  main: LoggedRequest[];
  recs: AccountRecord[];
  expectedAttempts: number;
  /** Bearer per attempt, in order. */
  bearers: string[];
  /** Retry rows: the same body hash on every attempt. Needs more than one attempt. */
  sameBody?: boolean;
  /**
   * Threshold rows: the same `prompt_cache_key` on every attempt. Needs more than one
   * attempt. Passes only when every attempt has a non-null session id, all share one,
   * AND the id matches /^claudish_[0-9a-f]{32}$/ (the shape the built proxy derives
   * from a session id); any other shape fails the check.
   */
  sameSession?: boolean;
  expectedRecords: string[];
  /** The third source's verdict(s), already evaluated by the caller. */
  third: Check[];
}

/** Switch rows: V11, V3, V14 (and V8's first request, whose switch ends in the pinned message). */
export function switchAgreement(i: SwitchInput): Check[] {
  const checks: Check[] = [];
  checks.push(
    ok(
      "[fake] main attempts",
      i.main.length === i.expectedAttempts,
      `${i.main.length} (${i.main.map(short).join(" -> ")})`
    )
  );
  checks.push(
    ok(
      "[fake] bearer per attempt",
      i.main.length === i.bearers.length && i.main.every((m, n) => m.bearer === i.bearers[n]),
      `got [${i.main.map((m) => m.bearer).join(", ")}] expected [${i.bearers.join(", ")}]`
    )
  );
  if (i.sameBody) {
    checks.push(
      ok(
        "[fake] same body hash across attempts",
        i.main.length > 1 && new Set(i.main.map((m) => m.bodySha256)).size === 1,
        i.main.map((m) => m.bodySha256.slice(0, 8)).join(",")
      )
    );
  }
  if (i.sameSession) {
    const keys = i.main.map((m) => m.sessionId);
    checks.push(
      ok(
        "[fake] same session id across attempts",
        i.main.length > 1 &&
          keys.every((k) => k !== null && k === keys[0]) &&
          /^claudish_[0-9a-f]{32}$/.test(String(keys[0])),
        keys.join(",")
      )
    );
  }
  checks.push(
    ...recordsCheck("switch", i.recs, i.expectedRecords, {
      singleRequestId: i.expectedRecords.some((r) => r.includes(":quota-switch:")),
    })
  );
  checks.push(...i.third);
  return checks;
}

export interface NoSwitchInput {
  main: LoggedRequest[];
  recs: AccountRecord[];
  expectedAttempts: number;
  /** Bearer per attempt, when attempts > 0. */
  bearers?: string[];
  /** Bearers that must NEVER reach the wire. */
  forbiddenBearers?: string[];
  expectedRecords: string[] | "none";
  third: Check[];
  /**
   * V8 and V8b: the proxy DID switch once (a `quota-switch` record is expected) and the
   * request still ended in a pinned error, so the "no switch record" check does not apply.
   */
  switchAttempted?: boolean;
}

/** No-switch rows: an attempt count, no switch record, and a pinned text or normal answer. */
export function noSwitchAgreement(i: NoSwitchInput): Check[] {
  const checks: Check[] = [];
  checks.push(
    ok(
      "[fake] main attempts",
      i.main.length === i.expectedAttempts,
      `${i.main.length} (${i.main.map(short).join(" -> ")})`
    )
  );
  if (i.bearers) {
    checks.push(
      ok(
        "[fake] bearer per attempt",
        i.main.length === i.bearers.length && i.main.every((m, n) => m.bearer === i.bearers?.[n]),
        `got [${i.main.map((m) => m.bearer).join(", ")}] expected [${i.bearers.join(", ")}]`
      )
    );
  }
  for (const forbidden of i.forbiddenBearers ?? []) {
    checks.push(
      ok(
        `[fake] ${forbidden} never contacted`,
        !i.main.some((m) => m.bearer === forbidden),
        `${i.main.filter((m) => m.bearer === forbidden).length} request(s)`
      )
    );
  }
  if (!i.switchAttempted) {
    checks.push(
      ok(
        "[accounts] no quota-switch record",
        !i.recs.some((r) => r.reason === "quota-switch"),
        i.recs.map(sig).join(", ") || "none"
      )
    );
  }
  checks.push(...recordsCheck("no-switch", i.recs, i.expectedRecords));
  checks.push(...i.third);
  return checks;
}

export interface V17Input {
  canaryHits: CanaryHit[];
  main: LoggedRequest[];
  recs: AccountRecord[];
  /** The api key the canary request must carry (the fake canary key). */
  key: string;
  third: Check[];
}

/** V17: the metered canary is contacted exactly once, with the api key; the fake and the pool see nothing. */
export function v17Agreement(i: V17Input): Check[] {
  return [
    ok(
      "[canary] exactly one metered request, signed with the api key",
      i.canaryHits.length === 1 && i.canaryHits[0]?.authorization === `Bearer ${i.key}`,
      i.canaryHits.map((h) => `${h.method} ${h.path} ${h.authorization}`).join("; ") || "none"
    ),
    ok(
      "[fake] no main request reached the subscription upstream",
      i.main.length === 0,
      `${i.main.length}`
    ),
    ...recordsCheck("v17", i.recs, "none"),
    ...i.third,
  ];
}
