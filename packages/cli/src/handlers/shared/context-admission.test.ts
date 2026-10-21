/**
 * #565 — admission census over DECLARED windows, pure halves.
 *
 * The route-level wiring is pinned in `proxy-server-step-skip-route.test.ts`
 * (K20–K23); this file pins the DECISION, where the mistakes live: guessing a
 * window nobody declared, refusing on an inflated base64 estimate, and — the
 * load-bearing one — wording a context refusal in vocabulary the quota
 * classifier reads as a wall.
 */

import { describe, expect, test } from "bun:test";
import {
  contextAdmissionDisabled,
  contextAdmissionRefusalText,
  decideContextAdmission,
  type DeclaredWindow,
} from "./context-overflow.js";
import { isQuotaExhaustion } from "../../fork/failover.js";

const payloadOf = (chars: number) => ({ messages: [{ role: "user", content: "x".repeat(chars) }] });

describe("#565 — decideContextAdmission", () => {
  test("a path that declares NOTHING falls open — the census never guesses a window", () => {
    const d = decideContextAdmission(payloadOf(4_000_000), []);
    expect(d.refuse).toBe(false);
    expect(d.largest).toBeUndefined();
    // Not even measured: with nothing to weigh, the body is never walked.
    expect(d.estTokens).toBe(0);
  });

  test("an entry with a non-finite or zero limit is not a declared window either", () => {
    // Each shape ALONE: with [NaN, 0] the NaN initialises `largest` and the
    // zero can never beat it, so a dropped validity filter still falls open by
    // an accident of ordering (mutation n6 survived — review 21/10). A lone
    // zero limit is the shape where the filter is the only thing deciding.
    const zeroOnly: DeclaredWindow[] = [{ name: "zero", limit: 0 }];
    expect(decideContextAdmission(payloadOf(4_000_000), zeroOnly).refuse).toBe(false);
    const nanOnly: DeclaredWindow[] = [{ name: "broken", limit: Number.NaN }];
    expect(decideContextAdmission(payloadOf(4_000_000), nanOnly).refuse).toBe(false);
    // And the pair, which was the original (vacuous-by-ordering) shape.
    const both: DeclaredWindow[] = [
      { name: "broken", limit: Number.NaN },
      { name: "zero", limit: 0 },
    ];
    expect(decideContextAdmission(payloadOf(4_000_000), both).refuse).toBe(false);
  });

  test("the LARGEST declared window is the one weighed — a small step alone would over-refuse", () => {
    const windows: DeclaredWindow[] = [
      { name: "small", limit: 32_768 },
      { name: "large", limit: 262_144 },
    ];
    const d = decideContextAdmission(payloadOf(400_000), windows); // est ≈ 100k tokens
    expect(d.refuse).toBe(false);
    expect(d.largest).toEqual({ name: "large", limit: 262_144 });
  });

  test("a request over EVERY declared window is refused, and the largest is named", () => {
    const windows: DeclaredWindow[] = [
      { name: "vllm-myia", limit: 262_144 },
      { name: "small", limit: 32_768 },
    ];
    const d = decideContextAdmission(payloadOf(4_400_000), windows); // est ≈ 1.1M tokens
    expect(d.refuse).toBe(true);
    expect(d.largest).toEqual({ name: "vllm-myia", limit: 262_144 });
  });

  test("the refusal clears the window by the #441 proportional margin, not by a hair", () => {
    // est = limit + 1000 ⇒ inside `max(2048, est/64)` ⇒ NOT refused: a request
    // merely NEAR a window belongs to the clamp and the learned cap.
    const near = decideContextAdmission(payloadOf(262_144 * 4 + 4_000), [
      { name: "w", limit: 262_144 },
    ]);
    expect(near.estTokens).toBeLessThanOrEqual(262_144 + 2_048);
    expect(near.refuse).toBe(false);
    // est = limit + ~40k ⇒ well past the margin ⇒ refused.
    const past = decideContextAdmission(payloadOf(262_144 * 4 + 160_000), [
      { name: "w", limit: 262_144 },
    ]);
    expect(past.refuse).toBe(true);
  });

  test("the estimate is the media-aware CLAMP estimate — a 1 MB screenshot is not 750k tokens", () => {
    // #442 review: base64 chars / 4 would score this ~750k tokens and refuse a
    // perfectly servable vision turn against a 262k window.
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this screenshot" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000_000) },
            },
          ],
        },
      ],
    };
    const d = decideContextAdmission(payload, [{ name: "w", limit: 262_144 }]);
    expect(d.estTokens).toBeLessThan(10_000);
    expect(d.refuse).toBe(false);
  });
});

describe("#565 — refusal wording never reads as a quota wall", () => {
  const text = contextAdmissionRefusalText(1_100_000, { name: "vllm-myia", limit: 262_144 });

  test("states the numbers it measured, and names the largest declared window", () => {
    expect(text).toContain("1100000");
    expect(text).toContain("262144");
    expect(text).toContain("vllm-myia");
  });

  test("claims only what the census weighed — DECLARED windows, never every candidate", () => {
    // Review 21/10 (non-blocking 1): an undeclared candidate on the path (nominal,
    // step, or a FallbackHandler provider swap) is INVISIBLE to the census, not
    // exonerated. The text must not assert knowledge it does not have.
    expect(text).toContain("DECLARED");
    expect(text).not.toContain("No candidate can serve");
  });

  test("LOAD-BEARING: isQuotaExhaustion does not match it — a context refusal must never arm a cascade", () => {
    expect(isQuotaExhaustion(200, text)).toBe(false);
    expect(isQuotaExhaustion(400, text)).toBe(false);
    // The status that matters most: a 429-shaped surface around this text.
    expect(isQuotaExhaustion(429, text)).toBe(false);
  });
});

describe("#565 — kill switch", () => {
  test("only an explicit 0 disarms; absent, empty and 1 keep the census on", () => {
    expect(contextAdmissionDisabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(contextAdmissionDisabled({ CLAUDISH_CONTEXT_ADMISSION: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(contextAdmissionDisabled({ CLAUDISH_CONTEXT_ADMISSION: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(contextAdmissionDisabled({ CLAUDISH_CONTEXT_ADMISSION: "0" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
