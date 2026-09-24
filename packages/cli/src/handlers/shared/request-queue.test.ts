/**
 * Tests for the shared RequestQueue base and the three provider queues built on
 * it (Gemini, OpenRouter, Local).
 *
 * The base mechanics (FIFO, concurrency, retry, pacing, backlog cap) are tested
 * through a small TestQueue subclass with fresh instances; the provider queues
 * are singletons, so each is exercised once for its distinctive policy.
 *
 * Run: bun test packages/cli/src/handlers/shared/request-queue.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { GeminiRequestQueue } from "./gemini-queue.js";
import { LocalModelQueue } from "./local-queue.js";
import { OpenRouterRequestQueue } from "./openrouter-queue.js";
import { RequestQueue } from "./request-queue.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Concrete queue exposing the hooks so base mechanics can be driven from a test. */
class TestQueue extends RequestQueue {
  delayValue = 0;
  retryPredicate: ((response: Response, attempt: number) => boolean) | null = null;
  onResponseThrow = false;
  retryWaitMs = 1;

  run(fetchFn: () => Promise<Response>, meta?: string, signal?: AbortSignal): Promise<Response> {
    return this.enqueueInternal(fetchFn, meta, signal);
  }

  protected override calculateDelay(): number {
    return this.delayValue;
  }
  protected override shouldRetry(response: Response, attempt: number): boolean {
    return this.retryPredicate ? this.retryPredicate(response, attempt) : false;
  }
  protected override retryDelayMs(): number {
    return this.retryWaitMs;
  }
  protected override onResponse(): void {
    if (this.onResponseThrow) throw new Error("boom");
  }
}

describe("RequestQueue — base mechanics", () => {
  test("resolves a request's response", async () => {
    const q = new TestQueue({ name: "Test" });
    const res = await q.run(async () => new Response("ok", { status: 200 }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("serial (maxParallel 1) runs one request at a time, in FIFO order", async () => {
    const q = new TestQueue({ name: "Test", maxParallel: 1 });
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const make = (id: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(15);
      active--;
      order.push(id);
      return new Response(String(id));
    };
    await Promise.all([q.run(make(1)), q.run(make(2)), q.run(make(3))]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  test("concurrency (maxParallel 3) runs up to the limit at once", async () => {
    const q = new TestQueue({ name: "Test", maxParallel: 3 });
    let active = 0;
    let maxActive = 0;
    const make = () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(25);
      active--;
      return new Response("ok");
    };
    await Promise.all(Array.from({ length: 6 }, () => q.run(make())));
    expect(maxActive).toBe(3);
  });

  test("throws when the backlog cap is exceeded", async () => {
    // maxParallel 1 keeps one active; maxQueueSize 1 leaves room for one queued.
    const q = new TestQueue({ name: "Test", maxParallel: 1, maxQueueSize: 1 });
    const gate = q.run(async () => {
      await sleep(30);
      return new Response("ok");
    });
    const queued = q.run(async () => new Response("queued")); // fills the single backlog slot
    expect(() => q.run(async () => new Response("overflow"))).toThrow(/queue full/i);
    await Promise.all([gate, queued]);
  });

  test("retries in place until shouldRetry returns false", async () => {
    const q = new TestQueue({ name: "Test" });
    q.retryPredicate = (_r, attempt) => attempt < 2; // retry twice
    let calls = 0;
    const res = await q.run(async () => {
      calls++;
      return new Response(String(calls), { status: calls < 3 ? 500 : 200 });
    });
    expect(calls).toBe(3);
    expect(res.status).toBe(200);
  });

  test("a throwing onResponse rejects the request", async () => {
    const q = new TestQueue({ name: "Test" });
    q.onResponseThrow = true;
    await expect(q.run(async () => new Response("ok"))).rejects.toThrow("boom");
  });

  test("a thrown fetch rejects the request", async () => {
    const q = new TestQueue({ name: "Test" });
    await expect(
      q.run(async () => {
        throw new Error("network down");
      })
    ).rejects.toThrow("network down");
  });

  test("calculateDelay paces successive requests", async () => {
    const q = new TestQueue({ name: "Test", maxParallel: 1 });
    q.delayValue = 40;
    const starts: number[] = [];
    const make = () => async () => {
      starts.push(Date.now());
      return new Response("ok");
    };
    await Promise.all([q.run(make()), q.run(make())]);
    // First runs immediately (lastRequestTime is 0); the second waits ~delayValue.
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30);
  });

  test("a signal that already aborted is refused before its fetch runs", () => {
    const q = new TestQueue({ name: "Test" });
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const enqueue = () =>
      q.run(
        async () => {
          calls++;
          return new Response("ok");
        },
        undefined,
        controller.signal
      );
    expect(enqueue).toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(calls).toBe(0);
  });

  test("aborting a queued request takes it out, and its fetch never runs", async () => {
    const q = new TestQueue({ name: "Test", maxParallel: 1 });
    const ran: string[] = [];
    const gate = q.run(async () => {
      await sleep(30);
      ran.push("gate");
      return new Response("gate");
    });
    const controller = new AbortController();
    const aborted = q.run(
      async () => {
        ran.push("aborted");
        return new Response("aborted");
      },
      undefined,
      controller.signal
    );
    const behind = q.run(async () => {
      ran.push("behind");
      return new Response("behind");
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([gate, behind]);
    expect(ran).toEqual(["gate", "behind"]);
  });

  test("a signal that aborts after admission leaves the request to its fetch", async () => {
    const q = new TestQueue({ name: "Test", maxParallel: 1 });
    const controller = new AbortController();
    const running = q.run(
      async () => {
        await sleep(20);
        return new Response("finished");
      },
      undefined,
      controller.signal
    );
    await sleep(5);
    controller.abort();
    const res = await running;
    expect(await res.text()).toBe("finished");
  });
});

describe("GeminiRequestQueue", () => {
  test("a 429 raises the delay and the consecutive-error count", async () => {
    const q = GeminiRequestQueue.getInstance();
    const before = q.getStats();
    const res = await q.enqueue(
      async () =>
        new Response(JSON.stringify({ error: { details: [{ quotaResetDelay: "3s" }] } }), {
          status: 429,
        })
    );
    const after = q.getStats();
    expect(res.status).toBe(429);
    expect(after.consecutiveErrors).toBe(before.consecutiveErrors + 1);
    expect(after.currentDelayMs).toBeGreaterThanOrEqual(before.currentDelayMs);
  });
});

describe("OpenRouterRequestQueue", () => {
  test("parses rate-limit headers off a successful response", async () => {
    const q = OpenRouterRequestQueue.getInstance();
    const res = await q.enqueue(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "X-RateLimit-Limit-Requests": "100",
            "X-RateLimit-Remaining-Requests": "42",
          },
        })
    );
    expect(res.status).toBe(200);
    expect(q.getStats().remainingRequests).toBe(42);
  });
});

describe("LocalModelQueue", () => {
  afterEach(() => {
    delete process.env.CLAUDISH_LOCAL_QUEUE_ENABLED;
  });

  test("isEnabled honours the env toggle", () => {
    expect(LocalModelQueue.isEnabled()).toBe(true);
    process.env.CLAUDISH_LOCAL_QUEUE_ENABLED = "false";
    expect(LocalModelQueue.isEnabled()).toBe(false);
    process.env.CLAUDISH_LOCAL_QUEUE_ENABLED = "0";
    expect(LocalModelQueue.isEnabled()).toBe(false);
  });

  test("concurrency 0 bypasses the queue and runs directly", async () => {
    let calls = 0;
    const res = await LocalModelQueue.getInstance().enqueue(
      async () => {
        calls++;
        return new Response("direct");
      },
      "ollama",
      0
    );
    expect(calls).toBe(1);
    expect(await res.text()).toBe("direct");
  });

  test("an aborted signal is refused on the bypass path too", () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const enqueue = () =>
      LocalModelQueue.getInstance().enqueue(
        async () => {
          calls++;
          return new Response("direct");
        },
        "ollama",
        0,
        controller.signal
      );
    expect(enqueue).toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(calls).toBe(0);
  });

  test("retries once on GPU OOM, then resolves the recovered response", async () => {
    let calls = 0;
    const res = await LocalModelQueue.getInstance().enqueue(async () => {
      calls++;
      return calls === 1
        ? new Response("CUDA out of memory", { status: 500 })
        : new Response("recovered", { status: 200 });
    }, "ollama");
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("recovered");
  });
});
