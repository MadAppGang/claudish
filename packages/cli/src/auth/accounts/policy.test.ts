import { describe, expect, test } from "bun:test";
import { type AccountCandidate, pressure, selectAccount } from "./policy.js";
import type { AccountRef, UsageSnapshot } from "./types.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

function ref(id: string): AccountRef {
  return { provider: "openai-codex", id, label: id };
}

function usage(
  windows: Array<{ slot: string; usedFraction: number; resetAt?: number }>,
  observedAt = NOW
): UsageSnapshot {
  return {
    observedAt,
    windows: windows.map((window) => ({
      displayId: window.slot,
      ...window,
    })),
  };
}

function candidate(
  id: string,
  order: number,
  overrides: Partial<AccountCandidate> = {}
): AccountCandidate {
  return {
    ref: ref(id),
    order,
    enabled: true,
    usage: usage([{ slot: "primary", usedFraction: 0.1, resetAt: NOW + 60_000 }]),
    usageFailed: false,
    needsReauth: null,
    isActive: false,
    ...overrides,
  };
}

describe("account selection policy", () => {
  test("keeps the sticky account while every live window is under threshold", () => {
    const active = candidate("work", 1, { isActive: true });
    const first = candidate("personal", 0);

    const result = selectAccount([first, active], { now: NOW, switchAt: 0.9 });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected an account");
    expect(result.candidate.ref.id).toBe("work");
    expect(result.reason).toBe("sticky");

    // Mutation caught: remove the sticky step and always choose the first account-list entry.
  });

  test("switches when any live window crosses its own threshold", () => {
    const active = candidate("work", 0, {
      isActive: true,
      usage: usage([
        { slot: "primary", usedFraction: 0.2, resetAt: NOW + 60_000 },
        { slot: "secondary", usedFraction: 0.91, resetAt: NOW + 60_000 },
      ]),
    });
    const spare = candidate("spare", 1);

    const result = selectAccount([active, spare], {
      now: NOW,
      switchAt: 0.95,
      switchAtByWindow: { secondary: 0.9 },
    });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected an account");
    expect(result.candidate.ref.id).toBe("spare");
    expect(result.reason).toBe("first-under-threshold");

    // Mutation caught: compare only the maximum window against the global threshold,
    // ignoring the per-slot threshold that the secondary window crossed.
  });

  test("uses the lowest-pressure account when every eligible account is over threshold", () => {
    const fuller = candidate("fuller", 0, {
      isActive: true,
      usage: usage([{ slot: "primary", usedFraction: 0.97, resetAt: NOW + 60_000 }]),
    });
    const lower = candidate("lower", 1, {
      usage: usage([{ slot: "primary", usedFraction: 0.91, resetAt: NOW + 60_000 }]),
    });

    const result = selectAccount([fuller, lower], { now: NOW, switchAt: 0.9 });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected an account");
    expect(result.candidate.ref.id).toBe("lower");
    expect(result.reason).toBe("lowest-pressure");

    // Mutation caught: fail selection when all accounts are over the soft threshold,
    // or keep the active account without comparing pressure.
  });

  test("returns none with one blocker per account when all are exhausted", () => {
    const a = candidate("work", 0, { exhaustedUntil: NOW + 60_000 });
    const b = candidate("spare", 1, { exhaustedUntil: NOW + 120_000 });

    const result = selectAccount([a, b], { now: NOW });

    expect(result.kind).toBe("none");
    if (result.kind !== "none") throw new Error("expected no account");
    expect(result.blockers).toEqual([
      { kind: "exhausted", ref: a.ref, resetAt: NOW + 60_000 },
      { kind: "exhausted", ref: b.ref, resetAt: NOW + 120_000 },
    ]);

    // Mutation caught: treat an exhaustion mark as advisory eligibility, or discard
    // blocker details while constructing the terminal result.
  });

  test("drops a window after its recorded reset and reads its pressure as unknown", () => {
    const reset = candidate("reset", 0, {
      isActive: true,
      usage: usage([{ slot: "primary", usedFraction: 1, resetAt: NOW - 1 }]),
    });

    expect(pressure(reset, NOW)).toBeNull();
    const result = selectAccount([reset], { now: NOW, switchAt: 0.9 });
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected an account");
    expect(result.reason).toBe("sticky");

    // Mutation caught: keep a spent window live after resetAt, which leaves the
    // account at pressure 1 and changes the reason to lowest-pressure.
  });

  test("treats an account with no usage reading as eligible", () => {
    const unknown = candidate("unknown", 0, { usage: null });
    const knownOver = candidate("known-over", 1, {
      usage: usage([{ slot: "primary", usedFraction: 0.95, resetAt: NOW + 60_000 }]),
    });

    const result = selectAccount([unknown, knownOver], { now: NOW, switchAt: 0.9 });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected an account");
    expect(result.candidate.ref.id).toBe("unknown");

    // Mutation caught: classify unknown usage as blocked rather than eligible.
  });

  test("does not decay a stale over-threshold reading into unknown before reset", () => {
    const staleOver = candidate("stale-over", 0, {
      isActive: true,
      usage: usage(
        [{ slot: "primary", usedFraction: 0.92, resetAt: NOW + 60_000 }],
        NOW - 20 * 60_000
      ),
    });
    const spare = candidate("spare", 1);

    const result = selectAccount([staleOver, spare], { now: NOW, switchAt: 0.9 });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected an account");
    expect(result.candidate.ref.id).toBe("spare");

    // Mutation caught: restore the 15-minute snapshot decay, which turns the stale
    // 92% reading into eligible unknown and re-selects the spent sticky account.
  });

  test("ranks unknown-failed behind a known-good eligible account", () => {
    const unreadable = candidate("unreadable", 0, { usage: null, usageFailed: true });
    const known = candidate("known", 1);

    const result = selectAccount([unreadable, known], { now: NOW });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected an account");
    expect(result.candidate.ref.id).toBe("known");

    // Mutation caught: remove usageFailed from the rank key, letting an unreadable
    // account outrank a known-good account by config order.
  });
});
