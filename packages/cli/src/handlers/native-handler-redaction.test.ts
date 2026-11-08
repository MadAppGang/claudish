import { afterEach, describe, expect, it, jest } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const childKey = "T1_NATIVE_REDACTION_CHILD";

if (process.env[childKey] !== "1") {
  it("runs native redaction checks with an isolated HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-t1-native-"));
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
  const { NativeHandler, redactSseErrorEvent } = await import("./native-handler.js");
  const { acquireSigningLease, redactSigningValues } = await import("../redact.js");
  const { buildAdvisorPanelPayload } = await import("./advisor-route-plan.js");
  const { createSigningSecrets, releaseWhenBodyEnds, SIGNING_SECRETS_KEY } = await import(
    "./shared/call-context.js"
  );
  const { setDiagOutput } = await import("../logger.js");
  const leases: ReturnType<typeof acquireSigningLease>[] = [];
  const encoder = new TextEncoder();
  const errorCapture = readFileSync(
    new URL("../test-fixtures/redaction/zai-instream-error.sse", import.meta.url),
    "utf8"
  );
  const contentCapture = readFileSync(
    new URL("../test-fixtures/redaction/native-content.sse", import.meta.url),
    "utf8"
  );
  const requestCapture = JSON.parse(
    readFileSync(
      new URL("../test-fixtures/redaction/roundtrip-request.json", import.meta.url),
      "utf8"
    )
  );
  const capturedErrorLine = errorCapture.split("\n").find((line) => line.includes('"request_id"'))!;
  const capturedError = JSON.parse(capturedErrorLine.slice("data: ".length));
  const secret = "temporarily"; // A real substring of the captured error, not an invented upstream echo.
  const nativeModel = JSON.parse(
    contentCapture
      .split("\n")
      .find((line) => line.includes('"type":"message_start"'))!
      .slice(5)
  ).message.model;
  // Derived request: the user turn is copied from roundtrip-string.request.json; the existing builder supplies Anthropic encoding.
  const payload = buildAdvisorPanelPayload(
    nativeModel,
    requestCapture.body.instructions,
    [
      {
        role: requestCapture.body.input[0].role,
        content: requestCapture.body.input[0].content[0].text,
      },
    ],
    16
  );
  const dataPrefix = capturedErrorLine.slice(0, capturedErrorLine.indexOf("{"));
  const eventPrefix = errorCapture.split("\n")[0]!.split(":")[0] + ": ";
  const errorType = Object.keys(capturedError)[0]!;
  // Derived test data: zai-instream-error.sse supplies the entire error object and SSE field prefixes.
  // Its existing "error" key supplies the event/type discriminator; no provider message is fabricated.
  const typedErrorLine = dataPrefix + JSON.stringify({ type: errorType, ...capturedError });
  const errorEventLine = eventPrefix + errorType;

  function hold(value: string) {
    const lease = acquireSigningLease();
    leases.push(lease);
    lease.add([value]);
    return lease;
  }
  function streamOf(bytes: Uint8Array) {
    // One-byte chunks also split field names, separators and UTF-8 code points.
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
  }
  function appFor(upstream: () => Response, headers: Record<string, string>) {
    const app = new Hono();
    const handler = new NativeHandler(); // No advisor is configured: this is the ordinary native request path.
    const secrets = createSigningSecrets();
    leases.push(secrets.lease);
    const outbound: Request[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      outbound.push(new Request(input, init));
      return upstream();
    }) as unknown as typeof fetch;
    app.post("/v1/messages", async (c) => {
      c.set(SIGNING_SECRETS_KEY, secrets);
      return releaseWhenBodyEnds(await handler.handle(c, payload), () => secrets.lease.release());
    });
    return {
      response: () => app.request("/v1/messages", { method: "POST", headers }),
      secrets,
      outbound,
    };
  }

  afterEach(() => {
    globalThis.fetch = (() => {
      throw new Error("T1 forbids network");
    }) as unknown as typeof fetch;
    for (const lease of leases.splice(0)) lease.release();
    setDiagOutput(null);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  process.on("exit", () => {
    globalThis.fetch = originalFetch;
  });

  describe("G4 native passthrough SSE error dispatch", () => {
    const cases = [
      {
        name: "data precedes event: error",
        lines: [capturedErrorLine, errorEventLine],
        newline: "\n",
        tail: "\n\n",
      },
      {
        name: "event: error precedes data",
        lines: [errorEventLine, capturedErrorLine],
        newline: "\n",
        tail: "\n\n",
      },
      {
        name: "JSON type:error without an event line",
        lines: [typedErrorLine],
        newline: "\n",
        tail: "\n\n",
      },
      {
        name: "CRLF event split across byte chunks",
        lines: [capturedErrorLine, errorEventLine],
        newline: "\r\n",
        tail: "\r\n\r\n",
      },
      {
        name: "trailing event without a newline",
        lines: [capturedErrorLine, errorEventLine],
        newline: "\n",
        tail: "",
      },
    ];
    for (const entry of cases) {
      it(`redacts ${entry.name} and preserves its framing`, async () => {
        const wire = entry.lines.join(entry.newline) + entry.tail;
        const expected = wire.replaceAll(secret, "[redacted]");
        hold(secret);
        const lines = wire.match(/[^\n]*\n|[^\n]+$/g)!;
        expect(redactSseErrorEvent(lines).join("")).toBe(expected);
        const { response } = appFor(
          () =>
            new Response(streamOf(encoder.encode(wire)), {
              headers: { "content-type": "text/event-stream" },
            }),
          { authorization: `Bearer ${secret}` }
        );
        const result = await response();
        expect(result.status).toBe(200);
        expect(await result.text()).toBe(expected);
      }, 10_000);
    }

    it("passes ordinary captured content byte-for-byte even when it quotes a registered value", async () => {
      const firstData = contentCapture
        .split("\n")
        .find((line) => line.includes('"type":"message_start"'))!;
      const value = JSON.parse(firstData.slice(5)).message.id as string;
      expect(value.length).toBeGreaterThanOrEqual(8);
      hold(value);
      expect(redactSseErrorEvent(contentCapture.match(/[^\n]*\n|[^\n]+$/g)!).join("")).toBe(
        contentCapture
      );
      const bytes = encoder.encode(contentCapture);
      const { response } = appFor(
        () =>
          new Response(streamOf(bytes), {
            headers: { "content-type": "text/event-stream" },
          }),
        { authorization: `Bearer ${value}` }
      );
      expect(new Uint8Array(await (await response()).arrayBuffer())).toEqual(bytes);
    }, 10_000);

    it("delivers a complete event before the next event is available", async () => {
      const separator = contentCapture.indexOf("\n\n") + 2;
      expect(separator).toBeGreaterThan(1);
      const first = encoder.encode(contentCapture.slice(0, separator));
      const rest = encoder.encode(contentCapture.slice(separator));
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const { response } = appFor(
        () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  source = controller;
                },
              },
              { highWaterMark: 0 }
            ),
            { headers: { "content-type": "text/event-stream" } }
          ),
        { authorization: "Bearer OPAQUE_TEST_TOKEN_T1" }
      );
      const result = await response();
      const reader = result.body!.getReader();
      source.enqueue(first);
      expect((await reader.read()).value).toEqual(first);
      source.enqueue(rest);
      source.close();
      const remaining: number[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        remaining.push(...chunk.value);
      }
      expect(Uint8Array.from(remaining)).toEqual(rest);
    }, 10_000);
  });

  describe("G2 native stream lease lifetime (A2)", () => {
    it("still redacts a late error frame after a year while the native stream is producing", async () => {
      jest.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
      const separator = contentCapture.indexOf("\n\n") + 2;
      const first = encoder.encode(contentCapture.slice(0, separator));
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const { response } = appFor(
        () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  source = controller;
                },
              },
              { highWaterMark: 0 }
            ),
            { headers: { "content-type": "text/event-stream" } }
          ),
        {
          authorization: `Bearer ${secret}`,
        }
      );
      const result = await response();
      const reader = result.body!.getReader();
      source.enqueue(first);
      expect((await reader.read()).value).toEqual(first);
      for (let day = 0; day < 366; day++) jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(redactSigningValues(secret)).toBe("[redacted]");
      // Derived late event: the same captured error line, with the captured field prefix and error discriminator.
      const late = capturedErrorLine + "\n" + errorEventLine + "\n\n";
      source.enqueue(encoder.encode(late));
      const later = new TextDecoder().decode((await reader.read()).value);
      expect(later).toBe(late.replaceAll(secret, "[redacted]"));
      source.close();
      expect((await reader.read()).done).toBe(true);
      expect(redactSigningValues(secret)).toBe(secret);
    }, 10_000);
  });

  describe("G3 native client error bodies", () => {
    it("redacts a non-success JSON body before it is sent to Claude Code", async () => {
      const { response } = appFor(
        () =>
          new Response(JSON.stringify(capturedError), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        { authorization: `Bearer ${secret}` }
      );
      const result = await response();
      expect(result.ok).toBe(false);
      const text = await result.text();
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(secret);
      expect(JSON.parse(text).error.message).toContain("[redacted]");
      expect(redactSigningValues(secret)).toBe(secret);
    }, 10_000);
  });

  describe("G5 every native request registers outbound credentials", () => {
    for (const header of ["authorization", "x-api-key"]) {
      it(`registers the ordinary native request's ${header} before fetch and releases after its body`, async () => {
        const value = "OPAQUE_TEST_TOKEN_NATIVE";
        const observations: string[] = [];
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const { response, secrets, outbound } = appFor(
          () => {
            observations.push(redactSigningValues(value));
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  start(controller) {
                    source = controller;
                  },
                },
                { highWaterMark: 0 }
              ),
              { headers: { "content-type": "text/event-stream" } }
            );
          },
          { [header]: header === "authorization" ? `Bearer ${value}` : value }
        );
        const result = await response();
        expect(observations).toEqual(["[redacted]"]);
        expect(outbound).toHaveLength(1);
        expect(new URL(outbound[0]!.url).origin).toBe("https://api.anthropic.com");
        expect(outbound[0]!.headers.get(header)).toBe(
          header === "authorization" ? `Bearer ${value}` : value
        );
        expect(secrets.values.has(value)).toBe(true);
        expect(redactSigningValues(value)).toBe("[redacted]");
        source.enqueue(encoder.encode(contentCapture));
        source.close();
        await result.text();
        expect(redactSigningValues(value)).toBe(value);
      }, 10_000);
    }
  });
}
