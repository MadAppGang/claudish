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
  delete process.env.CLAUDISH_CONNECT_RETRY_MAX;
  delete process.env.CLAUDISH_CONNECT_RETRY_DELAYS_MS;
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
    json: (body: unknown, statusOrInit?: number | ResponseInit) => {
      captured.body = body as CapturedErrorBody;
      captured.status = typeof statusOrInit === "number" ? statusOrInit : 200;
      // Hono accepts either a bare status or a ResponseInit — the buffered
      // path (composed-handler.ts:1252) passes { headers } with no status.
      return new Response(JSON.stringify(body), {
        ...(typeof statusOrInit === "object" ? statusOrInit : {}),
        status: typeof statusOrInit === "number" ? statusOrInit : 200,
      });
    },
    // Hono's c.body(stream, init) — the SSE path the success case returns
    // through (openai-sse.ts). Wraps the stream in a real Response so tests
    // can await its content.
    body: (stream: ReadableStream, init?: ResponseInit) => new Response(stream, init),
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

  test("a 400 `Model not exist` STOPS the chain — a model fault is not a transport blip (fa09cb7e)", async () => {
    // The fa09cb7e port names this body in the RECOVERY HINT only; retry
    // semantics are deliberately unchanged. isRetryableError's 400 list does
    // not carry Alibaba's wording ("does not exist" ≠ "not exist"), so the
    // chain does not advance to another host that would serve the same id —
    // the model is wrong, not the transport.
    let secondCalled = false;
    const first = {
      handle: async () =>
        new Response(JSON.stringify(wrapAnthropicError(400, "Model not exist", "invalid_request_error")), {
          status: 400,
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

    expect(secondCalled).toBe(false);
    expect(res.status).toBe(400);
  });
});

describe("ComposedHandler.handle — bounded same-provider connect retry (#251)", () => {
  /**
   * The fleet report: a z.ai reset (ECONNRESET before any byte) surfaced as a
   * blocking 400 in mono-candidate routing — no FallbackHandler exists there,
   * so nothing absorbed the blip. These tests pin the retry: "closed" only,
   * bounded, env-disarmable, and the upstream's real answer replaces the
   * connection error on recovery.
   */
  function stubUpstreamSequence(behaviors: Array<() => Promise<Response>>) {
    let calls = 0;
    globalThis.fetch = (async () => {
      const behavior = behaviors[Math.min(calls, behaviors.length - 1)];
      calls += 1;
      return behavior();
    }) as unknown as typeof fetch;
    return () => calls;
  }

  const closedThrow = () => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };

  test("all retry attempts fail — still the 400 connection_error, fetch called 1+2 times", async () => {
    process.env.CLAUDISH_CONNECT_RETRY_DELAYS_MS = "0,0";
    const calls = stubUpstreamSequence([closedThrow, closedThrow, closedThrow]);
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(calls()).toBe(3);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
    expect(captured.body?.error?.message).toContain("was closed before a response arrived");
  });

  test("CLAUDISH_CONNECT_RETRY_MAX=0 disarms — single call, the 400 contract unchanged", async () => {
    process.env.CLAUDISH_CONNECT_RETRY_MAX = "0";
    const calls = stubUpstreamSequence([closedThrow, closedThrow, closedThrow]);
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(calls()).toBe(1);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
  });

  test("refused is NOT retried — dns/refused/unreachable are stable conditions", async () => {
    process.env.CLAUDISH_CONNECT_RETRY_DELAYS_MS = "0,0";
    const calls = stubUpstreamSequence([
      () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    ]);
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(calls()).toBe(1);
    expect(captured.body?.error?.message).toContain("Make sure the server is running");
  });

  test("recovery on the second call — the upstream's answer replaces the connection error", async () => {
    process.env.CLAUDISH_CONNECT_RETRY_DELAYS_MS = "0,0";
    const calls = stubUpstreamSequence([
      closedThrow,
      () =>
        Promise.resolve(
          new Response(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            { status: 200 }
          )
        ),
    ]);
    const { c } = makeContext();
    const res = await makeHandler().handle(c, PAYLOAD);

    expect(calls()).toBe(2);
    // A real turn came back — PAYLOAD carries no stream:true, so the answer
    // is the buffered single JSON message (composed-handler.ts:1250), not the
    // 400 connection_error the first throw would have surfaced.
    expect(res.status).toBe(200);
    const message = (await res.json()) as {
      type?: string;
      stop_reason?: string;
    };
    expect(message.type).toBe("message");
    expect(message.stop_reason).toBeTruthy();
    expect(JSON.stringify(message)).not.toContain("connection_error");
  });
});

describe("ComposedHandler.handle — non-ok body: the provider's own words travel separately (196e6f8f port)", () => {
  test("a non-JSON SSE-frame body surfaces provider_message with the unwrapped sentence", async () => {
    // The non-JSON fallback wraps the WHOLE raw body as error.message — an SSE
    // frame. The unwrapped provider sentence must travel beside it.
    const frame =
      'event:error\ndata:{"code":"AccessDenied","message":"Model access denied.","request_id":"x"}';
    globalThis.fetch = (async () =>
      new Response(frame, { status: 403 })) as unknown as typeof fetch;
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(403);
    const err = captured.body?.error as { message?: string; provider_message?: string };
    // message keeps the raw frame (the fallback wrap — unchanged behavior)…
    expect(err.message).toContain("event:error");
    // …and the sentence rides in provider_message — unwrapped all the way to
    // the provider's words (string arm re-enters: frame → payload → message).
    expect(err.provider_message).toBe("Model access denied.");
  });

  test("a JSON error body does NOT duplicate itself into provider_message", async () => {
    const body = JSON.stringify({
      error: { type: "permission_error", message: "Model access denied." },
    });
    globalThis.fetch = (async () =>
      new Response(body, { status: 403 })) as unknown as typeof fetch;
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    const err = captured.body?.error as { message?: string; provider_message?: string };
    expect(err.message).toBe("Model access denied.");
    expect(Object.hasOwn(err, "provider_message")).toBe(false);
  });

  // The auth-retry return (401 → forceRefreshAuth → retried fetch non-ok) is
  // a SECOND wiring site with its own errorText. Before the CR fix it passed
  // the RAW text to the extractor: a JSON body re-stringified the whole
  // document into provider_message, duplicating message. Pinned here with a
  // transport that HAS forceRefreshAuth — without it the 401 branch never
  // fires and this site is untested (that is exactly how the bug survived).
  test("auth-retry path (forceRefreshAuth): a JSON body yields the nested sentence, no self-duplication", async () => {
    const transport = makeTransport() as unknown as Record<string, unknown>;
    transport.forceRefreshAuth = async () => {};
    const body = JSON.stringify({
      error: { type: "permission_error", message: "Token expired after refresh." },
    });
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      // #1: the 401 that triggers the forced refresh; #2: the retry's non-ok body
      return call === 1
        ? new Response("expired", { status: 401 })
        : new Response(body, { status: 403 });
    }) as unknown as typeof fetch;
    const { c, captured } = makeContext();
    const handler = new ComposedHandler(
      transport as unknown as ProviderTransport,
      "fugu-ultra",
      "fugu-ultra",
      8464,
      {}
    );
    await handler.handle(c, PAYLOAD);

    expect(captured.status).toBe(403);
    const err = captured.body?.error as { message?: string; provider_message?: string };
    // The envelope read the PARSED body: message is the provider's sentence…
    expect(err.message).toBe("Token expired after refresh.");
    // …not the whole JSON document, and the identical sentence does not ride
    // a second time in provider_message (the `!==` guard).
    expect(Object.hasOwn(err, "provider_message")).toBe(false);
  });

  test("auth-retry path (forceRefreshAuth): an SSE-frame body keeps the frame in message, the sentence in provider_message", async () => {
    const transport = makeTransport() as unknown as Record<string, unknown>;
    transport.forceRefreshAuth = async () => {};
    const frame =
      'event:error\ndata:{"code":"AccessDenied","message":"Refreshed token lacks scope.","request_id":"y"}';
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return call === 1
        ? new Response("expired", { status: 401 })
        : new Response(frame, { status: 403 });
    }) as unknown as typeof fetch;
    const { c, captured } = makeContext();
    const handler = new ComposedHandler(
      transport as unknown as ProviderTransport,
      "fugu-ultra",
      "fugu-ultra",
      8464,
      {}
    );
    await handler.handle(c, PAYLOAD);

    expect(captured.status).toBe(403);
    const err = captured.body?.error as { message?: string; provider_message?: string };
    expect(err.message).toContain("event:error");
    expect(err.provider_message).toBe("Refreshed token lacks scope.");
  });
});
