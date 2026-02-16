/**
 * Unit tests for KeyPool - API Key Rotation with Automatic Failover
 *
 * Tests cover:
 * - Constructor parsing (single key, multi-key, whitespace, empty)
 * - Round-robin rotation across executeWithFailover calls
 * - Failover on rotatable status codes (401, 402, 403, 408, 429, 500, 502, 503, 504)
 * - Non-rotatable errors returned immediately (400, 404, 422, 501)
 * - Network error handling (thrown exceptions)
 * - All keys exhausted scenario (returns last failed Response for HTTP errors)
 * - Response body drain for intermediate failures
 * - reset() behavior
 * - Single-key mode (no rotation overhead)
 * - getCurrentKey() and peekNextKey() consistency
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { KeyPool } from "../packages/cli/src/handlers/shared/key-pool";

// Helper to create a mock Response
function mockResponse(status: number, body = ""): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? "OK" : status === 429 ? "Too Many Requests" : `Error ${status}`,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Constructor & Parsing
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Constructor & Parsing", () => {
  test("should parse a single key", () => {
    const pool = new KeyPool("sk-abc123", "TestProvider");
    expect(pool.hasKeys()).toBe(true);
    expect(pool.keyCount()).toBe(1);
    expect(pool.getCurrentKey()).toBe("sk-abc123");
  });

  test("should parse multiple comma-separated keys", () => {
    const pool = new KeyPool("key1,key2,key3", "TestProvider");
    expect(pool.hasKeys()).toBe(true);
    expect(pool.keyCount()).toBe(3);
    expect(pool.getCurrentKey()).toBe("key1");
  });

  test("should trim whitespace from keys", () => {
    const pool = new KeyPool("  key1 , key2 ,  key3  ", "TestProvider");
    expect(pool.keyCount()).toBe(3);
    expect(pool.getCurrentKey()).toBe("key1");
  });

  test("should filter out empty segments", () => {
    const pool = new KeyPool("key1,,key2,,,key3", "TestProvider");
    expect(pool.keyCount()).toBe(3);
  });

  test("should handle empty string", () => {
    const pool = new KeyPool("", "TestProvider");
    expect(pool.hasKeys()).toBe(false);
    expect(pool.keyCount()).toBe(0);
    expect(pool.getCurrentKey()).toBe("");
  });

  test("should handle whitespace-only string", () => {
    const pool = new KeyPool("   ", "TestProvider");
    expect(pool.hasKeys()).toBe(false);
    expect(pool.keyCount()).toBe(0);
  });

  test("should handle only commas", () => {
    const pool = new KeyPool(",,,", "TestProvider");
    expect(pool.hasKeys()).toBe(false);
    expect(pool.keyCount()).toBe(0);
  });

  test("should preserve keys with special characters", () => {
    const pool = new KeyPool("sk-proj_abc-123.xyz,AIza-SyD_efg456", "TestProvider");
    expect(pool.keyCount()).toBe(2);
    expect(pool.getCurrentKey()).toBe("sk-proj_abc-123.xyz");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getCurrentKey & peekNextKey
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - getCurrentKey & peekNextKey", () => {
  test("getCurrentKey should return the key at current index", () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    expect(pool.getCurrentKey()).toBe("key1");
  });

  test("peekNextKey should return same as getCurrentKey (no advancement)", () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    expect(pool.peekNextKey()).toBe("key1");
    // Calling again should not advance
    expect(pool.peekNextKey()).toBe("key1");
  });

  test("getCurrentKey returns empty string for empty pool", () => {
    const pool = new KeyPool("", "Test");
    expect(pool.getCurrentKey()).toBe("");
  });

  test("peekNextKey returns empty string for empty pool", () => {
    const pool = new KeyPool("", "Test");
    expect(pool.peekNextKey()).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// reset()
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - reset()", () => {
  test("should reset to first key after rotation", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");

    // Advance by making a successful call (which advances index)
    await pool.executeWithFailover(async (_key) => mockResponse(200));
    // After 1 success, index should have advanced
    expect(pool.getCurrentKey()).toBe("key2");

    pool.reset();
    expect(pool.getCurrentKey()).toBe("key1");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// executeWithFailover - Success Scenarios
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - executeWithFailover (Success)", () => {
  test("should return successful response with single key", async () => {
    const pool = new KeyPool("key1", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      expect(key).toBe("key1");
      return mockResponse(200, "ok");
    });

    expect(response.status).toBe(200);
  });

  test("should pass the correct key to fetchFn", async () => {
    const pool = new KeyPool("alpha,bravo,charlie", "Test");
    const keysUsed: string[] = [];

    // First call uses first key
    await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(200);
    });

    // Second call uses second key (round-robin)
    await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(200);
    });

    // Third call uses third key
    await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(200);
    });

    expect(keysUsed).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("should wrap around after all keys used (round-robin)", async () => {
    const pool = new KeyPool("key1,key2", "Test");
    const keysUsed: string[] = [];

    for (let i = 0; i < 5; i++) {
      await pool.executeWithFailover(async (key) => {
        keysUsed.push(key);
        return mockResponse(200);
      });
    }

    expect(keysUsed).toEqual(["key1", "key2", "key1", "key2", "key1"]);
  });

  test("should throw when no keys configured", async () => {
    const pool = new KeyPool("", "Test");

    expect(
      pool.executeWithFailover(async () => mockResponse(200))
    ).rejects.toThrow("No keys configured");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// executeWithFailover - Retryable Status Codes (Failover)
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - executeWithFailover (Retryable Errors)", () => {
  test("should rotate to next key on 429 and succeed", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") return mockResponse(429);
      return mockResponse(200, "success");
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2"]);
  });

  test("should rotate to next key on 500 and succeed", async () => {
    const pool = new KeyPool("key1,key2", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") return mockResponse(500);
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2"]);
  });

  test("should rotate on 502", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      if (key === "key1") return mockResponse(502);
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
  });

  test("should rotate on 503", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      if (key === "key1") return mockResponse(503);
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
  });

  test("should rotate on 504", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      if (key === "key1") return mockResponse(504);
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
  });

  test("should try all keys before returning last failed response on 429", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    // When all keys fail with retryable HTTP errors, returns the last failed Response
    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(429);
    });

    expect(response.status).toBe(429);
    expect(keysUsed).toEqual(["key1", "key2", "key3"]);
  });

  test("should skip failed keys and find working one at end", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1" || key === "key2") return mockResponse(429);
      return mockResponse(200, "found it");
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2", "key3"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// executeWithFailover - Key-Related Status Codes (401, 402, 403, 408)
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - executeWithFailover (Key-Related Rotatable Errors)", () => {
  test("should rotate to next key on 401 (unauthorized) and succeed", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") return mockResponse(401);
      return mockResponse(200, "success");
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2"]);
  });

  test("should rotate to next key on 402 (payment required) and succeed", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") return mockResponse(402);
      return mockResponse(200, "success");
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2"]);
  });

  test("should rotate to next key on 403 (forbidden) and succeed", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") return mockResponse(403);
      return mockResponse(200, "success");
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2"]);
  });

  test("should rotate to next key on 408 (request timeout) and succeed", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") return mockResponse(408);
      return mockResponse(200, "success");
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2"]);
  });

  test("all keys return 401: exhausts pool and returns last 401", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(401);
    });

    expect(response.status).toBe(401);
    expect(keysUsed).toEqual(["key1", "key2", "key3"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// executeWithFailover - Non-Rotatable Errors
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - executeWithFailover (Non-Rotatable Errors)", () => {
  test("should return immediately on 400 (bad request)", async () => {
    const pool = new KeyPool("key1,key2", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(400);
    });

    expect(response.status).toBe(400);
    expect(keysUsed).toEqual(["key1"]);
  });

  test("should return immediately on 404 (not found)", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(404);
    });

    expect(response.status).toBe(404);
    expect(keysUsed).toEqual(["key1"]);
  });

  test("should return immediately on 422 (unprocessable entity)", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(422);
    });

    expect(response.status).toBe(422);
    expect(keysUsed).toEqual(["key1"]);
  });

  test("should return immediately on 501 (not implemented)", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(501);
    });

    expect(response.status).toBe(501);
    expect(keysUsed).toEqual(["key1"]);
  });

  test("esoteric codes propagate immediately (418, 451, 511)", async () => {
    for (const status of [418, 451, 511]) {
      const pool = new KeyPool("key1,key2,key3", "Test");
      const keysUsed: string[] = [];

      const response = await pool.executeWithFailover(async (key) => {
        keysUsed.push(key);
        return mockResponse(status);
      });

      expect(response.status).toBe(status);
      expect(keysUsed).toEqual(["key1"]);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// executeWithFailover - Network Errors (Exceptions)
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - executeWithFailover (Network Errors)", () => {
  test("should rotate to next key on network error", async () => {
    const pool = new KeyPool("key1,key2", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") throw new Error("ECONNREFUSED");
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2"]);
  });

  test("should propagate last network error when all keys fail", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    await expect(
      pool.executeWithFailover(async () => {
        throw new Error("Connection refused");
      })
    ).rejects.toThrow("Connection refused");
  });

  test("should handle mix of network errors and HTTP errors", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") throw new Error("timeout");
      if (key === "key2") return mockResponse(429);
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2", "key3"]);
  });

  test("should handle non-Error thrown values", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      if (key === "key1") throw "string error"; // eslint-disable-line no-throw-literal
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// executeWithFailover - Index Advancement
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Index Advancement", () => {
  test("should advance index after successful response", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");

    await pool.executeWithFailover(async () => mockResponse(200));
    expect(pool.getCurrentKey()).toBe("key2");

    await pool.executeWithFailover(async () => mockResponse(200));
    expect(pool.getCurrentKey()).toBe("key3");

    await pool.executeWithFailover(async () => mockResponse(200));
    expect(pool.getCurrentKey()).toBe("key1"); // wrapped around
  });

  test("should advance index after failover rotations", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");

    // key1 fails (429), key2 succeeds → index should now be at key3
    await pool.executeWithFailover(async (key) => {
      if (key === "key1") return mockResponse(429);
      return mockResponse(200);
    });

    // Next call should start with key3
    const keysUsed: string[] = [];
    await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(200);
    });
    expect(keysUsed).toEqual(["key3"]);
  });

  test("index state after all keys fail with HTTP errors", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    // All keys fail with retryable HTTP status - returns Response (no throw)
    const response = await pool.executeWithFailover(async () => mockResponse(429));
    expect(response.status).toBe(429);

    // After trying both keys and failing, index should have advanced past both
    // Due to wrap-around, it should be back to the start
    expect(pool.getCurrentKey()).toBe("key1");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// executeWithFailover - Single Key Mode
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Single Key Mode", () => {
  test("should work normally with single key on success", async () => {
    const pool = new KeyPool("only-key", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      expect(key).toBe("only-key");
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
  });

  test("should return failed response with single key on retryable error (no other key to try)", async () => {
    const pool = new KeyPool("only-key", "Test");

    // With only one key, a retryable error returns the failed response
    const response = await pool.executeWithFailover(async () => mockResponse(429));
    expect(response.status).toBe(429);
  });

  test("should return rotatable error as-is with single key (no other key to try)", async () => {
    const pool = new KeyPool("only-key", "Test");

    const response = await pool.executeWithFailover(async () => mockResponse(403));
    expect(response.status).toBe(403);
  });

  test("single key stays the same after successful calls", async () => {
    const pool = new KeyPool("only-key", "Test");

    await pool.executeWithFailover(async () => mockResponse(200));
    await pool.executeWithFailover(async () => mockResponse(200));
    await pool.executeWithFailover(async () => mockResponse(200));

    // With single key, wrap-around means it's always the same key
    expect(pool.getCurrentKey()).toBe("only-key");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// executeWithFailover - Response Body Consumption
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Response Handling", () => {
  test("should not consume the response body of successful response", async () => {
    const pool = new KeyPool("key1", "Test");

    const response = await pool.executeWithFailover(async () => {
      return new Response('{"result":"hello"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // Body should still be readable
    const data = await response.json();
    expect(data.result).toBe("hello");
  });

  test("should not consume body of non-rotatable error response", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    const response = await pool.executeWithFailover(async () => {
      return new Response('{"error":"bad_request"}', {
        status: 400,
      });
    });

    // Body should still be readable by the caller
    const data = await response.json();
    expect(data.error).toBe("bad_request");
  });

  test("should drain intermediate response bodies but preserve the last one", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const responseBodies: string[] = [];

    // All keys fail - intermediate bodies should be drained, last preserved
    const response = await pool.executeWithFailover(async (key) => {
      const body = `{"error":"rate_limited","key":"${key}"}`;
      responseBodies.push(body);
      return new Response(body, { status: 429, statusText: "Too Many Requests" });
    });

    expect(response.status).toBe(429);
    // The last response body should be readable
    const data = await response.text();
    expect(data).toContain("key3");
  });

  test("should drain intermediate response bodies on rotation", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    let bodiesDrained = 0;

    // Track that intermediate response bodies get drained
    const response = await pool.executeWithFailover(async (key) => {
      if (key === "key3") return mockResponse(200, "success");

      // Create a response with a body that tracks consumption
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`error from ${key}`));
          controller.close();
        },
        cancel() {
          bodiesDrained++;
        },
      });
      return new Response(body, { status: 429, statusText: "Too Many Requests" });
    });

    expect(response.status).toBe(200);
    // key1's body should have been drained before trying key3
    // (key2's body gets drained at the start of the key3 iteration)
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration-style: Simulated Real-world Scenarios
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Real-world Scenarios", () => {
  test("typical env var with spaces: 'key1, key2, key3'", () => {
    const pool = new KeyPool("sk-abc123, sk-def456, sk-ghi789", "OpenAI");
    expect(pool.keyCount()).toBe(3);
    expect(pool.getCurrentKey()).toBe("sk-abc123");
  });

  test("rate limit across multiple sequential requests", async () => {
    const pool = new KeyPool("key1,key2,key3", "Gemini");
    const callLog: Array<{ key: string; result: number }> = [];

    // Simulate: key1 gets rate-limited, key2 works
    const resp1 = await pool.executeWithFailover(async (key) => {
      if (key === "key1") {
        callLog.push({ key, result: 429 });
        return mockResponse(429);
      }
      callLog.push({ key, result: 200 });
      return mockResponse(200);
    });
    expect(resp1.status).toBe(200);

    // Next request should start with key3 (key1 failed → key2 succeeded → advanced to key3)
    const resp2 = await pool.executeWithFailover(async (key) => {
      callLog.push({ key, result: 200 });
      return mockResponse(200);
    });
    expect(resp2.status).toBe(200);

    expect(callLog).toEqual([
      { key: "key1", result: 429 },
      { key: "key2", result: 200 },
      { key: "key3", result: 200 },
    ]);
  });

  test("cascading failures: first two keys rate-limited, third works", async () => {
    const pool = new KeyPool("key1,key2,key3", "OpenRouter");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") return mockResponse(429);
      if (key === "key2") return mockResponse(500);
      return mockResponse(200, '{"id":"resp-123"}');
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2", "key3"]);

    const body = await response.json();
    expect(body.id).toBe("resp-123");
  });

  test("all keys rate-limited: returns last failed response", async () => {
    const pool = new KeyPool("key1,key2", "Gemini");

    const response = await pool.executeWithFailover(async () => mockResponse(429));
    expect(response.status).toBe(429);
  });

  test("all keys rate-limited: last response body is readable with error details", async () => {
    const pool = new KeyPool("key1,key2", "Gemini");

    const response = await pool.executeWithFailover(async (key) => {
      return new Response(
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: `Quota exceeded for key ${key}`,
          },
        }),
        { status: 429, statusText: "Too Many Requests" }
      );
    });

    expect(response.status).toBe(429);
    // Caller should be able to read error details from the last response
    const data = await response.json();
    expect(data.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(data.error.message).toContain("key2"); // Last key tried
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Bug Regression Tests
//
// Explicit regression tests for each of the 4 bugs found during review.
// These tests verify the exact failure modes so the bugs cannot regress.
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Bug Regression Tests", () => {
  /**
   * Bug #2 Regression: makeRequest must use the key parameter from executeWithFailover,
   * NOT getCurrentKey(). The broken code ignored the key param and always read
   * getCurrentKey(), so all retries used the same key.
   *
   * This test verifies that each retry attempt receives a DIFFERENT key.
   */
  test("Bug #2: each retry receives a different key (not getCurrentKey reused)", async () => {
    const pool = new KeyPool("key-A,key-B,key-C", "Gemini");
    const keysReceived: string[] = [];

    await pool.executeWithFailover(async (key) => {
      keysReceived.push(key);
      // First two keys fail with 429, third succeeds
      if (keysReceived.length < 3) return mockResponse(429);
      return mockResponse(200);
    });

    // Critical: all three keys must be DIFFERENT — the bug caused all to be "key-A"
    expect(keysReceived[0]).toBe("key-A");
    expect(keysReceived[1]).toBe("key-B");
    expect(keysReceived[2]).toBe("key-C");
    expect(new Set(keysReceived).size).toBe(3); // All unique
  });

  /**
   * Bug #2 Variant: Simulates the Gemini handler pattern where auth headers
   * are built from the key. Verifies the key param is actually used in header construction.
   */
  test("Bug #2: simulated Gemini auth header uses correct key per attempt", async () => {
    const pool = new KeyPool("AIza-key1,AIza-key2,AIza-key3", "Gemini");
    const headersBuilt: Array<Record<string, string>> = [];

    await pool.executeWithFailover(async (key) => {
      // Simulates how base-gemini-handler builds headers:
      // The FIX: authHeaders["x-goog-api-key"] = key (from param)
      // The BUG was: authHeaders["x-goog-api-key"] = getCurrentKey() (always first key)
      const authHeaders = {
        "Content-Type": "application/json",
        "x-goog-api-key": key, // Must use the param, not pool.getCurrentKey()
      };
      headersBuilt.push({ ...authHeaders });

      if (headersBuilt.length < 3) return mockResponse(429);
      return mockResponse(200);
    });

    // Each attempt must have used a different API key in the header
    expect(headersBuilt[0]["x-goog-api-key"]).toBe("AIza-key1");
    expect(headersBuilt[1]["x-goog-api-key"]).toBe("AIza-key2");
    expect(headersBuilt[2]["x-goog-api-key"]).toBe("AIza-key3");
  });

  /**
   * Bug #3 Regression: 429 Response objects must trigger rotation natively.
   * The broken code threw an Error on 429 instead of returning the Response,
   * which bypassed executeWithFailover's status-based rotation logic.
   *
   * This test ensures a 429 Response (not a thrown error) triggers key rotation.
   */
  test("Bug #3: 429 Response (not thrown) triggers rotation natively", async () => {
    const pool = new KeyPool("key1,key2", "Gemini");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") {
        // Return a 429 Response - NOT throw an error
        // The bug was: this was caught by a manual check and thrown as Error,
        // bypassing executeWithFailover's native status handling
        return mockResponse(429);
      }
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["key1", "key2"]);
  });

  /**
   * Bug #3 Variant: Ensures that when fetchWithRetry returns a 429 response,
   * executeWithFailover handles it directly — no intermediate throw needed.
   */
  test("Bug #3: all retryable statuses handled without throwing", async () => {
    const retryableStatuses = [401, 402, 403, 408, 429, 500, 502, 503, 504];

    for (const status of retryableStatuses) {
      const pool = new KeyPool("bad-key,good-key", "Test");
      let callCount = 0;

      const response = await pool.executeWithFailover(async (key) => {
        callCount++;
        if (callCount === 1) return mockResponse(status); // Return, don't throw
        return mockResponse(200);
      });

      expect(response.status).toBe(200);
      expect(callCount).toBe(2); // Must have rotated
    }
  });

  /**
   * Bug #4 Regression: Both multi-key and single-key paths must produce
   * identical response handling behavior. The bug was duplicated response
   * logic between the two code paths.
   *
   * This test verifies both modes return responses with the same structure.
   */
  test("Bug #4: single-key and multi-key modes produce consistent response handling", async () => {
    // Single-key mode
    const singlePool = new KeyPool("key1", "Anthropic");
    const singleResp = await singlePool.executeWithFailover(async () => {
      return new Response('{"type":"message","content":"hello"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // Multi-key mode (with successful first key)
    const multiPool = new KeyPool("key1,key2,key3", "Anthropic");
    const multiResp = await multiPool.executeWithFailover(async () => {
      return new Response('{"type":"message","content":"hello"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // Both should have identical response properties
    expect(singleResp.status).toBe(multiResp.status);
    expect(singleResp.headers.get("Content-Type")).toBe(multiResp.headers.get("Content-Type"));

    const singleData = await singleResp.json();
    const multiData = await multiResp.json();
    expect(singleData).toEqual(multiData);
  });

  /**
   * Bug #4 Variant: Error responses are also handled consistently
   * between single-key and multi-key modes.
   */
  test("Bug #4: error responses consistent between single-key and multi-key modes", async () => {
    // Single-key: non-rotatable error
    const singlePool = new KeyPool("key1", "Anthropic");
    const singleResp = await singlePool.executeWithFailover(async () => {
      return new Response('{"error":"bad_request"}', { status: 400 });
    });

    // Multi-key: non-rotatable error (should stop on first key, same as single)
    const multiPool = new KeyPool("key1,key2", "Anthropic");
    const multiResp = await multiPool.executeWithFailover(async () => {
      return new Response('{"error":"bad_request"}', { status: 400 });
    });

    expect(singleResp.status).toBe(multiResp.status);
    const singleData = await singleResp.json();
    const multiData = await multiResp.json();
    expect(singleData).toEqual(multiData);
  });

  /**
   * Bug #5 Regression: Response body drain for intermediate failures.
   * Without draining, unconsumed response bodies can leak memory and
   * hold TCP connections open in Node.js environments.
   */
  test("Bug #5: intermediate response bodies are drained (not leaked)", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const bodiesCreated: Response[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      const resp = new Response(`error-body-${key}`, {
        status: key === "key3" ? 200 : 429,
        statusText: key === "key3" ? "OK" : "Too Many Requests",
      });
      bodiesCreated.push(resp);
      return resp;
    });

    expect(response.status).toBe(200);

    // Intermediate responses (key1, key2) should have had their bodies consumed
    // The first response body should be consumed (drained before key3's attempt)
    expect(bodiesCreated[0].bodyUsed).toBe(true);
    // The second response body should be consumed (drained before success return)
    // Note: key2's response is drained at the start of the key3 iteration
    expect(bodiesCreated[1].bodyUsed).toBe(true);
    // The successful response body should NOT be consumed
    expect(bodiesCreated[2].bodyUsed).toBe(false);
  });

  /**
   * Bug #6 Regression: lastError tracking when network error followed by HTTP error.
   * Previously, a network error on key1 (setting lastError) followed by a 429
   * on key2 would re-throw the network error instead of returning the 429 response.
   * The fix clears lastError when an HTTP response is received.
   */
  test("Bug #6: HTTP response after network error returns response (not stale network error)", async () => {
    const pool = new KeyPool("k1,k2", "Test");

    // k1 throws network error, k2 returns 429
    // Should return the 429 response, NOT throw the network error
    const response = await pool.executeWithFailover(async (key) => {
      if (key === "k1") throw new Error("network down");
      return mockResponse(429);
    });

    expect(response.status).toBe(429);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Provider-Specific Auth Header Patterns
//
// Simulates how each handler type builds auth headers with the key.
// Ensures the key from executeWithFailover is correctly used in each pattern.
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Provider Auth Header Patterns", () => {
  test("Gemini pattern: x-goog-api-key header", async () => {
    const pool = new KeyPool("AIza-key1,AIza-key2", "Gemini");
    const headers: Record<string, string>[] = [];

    await pool.executeWithFailover(async (key) => {
      headers.push({
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      });
      if (headers.length === 1) return mockResponse(429);
      return mockResponse(200);
    });

    expect(headers[0]["x-goog-api-key"]).toBe("AIza-key1");
    expect(headers[1]["x-goog-api-key"]).toBe("AIza-key2");
  });

  test("OpenAI pattern: Authorization Bearer header", async () => {
    const pool = new KeyPool("sk-abc123,sk-def456", "OpenAI");
    const headers: Record<string, string>[] = [];

    await pool.executeWithFailover(async (key) => {
      headers.push({
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      });
      if (headers.length === 1) return mockResponse(500);
      return mockResponse(200);
    });

    expect(headers[0]["Authorization"]).toBe("Bearer sk-abc123");
    expect(headers[1]["Authorization"]).toBe("Bearer sk-def456");
  });

  test("Anthropic pattern: x-api-key header", async () => {
    const pool = new KeyPool("sk-ant-key1,sk-ant-key2", "Anthropic");
    const headers: Record<string, string>[] = [];

    await pool.executeWithFailover(async (key) => {
      headers.push({
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      });
      if (headers.length === 1) return mockResponse(429);
      return mockResponse(200);
    });

    expect(headers[0]["x-api-key"]).toBe("sk-ant-key1");
    expect(headers[1]["x-api-key"]).toBe("sk-ant-key2");
    // Both should have the same version header
    expect(headers[0]["anthropic-version"]).toBe(headers[1]["anthropic-version"]);
  });

  test("OpenRouter pattern: Authorization Bearer with routing headers", async () => {
    const pool = new KeyPool("or-key1,or-key2,or-key3", "OpenRouter");
    const headers: Record<string, string>[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      headers.push({
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://claudish.dev",
        "X-Title": "Claudish Proxy",
      });
      if (headers.length <= 2) return mockResponse(502);
      return mockResponse(200);
    });

    expect(response.status).toBe(200);
    expect(headers).toHaveLength(3);
    expect(headers[0]["Authorization"]).toBe("Bearer or-key1");
    expect(headers[1]["Authorization"]).toBe("Bearer or-key2");
    expect(headers[2]["Authorization"]).toBe("Bearer or-key3");
  });

  test("RemoteProvider base pattern: Authorization Bearer (OllamaCloud/LiteLLM)", async () => {
    const pool = new KeyPool("cloud-key1,cloud-key2", "OllamaCloud");
    const headers: Record<string, string>[] = [];

    await pool.executeWithFailover(async (key) => {
      headers.push({
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      });
      if (headers.length === 1) return mockResponse(503);
      return mockResponse(200);
    });

    expect(headers[0]["Authorization"]).toBe("Bearer cloud-key1");
    expect(headers[1]["Authorization"]).toBe("Bearer cloud-key2");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Concurrent Calls & Large Pools
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Concurrent & Stress Tests", () => {
  test("concurrent executeWithFailover calls distribute across keys", async () => {
    const pool = new KeyPool("key1,key2,key3,key4", "Test");
    const keysUsed: string[] = [];

    // Fire 4 calls concurrently
    const promises = Array.from({ length: 4 }, () =>
      pool.executeWithFailover(async (key) => {
        keysUsed.push(key);
        // Small delay to simulate API call
        await new Promise((r) => setTimeout(r, 10));
        return mockResponse(200);
      })
    );

    const results = await Promise.all(promises);
    results.forEach((r) => expect(r.status).toBe(200));
    // All 4 calls should have completed
    expect(keysUsed.length).toBe(4);
  });

  test("large key pool (10 keys): rotation works correctly", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `key-${i}`);
    const pool = new KeyPool(keys.join(","), "Test");
    expect(pool.keyCount()).toBe(10);

    const keysUsed: string[] = [];

    // Make 15 successful calls — should wrap around
    for (let i = 0; i < 15; i++) {
      await pool.executeWithFailover(async (key) => {
        keysUsed.push(key);
        return mockResponse(200);
      });
    }

    // First 10 should be key-0 through key-9, then wrap to key-0..key-4
    expect(keysUsed.slice(0, 10)).toEqual(keys);
    expect(keysUsed.slice(10)).toEqual(keys.slice(0, 5));
  });

  test("large key pool: all 10 keys fail exhaustively", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `key-${i}`);
    const pool = new KeyPool(keys.join(","), "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(429);
    });

    // Returns the last failed response
    expect(response.status).toBe(429);
    // Must have tried ALL 10 keys before failing
    expect(keysUsed).toEqual(keys);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Error Message Validation
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Error Message Details", () => {
  test("network error message propagated when all keys throw", async () => {
    const pool = new KeyPool("k1,k2", "Test");

    await expect(
      pool.executeWithFailover(async () => {
        throw new Error("ETIMEDOUT: connection timed out");
      })
    ).rejects.toThrow("ETIMEDOUT");
  });

  test("no keys configured error includes provider name", async () => {
    const pool = new KeyPool("", "Gemini");

    await expect(
      pool.executeWithFailover(async () => mockResponse(200))
    ).rejects.toThrow("Gemini");
  });

  test("no keys configured error is descriptive", async () => {
    const pool = new KeyPool("", "OpenAI");

    await expect(
      pool.executeWithFailover(async () => mockResponse(200))
    ).rejects.toThrow("No keys configured");
  });

  test("all-keys-exhausted with HTTP errors returns response (not throw)", async () => {
    const pool = new KeyPool("k1,k2,k3", "Test");

    const response = await pool.executeWithFailover(async () => mockResponse(500));
    expect(response.status).toBe(500);
  });

  test("all-keys-exhausted with network errors throws last error", async () => {
    const pool = new KeyPool("k1,k2", "Test");

    await expect(
      pool.executeWithFailover(async () => {
        throw new Error("Connection refused");
      })
    ).rejects.toThrow("Connection refused");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Edge Cases
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Additional Edge Cases", () => {
  test("two keys: first 429, second 200", async () => {
    const pool = new KeyPool("a,b", "Test");
    const keysUsed: string[] = [];

    const resp = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return key === "a" ? mockResponse(429) : mockResponse(200);
    });

    expect(resp.status).toBe(200);
    expect(keysUsed).toEqual(["a", "b"]);
  });

  test("two keys: first success, second never tried", async () => {
    const pool = new KeyPool("a,b", "Test");
    let callCount = 0;

    await pool.executeWithFailover(async () => {
      callCount++;
      return mockResponse(200);
    });

    expect(callCount).toBe(1);
  });

  test("non-rotatable after rotatable: stops immediately on non-rotatable", async () => {
    const pool = new KeyPool("key1,key2,key3", "Test");
    const keysUsed: string[] = [];

    const resp = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "key1") return mockResponse(429); // rotatable → rotate
      if (key === "key2") return mockResponse(400); // non-rotatable → stop
      return mockResponse(200); // should never reach key3
    });

    expect(resp.status).toBe(400);
    expect(keysUsed).toEqual(["key1", "key2"]); // key3 never tried
  });

  test("status 200 with non-standard success code (201) counts as ok", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    const resp = await pool.executeWithFailover(async () => {
      return new Response("created", { status: 201 });
    });

    expect(resp.status).toBe(201);
  });

  test("status 204 (no content) counts as ok", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    const resp = await pool.executeWithFailover(async () => {
      return new Response(null, { status: 204 });
    });

    expect(resp.status).toBe(204);
  });

  test("mixed: network error then retryable HTTP then success", async () => {
    const pool = new KeyPool("k1,k2,k3", "Test");
    const keysUsed: string[] = [];

    const resp = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "k1") throw new Error("DNS resolution failed");
      if (key === "k2") return mockResponse(502);
      return mockResponse(200, "finally");
    });

    expect(resp.status).toBe(200);
    expect(keysUsed).toEqual(["k1", "k2", "k3"]);
  });

  test("HTTP error after network error: returns HTTP response (not stale throw)", async () => {
    const pool = new KeyPool("k1,k2", "Test");

    // k1 throws network error, k2 returns 429
    // With the fix: lastError is cleared when k2's HTTP response is received,
    // so we return the 429 response instead of throwing the network error
    const response = await pool.executeWithFailover(async (key) => {
      if (key === "k1") throw new Error("network down");
      return mockResponse(429);
    });

    expect(response.status).toBe(429);
  });

  test("network error after HTTP error: throws network error", async () => {
    const pool = new KeyPool("k1,k2", "Test");

    // k1 returns 429 (HTTP error), k2 throws network error
    // Network error is the last failure, so it should be thrown
    await expect(
      pool.executeWithFailover(async (key) => {
        if (key === "k1") return mockResponse(429);
        throw new Error("connection reset");
      })
    ).rejects.toThrow("connection reset");
  });

  test("reset mid-sequence restores original rotation order", async () => {
    const pool = new KeyPool("a,b,c", "Test");

    // Use key a
    await pool.executeWithFailover(async () => mockResponse(200));
    expect(pool.getCurrentKey()).toBe("b");

    // Use key b
    await pool.executeWithFailover(async () => mockResponse(200));
    expect(pool.getCurrentKey()).toBe("c");

    // Reset and verify back to start
    pool.reset();
    expect(pool.getCurrentKey()).toBe("a");

    const keysUsed: string[] = [];
    await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(200);
    });
    expect(keysUsed).toEqual(["a"]);
  });

  test("wrap-around starting from middle of pool", async () => {
    const pool = new KeyPool("a,b,c,d,e", "Test");

    // Advance to key c
    await pool.executeWithFailover(async () => mockResponse(200)); // uses a
    await pool.executeWithFailover(async () => mockResponse(200)); // uses b
    expect(pool.getCurrentKey()).toBe("c");

    // Now all keys fail: should try c→d→e→a→b
    const keysUsed: string[] = [];
    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(429);
    });

    expect(response.status).toBe(429);
    expect(keysUsed).toEqual(["c", "d", "e", "a", "b"]);
  });

  test("single key with network error throws immediately", async () => {
    const pool = new KeyPool("only-key", "Test");

    await expect(
      pool.executeWithFailover(async () => {
        throw new Error("ECONNRESET");
      })
    ).rejects.toThrow("ECONNRESET");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Caller Integration Patterns
//
// Tests that verify the contract between KeyPool and its callers (handlers).
// These simulate how the handler code processes the return value.
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - Caller Integration Patterns", () => {
  test("caller can check response.ok after executeWithFailover returns", async () => {
    const pool = new KeyPool("key1,key2", "Test");

    // All keys return 429 - caller gets back a Response to check
    const response = await pool.executeWithFailover(async () => mockResponse(429));

    // Caller pattern: check response.ok and handle error
    if (!response.ok) {
      const errorText = await response.text();
      expect(response.status).toBe(429);
      // errorText may be empty for drained responses or contain error details
    }
  });

  test("Gemini handler pattern: 429 response uses lastErrorText path", async () => {
    const pool = new KeyPool("key1,key2", "Gemini");

    // Simulate fetchWithRetry returning a 429 response
    const response = await pool.executeWithFailover(async () => {
      return new Response(
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure" }],
          },
        }),
        { status: 429, statusText: "Too Many Requests" }
      );
    });

    // Simulates base-gemini-handler.ts line 774:
    // const errorText = response.status === 429 ? lastErrorText : await response.text();
    // For 429, Gemini handler uses lastErrorText from fetchWithRetry, not response.text()
    expect(response.status).toBe(429);
  });

  test("non-Gemini handler pattern: reads response.text() for error details", async () => {
    const pool = new KeyPool("key1,key2", "OpenAI");

    const response = await pool.executeWithFailover(async () => {
      return new Response('{"error":{"message":"Rate limit exceeded"}}', {
        status: 429,
        statusText: "Too Many Requests",
      });
    });

    expect(response.status).toBe(429);
    // Non-Gemini handlers read response.text() directly
    const errorText = await response.text();
    expect(errorText).toContain("Rate limit exceeded");
  });

  test("OpenAI handler pattern: timeout + key rotation", async () => {
    const pool = new KeyPool("sk-key1,sk-key2", "OpenAI");
    const keysUsed: string[] = [];

    // Simulate the OpenAI handler pattern where each attempt creates its own AbortController
    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        // Simulate API call
        if (key === "sk-key1") {
          clearTimeout(timeoutId);
          return new Response("rate limited", { status: 429 });
        }
        clearTimeout(timeoutId);
        return new Response('{"choices":[]}', { status: 200 });
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["sk-key1", "sk-key2"]);
  });

  test("OpenRouter handler pattern: queue + key rotation", async () => {
    const pool = new KeyPool("or-key1,or-key2,or-key3", "OpenRouter");
    const keysUsed: string[] = [];

    // Simulate OpenRouter's queue.enqueue pattern
    const simulatedQueue = {
      enqueue: async (fn: () => Promise<Response>) => fn(),
    };

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return simulatedQueue.enqueue(async () => {
        if (key === "or-key1") return new Response("", { status: 502 });
        if (key === "or-key2") return new Response("", { status: 503 });
        return new Response('{"choices":[]}', { status: 200 });
      });
    });

    expect(response.status).toBe(200);
    expect(keysUsed).toEqual(["or-key1", "or-key2", "or-key3"]);
  });

  test("AnthropicCompat handler pattern: streaming response after rotation", async () => {
    const pool = new KeyPool("mm-key1,mm-key2", "MiniMax");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "mm-key1") {
        return new Response("rate limited", { status: 429 });
      }
      // Simulate streaming response
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"type\":\"content_block_delta\"}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(keysUsed).toEqual(["mm-key1", "mm-key2"]);
    // Streaming body should still be readable
    const body = await response.text();
    expect(body).toContain("content_block_delta");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// All-Keys-Exhausted: Detailed Behavior
//
// Thorough tests for the all-keys-exhausted code path, which was changed
// from throwing to returning the last failed Response.
// ──────────────────────────────────────────────────────────────────────────────

describe("KeyPool - All-Keys-Exhausted Behavior", () => {
  test("all keys fail with different retryable statuses: returns LAST status", async () => {
    const pool = new KeyPool("k1,k2,k3", "Test");
    const keysUsed: string[] = [];

    const response = await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      if (key === "k1") return mockResponse(429);
      if (key === "k2") return mockResponse(500);
      return mockResponse(503);
    });

    expect(response.status).toBe(503); // Last key's status
    expect(keysUsed).toEqual(["k1", "k2", "k3"]);
  });

  test("response headers preserved when all keys fail", async () => {
    const pool = new KeyPool("k1,k2", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      return new Response("error", {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "Retry-After": "30",
          "X-RateLimit-Remaining": "0",
        },
      });
    });

    expect(response.status).toBe(429);
    expect(response.statusText).toBe("Too Many Requests");
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  test("all keys fail with 500: body readable for error parsing", async () => {
    const pool = new KeyPool("k1,k2", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      return new Response(
        JSON.stringify({ error: `server error from ${key}` }),
        { status: 500 }
      );
    });

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("server error from k2"); // Last key's body
  });

  test("three keys: HTTP→network→HTTP — returns last HTTP response", async () => {
    const pool = new KeyPool("k1,k2,k3", "Test");

    const response = await pool.executeWithFailover(async (key) => {
      if (key === "k1") return mockResponse(429);
      if (key === "k2") throw new Error("DNS failure");
      return mockResponse(502);
    });

    // k1: 429 (sets lastResponse), k2: network error (clears lastResponse, sets lastError),
    // k3: 502 (clears lastError, sets lastResponse) → returns 502 Response
    expect(response.status).toBe(502);
  });

  test("three keys: network→HTTP→network — throws last network error", async () => {
    const pool = new KeyPool("k1,k2,k3", "Test");

    await expect(
      pool.executeWithFailover(async (key) => {
        if (key === "k1") throw new Error("timeout");
        if (key === "k2") return mockResponse(429);
        throw new Error("connection reset");
      })
    ).rejects.toThrow("connection reset");
  });

  test("index wraps correctly across multiple failed calls", async () => {
    const pool = new KeyPool("a,b,c", "Test");

    // First call: all fail → tries a,b,c → index wraps to a
    const keysCall1: string[] = [];
    await pool.executeWithFailover(async (key) => {
      keysCall1.push(key);
      return mockResponse(429);
    });
    expect(keysCall1).toEqual(["a", "b", "c"]);
    expect(pool.getCurrentKey()).toBe("a"); // Wrapped around

    // Second call: all fail again → tries a,b,c again
    const keysCall2: string[] = [];
    await pool.executeWithFailover(async (key) => {
      keysCall2.push(key);
      return mockResponse(429);
    });
    expect(keysCall2).toEqual(["a", "b", "c"]);
  });

  test("failed call followed by successful call starts from correct index", async () => {
    const pool = new KeyPool("a,b,c", "Test");

    // All fail: tries a,b,c → wraps to a
    await pool.executeWithFailover(async () => mockResponse(429));
    expect(pool.getCurrentKey()).toBe("a");

    // Next call succeeds on first try
    const keysUsed: string[] = [];
    await pool.executeWithFailover(async (key) => {
      keysUsed.push(key);
      return mockResponse(200);
    });
    expect(keysUsed).toEqual(["a"]);
    expect(pool.getCurrentKey()).toBe("b"); // Advanced past a
  });
});
