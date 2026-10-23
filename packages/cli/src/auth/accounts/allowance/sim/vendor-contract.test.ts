import { describe, expect, test } from "bun:test";
import {
  type VendorAccountSpec,
  type VendorRequest,
  type VendorWindowSpec,
  admissible,
  advanceWorld,
  chargeWorld,
  costOf,
  createVendor,
  initialWorld,
  readingsNow,
} from "./vendor.js";

const start = Date.UTC(2026, 9, 23);
const HOUR = 3600000;
const h = (n: number) => start + n * HOUR;
const tokens = { input: 1000, cacheRead: 800, cacheWrite: 100, output: 50 };
const api = { createVendor, readingsNow, costOf, admissible };

function account(
  window: Partial<VendorWindowSpec> = {},
  extra: Partial<VendorAccountSpec> = {}
): VendorAccountSpec {
  return {
    id: "A",
    admission: "fits",
    quantum: 0,
    windows: [
      {
        slot: "primary",
        lengthMinutes: 300,
        capacityCu: 10,
        semantics: "fixed-start",
        resetAt: h(5),
        ...window,
      },
    ],
    ...extra,
  };
}

function request(at: number, cu = 1, extra: Partial<VendorRequest> = {}): VendorRequest {
  return {
    id: "request-" + at,
    at,
    account: "A",
    session: "s-123",
    model: "gpt-6-astra",
    tokens,
    cu,
    ...extra,
  };
}

describe("hidden-truth vendor contract (§4; V1–V13)", () => {
  test("fixed-start resets before a request exactly at the boundary", () => {
    const vendor = api.createVendor([account({ usedCu: 9, resetAt: h(2) })], start);
    const first = vendor.serve(request(h(1)));
    expect(first.accepted).toBe(true);
    expect(first.event.windows![0]).toMatchObject({ usedFraction: 1, resetAt: h(2) });
    const second = vendor.serve(request(h(2)));
    expect(second.accepted).toBe(true);
    expect(second.event.windows![0]).toMatchObject({ usedFraction: 0.1, resetAt: h(7) });
  });

  test("a full window accepts at R, not one millisecond later", () => {
    const vendor = api.createVendor([account({ capacityCu: 1, usedCu: 1, resetAt: h(1) })], start);
    expect(vendor.serve(request(h(1) - 1)).accepted).toBe(false);
    expect(vendor.serve(request(h(1))).accepted).toBe(true);
  });

  test("first-use has no epoch until charged and starts a new epoch after idle expiry", () => {
    const spec = account({ semantics: "first-use", resetAt: null });
    const world = initialWorld([spec], start);
    expect(api.readingsNow(world, "A")[0].resetAt).toBeNull();
    const vendor = api.createVendor([spec], start);
    expect(vendor.serve(request(h(3))).event.windows![0].resetAt).toBe(h(8));
    expect(vendor.serve(request(h(12))).event.windows![0].resetAt).toBe(h(17));
  });

  test("sliding releases only the charge that ages out and advances its reset", () => {
    const vendor = api.createVendor(
      [account({ semantics: "sliding", capacityCu: 5, resetAt: undefined })],
      start
    );
    for (const hour of [0, 1, 2]) expect(vendor.serve(request(h(hour))).accepted).toBe(true);
    expect(vendor.truth(h(4) + 59 * 60000).A[0].remainingCu).toBe(2);
    const truth = vendor.truth(h(5)).A[0];
    expect(truth.remainingCu).toBe(3);
    expect(vendor.truth(h(6)).A[0].remainingCu).toBe(4);
    const world = initialWorld(
      [account({ semantics: "sliding", capacityCu: 5, resetAt: undefined })],
      start
    );
    for (const hour of [0, 1, 2]) {
      advanceWorld(world, h(hour));
      chargeWorld(world, "A", 1);
    }
    expect(api.readingsNow(world, "A")[0].resetAt).toBe(h(5));
    advanceWorld(world, h(5));
    expect(api.readingsNow(world, "A")[0].resetAt).toBe(h(6));
  });

  test("whole-percent flooring differs from rounding and supports exact readings", () => {
    for (const [quantum, rounding, expected] of [
      [0.01, "floor", 0.41],
      [0.01, "round", 0.42],
      [0.001, "floor", 0.416],
      [0, "floor", 0.416],
    ] as const) {
      const world = initialWorld(
        [account({ capacityCu: 1, usedCu: 0.416 }, { quantum, rounding })],
        start
      );
      expect(api.readingsNow(world, "A")[0].usedFraction).toBeCloseTo(expected, 12);
    }
  });

  test("default reporting quantum is a whole percent", () => {
    const spec = account({ capacityCu: 1, usedCu: 0.416 });
    delete spec.quantum;
    const reading = api.readingsNow(initialWorld([spec], start), "A")[0];
    expect(reading.quantum).toBe(0.01);
    expect(reading.usedFraction).toBeCloseTo(0.41, 12);
  });

  test("before headers exclude this charge and after headers include it", () => {
    for (const timing of ["before", "after"] as const) {
      const vendor = api.createVendor([account({}, { headerTiming: timing })], start);
      expect(vendor.serve(request(start)).event.windows![0].usedFraction).toBe(
        timing === "before" ? 0 : 0.1
      );
      expect(vendor.truth(start).A[0].remainingCu).toBe(9);
    }
  });

  test("below-cap can overrun but fits returns quota with zero billed usage", () => {
    const loose = api.createVendor(
      [account({ capacityCu: 1, usedCu: 0.5 }, { admission: "below-cap" })],
      start
    );
    const accepted = loose.serve(request(start));
    expect(accepted.accepted).toBe(true);
    expect(accepted.event.windows![0].usedFraction).toBe(1);
    const strict = api.createVendor([account({ capacityCu: 1, usedCu: 0.5 })], start);
    const refused = strict.serve(request(start));
    expect(refused.accepted).toBe(false);
    expect(refused.event).toMatchObject({
      outcome: "quota",
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      finalInput: 0,
    });
    expect(refused.event.windows![0].rejected).toBe(true);
    expect(strict.truth(start).A[0].remainingCu).toBe(0.5);
  });

  test("all live windows must fit, even if the first has capacity", () => {
    const spec = account();
    spec.windows.push({
      slot: "secondary",
      lengthMinutes: 10080,
      capacityCu: 1,
      usedCu: 1,
      resetAt: h(10),
      semantics: "fixed-start",
    });
    const world = initialWorld([spec], start);
    expect(api.admissible(world, "A", 1)).toBe(false);
    advanceWorld(world, h(10));
    expect(api.admissible(world, "A", 1)).toBe(true);
  });

  test("stripped headers do not lose accepted tokens or alter other responses", () => {
    const vendor = api.createVendor([account({}, { strippedResponses: [1] })], start);
    const responses = [0, 1, 2].map((hour) => vendor.serve(request(h(hour))));
    expect(responses.map((r) => r.accepted)).toEqual([true, true, true]);
    expect(responses[0].event.windows).not.toBeNull();
    expect(responses[1].event.windows).toBeNull();
    expect(responses[2].event.windows).not.toBeNull();
    expect(responses[1].event.tokens).toEqual(tokens);
    expect(responses[1].event.outcome).toBe("ok");
  });

  test("removed windows stop constraining service and restored windows start empty", () => {
    const spec = account(
      { usedCu: 10, resetAt: h(500) },
      {
        windowSetChanges: [
          { at: h(240), remove: ["primary"] },
          { at: h(432), restore: ["primary"] },
        ],
      }
    );
    const vendor = api.createVendor([spec], start);
    expect(vendor.serve(request(start)).accepted).toBe(false);
    const removed = vendor.serve(request(h(240)));
    expect(removed.accepted).toBe(true);
    expect(removed.event.windows?.some((w) => w.slot === "primary") ?? false).toBe(false);
    const restored = vendor.serve(request(h(432)));
    expect(restored.accepted).toBe(true);
    expect(restored.event.windows![0].usedFraction).toBe(0.1);
  });

  test("external usage exhausts a window without any local request", () => {
    const vendor = api.createVendor(
      [
        account(
          {
            capacityCu: 100,
            usedCu: 90,
            lengthMinutes: 10080,
            resetAt: h(100),
          },
          { externalCuPerHour: 2 }
        ),
      ],
      start
    );
    expect(vendor.truth(h(5)).A[0].remainingCu).toBe(0);
    expect(vendor.serve(request(h(5))).accepted).toBe(false);
  });

  test("hidden cost counts uncached, cached, written and output tokens; explicit cu wins", () => {
    const spec = account();
    expect(api.costOf(spec, { tokens })).toBe(480);
    expect(api.costOf(spec, { tokens, cu: 7 })).toBe(7);
    expect(api.costOf(spec, { tokens, cu: 0 })).toBe(0);
  });

  test("time cannot move backwards", () => {
    const vendor = api.createVendor([account()], start);
    vendor.serve(request(h(1)));
    expect(() => vendor.serve(request(start))).toThrow(RangeError);
  });

  test("serve exposes only the response event, accepted flag and cost", () => {
    const spec = account();
    const before = structuredClone(spec);
    const result = api.createVendor([spec], start).serve(request(start));
    expect(Object.keys(result).sort()).toEqual(["accepted", "cu", "event"]);
    expect(result.event).toMatchObject({
      kind: "response",
      session: "s-123",
      model: "gpt-6-astra",
      tokens,
      outcome: "ok",
      finalInput: 1000,
    });
    expect(spec).toEqual(before);
    expect(result).not.toHaveProperty("world");
    expect(result.event).not.toHaveProperty("capacityCu");
  });
});
