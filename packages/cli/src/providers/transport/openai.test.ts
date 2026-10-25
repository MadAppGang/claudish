import { describe, test, expect, beforeEach } from "bun:test";
import { OpenAIProviderTransport, resetTokenizerMemoForTests } from "./openai.js";
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

describe("OpenAIProviderTransport busy bound applies to the first admission only (#431 CR S1)", () => {
  test("a 429-retry admission is unbounded — the bound never rides the ladder", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key", 1);

    let bCalls = 0;
    const b = transport
      .enqueueRequest(() => {
        bCalls++;
        if (bCalls === 1) {
          // While B backs off (Retry-After: 0), A takes the only slot and
          // holds it ~400 ms — B's RETRY admission finds the limiter full.
          void transport
            .enqueueRequest(
              () =>
                new Promise<Response>((resolve) => {
                  setTimeout(() => resolve(new Response('{"ok":true}', { status: 200 })), 400);
                })
            )
            .then(() => {});
          return Promise.resolve(
            new Response('{"error":"rate limited"}', {
              status: 429,
              headers: { "Retry-After": "0" },
            })
          );
        }
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      }, { busyWaitMs: 100 })
      .then((r) => r.status);

    // Pre-fix, the retry's gate call re-applied the 100 ms bound and rejected
    // with StepBusyError — a skip-shaped failure for a request the backend had
    // already 429'd. Post-fix the retry admits unbounded and waits out A's
    // lease (the pre-#431 behavior of every unbounded caller).
    await expect(b).resolves.toBe(200);
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

  test("a body that never ARRIVES also degrades to the ladder — it must not hang", async () => {
    // Regression, 2026-08-25. The short-circuit reads the 429 body; the ladder
    // never touched it before. Nothing else bounds that read on this path:
    // OpenAIProviderTransport implements no getRequestInit, so its fetch carries
    // no AbortSignal (only local.ts and vertex-oauth.ts attach one). Against a
    // Response over a never-closing stream, clone().text() awaited forever and
    // enqueueRequest never returned — a hung turn for whatever agent made the
    // request. The read now has its own 2s deadline and falls through here.
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key");
    let callCount = 0;
    const startTime = Date.now();

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount === 1) {
        const neverEnds = new ReadableStream({ start() { /* no enqueue, no close */ } });
        return Promise.resolve(new Response(neverEnds, { status: 429 }));
      }
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    expect(response.status).toBe(200);
    expect(callCount).toBe(2); // it retried instead of waiting on the body
    expect(Date.now() - startTime).toBeLessThan(10000); // bounded, not forever
  }, 20000);

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

// A burst that never clears walks the WHOLE ladder and then returns the last 429.
// That exit had no log line of any kind: the per-retry lines are debug-level and
// never reach stdout, so ~62s of sleeping left no trace anywhere. Diagnosing one
// cost a timing-correlation study across 28.5h of traffic (2026-08-25).
//
// `Retry-After: 0.01` collapses each rung to 10ms, so the full ladder runs in
// milliseconds instead of 62s — otherwise this path is untestable in a suite.
describe("OpenAIProviderTransport 429 ladder exhaustion", () => {
  test("walks every rung, then returns the last 429 rather than throwing", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(
        // No quota/plan wording: a burst, so the short-circuit must NOT fire and
        // the ladder must run in full.
        new Response('{"error":"rate limit: 10 requests per minute"}', {
          status: 429,
          headers: { "Retry-After": "0.01" },
        })
      );
    });

    expect(callCount).toBe(6); // maxRetries=5 → 6 attempts
    expect(response.status).toBe(429); // the last response, not an exception
  }, 15000);

  // The exhaustion line sits just before `return response`, which is ALSO the
  // success path — so it needs a status guard, and that guard needs a test.
  // (The first version of this fix put the line after the loop instead, where
  // it was dead code and never fired at all; the test above caught that.)
  test("a request that succeeds after a retry logs no exhaustion line", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "glm-5.2", "test-key");
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      let callCount = 0;
      const response = await transport.enqueueRequest(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response('{"error":"rate limit: 10 requests per minute"}', {
              status: 429,
              headers: { "Retry-After": "0.01" },
            })
          );
        }
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      });
      expect(response.status).toBe(200);
      expect(callCount).toBe(2);
    } finally {
      console.log = realLog;
    }
    expect(lines.filter((l) => l.includes("ladder exhausted"))).toEqual([]);
  }, 15000);
});

describe("OpenAIProviderTransport.countPromptTokens (#674)", () => {
  // Measured 25/10 on the shipping vLLM, from inside the hub container:
  // POST {root}/tokenize → 200 {count, max_model_len}; `{model, messages}` is
  // the only usable shape (12 tokens for `hello world` against 2 for a raw
  // prompt — the chat template is applied server-side), and /v1/tokenize is a
  // 404. Those three facts are what these pins hold.
  // Derived from the file's own mockProvider (same RemoteProvider shape, same
  // typing convention) so this pin adds no typecheck error of its own.
  const vllm = {
    ...mockProvider,
    name: "vllm-myia",
    baseUrl: "https://engine.test/v1",
    apiPath: "/chat/completions",
  };

  beforeEach(() => resetTokenizerMemoForTests());

  function stub(impl: (url: string, init: any) => Promise<Response>) {
    const original = globalThis.fetch;
    const seen: Array<{ url: string; init: any }> = [];
    (globalThis as any).fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      seen.push({ url, init });
      return impl(url, init);
    }) as typeof fetch;
    return {
      seen,
      restore: () => {
        (globalThis as any).fetch = original;
      },
    };
  }

  test("posts {model, messages} to the ROOT /tokenize — never /v1/tokenize", async () => {
    const s = stub(async () =>
      new Response(JSON.stringify({ count: 12, max_model_len: 262_144 }), { status: 200 })
    );
    try {
      const transport = new OpenAIProviderTransport(vllm, "swift-1.5-27b", "k");
      const result = await transport.countPromptTokens([{ role: "user", content: "hello world" }]);

      expect(s.seen.length).toBe(1);
      expect(s.seen[0].url).toBe("https://engine.test/tokenize"); // /v1 stripped, root path
      expect(JSON.parse(s.seen[0].init.body)).toEqual({
        model: "swift-1.5-27b",
        messages: [{ role: "user", content: "hello world" }],
      });
      expect(s.seen[0].init.signal).toBeTruthy(); // bounded: a black-holed endpoint must not hold the turn
      expect(result).toEqual({ exact: 12, maxModelLen: 262_144 });
    } finally {
      s.restore();
    }
  });

  test("a 404 turns the endpoint off for the PROCESS: the second call fetches nothing", async () => {
    const s = stub(async () => new Response("not found", { status: 404 }));
    try {
      const first = new OpenAIProviderTransport(vllm, "swift-1.5-27b", "k");
      expect(await first.countPromptTokens([{ role: "user", content: "hi" }])).toBeNull();
      // A DIFFERENT transport instance — the proxy rebuilds them, so the memo
      // has to be process-wide or the 404 is paid again on every recreate.
      const second = new OpenAIProviderTransport(vllm, "swift-1.5-27b", "k");
      expect(await second.countPromptTokens([{ role: "user", content: "hi" }])).toBeNull();

      expect(s.seen.length).toBe(1);
    } finally {
      s.restore();
    }
  });

  test("never throws: a rejected fetch resolves to null", async () => {
    const s = stub(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    try {
      const transport = new OpenAIProviderTransport(vllm, "swift-1.5-27b", "k");
      expect(await transport.countPromptTokens([{ role: "user", content: "hi" }])).toBeNull();
    } finally {
      s.restore();
    }
  });

  test("an unreadable count is null, never a guess — and an absent max_model_len is fine", async () => {
    const s = stub(async () => new Response(JSON.stringify({ count: "many" }), { status: 200 }));
    try {
      const transport = new OpenAIProviderTransport(vllm, "swift-1.5-27b", "k");
      expect(await transport.countPromptTokens([{ role: "user", content: "hi" }])).toBeNull();
    } finally {
      s.restore();
    }

    const ok = stub(async () => new Response(JSON.stringify({ count: 7 }), { status: 200 }));
    try {
      resetTokenizerMemoForTests();
      const transport = new OpenAIProviderTransport(vllm, "swift-1.5-27b", "k");
      expect(await transport.countPromptTokens([{ role: "user", content: "hi" }])).toEqual({
        exact: 7,
        maxModelLen: undefined,
      });
    } finally {
      ok.restore();
    }
  });

  test("empty or non-array messages fetch nothing at all", async () => {
    const s = stub(async () => new Response(JSON.stringify({ count: 1 }), { status: 200 }));
    try {
      const transport = new OpenAIProviderTransport(vllm, "swift-1.5-27b", "k");
      expect(await transport.countPromptTokens([])).toBeNull();
      expect(await transport.countPromptTokens(null as any)).toBeNull();
      expect(s.seen.length).toBe(0);
    } finally {
      s.restore();
    }
  });
});
