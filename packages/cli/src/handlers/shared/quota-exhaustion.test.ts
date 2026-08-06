import { describe, expect, test } from "bun:test";
import { hasQuotaExhaustionWording, isQuotaExhaustionError } from "./quota-exhaustion.js";

const KIMI_EXHAUSTION_BODY =
  '{"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing"}}';

describe("isQuotaExhaustionError", () => {
  test("detects the captured Kimi permission_error at status 403", () => {
    expect(isQuotaExhaustionError(403, KIMI_EXHAUSTION_BODY)).toBe(true);
  });

  test("detects the captured Kimi exhaustion body at statuses 401 and 429", () => {
    expect(isQuotaExhaustionError(401, KIMI_EXHAUSTION_BODY)).toBe(true);
    expect(isQuotaExhaustionError(429, KIMI_EXHAUSTION_BODY)).toBe(true);
  });

  test("rejects the captured Kimi exhaustion body for unrelated statuses", () => {
    for (const status of [200, 400, 404, 500, 503]) {
      expect(isQuotaExhaustionError(status, KIMI_EXHAUSTION_BODY)).toBe(false);
    }
  });

  test("explicitly excludes status 402 because payment required is handled separately", () => {
    expect(isQuotaExhaustionError(402, KIMI_EXHAUSTION_BODY)).toBe(false);
  });

  describe("genuine authentication failures", () => {
    const authFailureBodies = [
      '{"error":{"message":"invalid api key"}}',
      '{"error":{"message":"Unauthorized"}}',
      '{"error":{"type":"permission_error","message":"Permission denied"}}',
      '{"error":{"message":"Forbidden"}}',
      '{"error":{"message":"authentication failed"}}',
      '{"error":{"message":"invalid client id"}}',
    ] as const;

    for (const status of [401, 403]) {
      for (const body of authFailureBodies) {
        test(`does not classify ${body} at status ${status} as quota exhaustion`, () => {
          expect(isQuotaExhaustionError(status, body)).toBe(false);
        });
      }
    }

    test("keys off limit wording rather than permission_error", () => {
      const permissionDeniedBody =
        '{"error":{"type":"permission_error","message":"Permission denied"}}';

      expect(isQuotaExhaustionError(403, KIMI_EXHAUSTION_BODY)).toBe(true);
      expect(isQuotaExhaustionError(403, permissionDeniedBody)).toBe(false);
    });
  });

  describe("other exhaustion wordings", () => {
    const exhaustionWordings = [
      "insufficient balance",
      "insufficient_quota",
      "You exceeded your current quota",
      "out of credits",
      "credit balance is too low",
      "upgrade your plan",
    ] as const;

    for (const wording of exhaustionWordings) {
      test(`detects \"${wording}\" at status 403`, () => {
        expect(isQuotaExhaustionError(403, wording)).toBe(true);
      });
    }
  });

  test("returns false for an empty body", () => {
    expect(isQuotaExhaustionError(403, "")).toBe(false);
  });

  test("matches Kimi's exhaustion message case-insensitively", () => {
    expect(isQuotaExhaustionError(403, KIMI_EXHAUSTION_BODY.toUpperCase())).toBe(true);
  });
});

/**
 * Captured live from Zen Go, 2026-08-06. Note the wording differs from Kimi's:
 * this is a ROLLING window ("usage limit reached … Resets in 3hr"), Kimi's is a
 * SPENT allowance ("billing cycle"). Both must be detected — they are different
 * vendor vocabularies for the same decision.
 */
const ZEN_GO_ROLLING_WINDOW_BODY =
  '{"type":"error","error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 3hr 17min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01KK0EAEMKQZZN68V8YN1WAJ33/go"},"metadata":{"workspace":"wrk_01KK0EAEMKQZZN68V8YN1WAJ33","limitName":"5 hour"}}';

describe("hasQuotaExhaustionWording — the status-agnostic predicate", () => {
  test("detects both vendors' wordings: a spent cycle and a rolling window", () => {
    expect(hasQuotaExhaustionWording(KIMI_EXHAUSTION_BODY)).toBe(true);
    expect(hasQuotaExhaustionWording(ZEN_GO_ROLLING_WINDOW_BODY)).toBe(true);
  });

  /**
   * THIS PAIR IS THE BUG THE SPLIT FIXES.
   *
   * `fallback-handler.ts` decides whether to advance the provider chain, and by
   * the time it looks, a terminal 429 has been REMAPPED to 400 by the "terminal
   * errors become 400" doctrine in composed-handler.ts. 400 is otherwise
   * non-retryable, so a status-gated check there stopped the chain dead — a bare
   * `minimax-m2.5` hard-failed while Zen Go's window was spent and metered
   * MiniMax stood ready to serve.
   *
   * If someone re-collapses these two predicates into one, this test fails.
   */
  test("survives the 429→400 remap that the status-gated predicate cannot", () => {
    expect(isQuotaExhaustionError(429, ZEN_GO_ROLLING_WINDOW_BODY)).toBe(true);
    // Remapped: the status-gated form no longer recognises it …
    expect(isQuotaExhaustionError(400, ZEN_GO_ROLLING_WINDOW_BODY)).toBe(false);
    // … which is exactly why fallback-handler.ts must use the wording form.
    expect(hasQuotaExhaustionWording(ZEN_GO_ROLLING_WINDOW_BODY)).toBe(true);
  });

  test("does not fire on genuine auth failures, at any status", () => {
    for (const body of [
      '{"error":{"message":"invalid api key"}}',
      '{"error":{"message":"Unauthorized"}}',
      '{"error":{"type":"permission_error","message":"Permission denied"}}',
      '{"error":{"message":"Forbidden"}}',
    ]) {
      expect(hasQuotaExhaustionWording(body)).toBe(false);
    }
  });

  test("returns false for an empty body", () => {
    expect(hasQuotaExhaustionWording("")).toBe(false);
  });

  test("covers the later-added rolling-window wordings", () => {
    expect(hasQuotaExhaustionWording("daily limit exceeded for this plan")).toBe(true);
    expect(hasQuotaExhaustionWording("plan limit reached")).toBe(true);
  });

  /**
   * A request-RATE limit is a different event from a spent allowance, and the
   * right advice differs: "reduce concurrency" helps the first and is useless
   * for the second. Conflating them would put the wrong hint in front of users.
   */
  test("does not treat a request-rate limit as a spent allowance", () => {
    expect(hasQuotaExhaustionWording("rate limit exceeded, slow down")).toBe(false);
  });
});

describe("fallback quota-exhaustion contract", () => {
  // fallback-handler.ts uses the WORDING form for both decisions it makes here:
  // whether to advance the chain, and whether to warn that the next provider
  // bills per token. In BOTH cases the chain advances — only the log line
  // differs. Exhaustion is NOT chain-terminal; see quota-exhaustion.ts for why
  // making it so was reverted.
  test("a spent allowance is recognised, so the advance is announced not silent", () => {
    expect(hasQuotaExhaustionWording(KIMI_EXHAUSTION_BODY)).toBe(true);
    expect(hasQuotaExhaustionWording(ZEN_GO_ROLLING_WINDOW_BODY)).toBe(true);
  });

  test("a plain auth failure advances quietly, with the generic log line", () => {
    expect(hasQuotaExhaustionWording('{"error":{"message":"Forbidden"}}')).toBe(false);
  });
});
