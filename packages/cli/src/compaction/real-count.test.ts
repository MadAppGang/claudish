import { expect, test } from "bun:test";
import { RealTokenCount } from "./real-count.js";

const session = "real-count-session";

/** A payload of `n` messages of about 400 characters each, the first fixed. */
function payload(n: number): { messages: unknown[] } {
  return {
    messages: Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} ${"x".repeat(400)}`,
    })),
  };
}

const usage = (tokens: number) => ({ input_tokens: tokens });

/**
 * Two requests of one thread overlap, and the older one's response ends
 * last. Its smaller count is not a drop (a swap or Claude Code's compaction)
 * and must not start the growth window again or replace the newer
 * measurement.
 */
test("a late response of an older request neither resets growth nor replaces the newer count", () => {
  let now = 0;
  const counter = new RealTokenCount(() => now);
  const thread = "thread-a";
  const measured = [150_000, 155_000, 160_000];
  for (let i = 0; i < measured.length; i++) {
    now += 1_000;
    const mark = counter.mark(session, thread, payload(10 + i));
    counter.record(mark, usage(measured[i]!));
  }

  now += 1_000;
  const older = counter.mark(session, thread, payload(13));
  now += 1_000;
  const newer = counter.mark(session, thread, payload(14));
  counter.record(newer, usage(164_000));
  counter.record(older, usage(161_000));

  const growth = counter.observe(session, thread).growthPerRequest;
  expect(growth).toBeCloseTo((164_000 - 150_000) / 3, 6);
  const next = counter.count(session, thread, payload(15));
  expect(next.source).toBe("usage");
  expect(next.measured).toBe(164_000);
});

test("a real drop after the newest request still starts the growth window again", () => {
  let now = 0;
  const counter = new RealTokenCount(() => now);
  const thread = "thread-b";
  for (const tokens of [150_000, 155_000, 160_000]) {
    now += 1_000;
    counter.record(counter.mark(session, thread, payload(10)), usage(tokens));
  }
  now += 1_000;
  counter.record(counter.mark(session, thread, payload(4)), usage(90_000));
  expect(counter.observe(session, thread).growthPerRequest).toBeUndefined();
});
