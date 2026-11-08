import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import type { StatsEvent } from "../../../stats.js";

if (process.env.CLAUDISH_T2_CANCEL_CHILD !== "1") {
  test("G2–G4 client-cancel contracts in an isolated HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-t2-cancel-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          XDG_CONFIG_HOME: home,
          CLAUDISH_T2_CANCEL_CHILD: "1",
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
  const { DefaultAPIFormat } = await import("../../../adapters/base-api-format.js");
  const logger = await import("../../../logger.js");
  const { acquireSigningLease, redactSigningValues } = await import("../../../redact.js");
  const { releaseWhenBodyEnds } = await import("../call-context.js");
  const { cancelEndsUpstreamWork, notifyOnDownstreamCancel } = await import("./upstream-cancel.js");
  const { createStreamingResponseHandler } = await import("./openai-sse.js");
  const { createGeminiSseStream } = await import("./gemini-sse.js");
  const { createAnthropicPassthroughStream } = await import("./anthropic-sse.js");
  const { createDevinConnectStream } = await import("./devin-connect.js");
  const { createOllamaJsonlStream } = await import("./ollama-jsonl.js");
  const { ComposedHandler } = await import("../../composed-handler.js");
  const stats = await import("../../../stats.js");

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  }

  async function ticks() {
    for (let i = 0; i < 80; i++) await Promise.resolve();
  }

  const encoder = new TextEncoder();
  const dataUrl = (name: string) =>
    new URL(`../../../test-fixtures/sse-responses/${name}`, import.meta.url);
  const grok = await Bun.file(dataUrl("grok-4.6-openai-advisor-turn1.sse")).text();
  const gemini = await Bun.file(dataUrl("gemini-3.6-flash-antigravity-ok-answer.sse")).text();
  const anthropic = await Bun.file(
    dataUrl("minimax-m3-anthropic-implicit-signature-r10324.sse")
  ).text();
  const frames = (s: string) => s.match(/[\s\S]*?(?:\r?\n){2}/g) ?? [];

  // All delivered frames are byte-for-byte slices of the named captures. Drop
  // later frames, not fields, to model a client leaving before provider usage.
  const openaiPrefix = frames(grok).slice(0, 12).join("");
  const anthropicPrefix = frames(anthropic)
    .filter((frame) => /event: content_block_(?:start|delta)/.test(frame))
    .slice(0, 4)
    .join("");
  const usageFrame = frames(grok).find((frame) => /"usage":\{/.test(frame))!;
  const geminiFrame = frames(gemini)[0];
  const anthropicUsage = frames(anthropic).find((frame) => /event: message_delta/.test(frame))!;

  function upstream(prefix = "", teardown?: Promise<void>) {
    const waiting = deferred<void>();
    const events: string[] = [];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          if (prefix) c.enqueue(encoder.encode(prefix));
        },
        pull() {
          waiting.resolve();
        },
        async cancel() {
          events.push("upstream-cancel");
          await teardown;
          events.push("upstream-settled");
        },
      })
    );
    return { response, waiting, events };
  }

  interface Hooks {
    tokens: (input: number, output: number) => void;
    /**
     * The raw tier's `providerStreamEnd`: the one end-of-turn hook left at the
     * parser level. The closed `responseEnd` runs at the response seam above
     * every parser, and only on a `message_stop` (hooks/seam-tap.ts).
     */
    streamEnd: () => void;
  }
  /** A raw-tier tap that commits every chunk unchanged and records its stream end. */
  const rawTap = (h: Hooks) => ({
    chunk: <T>(chunk: T): T => chunk,
    streamEnd: async () => {
      h.streamEnd();
    },
  });
  type Factory = (c: Context, response: Response, hooks: Hooks) => Response;
  const factories: Record<string, Factory> = {
    "openai-sse": (c, r, h) =>
      createStreamingResponseHandler(
        c,
        r,
        new DefaultAPIFormat("t2"),
        "t2",
        rawTap(h),
        h.tokens,
        undefined,
        undefined,
        undefined,
        {}
      ),
    "gemini-sse": (c, r, h) =>
      createGeminiSseStream(c, r, {
        modelName: "t2",
        unwrapResponse: true,
        raw: rawTap(h),
        onTokenUpdate: h.tokens,
      }),
    // No raw tap on these wires: the parser has no end-of-turn hook at all.
    "anthropic-sse": (c, r, h) =>
      createAnthropicPassthroughStream(c, r, {
        modelName: "t2",
        onTokenUpdate: h.tokens,
      }),
    "devin-connect": (c, r, h) =>
      createDevinConnectStream(c, r, {
        modelName: "t2",
        onTokenUpdate: h.tokens,
      }),
    "ollama-jsonl": (c, r, h) =>
      createOllamaJsonlStream(c, r, { modelName: "t2", onTokenUpdate: h.tokens }),
  };

  function hooks(): Hooks {
    return {
      tokens: mock(() => {}),
      streamEnd: mock(() => {}),
    };
  }

  /** Read the downstream body until `pattern` appears in what was delivered. */
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    pattern: RegExp
  ): Promise<string> {
    const decoder = new TextDecoder();
    let seen = "";
    while (!pattern.test(seen)) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    return seen;
  }

  function captureLogs() {
    const lines: string[] = [];
    spyOn(logger, "log").mockImplementation((line) => {
      lines.push(line);
    });
    return lines;
  }

  async function parse(factory: Factory, response: Response, h: Hooks) {
    const app = new Hono();
    app.get("/", (c) => factory(c, response, h));
    return app.request("http://t2.invalid/");
  }

  afterEach(() => {
    mock.restore();
  });

  describe("G2 — cancellation is not silent truncation", () => {
    for (const name of Object.keys(factories)) {
      test(`${name}: cancel before usage records no estimate or turn-end hook`, async () => {
        const lines = captureLogs();
        const h = hooks();
        // Gemini's available capture includes usage in its FIRST frame; cancel
        // before it. No Devin/Ollama streaming capture exists in test-fixtures,
        // so those two cases deliberately exercise the pre-first-byte path.
        const prefix =
          name === "openai-sse" ? openaiPrefix : name === "anthropic-sse" ? anthropicPrefix : "";
        const source = upstream(prefix);
        const response = await parse(factories[name], source.response, h);
        const reader = response.body!.getReader();
        try {
          // The prefix's content reached the client before it left.
          const seen = prefix ? await readUntil(reader, /content_block_delta/) : "";
          await source.waiting.promise;
          await ticks();
          if (prefix) expect(seen).toMatch(/content_block_delta/);
        } finally {
          await reader.cancel("client left");
        }
        expect(source.events).toEqual(["upstream-cancel", "upstream-settled"]);
        expect(h.tokens).not.toHaveBeenCalled();
        expect(h.streamEnd).not.toHaveBeenCalled();
        expect(
          lines.filter((line) =>
            /Stream ending error|silent-truncation|ending.*failure/i.test(line)
          )
        ).toEqual([]);
        expect(lines.filter((line) => line.includes("Client cancelled the stream"))).toHaveLength(
          1
        );
      }, 10_000);
    }

    for (const [name, frame] of [
      ["openai-sse", usageFrame],
      ["gemini-sse", geminiFrame],
      ["anthropic-sse", anthropicUsage],
    ] as const) {
      test(`${name}: cancel preserves provider-sent usage without a turn-end hook`, async () => {
        const lines = captureLogs();
        const h = hooks();
        const source = upstream(frame);
        const response = await parse(factories[name], source.response, h);
        await source.waiting.promise;
        await ticks();
        await response.body!.cancel("client left");
        expect(h.tokens).toHaveBeenCalledTimes(1);
        expect(h.streamEnd).not.toHaveBeenCalled();
        expect(lines.filter((line) => line.includes("Stream ending error"))).toEqual([]);
        expect(lines.filter((line) => line.includes("Client cancelled the stream"))).toHaveLength(
          1
        );
      }, 10_000);
    }
  });

  describe("G3 — a cancel retains its signing lease until work settles", () => {
    test("outstanding parser read cannot release during delayed upstream cancellation", async () => {
      const teardown = deferred<void>();
      const source = upstream(openaiPrefix, teardown.promise);
      const lease = acquireSigningLease();
      const token = "OPAQUE_TEST_TOKEN_T2_parser";
      lease.add([token]);
      const release = mock(() => {
        source.events.push("released");
        lease.release();
      });
      const parsed = await parse(factories["openai-sse"], source.response, hooks());
      const response = releaseWhenBodyEnds(parsed, release);
      const reader = response.body!.getReader();
      const consuming = (async () => {
        while (!(await reader.read()).done) {
          /* drain to the pending read */
        }
      })();
      await source.waiting.promise;
      await ticks();
      const cancelled = reader.cancel("client left");
      await ticks();
      try {
        expect(source.events).toEqual(["upstream-cancel"]);
        expect(release).not.toHaveBeenCalled();
        expect(redactSigningValues(token)).toBe("[redacted]");
      } finally {
        teardown.resolve();
        await cancelled;
        await consuming;
        lease.release();
      }
      expect(source.events).toEqual(["upstream-cancel", "upstream-settled", "released"]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(redactSigningValues(token)).toBe(token);
    }, 10_000);

    test("cancel awaits the parser task's delayed teardown, not only reader.cancel", async () => {
      const teardown = deferred<void>();
      const source = upstream();
      const reader = source.response.body!.getReader();
      const lease = acquireSigningLease();
      const token = "OPAQUE_TEST_TOKEN_T2_task";
      lease.add([token]);
      const events: string[] = [];
      const parsed = new Response(
        new ReadableStream<Uint8Array>(
          cancelEndsUpstreamWork(
            { reader },
            {
              async start() {
                await reader.read();
                await teardown.promise;
                events.push(`teardown:${redactSigningValues(token)}`);
              },
            }
          )
        )
      );
      const release = mock(() => {
        events.push("released");
        lease.release();
      });
      const wrapped = releaseWhenBodyEnds(parsed, release);
      const downstream = wrapped.body!.getReader();
      const pendingRead = downstream.read();
      await source.waiting.promise;
      const cancel = downstream.cancel();
      await ticks();
      try {
        expect(source.events).toEqual(["upstream-cancel", "upstream-settled"]);
        expect(release).not.toHaveBeenCalled();
        expect(redactSigningValues(token)).toBe("[redacted]");
      } finally {
        teardown.resolve();
        await cancel;
        await pendingRead;
        lease.release();
      }
      expect(events).toEqual(["teardown:[redacted]", "released"]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(redactSigningValues(token)).toBe(token);
    }, 10_000);
  });

  describe("G4 — cancellation stats", () => {
    test("downstream cancel callback precedes the source's cancel", async () => {
      const events: string[] = [];
      const response = notifyOnDownstreamCancel(
        new Response(
          new ReadableStream({
            cancel() {
              events.push("source");
            },
          })
        ),
        () => {
          events.push("callback");
        }
      );
      await response.body!.cancel();
      expect(events).toEqual(["callback", "source"]);
    }, 10_000);

    for (const withUsage of [false, true]) {
      test(`ComposedHandler cancel ${withUsage ? "with" : "without"} provider usage`, async () => {
        const events: Partial<StatsEvent>[] = [];
        spyOn(stats, "recordStats").mockImplementation((event) => {
          events.push(event);
        });
        const source = upstream(withUsage ? usageFrame : openaiPrefix);
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
          (async () => source.response) as unknown as typeof fetch
        );
        const handler = new ComposedHandler(
          {
            name: "t2-metered",
            displayName: "T2",
            streamFormat: "openai-sse",
            getEndpoint: () => "http://t2.invalid/chat/completions",
            getHeaders: async () => ({}),
          },
          "t2-model",
          "t2-model",
          0,
          {
            adapter: new DefaultAPIFormat("t2-model", "openai-sse"),
            requestRole: "advisor",
            codeMode: "off",
            catalogCachePath: join(process.env.HOME!, "absent-catalog.json"),
          }
        );
        // Derived from the recorded Claude Code request: retain actual messages
        // and limit, omit tool/system/metadata fields unrelated to cancellation.
        const inbound = JSON.parse(
          (
            await Bun.file(
              new URL(
                "../../../test-fixtures/code-mode/cc-2.1.304-inbound-system.jsonl",
                import.meta.url
              )
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
        const app = new Hono();
        app.post("/", (c) => handler.handle(c, payload));
        try {
          const response = await app.request("http://t2.invalid/", { method: "POST" });
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          await source.waiting.promise;
          await ticks();
          await response.body!.cancel("client left");
          if (withUsage) {
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
              success: false,
              error_class: "cancelled",
              error_code: "client_cancelled",
              request_role: "advisor",
            });
            const captured = JSON.parse(usageFrame.split("data: ")[1]);
            expect(events[0].input_tokens).toBe(captured.usage.prompt_tokens);
          } else {
            expect(events).toEqual([]);
            expect(handler.getTokenTracker().getTotalCost()).toBe(0);
          }
        } finally {
          await handler.shutdown();
        }
      }, 10_000);
    }
  });
}
