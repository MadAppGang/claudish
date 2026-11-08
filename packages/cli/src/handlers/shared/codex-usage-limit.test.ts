import { describe, expect, test } from "bun:test";
import { parseCodexUsageLimit, resolveUsageLimitResetAt } from "./codex-usage-limit.js";

/**
 * PROVISIONAL: D8 requires replacement with a real captured Codex
 * `usage_limit_reached` body/frame before Phase 2 merges. These constructed
 * shapes cover the documented containers and reset encodings only.
 */
const PROVISIONAL_LIMIT = {
  type: "error",
  error: {
    type: "api_error",
    code: "usage_limit_reached",
    message: "You've hit your usage limit. Please retry after the reset.",
    resets_in_seconds: 90,
    plan_type: "plus",
  },
};

describe("parseCodexUsageLimit", () => {
  test("parses the structured error container before relying on prose", () => {
    const parsed = parseCodexUsageLimit(PROVISIONAL_LIMIT);

    expect(parsed).toEqual({
      code: "usage_limit_reached",
      message: "You've hit your usage limit. Please retry after the reset.",
      resetsInSeconds: 90,
      plan: "plus",
    });

    // Mutation caught: remove structured code recognition or parse only the root.
  });

  test.each([
    {
      label: "response.error with ISO time",
      input: {
        type: "response.failed",
        response: {
          error: {
            code: "usage_limit_reached",
            message: "window spent",
            resets_at: "2026-09-12T14:32:00.000Z",
          },
        },
      },
      expected: Date.parse("2026-09-12T14:32:00.000Z"),
    },
    {
      label: "detail with epoch seconds",
      input: {
        detail: {
          type: "plan_usage_limit_reached",
          message: "window spent",
          resets_at: 1_789_200_000,
        },
      },
      expected: 1_789_200_000_000,
    },
    {
      label: "root with epoch milliseconds",
      input: {
        code: "quota_exceeded",
        message: "window spent",
        resetsAt: 1_789_200_000_123,
      },
      expected: 1_789_200_000_123,
    },
  ])("normalizes resets_at from $label", ({ input, expected }) => {
    expect(parseCodexUsageLimit(input)?.resetsAt).toBe(expected);

    // Mutations caught: drop response.error/detail/root traversal, ISO parsing,
    // or the epoch-seconds to epoch-milliseconds conversion.
  });

  test("resolves a relative reset against the caller's clock", () => {
    const parsed = parseCodexUsageLimit(PROVISIONAL_LIMIT);
    expect(parsed).not.toBeNull();
    expect(resolveUsageLimitResetAt(parsed!, 1_000_000)).toBe(1_090_000);

    // Mutation caught: resolve resets_in_seconds against module time or forget
    // the seconds-to-milliseconds conversion.
  });

  test("keeps a plain per-minute rate limit out of the usage-window classifier", () => {
    expect(
      parseCodexUsageLimit({
        type: "error",
        error: {
          code: "rate_limit_exceeded",
          message: "Too many requests; please slow down and retry later.",
        },
      })
    ).toBeNull();

    // Mutation caught: classify every 429/rate-limit-like error as plan quota.
  });

  test("uses the narrow prose backstop for a non-JSON vendor body", () => {
    expect(parseCodexUsageLimit("Weekly usage limit reached; resets tomorrow")).toEqual({
      code: "usage_limit_reached",
      message: "Weekly usage limit reached; resets tomorrow",
    });
    expect(parseCodexUsageLimit("temporarily overloaded; try again later")).toBeNull();

    // Mutation caught: delete the non-JSON backstop or broaden it to transient
    // overload wording.
  });
});
