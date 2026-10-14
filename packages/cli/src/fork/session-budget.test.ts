/**
 * #317 option B — per-session output-token ceiling. Pins from the arbitrated
 * design (ai-01, 2026-10-11 23:18Z):
 *
 *  1. Wording: the 429 refusal body must NOT arm `isQuotaExhaustion` — pinned
 *     against the REAL predicate, not a copy (precedent #296).
 *  2. Upstream counting: a 2-step cascade with usage on each attempt
 *     increments the counter for BOTH.
 *  3. Isolation: two sessions → independent counters; the entry TTL slides on
 *     activity (#91 dwell semantics).
 *  4. Inert: without the env knobs nothing counts, nothing refuses (and the
 *     refusal DOES fire once the ceiling is armed and consumed — the mutation
 *     "remove the increment" turns this red).
 *  5. Swarm: N subagent requests under one parent session_id feed ONE
 *     counter (subagents share the parent's sid — measured 2026-10-12).
 *
 * Pin 6 (relay 429 passthrough) lives in relay.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  admitSessionBudget,
  openSessionBudgetAttempt,
  recordSessionBudgetOutput,
  sessionBudgetConsumed,
  sessionBudgetRefusalAnthropic,
  resetSessionBudgetForTests,
  setSessionBudgetClockForTests,
  SESSION_BUDGET_WINDOW_MS,
  ATTEMPT_SETTLE_MS,
} from "./session-budget.js";
import { isQuotaExhaustion } from "./failover.js";

const SID_SWARM = "bc377615-b7bb-4c44-a6f9-636a7855949f"; // the 27/09 swarm session, measured
const SID_OTHER = "9f005d56-b7bb-0000-0000-000000000000";
const MACHINE = "myia-ai-01";

/** Opaque raw stand-in (the sink keys on object identity via WeakMap). */
function fakeRaw(): object {
  return {};
}

/** Simulate one paid cascade attempt: fresh raw + fresh token + usage report. */
function paidAttempt(
  machine: string | null,
  sid: string | null,
  outputTokens: number,
  env: NodeJS.ProcessEnv
): object {
  const raw = fakeRaw();
  openSessionBudgetAttempt(raw, machine, sid, env);
  recordSessionBudgetOutput(raw, outputTokens);
  return raw;
}

describe("session budget ceiling (#317 option B)", () => {
  let clockMs = 0;
  const ENV_CEILING = { CLAUDISH_SESSION_BUDGET_CEILING: "1000" } as NodeJS.ProcessEnv;
  const ENV_WARN_ONLY = { CLAUDISH_SESSION_BUDGET_WARN: "800" } as NodeJS.ProcessEnv;

  beforeEach(() => {
    resetSessionBudgetForTests();
    clockMs = 1_700_000_000_000;
    setSessionBudgetClockForTests(() => clockMs);
  });

  afterEach(() => {
    setSessionBudgetClockForTests(undefined);
    resetSessionBudgetForTests();
  });

  it("pin 4 (inert half): without env knobs nothing is refused, nothing is counted", () => {
    // Heavy consumption attempt through the sink, both bars off.
    paidAttempt(MACHINE, SID_SWARM, 5000, {});
    expect(admitSessionBudget(MACHINE, SID_SWARM, {})).toBeNull();
    // The attempt attached no token → the report went nowhere.
    expect(sessionBudgetConsumed(MACHINE, SID_SWARM)).toBe(0);
  });

  it("pin 4 (armed half): consumption through the sink crosses the ceiling → refused", () => {
    // Under the bar: served.
    paidAttempt(MACHINE, SID_SWARM, 600, ENV_CEILING);
    clockMs += ATTEMPT_SETTLE_MS + 1; // seal the attempt into the window
    const underBar = admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING);
    expect(underBar).not.toBeNull();
    expect(underBar!.refused).toBe(false);

    // A second paid attempt pushes the window total over the bar.
    paidAttempt(MACHINE, SID_SWARM, 500, ENV_CEILING);
    clockMs += ATTEMPT_SETTLE_MS + 1;
    const overBar = admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING);
    expect(overBar).not.toBeNull();
    expect(overBar!.refused).toBe(true);
    expect(sessionBudgetConsumed(MACHINE, SID_SWARM)).toBe(1100);
  });

  it("pin 1: the refusal body NEVER arms isQuotaExhaustion (real predicate)", async () => {
    paidAttempt(MACHINE, SID_SWARM, 2000, ENV_CEILING);
    clockMs += ATTEMPT_SETTLE_MS + 1;
    const admission = admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING)!;
    expect(admission.refused).toBe(true);

    // The message itself…
    expect(isQuotaExhaustion(429, admission.message)).toBe(false);
    // …and the full rendered body the client receives.
    const response = sessionBudgetRefusalAnthropic(admission);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(admission.retryAfterSec));
    const body = await response.text();
    expect(isQuotaExhaustion(429, body)).toBe(false);
  });

  it("pin 2: a cascade's TWO paid attempts both count (upstream accounting)", () => {
    // Attempt 1 (nominal) reports 400 tokens, attempt 2 (step) reports 350 —
    // one client response, two paid usages; the ceiling must see both.
    paidAttempt(MACHINE, SID_SWARM, 400, ENV_CEILING);
    paidAttempt(MACHINE, SID_SWARM, 350, ENV_CEILING);
    clockMs += ATTEMPT_SETTLE_MS + 1;
    expect(admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING)!.refused).toBe(false);
    expect(sessionBudgetConsumed(MACHINE, SID_SWARM)).toBe(750);
    // 750 < 1000 → served. One more paid attempt crosses.
    paidAttempt(MACHINE, SID_SWARM, 300, ENV_CEILING);
    clockMs += ATTEMPT_SETTLE_MS + 1;
    expect(admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING)!.refused).toBe(true);
  });

  it("pin 2b: two paid attempts of ONE request (same raw, re-attached between) land in DISTINCT slots", () => {
    // The re-attach site (#299-B walk / armed loop, proxy-server): the second
    // openSessionBudgetAttempt on the SAME raw must replace the token, or the
    // max-per-attempt ledger takes max(400, 350) = 400 and under-counts a
    // request that paid 750. Route-level B2b cannot kill this mutation: a
    // nominal that walks (529) carries no usage, so the stale token still
    // counts the walk's — the slot-distinctness is only observable when BOTH
    // attempts pay, which is HERE.
    const raw = fakeRaw();
    openSessionBudgetAttempt(raw, MACHINE, SID_SWARM, ENV_CEILING);
    recordSessionBudgetOutput(raw, 400);
    openSessionBudgetAttempt(raw, MACHINE, SID_SWARM, ENV_CEILING); // the re-attach
    recordSessionBudgetOutput(raw, 350);
    clockMs += ATTEMPT_SETTLE_MS + 1;
    expect(sessionBudgetConsumed(MACHINE, SID_SWARM)).toBe(750); // sum, not max
  });

  it("pin 3: two sessions have independent counters; the TTL slides on activity", () => {
    paidAttempt(MACHINE, SID_SWARM, 900, ENV_CEILING);
    paidAttempt(MACHINE, SID_OTHER, 100, ENV_CEILING);
    clockMs += ATTEMPT_SETTLE_MS + 1;

    // SID_OTHER never near its bar; SID_SWARM over it after one more attempt.
    expect(admitSessionBudget(MACHINE, SID_OTHER, ENV_CEILING)!.refused).toBe(false);
    paidAttempt(MACHINE, SID_SWARM, 200, ENV_CEILING);
    clockMs += ATTEMPT_SETTLE_MS + 1;
    expect(admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING)!.refused).toBe(true);
    expect(admitSessionBudget(MACHINE, SID_OTHER, ENV_CEILING)!.refused).toBe(false);

    // TTL slides on activity: events at t0, re-admitted at t0+23h (fresh
    // activity), still consumed at t0+23h50m where a dead session would be 0.
    clockMs += 23 * 60 * 60 * 1000;
    admitSessionBudget(MACHINE, SID_OTHER, ENV_CEILING); // activity renews lastActivity
    clockMs += 20 * 60 * 1000; // 23h50m after the events — inside the window
    expect(sessionBudgetConsumed(MACHINE, SID_OTHER)).toBe(100);
    // Past the full window with no activity: the events expired.
    clockMs += SESSION_BUDGET_WINDOW_MS;
    expect(sessionBudgetConsumed(MACHINE, SID_OTHER)).toBe(0);
  });

  it("pin 5: a swarm of subagent attempts feeds ONE counter (shared session_id)", () => {
    // 12 attempts = 12 subagent requests, all sharing the parent's sid.
    for (let i = 0; i < 12; i++) {
      paidAttempt(MACHINE, SID_SWARM, 100, ENV_CEILING);
      clockMs += 1000;
    }
    clockMs += ATTEMPT_SETTLE_MS + 1;
    expect(sessionBudgetConsumed(MACHINE, SID_SWARM)).toBe(1200);
    expect(admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING)!.refused).toBe(true);
    // The same sid on ANOTHER machine is a different counter.
    expect(admitSessionBudget("myia-po-2025", SID_SWARM, ENV_CEILING)!.refused).toBe(false);
  });

  it("retry-after is the real remaining window, not a fixed horizon", () => {
    paidAttempt(MACHINE, SID_SWARM, 2000, ENV_CEILING); // t0
    clockMs += ATTEMPT_SETTLE_MS + 1;
    clockMs += 2 * 60 * 60 * 1000; // refuse at t0+2h
    const admission = admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING)!;
    expect(admission.refused).toBe(true);
    const expectedSec = Math.ceil((SESSION_BUDGET_WINDOW_MS - (ATTEMPT_SETTLE_MS + 1 + 2 * 60 * 60 * 1000)) / 1000);
    expect(admission.retryAfterSec).toBe(expectedSec); // ≈ 21h58m
  });

  it("the window slides: an old event expires and the session is served again", () => {
    paidAttempt(MACHINE, SID_SWARM, 2000, ENV_CEILING);
    clockMs += ATTEMPT_SETTLE_MS + 1;
    expect(admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING)!.refused).toBe(true);
    // Slide past the full window: nothing left, served.
    clockMs += SESSION_BUDGET_WINDOW_MS + 1000;
    const admission = admitSessionBudget(MACHINE, SID_SWARM, ENV_CEILING)!;
    expect(admission.refused).toBe(false);
    expect(admission.consumed).toBe(0);
  });

  it("WARN-only pose: the WARN bar fires without ever refusing", () => {
    paidAttempt(MACHINE, SID_SWARM, 850, ENV_WARN_ONLY);
    clockMs += ATTEMPT_SETTLE_MS + 1;
    const admission = admitSessionBudget(MACHINE, SID_SWARM, ENV_WARN_ONLY)!;
    // Over the WARN bar, far over — but no ceiling is armed: never refused.
    expect(admission.warnAt).toBe(800);
    expect(admission.consumed).toBe(850);
    expect(admission.refused).toBe(false);
    expect(admission.ceiling).toBe(0);
  });

  it("no session key → the instrument is blind for that request (no crash, no refuse)", () => {
    paidAttempt(MACHINE, null, 5000, ENV_CEILING);
    expect(admitSessionBudget(MACHINE, null, ENV_CEILING)).toBeNull();
  });

  it("repeated reports within one attempt take the max, not the sum (no double-count)", () => {
    const raw = fakeRaw();
    openSessionBudgetAttempt(raw, MACHINE, SID_SWARM, ENV_CEILING);
    recordSessionBudgetOutput(raw, 0); // wire-openai's leading zero block
    recordSessionBudgetOutput(raw, 400);
    recordSessionBudgetOutput(raw, 400); // duplicated terminal usage
    clockMs += ATTEMPT_SETTLE_MS + 1;
    expect(sessionBudgetConsumed(MACHINE, SID_SWARM)).toBe(400);
  });
});
