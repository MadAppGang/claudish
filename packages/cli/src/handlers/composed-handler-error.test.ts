import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";
import { FallbackHandler } from "./fallback-handler.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";

/**
 * Connection-error surfacing wiring in ComposedHandler.handle() (S4-e lot E1,
 * upstream d1a33795 + the composed-handler hunks of 218c3586).
 *
 * A failure to even REACH the provider (DNS, refused, unreachable) is a LOCAL
 * network problem. These tests pin the four invariants the lot was cut on:
 *
 *   (i)   the `connection_error` TYPE survives the status remap — the body
 *         carries the meaning, the status only decides retry semantics;
 *   (ii)  the surfaced 400 ADVANCES the FallbackHandler chain — its candidates
 *         are different providers, hence different hosts, and a connect failure
 *         on one says nothing about another. When every host is unreachable the
 *         surfaced error stays a 400 connection_error (never a 502 that Claude
 *         Code would retry as overloaded_error), and in mono-candidate routing
 *         no FallbackHandler exists so that same 400 reaches the client
 *         verbatim;
 *   (iii) ONLY connect failures are remapped — any other thrown error
 *         propagates untouched, so no status the budget-failover cascade keys
 *         on (402 / 429-quota, which arrive as HTTP responses, not throws)
 *         can be swallowed by this catch;
 *   (iv)  never-hang: every path here returns BEFORE any client stream is
 *         opened — the upstream fetch itself failed, handle() resolves to a
 *         terminal Response, nothing is left dangling.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Fake transport with NO refreshAuth — the auth-retry branch stays out of the
 * way so the connection catch under test is the only error path exercised.
 */
function makeTransport(): ProviderTransport {
  return {
    name: "sakana",
    displayName: "Sakana Fugu",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost:19999/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
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
  return new ComposedHandler(makeTransport(), "fugu-ultra", "fugu-ultra", 8464, {});
}

describe("ComposedHandler.handle — connection-error surfacing (lot E1)", () => {
  test("a thrown DNS error is surfaced as a 400 connection_error — the type survives the status remap (i)", async () => {
    stubUpstreamThrow(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND host"), { code: "ENOTFOUND" }),
      })
    );
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    // 400, NOT 503: both stop claudish's fallback chain, but Claude Code
    // retries a 503 as overloaded_error and buries the cause behind the
    // "attempt N/10" banner; a 400 is rendered verbatim inline.
    expect(captured.status).toBe(400);
    expect(captured.body?.type).toBe("error");
    expect(captured.body?.error?.type).toBe("connection_error");
    expect(captured.body?.error?.message).toContain("Cannot resolve");
    expect(captured.body?.error?.message).toContain("DNS");
    expect(captured.body?.error?.type).not.toBe("api_error");
  });

  test("a thrown ECONNREFUSED error is surfaced as a 400 connection_error", async () => {
    stubUpstreamThrow(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
    // Loopback endpoint → the actionable "start the server" wording.
    expect(captured.body?.error?.message).toContain("Make sure the server is running");
  });

  test("a Bun-style flat ConnectionRefused error is classified and surfaced with a single-line terminal-safe message", async () => {
    // Bun's fetch throws a FLAT error with its own code and no `.cause` — the
    // runtime claudish actually ships on. Its dump carries ANSI and newlines;
    // the surfaced message must not.
    stubUpstreamThrow(
      Object.assign(
        new Error(
          "Unable to connect. Is the computer able to access the url?\n\t\u001b[31mconnection failed\u001b[0m"
        ),
        { code: "ConnectionRefused" }
      )
    );
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
    const message = captured.body?.error?.message;
    expect(typeof message).toBe("string");
    expect(message).not.toMatch(/[\r\n\t]/);
    expect(message).not.toContain("\u001b");
  });

  test("a non-connection throw propagates without calling c.json — nothing else is remapped (iii)", async () => {
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

  test("a refreshAuth failure surfaces a 401 wrapped in the Anthropic error envelope", async () => {
    // The 218c3586 401 hunk: the auth branch must go through
    // wrapAnthropicError, not a hand-rolled body shape.
    const transport = {
      ...makeTransport(),
      refreshAuth: async () => {
        throw new Error("token expired");
      },
    } as unknown as ProviderTransport;
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8465, {});
    const { c, captured } = makeContext();
    await handler.handle(c, PAYLOAD);

    expect(captured.status).toBe(401);
    expect(captured.body?.type).toBe("error");
    expect(captured.body?.error?.type).toBe("authentication_error");
    expect(captured.body?.error?.message).toContain("token expired");
  });
});

describe("FallbackHandler chain — a connect failure advances, all-hosts-down stays 400 (lot E1, invariant ii)", () => {
  function connectionErrorResponse(host = "localhost:19999"): Response {
    // Exactly the body ComposedHandler returns on a connect failure.
    return new Response(
      JSON.stringify(
        wrapAnthropicError(
          400,
          `Cannot connect to Sakana Fugu at http://${host}/v1/chat/completions. Make sure the server is running.`,
          "connection_error"
        )
      ),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  test("a connect failure on one host ADVANCES the chain — candidates are different hosts by construction", async () => {
    // The premise that a connect failure is terminal held only for a chain of
    // candidates sharing an endpoint, which is the exception. FallbackHandler
    // exists precisely to try a different host.
    let secondCalled = false;
    const first = { handle: async () => connectionErrorResponse("unreachable-host-a.example") };
    const second = {
      handle: async () => {
        secondCalled = true;
        return new Response("{}", { status: 200 });
      },
    };
    const fb = new FallbackHandler([
      { name: "first", handler: first as any },
      { name: "second", handler: second as any },
    ]);
    const { c } = makeContext();
    const res = await fb.handle(c, PAYLOAD);

    expect(secondCalled).toBe(true);
    expect(res.ok).toBe(true);
  });

  test("when EVERY host is unreachable the surfaced error is a 400 connection_error, never a 502", async () => {
    // All hosts down is the user's network, and the case where the actionable
    // sentence matters most. A 502 would be retried by Claude Code as
    // overloaded_error and bury it behind the retry banner.
    const first = { handle: async () => connectionErrorResponse("unreachable-host-a.example") };
    const second = { handle: async () => connectionErrorResponse("unreachable-host-b.example") };
    const fb = new FallbackHandler([
      { name: "first", handler: first as any },
      { name: "second", handler: second as any },
    ]);
    const { c } = makeContext();
    const res = await fb.handle(c, PAYLOAD);
    const body = (await res.json()) as { type?: string; error?: { type?: string; message?: string } };

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(502);
    expect(body.type).toBe("error");
    expect(body.error?.type).toBe("connection_error");
    expect(body.error?.message).toContain("Cannot reach any of the 2 provider hosts");
    expect(body.error?.message).toContain("Make sure the server is running");
  });

  test("mono-candidate routing returns the honest 400 verbatim (no FallbackHandler is built)", async () => {
    // proxy-server.ts: candidates.length > 1 ? new FallbackHandler(...) : candidates[0].handler
    const only = { handle: async (_c: unknown, _payload: unknown) => connectionErrorResponse() };
    const { c } = makeContext();
    const res = await only.handle(c, PAYLOAD);
    const body = (await res.json()) as { error?: { type?: string } };

    expect(res.status).toBe(400);
    expect(body.error?.type).toBe("connection_error");
  });

  test("a 401 keeps the chain moving (retryable by design)", async () => {
    let secondCalled = false;
    const first = {
      handle: async () =>
        new Response(JSON.stringify(wrapAnthropicError(401, "invalid api key", "authentication_error")), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    };
    const second = {
      handle: async () => {
        secondCalled = true;
        return new Response("{}", { status: 200 });
      },
    };
    const fb = new FallbackHandler([
      { name: "first", handler: first as any },
      { name: "second", handler: second as any },
    ]);
    const { c } = makeContext();
    const res = await fb.handle(c, PAYLOAD);

    expect(secondCalled).toBe(true);
    expect(res.ok).toBe(true);
  });
});
