import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

/**
 * Integration tests for the error-surfacing WIRING in ComposedHandler.handle().
 *
 * The unit tests in shared/anthropic-error.test.ts prove the helper functions
 * (isTerminalError / buildSurfacedErrorMessage / extractProviderMessage) in
 * isolation. These tests prove the handler actually CALLS them on the upstream
 * error path: terminal errors must be remapped to a surfaced HTTP 400 (so Claude
 * Code stops its silent retry loop and shows the real reason), while transient
 * errors must keep their retryable status untouched (so legitimate retries still
 * happen). Without these, the user-visible behavior — the whole point of the
 * change — is unverified.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake transport that returns a fixed upstream Response from a stubbed fetch. */
function makeTransport(): ProviderTransport {
  return {
    name: "sakana",
    displayName: "Sakana Fugu",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/v1/chat/completions",
    getHeaders: async () => ({}),
    // NOTE: deliberately NO forceRefreshAuth — keeps even a 401 on the generic
    // error branch (the path under test) instead of the OAuth-retry branch.
  } as unknown as ProviderTransport;
}

/** Stub global fetch to return one canned upstream error response. */
function stubUpstream(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  globalThis.fetch = (async () =>
    new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Stub global fetch to throw before any upstream response is received. */
function stubUpstreamThrow(error: unknown) {
  globalThis.fetch = (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

interface CapturedErrorBody {
  type?: string;
  error?: {
    type?: string;
    message?: string;
  };
}

interface CapturedResponse {
  body?: CapturedErrorBody;
  status?: number;
}

/** Minimal Hono Context capturing what c.json() was called with. */
function makeContext(): { c: Context; captured: CapturedResponse } {
  const captured: CapturedResponse = {};
  const c = {
    req: { header: () => ({}) },
    header: () => {},
    json: (body: unknown, status?: number) => {
      captured.body = body as CapturedErrorBody;
      captured.status = status;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
  } as unknown as Context;
  return { c, captured };
}

/** A minimal but valid Claude-format request payload. */
const PAYLOAD = {
  model: "fugu-ultra",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

function makeHandler(): ComposedHandler {
  return new ComposedHandler(makeTransport(), "fugu-ultra", "fugu-ultra", 8080, {});
}

describe("ComposedHandler.handle — error surfacing wiring", () => {
  test("terminal billing 429 is remapped to a surfaced HTTP 400 (stops silent retry)", async () => {
    stubUpstream(429, {
      error: {
        message: "You exceeded your current quota, check your plan & billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    // Remapped away from the retryable 429 to a terminal 400.
    expect(captured.status).toBe(400);
    expect(captured.body?.type).toBe("error");
    expect(captured.body?.error?.type).toBe("invalid_request_error");
    // Rich, attributed, includes the real upstream message.
    expect(captured.body?.error?.message).toContain("Sakana Fugu error (HTTP 429)");
    expect(captured.body?.error?.message).toContain("exceeded your current quota");
  });

  test("terminal auth 401 is surfaced as 400 (not silently retried)", async () => {
    stubUpstream(401, { error: { message: "invalid api key" } });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("invalid_request_error");
    expect(captured.body?.error?.message).toContain("Sakana Fugu error (HTTP 401)");
    expect(captured.body?.error?.message).toContain("invalid api key");
  });

  test("transient 503 keeps its retryable status (Claude Code SHOULD retry)", async () => {
    stubUpstream(503, { error: { message: "temporary overload", type: "server_error" } });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    // NOT remapped — must stay 503 so the host retries the transient failure.
    expect(captured.status).toBe(503);
    expect(captured.body?.type).toBe("error");
    expect(captured.body?.error?.message).toContain("temporary overload");
  });

  test("plain (non-terminal) 429 rate-limit keeps its retryable status", async () => {
    stubUpstream(429, { error: { message: "rate limit exceeded, slow down" } });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(429);
    expect(captured.body?.error?.message).toContain("rate limit exceeded");
  });

  test("transient 500 whose prose contains 'not supported' is NOT mis-remapped to 400", async () => {
    // False-positive guard at the integration level: a transient 5xx body that
    // happens to contain a terminal-looking phrase must still retry.
    stubUpstream(503, {
      error: { message: "Retry-After header not supported by upstream gateway; overloaded" },
    });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(503);
  });

  test("non-JSON upstream error body is still surfaced, not dropped", async () => {
    // 401 is terminal regardless of body shape → remapped to 400, raw text kept.
    stubUpstream(401, "Unauthorized");
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.message).toContain("Unauthorized");
  });

  test("a thrown DNS error is surfaced as a 503 connection_error", async () => {
    stubUpstreamThrow(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND host"), { code: "ENOTFOUND" }),
      })
    );
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(503);
    expect(captured.body?.type).toBe("error");
    expect(captured.body?.error?.type).toBe("connection_error");
    expect(captured.body?.error?.message).toContain("Cannot resolve");
    expect(captured.body?.error?.message).toContain("DNS");
    expect(captured.body?.error?.type).not.toBe("api_error");
  });

  test("a thrown ECONNREFUSED error is surfaced as a 503 connection_error", async () => {
    stubUpstreamThrow(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(503);
    expect(captured.body?.error?.type).toBe("connection_error");
    expect(captured.body?.error?.message).toContain("Make sure the server is running");
  });

  test("a non-connection throw propagates without calling c.json", async () => {
    const thrown = new TypeError("Cannot read properties of undefined");
    stubUpstreamThrow(thrown);
    const { c, captured } = makeContext();
    let didReject = false;

    try {
      await makeHandler().handle(c, PAYLOAD);
    } catch (error) {
      didReject = true;
      expect(error).toBe(thrown);
    }

    expect(didReject).toBe(true);
    expect(captured.status).toBeUndefined();
  });
});
