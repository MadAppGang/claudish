import { expect, test } from "bun:test";
import { isRetryableError } from "../../handlers/fallback-handler.js";
import { hasQuotaExhaustionWording } from "../../handlers/shared/quota-exhaustion.js";
import {
  AccountListUnavailableError,
  AllAccountsExhaustedError,
  MeteredEscapeError,
  NeedsReauthError,
  NoUsableAccountError,
  PersistOutcomeUnknownError,
  RefreshUnavailableError,
  buildExhaustedMessage,
} from "./errors.js";

// PROVISIONAL: constructed account labels/reset; replace with a sanitized Phase V capture.
const message = buildExhaustedMessage({
  vendor: "Codex",
  total: 1,
  now: 1_000,
  blockers: [
    {
      kind: "exhausted",
      ref: { provider: "openai-codex", id: "abc123def456", label: "work" },
      resetAt: 61_000,
    },
  ],
});

test("U16: RefreshUnavailableError rejects a transient credential 401", () => {
  expect(() => new RefreshUnavailableError("r", undefined, [], 401)).toThrow(RangeError);
});

test("U10: exhaustion wording alone advances a remapped 400", () => {
  // Mutation: remove 'usage limit' from the template. No upstream status masks it here.
  expect(hasQuotaExhaustionWording(message)).toBe(true);
  expect(isRetryableError(400, message)).toBe(true);
});

for (const [error, terminal, status, quota] of [
  [new AllAccountsExhaustedError(message), true, 429, true],
  [new NeedsReauthError("work needs login"), true, 401, false],
  [new NoUsableAccountError("work is disabled"), true, 401, false],
  [new RefreshUnavailableError("store unreadable"), false, 503, false],
  [new RefreshUnavailableError("r", undefined, [], 429), false, 429, false],
  [new AccountListUnavailableError("config.json", "EACCES"), false, 503, false],
  [new PersistOutcomeUnknownError("EIO"), false, 503, false],
  [new MeteredEscapeError("unexpected arm"), true, undefined, false],
] as const) {
  test(`U16: ${error.name} preserves taxonomy and routing`, () => {
    // Mutation: remove/change any flag or upstreamStatus, or add quota wording to a disk failure.
    expect(error.terminal).toBe(terminal);
    expect(error.transient).toBe(!terminal);
    expect(error.upstreamStatus).toBe(status);
    expect(hasQuotaExhaustionWording(error.message)).toBe(quota);
    const body = JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: error.message,
        upstream_status: error.upstreamStatus,
      },
    });
    if (error.transient) {
      const headers = new Headers({ "x-claudish-auth-verdict": "transient" });
      expect(isRetryableError(status === 429 ? 429 : 503, body, undefined, headers)).toBe(false);
    } else {
      expect(isRetryableError(400, body)).toBe(status !== undefined);
    }
  });
}
