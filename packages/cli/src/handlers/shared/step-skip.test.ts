/**
 * #679 — unit pins for `classifyConcurrencyRefusal`: the z.ai plan's
 * request-concurrency refusal (HTTP 429, `error.code 1302`) is a busy skip,
 * and NOTHING else is. The code is the contract because the wordings vary
 * (both measured shapes pinned here); the status gate keeps a same-code body
 * on another status (an in-stream 1302 arrives as HTTP 200 and is the
 * patient-backoff's business, not this predicate's) from ever matching.
 *
 * Route-level behavior (skip-advance, no bench, kill switch, last step) is
 * pinned in `proxy-server-step-skip-route.test.ts` — this file owns only the
 * predicate's boundary.
 */

import { describe, expect, test } from "bun:test";
import { classifyConcurrencyRefusal, isConcurrencyRefusalResponse } from "./step-skip.js";

const body = (error: unknown) => JSON.stringify(error);

describe("classifyConcurrencyRefusal (#679)", () => {
  test("both measured 429 wordings match, by code alone", () => {
    expect(
      classifyConcurrencyRefusal(
        429,
        body({ error: { code: "1302", message: "Rate limit reached for requests" } })
      )
    ).toBe(true);
    expect(
      classifyConcurrencyRefusal(
        429,
        body({
          error: {
            code: "1302",
            message: "Your account has reached its rate limit (concurrency/RPM). Please try again later.",
          },
        })
      )
    ).toBe(true);
  });

  test("the code as a NUMBER matches too — z.ai has shipped both encodings", () => {
    expect(classifyConcurrencyRefusal(429, body({ error: { code: 1302, message: "rate limit" } }))).toBe(true);
  });

  test("the 5-hour usage wall (1308) NEVER matches — it is isQuotaExhaustion's", () => {
    expect(
      classifyConcurrencyRefusal(
        429,
        body({ error: { code: "1308", message: "Usage limit reached for 5 hour" } })
      )
    ).toBe(false);
    expect(classifyConcurrencyRefusal(429, body({ error: { code: 1308, message: "x" } }))).toBe(false);
  });

  test("a 429 without the code — even rate-limit-shaped — does not match", () => {
    expect(classifyConcurrencyRefusal(429, body({ error: { message: "Too many requests" } }))).toBe(false);
    expect(classifyConcurrencyRefusal(429, body({ error: { code: "429", message: "rate limit" } }))).toBe(false);
    // Anthropic's account-cap wording — that is a quota wall, never a busy skip
    expect(
      classifyConcurrencyRefusal(
        429,
        body({ error: { message: "This request would exceed your account's rate limit." } })
      )
    ).toBe(false);
  });

  test("the status gate: a 1302 body on any other status does not match", () => {
    expect(classifyConcurrencyRefusal(200, body({ error: { code: "1302", message: "x" } }))).toBe(false);
    expect(classifyConcurrencyRefusal(503, body({ error: { code: "1302", message: "x" } }))).toBe(false);
  });

  test("unparseable or empty bodies never match — the code cannot be read, never guessed", () => {
    expect(classifyConcurrencyRefusal(429, "not json at all")).toBe(false);
    expect(classifyConcurrencyRefusal(429, "")).toBe(false);
    expect(classifyConcurrencyRefusal(429, body({ something: "else" }))).toBe(false);
  });
});

describe("isConcurrencyRefusalResponse (#679) — the body read is bounded", () => {
  // Regression pin: the first version awaited `clone().text()` with no deadline.
  // A 429 whose body never arrives (measured shape in openai.test.ts: "a body
  // that never ARRIVES also degrades to the ladder — it must not hang") then
  // blocked the transport forever instead of retrying. The read now carries its
  // own deadline, exactly like isQuotaWall's.
  test("a body that never arrives resolves to false instead of hanging", async () => {
    const never = new Response(
      new ReadableStream({
        start() {
          /* never enqueues, never closes */
        },
      }),
      { status: 429 }
    );
    const t0 = Date.now();
    expect(await isConcurrencyRefusalResponse(never)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test("a real 1302 body still short-circuits", async () => {
    const r = new Response(body({ error: { code: "1302", message: "Rate limit reached for requests" } }), {
      status: 429,
    });
    expect(await isConcurrencyRefusalResponse(r)).toBe(true);
  });
});
