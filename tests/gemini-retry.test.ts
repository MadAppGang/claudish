/**
 * Unit tests for Gemini Retry Utilities
 *
 * Tests cover:
 * - parseRetryDelay: extracting retry hints from Gemini 429 error responses
 * - isTerminalQuotaLimit: detecting daily vs transient quota limits
 * - skipRetryOn429: the key rotation integration flag for fetchWithRetry
 *
 * Note: fetchWithRetry itself depends on GeminiRequestQueue and real fetch(),
 * so we test the pure utility functions directly and simulate the integration
 * pattern between fetchWithRetry and executeWithFailover.
 */

import { describe, test, expect } from "bun:test";
import {
  parseRetryDelay,
  isTerminalQuotaLimit,
} from "../packages/cli/src/handlers/shared/gemini-retry";
import { KeyPool } from "../packages/cli/src/handlers/shared/key-pool";

// ──────────────────────────────────────────────────────────────────────────────
// parseRetryDelay
// ──────────────────────────────────────────────────────────────────────────────

describe("parseRetryDelay", () => {
  test("should return default backoff when errorText is not valid JSON", () => {
    const delay = parseRetryDelay("not json", 0, 2000);
    // Default: (attempt + 1) * baseDelayMs = 1 * 2000 = 2000
    expect(delay).toBe(2000);
  });

  test("should return default backoff when JSON has no retry info", () => {
    const delay = parseRetryDelay(JSON.stringify({ error: { message: "rate limited" } }), 0, 2000);
    expect(delay).toBe(2000);
  });

  test("should scale default backoff by attempt number", () => {
    const delay0 = parseRetryDelay("invalid", 0, 2000); // (0+1)*2000 = 2000
    const delay1 = parseRetryDelay("invalid", 1, 2000); // (1+1)*2000 = 4000
    const delay2 = parseRetryDelay("invalid", 2, 2000); // (2+1)*2000 = 6000

    expect(delay0).toBe(2000);
    expect(delay1).toBe(4000);
    expect(delay2).toBe(6000);
  });

  test("should parse retryDelay from error details (integer seconds)", () => {
    const errorText = JSON.stringify({
      error: {
        details: [{ retryDelay: "3s" }],
      },
    });
    const delay = parseRetryDelay(errorText, 0, 2000);
    expect(delay).toBe(3000);
  });

  test("should parse retryDelay from error details (fractional seconds)", () => {
    const errorText = JSON.stringify({
      error: {
        details: [{ retryDelay: "1.5s" }],
      },
    });
    const delay = parseRetryDelay(errorText, 0, 2000);
    // Math.ceil(1.5 * 1000) = 1500
    expect(delay).toBe(1500);
  });

  test("should parse 'reset after Xs' from error message", () => {
    const errorText = JSON.stringify({
      error: {
        message: "Quota exhausted. Please try again. quota will reset after 5s",
      },
    });
    const delay = parseRetryDelay(errorText, 0, 1000);
    // 5s = 5000ms, default = 1000ms, max(5000, 1000) = 5000
    expect(delay).toBe(5000);
  });

  test("should use max of retryDelay and message pattern", () => {
    const errorText = JSON.stringify({
      error: {
        message: "quota will reset after 10s",
        details: [{ retryDelay: "3s" }],
      },
    });
    const delay = parseRetryDelay(errorText, 0, 2000);
    // retryDelay = 3000, message = 10000, max(3000, 10000) = 10000
    expect(delay).toBe(10000);
  });

  test("should handle retryDelay detail among multiple details", () => {
    const errorText = JSON.stringify({
      error: {
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
          { retryDelay: "7s" },
        ],
      },
    });
    const delay = parseRetryDelay(errorText, 0, 2000);
    expect(delay).toBe(7000);
  });

  test("should handle empty error details array", () => {
    const errorText = JSON.stringify({
      error: { details: [] },
    });
    const delay = parseRetryDelay(errorText, 0, 2000);
    expect(delay).toBe(2000); // Falls back to default
  });

  test("should handle retryDelay without 's' suffix", () => {
    // The regex matches any number, so "3" without "s" should still work
    const errorText = JSON.stringify({
      error: {
        details: [{ retryDelay: "3" }],
      },
    });
    const delay = parseRetryDelay(errorText, 0, 2000);
    expect(delay).toBe(3000);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isTerminalQuotaLimit
// ──────────────────────────────────────────────────────────────────────────────

describe("isTerminalQuotaLimit", () => {
  test("should return true for PerDay quota", () => {
    const errorText = JSON.stringify({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "GenerateContentRequestsPerDayPerProject" }],
          },
        ],
      },
    });
    expect(isTerminalQuotaLimit(errorText)).toBe(true);
  });

  test("should return true for Daily quota (case-insensitive)", () => {
    const errorText = JSON.stringify({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "DailyTokenQuota" }],
          },
        ],
      },
    });
    expect(isTerminalQuotaLimit(errorText)).toBe(true);
  });

  test("should return false for PerMinute quota (transient)", () => {
    const errorText = JSON.stringify({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              { quotaId: "GenerateContentRequestsPerMinutePerProjectPerRegion" },
            ],
          },
        ],
      },
    });
    expect(isTerminalQuotaLimit(errorText)).toBe(false);
  });

  test("should return false for PerSecond quota (transient)", () => {
    const errorText = JSON.stringify({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "TokensPerSecondPerProject" }],
          },
        ],
      },
    });
    expect(isTerminalQuotaLimit(errorText)).toBe(false);
  });

  test("should return false when no QuotaFailure detail exists", () => {
    const errorText = JSON.stringify({
      error: {
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo" }],
      },
    });
    expect(isTerminalQuotaLimit(errorText)).toBe(false);
  });

  test("should return false when violations array is empty", () => {
    const errorText = JSON.stringify({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [],
          },
        ],
      },
    });
    expect(isTerminalQuotaLimit(errorText)).toBe(false);
  });

  test("should return false for invalid JSON", () => {
    expect(isTerminalQuotaLimit("not json")).toBe(false);
  });

  test("should return false for empty string", () => {
    expect(isTerminalQuotaLimit("")).toBe(false);
  });

  test("should return false when error field is missing", () => {
    expect(isTerminalQuotaLimit(JSON.stringify({ message: "some error" }))).toBe(false);
  });

  test("should return false when details field is missing", () => {
    expect(isTerminalQuotaLimit(JSON.stringify({ error: { message: "rate limited" } }))).toBe(
      false
    );
  });

  test("should check only the first violation's quotaId", () => {
    // First violation is PerMinute (transient), second is PerDay (terminal)
    // Should return false because only first violation is checked
    const errorText = JSON.stringify({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              { quotaId: "RequestsPerMinute" },
              { quotaId: "RequestsPerDay" },
            ],
          },
        ],
      },
    });
    expect(isTerminalQuotaLimit(errorText)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// skipRetryOn429 Integration Pattern
//
// These tests simulate how fetchWithRetry + executeWithFailover interact
// when skipRetryOn429 is enabled for multi-key rotation.
//
// Since fetchWithRetry depends on GeminiRequestQueue and real fetch(),
// we simulate its behavior: with skipRetryOn429=true, it returns the 429
// response immediately (after reading the body into lastErrorText).
// ──────────────────────────────────────────────────────────────────────────────

describe("skipRetryOn429 - Gemini Multi-Key Integration Pattern", () => {
  /**
   * Simulates the exact pattern used in base-gemini-handler.ts:
   *
   * 1. fetchWithRetry is called with skipRetryOn429=true
   * 2. On 429, fetchWithRetry reads the body (lastErrorText) and returns immediately
   * 3. executeWithFailover sees the 429 Response and rotates to next key
   * 4. The next key succeeds
   * 5. Caller uses lastErrorText (not response.text()) for 429 error details
   */
  test("simulated: fetchWithRetry with skipRetryOn429 returns 429 immediately for rotation", async () => {
    const pool = new KeyPool("AIza-key1,AIza-key2,AIza-key3", "Gemini");
    let lastErrorText = "";
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);

      // Simulate fetchWithRetry behavior with skipRetryOn429=true:
      // - Makes one fetch attempt
      // - On 429: reads body into lastErrorText, returns the (body-consumed) Response
      // - On success: returns Response with body intact
      if (key === "AIza-key1") {
        const errorBody = JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "Quota exceeded for AIza-key1",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [{ quotaId: "GenerateContentRequestsPerMinutePerProjectPerRegion" }],
              },
            ],
          },
        });

        // fetchWithRetry reads the body (simulating line 167: lastErrorText = await response.text())
        const resp = new Response(errorBody, { status: 429, statusText: "Too Many Requests" });
        lastErrorText = await resp.text(); // Body is now consumed
        return resp; // Returns consumed-body Response to executeWithFailover
      }

      // Key 2 succeeds
      return new Response('{"candidates":[{"content":"hello"}]}', {
        status: 200,
        statusText: "OK",
      });
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["AIza-key1", "AIza-key2"]);
    // The caller has lastErrorText from the failed key's body
    expect(lastErrorText).toContain("RESOURCE_EXHAUSTED");
    expect(lastErrorText).toContain("AIza-key1");
  });

  test("simulated: all Gemini keys 429 — caller uses lastErrorText for quota parsing", async () => {
    const pool = new KeyPool("AIza-key1,AIza-key2", "Gemini");
    let lastErrorText = "";

    const response = await pool.executeWithFailover(async (key) => {
      const errorBody = JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: `Quota exceeded for ${key}`,
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId: "GenerateContentRequestsPerMinutePerProjectPerRegion" }],
            },
            { retryDelay: "3s" },
          ],
        },
      });

      // Simulate fetchWithRetry: reads body, returns consumed Response
      const resp = new Response(errorBody, { status: 429, statusText: "Too Many Requests" });
      lastErrorText = await resp.text();
      return resp;
    });

    // All keys failed — executeWithFailover returns the last failed Response
    expect(response.status).toBe(429);

    // The response body was consumed by fetchWithRetry, but the caller
    // uses lastErrorText instead (base-gemini-handler.ts line 774):
    // const errorText = response.status === 429 ? lastErrorText : await response.text();
    expect(lastErrorText).toContain("RESOURCE_EXHAUSTED");
    expect(lastErrorText).toContain("AIza-key2"); // From the LAST key attempted

    // Can parse quota info from lastErrorText
    const errorData = JSON.parse(lastErrorText);
    expect(isTerminalQuotaLimit(lastErrorText)).toBe(false); // PerMinute = transient
    expect(parseRetryDelay(lastErrorText, 0, 2000)).toBe(3000); // retryDelay: "3s"
  });

  test("simulated: terminal daily quota detected — key rotation still skips to next key", async () => {
    const pool = new KeyPool("AIza-key1,AIza-key2", "Gemini");
    let lastErrorText = "";
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);

      if (key === "AIza-key1") {
        // Key 1: daily quota exhausted (terminal)
        const errorBody = JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [{ quotaId: "GenerateContentRequestsPerDayPerProject" }],
              },
            ],
          },
        });
        const resp = new Response(errorBody, { status: 429, statusText: "Too Many Requests" });
        lastErrorText = await resp.text();
        // With skipRetryOn429=true, fetchWithRetry returns immediately
        // executeWithFailover sees 429 and rotates to next key
        return resp;
      }

      // Key 2: works fine (different account, separate quota)
      return new Response('{"candidates":[]}', { status: 200 });
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["AIza-key1", "AIza-key2"]);
    // The daily quota was on key1 only — key2 has its own quota
    expect(isTerminalQuotaLimit(lastErrorText)).toBe(true);
  });

  test("simulated: single Gemini key does NOT use skipRetryOn429", async () => {
    // With single key, base-gemini-handler uses the regular fetchWithRetry
    // (maxRetries: 5, no skipRetryOn429), simulating normal retry behavior
    const pool = new KeyPool("AIza-only-key", "Gemini");

    // Single key path: fetchWithRetry handles retries internally
    // If it eventually gives up, the response comes back
    const response = await pool.executeWithFailover(async (key) => {
      expect(key).toBe("AIza-only-key");
      // Simulate fetchWithRetry exhausting its own retries and returning final 429
      return new Response('{"error":"exhausted"}', {
        status: 429,
        statusText: "Too Many Requests",
      });
    });

    // Single-key mode: executeWithFailover tries once and returns
    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toContain("exhausted");
  });

  test("simulated: Gemini key rotation with mixed 429 and 500 errors", async () => {
    const pool = new KeyPool("key1,key2,key3", "Gemini");
    let lastErrorText = "";
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);

      if (key === "key1") {
        // 429 rate limit
        const body = JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } });
        const resp = new Response(body, { status: 429 });
        lastErrorText = await resp.text();
        return resp;
      }
      if (key === "key2") {
        // 500 internal server error (also retryable)
        return new Response("Internal Server Error", { status: 500 });
      }
      // key3 succeeds
      return new Response('{"candidates":[{"content":"hello"}]}', { status: 200 });
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2", "key3"]);
    expect(lastErrorText).toContain("RESOURCE_EXHAUSTED");
  });
});
