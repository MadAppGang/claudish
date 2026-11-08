import { describe, expect, test } from "bun:test";
import {
  ADVERSARIAL_TRACES,
  ALERT_TRACES,
  GPT_1,
  GPT_8,
  OPUS_CHOOSE,
  OPUS_H1,
  OPUS_M4,
  R1,
  R2,
  R3,
  SERVED_TRACES,
  SLIDING_RELEASE,
  STRIPPED_HEADERS,
  type ServedTrace,
  T0,
  WINDOW_RETIRED,
  bucketDemandOf,
  h,
} from "./adversarial.js";
import { oracle } from "./oracle.js";
import { type VendorAccountSpec, createVendor } from "./vendor.js";

const api = { oracle, bucketDemandOf };
const expected: [ServedTrace, number][] = [
  [R1, 3],
  [GPT_1, 4],
  [OPUS_H1, 5],
  [OPUS_CHOOSE, 6],
];

describe("adversarial oracle contract (§4 table; O1–O6)", () => {
  for (const [trace, figure] of expected) {
    test(trace.name +
      ": oracle re-derives " +
      figure +
      " cu, independently of trace.expected", () => {
      const input = { accounts: trace.accounts, start: trace.start, requests: trace.requests };
      const before = structuredClone(input);
      const result = api.oracle(input);
      expect(result.servedCu).toBe(figure);
      expect(result.served).toBe(trace.requests.length);
      expect(result.assignment).toHaveLength(trace.requests.length);
      expect(api.oracle(input)).toEqual(result);
      expect(api.oracle({ ...input, mustServe: true }).servedCu).toBe(figure);
      expect(input).toEqual(before);
      const vendor = createVendor(trace.accounts, trace.start);
      let served = 0;
      result.assignment.forEach((account, index) => {
        if (account === null) return;
        const request = trace.requests[index];
        const replay = vendor.serve({
          id: "replay-" + index,
          at: request.at,
          account,
          session: null,
          model: "gpt-6-astra",
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          cu: request.cu,
        });
        expect(replay.accepted).toBe(true);
        served += replay.cu;
      });
      expect(served).toBe(figure);
    });
  }

  test("the free optimum may idle while mustServe cannot", () => {
    const account: VendorAccountSpec = {
      id: "A",
      admission: "fits",
      quantum: 0,
      windows: [
        {
          slot: "primary",
          lengthMinutes: 10080,
          capacityCu: 1,
          semantics: "fixed-start",
          resetAt: h(168),
        },
      ],
    };
    const input = {
      accounts: [account],
      start: T0,
      requests: [
        { at: h(0), cu: 0.5 },
        { at: h(1), cu: 1 },
      ],
    };
    expect(api.oracle(input).servedCu).toBe(1);
    expect(api.oracle(input).assignment).toEqual([null, "A"]);
    expect(api.oracle({ ...input, mustServe: true }).servedCu).toBe(0.5);
  });

  test("oracle rejects searches above twelve requests or three accounts", () => {
    const input = {
      accounts: R1.accounts,
      start: T0,
      requests: Array.from({ length: 13 }, (_, n) => ({ at: h(n), cu: 1 })),
    };
    expect(() => api.oracle(input)).toThrow(RangeError);
    expect(() =>
      api.oracle({
        ...input,
        requests: [],
        accounts: Array.from({ length: 4 }, (_, n) => ({ ...R1.accounts[0], id: "A" + n })),
      })
    ).toThrow(RangeError);
  });
});

describe("adversarial data contract (A1–A4; not a strategy tournament)", () => {
  test("the complete registry contains all four served traces and all seven other traces", () => {
    expect(SERVED_TRACES.map((trace) => trace.name)).toEqual([
      "R1",
      "gpt #1",
      "opus H1",
      "opus choose",
    ]);
    expect(SERVED_TRACES.map((trace) => trace.expected.oracle)).toEqual([3, 4, 5, 6]);
    expect(new Set(ALERT_TRACES)).toEqual(
      new Set([R2, GPT_8, OPUS_M4, R3, SLIDING_RELEASE, WINDOW_RETIRED, STRIPPED_HEADERS])
    );
    expect(ADVERSARIAL_TRACES).toHaveLength(11);
    expect(new Set(ADVERSARIAL_TRACES.map((trace) => trace.name)).size).toBe(11);
  });

  test("served figures match the architecture table; choose promises no strategy figure", () => {
    expect(R1.expected.served).toEqual({ sticky: 3, ebr: 3, lookahead: 3, "governing-fefo": 2 });
    expect(GPT_1.expected.served).toEqual({ sticky: 4, ebr: 3, lookahead: 4, "governing-fefo": 3 });
    expect(OPUS_H1.expected.served).toEqual({
      sticky: 4,
      ebr: 4,
      lookahead: 5,
      "governing-fefo": 5,
    });
    expect(OPUS_CHOOSE.expected.served).toEqual({});
    expect(OPUS_H1.expected.gaps).toEqual({ ebr: [{ startH: 50, endH: 100 }], lookahead: [] });
  });

  test("unit-task accounts use exact, drift-free fits semantics in configuration order", () => {
    expect(R1.accounts.map((a) => a.id)).toEqual([OPUS_H1.accounts[1].id, OPUS_H1.accounts[0].id]);
    expect(GPT_1.accounts.map((a) => a.id)).toEqual(R1.accounts.map((a) => a.id));
    for (const trace of SERVED_TRACES) {
      for (const account of trace.accounts) {
        expect(account.admission).toBe("fits");
        expect(account.quantum).toBe(0);
        expect(account.externalCuPerHour ?? 0).toBe(0);
      }
    }
  });

  test("H1 has one task at h0/h1 and three indivisible tasks at h50", () => {
    const demand = api.bucketDemandOf(OPUS_H1, 60);
    expect(demand).toHaveLength(60);
    expect(demand[0]).toBe(1);
    expect(demand[1]).toBe(1);
    expect(demand[50]).toBe(3);
    expect(demand.reduce((sum, value) => sum + value, 0)).toBe(5);
    expect(demand.filter((value) => value !== 0)).toEqual([1, 1, 3]);
  });

  test("R2 preserves both the 80 h and 1 h plus 86 h gap scenarios", () => {
    expect(R2.scenarios.map((s) => s.rateCuPerHour).sort((a, b) => a - b)).toEqual([15, 21]);
    const lengths = R2.scenarios.map((s) => s.gaps.map((g) => g.endH - g.startH));
    expect(lengths).toContainEqual([80]);
    expect(lengths).toContainEqual([1, 86]);
    expect(R2.scenarios.every((s) => s.level === "critical")).toBe(true);
    expect([...R2.strategies].sort()).toEqual(["ebr", "lookahead", "sticky"]);
  });

  test("external-only GPT #8 retains its 95 h gap and non-addressable remedy", () => {
    const scenario = GPT_8.scenarios[0];
    expect(scenario.rateCuPerHour).toBe(0);
    expect(scenario.gaps).toHaveLength(1);
    expect(scenario.gaps[0]).toMatchObject({ startH: 5, endH: 100 });
    expect(scenario.remedy).toEqual({ kind: "not-addressable", reason: "external-use" });
  });

  test("opus M4 declares one episode raised once at minute 15", () => {
    expect(OPUS_M4.expected).toEqual({
      transitions: [{ atMinutes: 15, to: "raised" }],
      episodes: 1,
    });
    expect(OPUS_M4.steps.length).toBeGreaterThan(1);
    expect(OPUS_M4.steps.some((s) => s.long.length === 2)).toBe(true);
  });

  test("R3 stays on B instead of crediting a full residual hour to A", () => {
    expect(R3.threadAccount).toBe(R3.accounts[1].id);
    expect(R3.expected.account).toBe(R3.accounts[1].id);
    expect(R3.expected.neverOnto).toBe(R3.accounts[0].id);
    expect(R3.expected.deliverable.value).toBeCloseTo(0.0503, 3);
    expect(R3.expected.deliverable.tolerance).toBeLessThanOrEqual(0.0005);
  });

  test("sliding release retains the 0.6 remaining-at-bucket-five acceptance target", () => {
    expect(SLIDING_RELEASE.expected.remainingAtBucket).toBe(5);
    expect(SLIDING_RELEASE.expected.remaining).toBeCloseTo(0.6, 12);
    expect(SLIDING_RELEASE.account.windows.some((w) => w.semantics === "sliding")).toBe(true);
  });

  test("retirement input includes two null snapshots and two complete snapshots without 5h", () => {
    const snapshots = WINDOW_RETIRED.events.filter(
      (e) => e.kind === "response" || e.kind === "snapshot"
    );
    expect(snapshots).toHaveLength(5);
    expect(snapshots[1].windows).toBeNull();
    expect(snapshots[2].windows).toBeNull();
    for (const index of [3, 4]) {
      expect(snapshots[index].windows).not.toBeNull();
      expect(snapshots[index].windows!.some((w) => w.lengthMinutes === 300)).toBe(false);
    }
  });

  test("stripped-header input retains a 0.4 initial reading and 2000 total input tokens", () => {
    const events = STRIPPED_HEADERS.events.filter((e) => e.kind === "response");
    expect(events[0].windows!.some((w) => w.usedFraction === 0.4)).toBe(true);
    expect(events.slice(1).every((e) => e.windows === null)).toBe(true);
    expect(events.reduce((sum, e) => sum + e.tokens.input, 0)).toBe(2000);
  });
});
