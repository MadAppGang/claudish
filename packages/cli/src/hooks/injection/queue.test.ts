/**
 * The pure injection queue policy (architecture §7.2, §4.7 rules 1-7), with a fake clock.
 */

import { describe, expect, test } from "bun:test";
import {
  type HookQueueItem,
  INJECTION_EXPIRY_MS,
  type InjectionQueueState,
  type QueueItem,
  afterAdmission,
  emptyQueueState,
  next,
} from "./queue.js";

const T0 = 1_000_000;
const always = () => true;

function hook(
  text: string,
  callerSeq: number,
  queuedAt = T0,
  hookIds = ["hook:m/a"]
): HookQueueItem {
  return { kind: "hook", text, hookIds, queuedAt, callerSeq };
}

function state(items: QueueItem[], over: Partial<InjectionQueueState> = {}): InjectionQueueState {
  return { ...emptyQueueState(3), items, callerAdmitted: 1, ...over };
}

describe("next(): delivery only in IDLE, caller first", () => {
  test("a caller item is delivered before any hook item, and the hook item stays queued", () => {
    const h = hook("HOOK", 1);
    const r = next(state([h, { kind: "caller", text: "CALLER" }]), T0, "IDLE", always);
    expect(r.deliver).toEqual({ kind: "caller", text: "CALLER" });
    expect(r.drop).toEqual([]);
    expect(r.remaining).toEqual([h]);
  });

  for (const phase of ["RUNNING", "ADMITTING", "BOOTING"] as const) {
    test(`${phase}: nothing is delivered and nothing dropped`, () => {
      const items = [hook("HOOK", 1), { kind: "caller" as const, text: "C" }];
      const r = next(state(items), T0, phase, always);
      expect(r.deliver).toBeUndefined();
      expect(r.drop).toEqual([]);
      expect(r.pressEscape).toBe(false);
      expect(r.remaining).toEqual(items);
    });
  }

  test("QUESTION/PERMISSION: a queue of hook items only never presses Esc (§7.2)", () => {
    for (const phase of ["QUESTION", "PERMISSION"] as const) {
      expect(next(state([hook("HOOK", 1)]), T0, phase, always).pressEscape).toBe(false);
      expect(
        next(state([hook("HOOK", 1), { kind: "caller", text: "C" }]), T0, phase, always).pressEscape
      ).toBe(true);
    }
  });
});

describe("next(): staleness is counted in caller admissions", () => {
  test("a sessionStart item queued after the initial prompt (callerSeq 1) survives it", () => {
    // the initial prompt was admitted: callerAdmitted 1; sessionStart fired after that
    const r = next(state([hook("START", 1)], { callerAdmitted: 1 }), T0, "IDLE", always);
    expect(r.deliver?.text).toBe("START");
    expect(r.drop).toEqual([]);
  });

  test("a hook item queued before a later caller turn was admitted is stale", () => {
    const h = hook("OLD", 1);
    const r = next(state([h], { callerAdmitted: 2 }), T0, "IDLE", always);
    expect(r.deliver).toBeUndefined();
    expect(r.drop).toEqual([{ item: h, reason: "stale" }]);
    expect(r.remaining).toEqual([]);
  });
});

describe("next(): merge, cap, expiry, delivery check", () => {
  test("every live hook item merges into ONE turn: queue order, \\n\\n, duplicates once", () => {
    const items = [
      hook("from-start", 1, T0, ["hook:a/s"]),
      hook("proxy-1", 1, T0 + 5, ["hook:b/p"]),
      hook("from-start", 1, T0 + 6, ["hook:c/dup"]),
      hook("idle", 1, T0 + 7, ["hook:d/i"]),
    ];
    const r = next(state(items), T0 + 10, "IDLE", always);
    expect(r.deliver).toMatchObject({
      kind: "hook",
      text: "from-start\n\nproxy-1\n\nidle",
      hookIds: ["hook:a/s", "hook:b/p", "hook:c/dup", "hook:d/i"],
      queuedAt: T0,
      callerSeq: 1,
    });
    expect(r.remaining).toEqual([]);
  });

  test("over the cap of consecutive hook-caused turns: dropped capped", () => {
    const h = hook("HOOK", 1);
    const r = next(state([h], { consecutiveHookTurns: 3 }), T0, "IDLE", always);
    expect(r.drop).toEqual([{ item: h, reason: "capped" }]);
    expect(next(state([h], { consecutiveHookTurns: 2 }), T0, "IDLE", always).deliver?.text).toBe(
      "HOOK"
    );
  });

  test("the cap resets only when a CALLER turn is admitted; a hook admission extends the run", () => {
    let s = state([], { consecutiveHookTurns: 0 });
    for (let i = 0; i < 3; i++) Object.assign(s, afterAdmission(s, hook("h", 1)));
    expect(s.consecutiveHookTurns).toBe(3);
    expect(s.callerAdmitted).toBe(1);
    s = { ...s, ...afterAdmission(s, { kind: "caller", text: "c" }) };
    expect(s.consecutiveHookTurns).toBe(0);
    expect(s.callerAdmitted).toBe(2);
  });

  test("an injection not delivered within 10 minutes is dropped expired", () => {
    const h = hook("OLD", 1, T0);
    const fresh = hook("NEW", 1, T0 + INJECTION_EXPIRY_MS);
    const r = next(state([h, fresh]), T0 + INJECTION_EXPIRY_MS + 1, "IDLE", always);
    expect(r.drop).toEqual([{ item: h, reason: "expired" }]);
    expect(r.deliver?.text).toBe("NEW");
  });

  test("a merge that cannot be delivered (multi-line, no Read) is dropped delivery_unavailable", () => {
    const a = hook("line one", 1);
    const b = hook("line two", 1);
    // the merged text is two lines: only a file delivery could carry it
    const canDeliver = (t: string) => !t.includes("\n");
    const r = next(state([a, b]), T0, "IDLE", canDeliver);
    expect(r.deliver).toBeUndefined();
    expect(r.drop).toEqual([
      { item: a, reason: "delivery_unavailable" },
      { item: b, reason: "delivery_unavailable" },
    ]);
    expect(r.remaining).toEqual([]);
  });

  test("next() is pure: the state passed in is not changed", () => {
    const s = state([hook("H", 0)], { callerAdmitted: 1 });
    const before = structuredClone(s);
    next(s, T0, "IDLE", always);
    expect(s).toEqual(before);
  });
});
