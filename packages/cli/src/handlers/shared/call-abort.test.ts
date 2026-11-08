import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTransport } from "../../providers/transport/types.js";

// Import production modules only in a fresh process: Bun caches homedir(), so
// changing HOME in this process would not isolate config or credential reads.
if (process.env.CLAUDISH_T2_ABORT_CHILD !== "1") {
  test("G1 abort contracts in an isolated HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-t2-abort-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          XDG_CONFIG_HOME: home,
          CLAUDISH_T2_ABORT_CHILD: "1",
        },
        stdout: "inherit",
        stderr: "inherit",
      });
      expect(await child.exited).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const { Hono } = await import("hono");
  const { DefaultAPIFormat } = await import("../../adapters/base-api-format.js");
  const { ComposedHandler } = await import("../composed-handler.js");
  const { FallbackHandler } = await import("../fallback-handler.js");
  const { OpenAIProviderTransport } = await import("../../providers/transport/openai.js");
  const { AnthropicProviderTransport } = await import(
    "../../providers/transport/anthropic-compat.js"
  );
  const { GeminiRequestQueue } = await import("./gemini-queue.js");
  const { OpenRouterRequestQueue } = await import("./openrouter-queue.js");
  const { LocalModelQueue } = await import("./local-queue.js");
  const { CALL_ABORT_SIGNAL_KEY, CALL_ABORTED_HEADER, raceCallAbort, sleepUnlessAborted } =
    await import("./call-context.js");
  const logger = await import("../../logger.js");
  const stats = await import("../../stats.js");

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  async function ticks() {
    for (let i = 0; i < 80; i++) await Promise.resolve();
  }

  // Fake only the timer API used by the queues/retry waits. No real-time sleeps.
  function fakeClock() {
    let now = 2_000_000;
    const pending = new Map<object, { at: number; run: () => void }>();
    spyOn(Date, "now").mockImplementation(() => now);
    spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      delay = 0,
      ...args: unknown[]
    ) => {
      const id = {
        unref() {
          return this;
        },
        ref() {
          return this;
        },
      };
      pending.set(id, { at: now + Number(delay), run: () => fn(...args) });
      return id;
    }) as unknown as typeof setTimeout);
    spyOn(globalThis, "clearTimeout").mockImplementation(((id: object) => {
      pending.delete(id);
    }) as unknown as typeof clearTimeout);
    spyOn(Bun, "sleep").mockImplementation(
      ((delay: number | Date) =>
        new Promise((resolve) => {
          const id = {};
          pending.set(id, {
            at: now + (delay instanceof Date ? delay.getTime() - now : delay),
            run: () => resolve(undefined),
          });
        })) as typeof Bun.sleep
    );
    return {
      async advance(ms: number) {
        const end = now + ms;
        for (let n = 0; n < 1000; n++) {
          await ticks();
          const next = [...pending.entries()]
            .filter(([, t]) => t.at <= end)
            .sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          now = next[1].at;
          pending.delete(next[0]);
          next[1].run();
        }
        now = end;
        await ticks();
      },
      size: () => pending.size,
    };
  }

  // Derived from the recorded inbound request, omitting tools/metadata/system:
  // test-fixtures/code-mode/cc-2.1.304-inbound-system.jsonl. No invented messages.
  const inbound = JSON.parse(
    (
      await Bun.file(
        new URL("../../test-fixtures/code-mode/cc-2.1.304-inbound-system.jsonl", import.meta.url)
      ).text()
    )
      .trim()
      .split("\n")[0]
  ).body;
  const payload = {
    model: inbound.model,
    messages: inbound.messages,
    max_tokens: inbound.max_tokens,
    stream: inbound.stream,
  };

  function appFor(signal: AbortSignal, handle: (c: import("hono").Context) => Promise<Response>) {
    const app = new Hono();
    app.post("/", (c) => {
      c.set(CALL_ABORT_SIGNAL_KEY, signal);
      return handle(c);
    });
    return async () => await app.request("http://t2.invalid/", { method: "POST" });
  }

  function transport(overrides: Partial<ProviderTransport> = {}): ProviderTransport {
    return {
      name: "t2-metered",
      displayName: "T2",
      streamFormat: "openai-sse",
      getEndpoint: () => "http://t2.invalid/v1/chat/completions",
      getHeaders: async () => ({}),
      ...overrides,
    };
  }

  const handlers: InstanceType<typeof ComposedHandler>[] = [];
  function handler(provider: ProviderTransport) {
    const h = new ComposedHandler(provider, "t2-model", "t2-model", 0, {
      adapter: new DefaultAPIFormat("t2-model", "openai-sse"),
      requestRole: "advisor",
      codeMode: "off",
      catalogCachePath: join(process.env.HOME!, "absent-catalog.json"),
    });
    handlers.push(h);
    return h;
  }

  afterEach(async () => {
    for (const h of handlers.splice(0)) await h.shutdown();
    mock.restore();
  });

  describe("G1 — the internal deadline stops upstream work", () => {
    test("already aborted handler starts no auth, queue or fetch", async () => {
      const controller = new AbortController();
      controller.abort();
      const auth = mock(async () => undefined);
      const queue = mock(async (fetchFn: () => Promise<Response>) => fetchFn());
      const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("unexpected network")
      );
      spyOn(stats, "recordStats").mockImplementation(() => {});
      const h = handler(transport({ refreshAuth: auth, enqueueRequest: queue }));
      const response = await appFor(controller.signal, (c) => h.handle(c, payload))();
      expect(response.status).toBe(408);
      expect(response.headers.get(CALL_ABORTED_HEADER)).toBe("1");
      expect(auth).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      await response.text();
    }, 10_000);

    test("abort stops waiting for a shared refresh and owns its late rejection", async () => {
      const controller = new AbortController();
      const refresh = deferred<void>();
      const entered = deferred<void>();
      const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("unexpected network")
      );
      spyOn(stats, "recordStats").mockImplementation(() => {});
      const h = handler(
        transport({
          refreshAuth: () => {
            entered.resolve();
            return refresh.promise;
          },
        })
      );
      let settled = false;
      const work = appFor(controller.signal, (c) => h.handle(c, payload))().then((response) => {
        settled = true;
        return response;
      });
      await entered.promise;
      controller.abort();
      await ticks();
      expect(settled).toBe(true);
      expect((await work).headers.get(CALL_ABORTED_HEADER)).toBe("1");
      refresh.reject(new Error("late shared refresh failure"));
      await ticks();
      expect(fetchSpy).not.toHaveBeenCalled();
    }, 10_000);

    test("a queued closure invoked after abort never reaches injected fetch", async () => {
      const controller = new AbortController();
      const queued = deferred<() => Promise<Response>>();
      const result = deferred<Response>();
      let queuedSignal: AbortSignal | undefined;
      const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("unexpected network")
      );
      spyOn(stats, "recordStats").mockImplementation(() => {});
      const h = handler(
        transport({
          enqueueRequest: (fn, opts) => {
            queuedSignal = opts?.signal;
            queued.resolve(fn);
            return result.promise;
          },
        })
      );
      const work = appFor(controller.signal, (c) => h.handle(c, payload))();
      const queuedFetch = await queued.promise;
      controller.abort();
      expect(queuedSignal?.aborted).toBe(true);
      try {
        await expect(queuedFetch()).rejects.toHaveProperty("name", "AbortError");
      } finally {
        const error = new Error("cancelled queued work");
        error.name = "AbortError";
        result.reject(error);
        await work;
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    }, 10_000);

    for (const name of ["gemini", "openrouter", "local"] as const) {
      test(`${name} queue removes an aborted waiter before its busy slot frees`, async () => {
        const clock = fakeClock();
        const controller = new AbortController();
        const held = deferred<Response>();
        const busy = deferred<void>();
        const queue =
          name === "gemini"
            ? GeminiRequestQueue.getInstance()
            : name === "openrouter"
              ? OpenRouterRequestQueue.getInstance()
              : LocalModelQueue.getInstance();
        const enqueue = (fn: () => Promise<Response>, signal?: AbortSignal) =>
          name === "local"
            ? (queue as ReturnType<typeof LocalModelQueue.getInstance>).enqueue(fn, "t2", 1, signal)
            : (queue as ReturnType<typeof GeminiRequestQueue.getInstance>).enqueue(fn, { signal });
        const first = enqueue(() => {
          busy.resolve();
          return held.promise;
        });
        await clock.advance(60_000);
        await busy.promise;
        let laterFetches = 0;
        const second = enqueue(async () => {
          laterFetches++;
          return new Response(null);
        }, controller.signal);
        const outcome = second.catch((error: Error) => error);
        controller.abort();
        try {
          await ticks();
          expect(await outcome).toHaveProperty("name", "AbortError");
          expect(queue.getStats().queueLength).toBe(0);
        } finally {
          held.resolve(new Response(null));
          await clock.advance(600_000);
          await first;
        }
        expect(laterFetches).toBe(0);
        expect(queue.getStats().queueLength).toBe(0);
      }, 10_000);
    }

    for (const name of ["openai", "anthropic-compat"] as const) {
      test(`${name} retry wait ends at abort without a later fetch`, async () => {
        const clock = fakeClock();
        const controller = new AbortController();
        const provider = {
          name: "t2",
          baseUrl: "http://t2.invalid",
          apiPath: "/messages",
          apiKeyEnvVar: "",
          prefixes: [],
        };
        const p =
          name === "openai"
            ? new OpenAIProviderTransport(provider, "t2", "")
            : new AnthropicProviderTransport(provider, "");
        // Bodyless status/header input, not fabricated provider protocol data.
        const fetchFn = mock(
          async () =>
            new Response(null, {
              status: 429,
              headers: { "retry-after": "60" },
            })
        );
        let settled = false;
        const work = p
          .enqueueRequest(fetchFn, { signal: controller.signal })
          .catch((error: Error) => {
            settled = true;
            return error;
          });
        await ticks();
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(clock.size()).toBeGreaterThan(0);
        controller.abort();
        await ticks();
        try {
          expect(settled).toBe(true);
        } finally {
          await clock.advance(600_000);
        }
        expect(await work).toHaveProperty("name", "AbortError");
        expect(fetchFn).toHaveBeenCalledTimes(1);
      }, 10_000);
    }

    test("sleep and a pending abort race settle without advancing fake time", async () => {
      const clock = fakeClock();
      const controller = new AbortController();
      const pending = deferred<void>();
      let sleepSettled = false;
      let raced: string | undefined;
      const sleep = sleepUnlessAborted(60_000, controller.signal).then(() => {
        sleepSettled = true;
      });
      const race = raceCallAbort(pending.promise, controller.signal).catch((error: Error) => {
        raced = error.name;
      });
      controller.abort();
      await ticks();
      try {
        expect(sleepSettled).toBe(true);
        expect(raced).toBe("AbortError");
      } finally {
        pending.reject(new Error("late unbilled work"));
        await clock.advance(60_000);
        await Promise.all([sleep, race]);
      }
    }, 10_000);

    for (const outcome of ["response", "throw"] as const) {
      test(`routing chain never advances after hop 1 aborts (${outcome})`, async () => {
        const controller = new AbortController();
        const lines: string[] = [];
        spyOn(logger, "logStderr").mockImplementation((line) => {
          lines.push(line);
        });
        const next = mock(async () => new Response(null));
        const original = new Response(null, { status: 503 });
        const chain = new FallbackHandler([
          {
            name: "T2 first",
            handler: {
              async handle() {
                controller.abort();
                if (outcome === "throw") throw new Error("cancelled upstream");
                return original;
              },
              async shutdown() {},
            },
          },
          { name: "T2 next", handler: { handle: next, async shutdown() {} } },
        ]);
        const response = await appFor(controller.signal, (c) => chain.handle(c, payload))();
        expect(next).not.toHaveBeenCalled();
        if (outcome === "response") expect(response.status).toBe(503);
        else expect(response.headers.get(CALL_ABORTED_HEADER)).toBe("1");
        expect(
          lines.filter((line) => line.includes("[Fallback]") && line.includes("failed"))
        ).toEqual([]);
        await chain.shutdown();
      }, 10_000);
    }

    test("already aborted routing chain does not enter even its first hop", async () => {
      const controller = new AbortController();
      controller.abort();
      const first = mock(async () => new Response(null));
      const chain = new FallbackHandler([
        { name: "T2", handler: { handle: first, async shutdown() {} } },
      ]);
      const response = await appFor(controller.signal, (c) => chain.handle(c, payload))();
      expect(response.headers.get(CALL_ABORTED_HEADER)).toBe("1");
      expect(first).not.toHaveBeenCalled();
      await chain.shutdown();
    }, 10_000);
  });
}
