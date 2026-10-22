import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME must be set before imports: Bun caches homedir() at process startup.
if (process.env.CLAUDISH_W2_TEST_CHILD !== import.meta.path) {
  test("W2: isolated HOME child", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-w2-"));
    try {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_W2_TEST_CHILD: import.meta.path,
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
        },
        timeout: 18_000,
      });
      const output =
        new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
      console.info(output);
      expect(child.exitCode, output).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const check = (name: string, run: () => unknown) =>
    test(name, async () => {
      await run();
    }, 10_000);

  const { afterEach } = await import("bun:test");
  const { readFileSync } = await import("node:fs");
  const { Hono } = await import("hono");
  const { decideHopFailure } = await import("./hop-decision.js");
  const { FallbackHandler } = await import("../fallback-handler.js");
  const { probeLink } = await import("../../providers/probe-live.js");
  const { preflightModel } = await import("../../providers/preflight-chain.js");
  const { setConfigFileOverride } = await import("../../profile-config.js");
  setConfigFileOverride(join(process.env.HOME!, "config.json"));
  const originalFetch = globalThis.fetch;
  const blockedFetch = Object.assign(async () => {
    throw new Error("W2 forbids upstream network");
  }, originalFetch);
  globalThis.fetch = blockedFetch;
  afterEach(() => {
    globalThis.fetch = blockedFetch;
  });

  type Case = {
    name: string;
    status: number;
    headers?: Record<string, string>;
    provider: string;
    action: "advance" | "stop";
    reason: import("./hop-decision.js").HopFailureReason;
    thrown?: boolean;
  };
  const cases: Case[] = [
    {
      name: "connection fault",
      status: 400,
      headers: { "x-claudish-connection-error": "1" },
      provider: "kimi-coding",
      action: "stop",
      reason: "non-retryable",
    },
    {
      name: "stream failure",
      status: 400,
      headers: { "x-claudish-stream-failure": "1" },
      provider: "kimi-coding",
      action: "stop",
      reason: "stream-failure",
    },
    {
      name: "recovery hold",
      status: 503,
      headers: { "x-claudish-recovery": "1" },
      provider: "kimi-coding",
      action: "stop",
      reason: "recovery-hold",
    },
    {
      name: "metered credential rejection",
      status: 400,
      headers: { "x-claudish-auth-verdict": "terminal" },
      provider: "openai",
      action: "stop",
      reason: "credential-hold",
    },
    {
      name: "subscription credential rejection",
      status: 400,
      headers: { "x-claudish-auth-verdict": "terminal" },
      provider: "kimi-coding",
      action: "advance",
      reason: "subscription-credential-rejected",
    },
    { name: "404", status: 404, provider: "openai", action: "advance", reason: "retryable" },
    { name: "plain 500", status: 500, provider: "openai", action: "stop", reason: "non-retryable" },
    {
      name: "thrown hop / marked 500",
      status: 500,
      headers: { "x-claudish-unhandled-error": "1" },
      provider: "openai",
      action: "advance",
      reason: "thrown",
      thrown: true,
    },
  ];

  for (const item of cases) {
    check(`G2 / 2.1-2.4: runtime, probe and preflight agree on ${item.name}`, async () => {
      const input: import("./hop-decision.js").HopFailureInput = item.thrown
        ? { kind: "thrown" }
        : {
            kind: "response",
            status: item.status,
            headers: new Headers(item.headers),
            body: "",
            provider: item.provider,
            name: item.provider,
          };
      expect(decideHopFailure(input)).toEqual({ action: item.action, reason: item.reason });

      const response = () => new Response(null, { status: item.status, headers: item.headers });
      let secondCalls = 0;
      const runtime = new FallbackHandler([
        {
          name: item.provider,
          provider: item.provider,
          handler: {
            handle: async () => {
              if (item.thrown) throw new Error("W2 thrown hop");
              return response();
            },
            shutdown: async () => {},
          },
        },
        {
          name: "W2 second",
          provider: "openrouter",
          handler: {
            handle: async () => {
              secondCalls++;
              return new Response(null, { status: 204 });
            },
            shutdown: async () => {},
          },
        },
      ]);
      const app = new Hono();
      app.post("/", (context) => runtime.handle(context, {}));
      try {
        const observed = await app.request("http://w2.test/", { method: "POST" });
        expect(secondCalls).toBe(item.action === "advance" ? 1 : 0);
        expect(observed.status).toBe(item.action === "advance" ? 204 : item.status);
      } finally {
        await runtime.shutdown();
      }

      globalThis.fetch = Object.assign(async () => response(), originalFetch);
      const probe = await probeLink(
        "http://w2.test",
        { provider: item.provider, modelSpec: `${item.provider}@w2`, hasCredentials: true },
        100
      );
      expect(probe.chainAction).toBe(item.action);
      expect(probe.chainReason).toBe(item.reason);
      let calls = 0;
      const result = await preflightModel("w2-parity", {
        explain: async () => ({
          requestedModel: "w2-parity",
          routedModel: "w2-parity",
          source: "catalog",
          outcome: { kind: "ok" },
          warnings: [],
          candidates: [item.provider, "openrouter"].map((provider, index) => ({
            provider,
            displayName: provider,
            modelSpec: `${provider}@wire-${index}`,
            wireId: `wire-${index}`,
            position: "candidate" as const,
            outcome: "kept" as const,
          })),
        }),
        probe: async () => (++calls === 1 ? probe : { state: "live", latencyMs: 0 }),
      });
      expect(calls).toBe(item.action === "advance" ? 2 : 1);
      expect(result.kind).toBe(item.action === "advance" ? "served" : "failed");
    });
  }

  check("G2 / 2.1: connection marker takes priority over quota wording and auth verdict", () => {
    expect(
      decideHopFailure({
        kind: "response",
        status: 400,
        headers: new Headers({
          "x-claudish-connection-error": "1",
          "x-claudish-auth-verdict": "terminal",
        }),
        body: "quota",
        provider: "kimi-coding",
        name: "Kimi Coding",
      }).action
    ).toBe("stop");
  });

  check("G2 / 2.2: captured content followed by SSE error stops after-200", async () => {
    const stream = readFileSync(
      join(
        import.meta.dir,
        "../../test-fixtures/sse-responses/regression-zai-glm5-instream-error.sse"
      )
    );
    globalThis.fetch = Object.assign(
      async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      originalFetch
    );
    const result = await probeLink(
      "http://w2.test",
      { provider: "openai", modelSpec: "openai@w2", hasCredentials: true },
      100
    );
    expect(result.state).not.toBe("live");
    expect(result.chainAction).toBe("stop");
    expect(result.chainReason).toBe("after-200");
  });

  check("G2 / 2.2: captured live stream has no chainAction", async () => {
    const stream = readFileSync(
      join(
        import.meta.dir,
        "../../test-fixtures/sse-responses/minimax-m25-turn1-thinking-text-tool.sse"
      )
    );
    globalThis.fetch = Object.assign(
      async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      originalFetch
    );
    const result = await probeLink(
      "http://w2.test",
      { provider: "openai", modelSpec: "openai@w2", hasCredentials: true },
      100
    );
    expect(result.state).toBe("live");
    expect(result.chainAction).toBeUndefined();
  });
}
