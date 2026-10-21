import { afterEach, describe, expect, it, jest } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const childKey = "T1_COMPOSED_REDACTION_CHILD";

if (process.env[childKey] !== "1") {
  it("runs client-body redaction checks with an isolated HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-t1-client-"));
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        [childKey]: "1",
      };
      for (const key of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE/.test(key) && key !== childKey) delete env[key];
      }
      const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        env,
        timeout: 18_000,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      console.log(output);
      expect(result.exitCode, output).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("T1 forbids network");
  }) as unknown as typeof fetch;
  const { Hono } = await import("hono");
  const { ComposedHandler } = await import("./composed-handler.js");
  const { OpenAIAPIFormat } = await import("../adapters/openai-api-format.js");
  const { AnthropicAPIFormat } = await import("../adapters/anthropic-api-format.js");
  const { buildAdvisorPanelPayload } = await import("./advisor-route-plan.js");
  const { acquireSigningLease, redactForClient } = await import("../redact.js");
  const { respondAuthFailure } = await import("./shared/auth-failure.js");
  const { createSigningSecrets, releaseWhenBodyEnds, SIGNING_SECRETS_KEY } = await import(
    "./shared/call-context.js"
  );
  const { setDiagOutput } = await import("../logger.js");
  type AuthFailure = import("./shared/auth-failure.js").AuthFailure;
  type ProviderTransport = import("../providers/transport/types.js").ProviderTransport;
  type StreamFormat = import("../providers/transport/types.js").StreamFormat;
  const source = readFileSync(
    new URL("../test-fixtures/redaction/zai-instream-error.sse", import.meta.url),
    "utf8"
  );
  const requestSource = JSON.parse(
    readFileSync(
      new URL("../test-fixtures/redaction/roundtrip-request.json", import.meta.url),
      "utf8"
    )
  );
  const errorLine = source.split("\n").find((line) => line.includes('"request_id"'))!;
  const errorBody = JSON.parse(errorLine.slice(6));
  const secret = "temporarily";
  const leases: ReturnType<typeof acquireSigningLease>[] = [];
  const handlers: InstanceType<typeof ComposedHandler>[] = [];
  // Derived from roundtrip-string.request.json's actual user turn; the production builder supplies request encoding.
  const payload = buildAdvisorPanelPayload(
    requestSource.body.model,
    requestSource.body.instructions,
    [
      {
        role: requestSource.body.input[0].role,
        content: requestSource.body.input[0].content[0].text,
      },
    ],
    16
  );
  // Derived from zai-instream-error.sse: its "error" key supplies the type/event discriminator.
  // The complete provider error object, message and SSE field prefixes are retained from the capture.
  const errorType = Object.keys(errorBody)[0]!;
  const typedData = errorLine.slice(0, 6) + JSON.stringify({ type: errorType, ...errorBody });
  const eventLine = source.split("\n")[0]!.split(":")[0] + ": " + errorType;
  const responsesHead = typedData + "\n\n";
  const anthropicError =
    source.slice(0, source.indexOf(errorLine)) + eventLine + "\n" + typedData + "\n\n";

  function hold() {
    const lease = acquireSigningLease();
    leases.push(lease);
    lease.add([secret]);
    return lease;
  }
  function appFor(transport: ProviderTransport, stream: boolean) {
    const app = new Hono();
    const format =
      transport.streamFormat === "anthropic-sse"
        ? new AnthropicAPIFormat(payload.model)
        : new OpenAIAPIFormat(payload.model);
    const handler = new ComposedHandler(transport, payload.model, payload.model, 0, {
      adapter: format,
      requestRole: "advisor",
      codeMode: "off",
      isInteractive: false,
    });
    handlers.push(handler);
    app.post("/v1/messages", async (c) => {
      const secrets = createSigningSecrets();
      leases.push(secrets.lease);
      c.set(SIGNING_SECRETS_KEY, secrets);
      // The only change to the captured-turn-derived payload is the requested stream mode.
      return releaseWhenBodyEnds(await handler.handle(c, { ...payload, stream }), () =>
        secrets.lease.release()
      );
    });
    return () => app.request("/v1/messages", { method: "POST" });
  }
  function transport(
    format: StreamFormat,
    extras: Partial<ProviderTransport> = {}
  ): ProviderTransport {
    return {
      name: "t1-redaction",
      displayName: "T1 redaction",
      streamFormat: format,
      getEndpoint: () => "https://t1.invalid/v1/messages",
      getHeaders: async () => ({ authorization: `Bearer ${secret}` }),
      overrideStreamFormat: () => format,
      ...extras,
    };
  }
  function mockFetch(response: () => Response) {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "https://t1.invalid/v1/messages") throw new Error(`T1 forbids network: ${url}`);
      calls++;
      return response();
    }) as unknown as typeof fetch;
    return () => calls;
  }

  afterEach(async () => {
    for (const handler of handlers.splice(0)) await handler.shutdown();
    for (const lease of leases.splice(0)) lease.release();
    setDiagOutput(null);
    jest.useRealTimers();
    globalThis.fetch = (() => {
      throw new Error("T1 forbids network");
    }) as unknown as typeof fetch;
  });
  process.on("exit", () => {
    globalThis.fetch = originalFetch;
  });

  describe("G3 Claude Code-facing error bodies", () => {
    const failures: AuthFailure[] = [
      { kind: "terminal", upstreamStatus: 401, message: errorBody.error.message },
      { kind: "transient", status: 503, message: errorBody.error.message },
      { kind: "unknown", message: errorBody.error.message },
    ];
    for (const failure of failures) {
      it(`redacts respondAuthFailure's ${failure.kind} message without changing its verdict`, async () => {
        hold();
        const app = new Hono();
        app.post(
          "/auth",
          (c) =>
            respondAuthFailure(c, failure, {
              isSubscription: true,
              providerDisplayName: "T1 subscription",
            })!
        );
        const result = await app.request("/auth", { method: "POST" });
        expect(result.status).toBe(failure.kind === "terminal" ? 400 : 503);
        expect(result.headers.get("x-claudish-auth-verdict")).toBe(
          failure.kind === "terminal" ? "terminal" : "transient"
        );
        const text = await result.text();
        expect(text).toContain("[redacted]");
        expect(text).not.toContain(secret);
        expect(JSON.parse(text).error.message).toContain("[redacted]");
        expect(redactForClient(secret)).toBe("[redacted]");
      }, 10_000);
    }

    it("redacts a ComposedHandler HTTP error signed with an opaque header value", async () => {
      const calls = mockFetch(
        () =>
          new Response(JSON.stringify(errorBody), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
      );
      const response = await appFor(transport("openai-sse"), false)();
      const text = await response.text();
      expect(calls()).toBe(1);
      expect(response.ok).toBe(false);
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(secret);
      expect(JSON.parse(text).error).toBeDefined();
    }, 10_000);

    it("redacts exhausted Responses stream-head failure text after all retries", async () => {
      jest.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
      const calls = mockFetch(
        () =>
          new Response(responsesHead, {
            headers: { "content-type": "text/event-stream" },
          })
      );
      setDiagOutput({ write() {}, cleanup() {} });
      let settled = false;
      const pending = Promise.resolve(appFor(transport("openai-responses-sse"), false)());
      void pending.then(() => {
        settled = true;
      });
      for (let seconds = 0; seconds < 120 && !settled; seconds++) {
        for (let turn = 0; turn < 80; turn++) await Promise.resolve();
        jest.advanceTimersByTime(1000);
      }
      expect(settled).toBe(true);
      const response = await pending;
      const text = await response.text();
      expect(calls()).toBe(4);
      expect(response.status).toBe(503);
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(secret);
      expect(JSON.parse(text).error).toBeDefined();
    }, 10_000);

    it("redacts the parser's SSE error frame using the transport's body-only signing secret", async () => {
      mockFetch(
        () => new Response(anthropicError, { headers: { "content-type": "text/event-stream" } })
      );
      const response = await appFor(
        transport("anthropic-sse", {
          getHeaders: async () => ({}),
          redactionSecrets: () => [secret],
        }),
        true
      )();
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain("event: error");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(secret);
    }, 10_000);
  });
}
