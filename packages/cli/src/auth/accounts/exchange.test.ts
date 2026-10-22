import { describe, expect, test } from "bun:test";
import { createCodexTokenExchange } from "./exchange.js";
import { ExchangeOutcomeUnknownError } from "./token-manager.js";
import { type StoredTokenRecord, fingerprintOf } from "./token-store.js";
import type { AccountRef } from "./types.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const ref: AccountRef = {
  provider: "openai-codex",
  id: "abc123def456",
  label: "work",
};
const record: StoredTokenRecord = {
  accessToken: "access-old",
  refreshToken: "refresh-old",
  expiresAt: NOW - 1,
  generation: 0,
  fingerprint: fingerprintOf("refresh-old"),
  updatedAt: NOW,
};

describe("Codex token exchange timeout", () => {
  test("aborts an accepted request that never answers and reports an unknown outcome", async () => {
    let accepted = 0;
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        accepted++;
        return new Promise<Response>(() => {});
      },
    });
    const timeoutMs = 25;
    const exchange = createCodexTokenExchange({
      timeoutMs,
      now: () => NOW,
      fetch: (_input, init) => fetch(new URL("/oauth/token", endpoint.url), init),
    });
    const started = performance.now();

    try {
      let thrown: unknown;
      try {
        await exchange.refresh(record, ref);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExchangeOutcomeUnknownError);
      expect((thrown as Error).message).toContain("outcome is unknown");
      expect(accepted).toBe(1);
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      endpoint.stop(true);
    }

    // Mutation caught: omit AbortSignal.timeout from the fetch. The fake accepts
    // the request and never resolves, so this test reaches its own 2 s timeout.
    // A timeout must stay ExchangeOutcomeUnknownError because the vendor may
    // have rotated the refresh token before its response was lost.
  }, 2_000);
});
