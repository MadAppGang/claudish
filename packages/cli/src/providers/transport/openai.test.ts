import { describe, test, expect } from "bun:test";
import { OpenAIProviderTransport } from "./openai.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";

const mockProvider: RemoteProvider = {
  name: "opencode-zen",
  displayName: "Zen",
  baseUrl: "https://opencode.ai/zen",
  apiPath: "/v1/chat/completions",
  transport: "openai",
};

describe("OpenAIProviderTransport 429 retry (#66)", () => {
  test("retries on 429 with exponential backoff", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(new Response('{"error":"rate limited"}', { status: 429 }));
      }
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    expect(response.status).toBe(200);
    expect(callCount).toBe(3); // 2 retries + 1 success
  }, 15000); // 2s + 4s backoff

  test("respects Retry-After header", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;
    const startTime = Date.now();

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response('{"error":"rate limited"}', {
            status: 429,
            headers: { "Retry-After": "1" },
          })
        );
      }
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    const elapsed = Date.now() - startTime;
    expect(response.status).toBe(200);
    expect(callCount).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900); // ~1s Retry-After
  }, 10000);

  test("returns 429 response after max retries exhausted", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response('{"error":"rate limited"}', { status: 429 }));
    });

    expect(response.status).toBe(429);
    expect(callCount).toBe(6); // 1 initial + 5 retries
  }, 120000);

  test("does not retry non-429 errors", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response('{"error":"bad request"}', { status: 400 }));
    });

    expect(response.status).toBe(400);
    expect(callCount).toBe(1); // No retry
  });
});

describe("OpenAIProviderTransport 429 backoff releases the concurrency slot", () => {
  // The cap exists to bound requests IN FLIGHT to a backend. A backoff sleep has
  // nothing in flight, so a slot held across one is capacity the backend could be
  // serving with. With cap=6 on the GLM lane, six throttled requests held every
  // slot for the full ladder (~62.5s) while the backend sat idle — one burst 429
  // amplified into fleet-wide `Connection lost mid-response` (2026-08-24).
  test("a request in 429 backoff does not block another request to the same provider", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key", 1);
    const order: string[] = [];

    let aCalls = 0;
    const a = transport
      .enqueueRequest(() => {
        aCalls++;
        // Retry-After: 1 → a 1s backoff, long enough for B to overtake.
        if (aCalls === 1) {
          return Promise.resolve(
            new Response('{"error":"rate limited"}', {
              status: 429,
              headers: { "Retry-After": "1" },
            })
          );
        }
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      })
      .then(() => order.push("A"));

    // Let A receive its 429 and enter the backoff before B asks for the slot.
    await new Promise((r) => setTimeout(r, 100));

    const b = transport
      .enqueueRequest(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })))
      .then(() => order.push("B"));

    await Promise.all([a, b]);

    // Before the fix the whole retry unit was one gated item: A held the only
    // slot for its entire ladder and B could not start until A had finished.
    expect(order).toEqual(["B", "A"]);
    expect(aCalls).toBe(2);
  }, 15000);

  test("still caps concurrent fetches at maxConcurrency", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key", 2);
    let inFlight = 0;
    let peak = 0;

    const fire = () =>
      transport.enqueueRequest(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return new Response('{"ok":true}', { status: 200 });
      });

    await Promise.all([fire(), fire(), fire(), fire(), fire()]);

    expect(peak).toBe(2); // gating still applies — only the sleep was moved out
  });

  test("patience is unchanged: exhausted retries still return the last 429", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key", 1);
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(
        new Response('{"error":"rate limited"}', {
          status: 429,
          headers: { "Retry-After": "0" },
        })
      );
    });

    expect(response.status).toBe(429);
    expect(callCount).toBe(6); // 5 retries + the initial attempt, as before
  }, 15000);
});

describe("OpenAIProviderTransport 429 quota-wall short-circuit", () => {
  const WALL = '{"error":{"message":"You have exceeded your plan limit for this period"}}';
  const BURST = '{"error":{"message":"rate limited, slow down"}}';

  test("a quota wall skips the ladder instead of sleeping ~62s against it", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key");
    let callCount = 0;
    const startTime = Date.now();

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response(WALL, { status: 429 }));
    });

    expect(response.status).toBe(429);
    expect(callCount).toBe(1); // no retry at all
    expect(Date.now() - startTime).toBeLessThan(1000); // no 2s first rung
  }, 10000);

  test("the short-circuited response still has a readable body (clone, not consume)", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key");
    const response = await transport.enqueueRequest(() =>
      Promise.resolve(new Response(WALL, { status: 429 }))
    );
    // FallbackHandler / isQuotaExhaustion upstream still need this body.
    expect(await response.text()).toBe(WALL);
  }, 10000);

  test("a BURST still walks the ladder — the property that keeps this safe", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key");
    let callCount = 0;
    const startTime = Date.now();

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(new Response(BURST, { status: 429 }));
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    expect(response.status).toBe(200);
    expect(callCount).toBe(2); // it retried
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(1900); // it slept the 2s rung
  }, 15000);

  test("an unreadable body degrades to the ladder, never to a wrong short-circuit", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount === 1) {
        // Body already consumed → clone().text() throws inside isQuotaWall.
        const r = new Response(WALL, { status: 429 });
        void r.text();
        return Promise.resolve(r);
      }
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    expect(response.status).toBe(200);
    expect(callCount).toBe(2); // fell through to the retry, as before
  }, 15000);
});
