import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STALL_THRESHOLD_MS,
  type StallClock,
  StallGuard,
  type StallPolicy,
  isOutputBearingEvent,
  resolveStallPolicy,
} from "./stall-guard.js";

function clock(at: number) {
  let now = at;
  let sequence = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const api: StallClock & { advance(ms: number): void } = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++sequence;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id as number);
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...pending]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].fn();
      }
      now = target;
    },
  };
  return api;
}

describe("REQ-12 stall policy scope", () => {
  test.each([
    ["openai-codex", "oauth", 150000],
    ["openai-codex", "api-key", 0],
    ["openai-codex", undefined, 0],
    ["openai", "oauth", 0],
    ["custom-responses", "oauth", 0],
  ] as const)("REQ-12 TEST-13 %s / %s resolves to %d ms", (providerName, arm, thresholdMs) => {
    const expected: StallPolicy =
      thresholdMs === 0 ? { thresholdMs: 0 } : { thresholdMs: 150000, finalThresholdMs: 300000 };
    expect(resolveStallPolicy({ env: {}, providerName, arm })).toEqual(expected);
    expect(DEFAULT_STALL_THRESHOLD_MS).toBe(150000);
  });

  test.each(["openai", "custom-responses", "openai-codex"])(
    "REQ-12 TEST-13 env override arms %s and zero disables",
    (providerName) => {
      expect(
        resolveStallPolicy({
          env: { CLAUDISH_RESPONSES_STALL_MS: "1234" },
          providerName,
          arm: "api-key",
        })
      ).toEqual({ thresholdMs: 1234, finalThresholdMs: 2468 });
      expect(
        resolveStallPolicy({
          env: { CLAUDISH_RESPONSES_STALL_MS: "0" },
          providerName,
          arm: "oauth",
        })
      ).toEqual({ thresholdMs: 0 });
    }
  );
});

describe("REQ-11 headers-relative stall clock", () => {
  test("REQ-11 TEST-14 includes the already elapsed sniff window and fires exactly once", () => {
    const time = clock(12000);
    const fired: number[] = [];
    const guard = new StallGuard(150000, 0, (ms) => fired.push(ms), time);
    time.advance(137999);
    expect(fired).toEqual([]);
    time.advance(1);
    expect(fired).toEqual([150000]);
    time.advance(300000);
    expect(fired).toEqual([150000]);
    expect(guard.armed).toBe(false);
  });

  test("REQ-11 TEST-14 disarming before output prevents a timer firing", () => {
    const time = clock(0);
    const fired: number[] = [];
    const guard = new StallGuard(150000, 0, (ms) => fired.push(ms), time);
    guard.disarm();
    time.advance(600000);
    expect(fired).toEqual([]);
    expect(guard.armed).toBe(false);
  });

  test.each(["response.created", "response.in_progress", "keepalive", "response.metadata"])(
    "REQ-11 TEST-14 %s is not output-bearing",
    (type) => expect(isOutputBearingEvent(type)).toBe(false)
  );
  test.each([
    "response.output_item.added",
    "response.output_text.delta",
    "response.function_call_arguments.delta",
    "response.reasoning_summary_text.delta",
  ])("REQ-11 TEST-14 %s is output-bearing", (type) =>
    expect(isOutputBearingEvent(type)).toBe(true)
  );
});
