import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { GrokModelDialect } from "../adapters/grok-model-dialect.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";
import { FallbackHandler } from "./fallback-handler.js";
import type { ModelHandler } from "./types.js";

/**
 * The five sites in ComposedHandler that make an outbound call which can throw
 * WITHOUT a Response, and what each one is allowed to answer.
 *
 * Four of them used to answer something untrue when the failure was the
 * network rather than the credential:
 *
 *   1. `refreshAuth` catch          → unconditional 401
 *   2. `forceRefreshAuth` catch     → unconditional 401 (wraps the retry fetch too)
 *   3. parameter-recovery re-fetch  → no `try` at all; escaped `handle()`
 *   4. `getHeaders()`               → outside every `try`; escaped `handle()`
 *   5. the primary fetch            → already classified (the control)
 *
 * 401 is not a cosmetic mislabel. `fallback-handler.ts`'s `isRetryableError`
 * reads 401 as retryable, so a network outage during a token refresh ADVANCES
 * THE CHAIN — moving a subscription user onto a per-token provider, mid-outage,
 * for a fault that had nothing to do with their credentials. An escaped throw
 * does the same thing one layer out: `fallback-handler.ts`'s catch records
 * `status: 0` and advances unconditionally, without even the cost warning.
 *
 * So the assertions that matter here are ABSENCES: not 401, and no chain
 * advance. A test that only checked the status of the first response would pass
 * against the bug.
 *
 * These tests add NO retry machinery and assert none — the retry ladder is a
 * later phase. This phase only stops the misclassification.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Fixtures — PROVOKED, not hand-written
// ---------------------------------------------------------------------------

/**
 * A real Bun connect failure, taken by actually failing to connect.
 *
 * Hand-writing `{ code: "ECONNREFUSED" }` would test the classifier's table
 * rather than the runtime's behaviour, and claudish runs on Bun, whose fetch
 * uses NEITHER Node's errno names NOR `.cause` — it throws a flat TypeError
 * carrying its own `code`. Measured on this machine:
 *
 *   { name: "TypeError",
 *     message: "Unable to connect. Is the computer able to access the url?",
 *     code: "ConnectionRefused", errno: 0,
 *     path: "http://127.0.0.1:1/x", cause: undefined }
 *
 * Port 1 is privileged and unbound, so this is refused in ~1 ms with no network
 * involved — hermetic, and it cannot drift away from what Bun really throws.
 */
let CONNECT_FAILURE: unknown;
beforeAll(async () => {
  try {
    await realFetch("http://127.0.0.1:1/refused-on-purpose");
    throw new Error("127.0.0.1:1 accepted a connection — this fixture needs a closed port");
  } catch (e) {
    CONNECT_FAILURE = e;
  }
  // Guard the guard: if Bun ever stops setting a recognisable code, every test
  // below would go green for the wrong reason.
  expect((CONNECT_FAILURE as { code?: string }).code).toBe("ConnectionRefused");
});

/** The shape a transport produces when it wraps a connect failure it caught. */
function wrappedConnectFailure(message: string): Error {
  return new Error(message, { cause: CONNECT_FAILURE });
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface TransportHooks {
  refreshAuth?: () => Promise<void>;
  forceRefreshAuth?: () => Promise<void>;
  getHeaders?: () => Promise<Record<string, string>>;
}

function makeTransport(hooks: TransportHooks = {}): ProviderTransport {
  const t: Record<string, unknown> = {
    name: "sakana",
    displayName: "Sakana Fugu",
    streamFormat: "openai-sse",
    getEndpoint: () => "https://api.sakana.example/v1/chat/completions",
    getHeaders: hooks.getHeaders ?? (async () => ({})),
  };
  if (hooks.refreshAuth) t.refreshAuth = hooks.refreshAuth;
  if (hooks.forceRefreshAuth) t.forceRefreshAuth = hooks.forceRefreshAuth;
  return t as unknown as ProviderTransport;
}

interface CapturedResponse {
  body?: { type?: string; error?: { type?: string; message?: string } };
  status?: number;
}

function makeContext(): { c: Context; captured: CapturedResponse } {
  const captured: CapturedResponse = {};
  const c = {
    // These tests exercise CLASSIFICATION and STATUS, not the retry ladder —
    // see the file header: "These tests add NO retry machinery and assert
    // none." They opt out of the ladder exactly the way `probe-live.ts:157`
    // does, with the header `composed-handler.ts:441` reads.
    //
    // Without this, a provoked connect failure enters the ladder and every
    // assertion below times out at the test runner's limit instead of failing
    // honestly — 12 tests reporting ~5000ms, which reads as a hang rather than
    // as the deliberate behaviour change it is.
    req: {
      header: (name?: string) =>
        name === undefined ? {} : name === "x-claudish-no-recovery" ? "1" : undefined,
    },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) => {
      captured.body = body as CapturedResponse["body"];
      captured.status = status;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
  } as unknown as Context;
  return { c, captured };
}

const PAYLOAD = {
  model: "fugu-ultra",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

function makeHandler(transport: ProviderTransport, model = "fugu-ultra"): ComposedHandler {
  return new ComposedHandler(transport, model, model, 8080, {});
}

/**
 * Run `handler` as the FIRST candidate of a two-candidate chain and report
 * whether the SECOND was ever reached.
 *
 * This is the assertion that costs money when it is wrong: candidate 2 is the
 * metered provider a subscription user gets silently moved onto.
 */
async function runInChain(first: ModelHandler): Promise<{
  status: number;
  advanced: boolean;
  body: string;
}> {
  let advanced = false;
  const second: ModelHandler = {
    async handle() {
      advanced = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  } as unknown as ModelHandler;

  const chain = new FallbackHandler([
    { name: "Sakana Fugu", handler: first },
    { name: "Metered Fallback", handler: second },
  ]);
  const { c } = makeContext();
  const response = await chain.handle(c, PAYLOAD);
  return { status: response.status, advanced, body: await response.text() };
}

// ---------------------------------------------------------------------------
// Site 1 — the `refreshAuth` catch
// ---------------------------------------------------------------------------

describe("site 1: refreshAuth", () => {
  test("a connection failure answers connection_error 400, never 401", async () => {
    const handler = makeHandler(
      makeTransport({
        refreshAuth: async () => {
          // What LocalTransport / VertexOAuth now throw: their own sentence with
          // the real syscall error preserved as `cause`.
          throw wrappedConnectFailure("Cannot connect to Ollama at http://localhost:11434.");
        },
      })
    );
    const { c, captured } = makeContext();

    await handler.handle(c, PAYLOAD);

    expect(captured.status).not.toBe(401);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
  });

  test("classification happens BEFORE the terminal check, not after", async () => {
    // A transport can mark an error terminal AND have it be a connect failure —
    // ordering decides which reading wins, and only the network one is true.
    const err = wrappedConnectFailure("Sakana auth failed") as Error & { terminal?: boolean };
    err.terminal = true;
    const handler = makeHandler(
      makeTransport({
        refreshAuth: async () => {
          throw err;
        },
      })
    );
    const { c, captured } = makeContext();

    await handler.handle(c, PAYLOAD);

    expect(captured.body?.error?.type).toBe("connection_error");
    expect(captured.body?.error?.type).not.toBe("invalid_request_error");
  });

  test("THE MONEY TEST: a connection failure does not advance the fallback chain", async () => {
    const handler = makeHandler(
      makeTransport({
        refreshAuth: async () => {
          throw wrappedConnectFailure("Cannot connect to Ollama at http://localhost:11434.");
        },
      })
    );

    const { status, advanced, body } = await runInChain(handler);

    // The absence is the point: candidate 2 bills per token.
    expect(advanced).toBe(false);
    expect(status).toBe(400);
    expect(body).toContain("connection_error");
  });

  // ── Unchanged behaviour, pinned so the fix cannot over-reach ──────────────

  test("a terminal NON-connection failure still answers 400 invalid_request_error", async () => {
    const err = new Error("Entitlement revoked") as Error & { terminal?: boolean };
    err.terminal = true;
    const handler = makeHandler(
      makeTransport({
        refreshAuth: async () => {
          throw err;
        },
      })
    );
    const { c, captured } = makeContext();

    await handler.handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("invalid_request_error");
  });

  test("an ordinary auth failure still answers 401 and still advances the chain", async () => {
    const handler = makeHandler(
      makeTransport({
        refreshAuth: async () => {
          throw new Error("Invalid API key");
        },
      })
    );
    const { c, captured } = makeContext();
    await handler.handle(c, PAYLOAD);
    expect(captured.status).toBe(401);
    expect(captured.body?.error?.type).toBe("authentication_error");

    // And the chain still advances for it — this fix must not have turned every
    // auth failure into a dead end.
    const chainHandler = makeHandler(
      makeTransport({
        refreshAuth: async () => {
          throw new Error("Invalid API key");
        },
      })
    );
    const { advanced } = await runInChain(chainHandler);
    expect(advanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Site 4 — `getHeaders()`, which used to sit outside every `try`
// ---------------------------------------------------------------------------

describe("site 4: getHeaders", () => {
  test("a connection failure answers connection_error 400 instead of escaping handle()", async () => {
    const handler = makeHandler(
      makeTransport({
        // For `gk@` this is the request's FIRST network touch:
        // resolveGrokAccessToken() → fetch(auth.x.ai/oauth2/token).
        getHeaders: async () => {
          throw wrappedConnectFailure(
            "Could not reach https://auth.x.ai/oauth2/token to refresh the Grok token"
          );
        },
      })
    );
    const { c, captured } = makeContext();

    const response = await handler.handle(c, PAYLOAD);

    expect(response.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
  });

  test("a connection failure in getHeaders does not advance the fallback chain", async () => {
    const handler = makeHandler(
      makeTransport({
        getHeaders: async () => {
          throw wrappedConnectFailure("Could not reach https://auth.x.ai/oauth2/token");
        },
      })
    );

    const { advanced, status } = await runInChain(handler);

    expect(advanced).toBe(false);
    expect(status).toBe(400);
  });

  test("a NON-connection failure in getHeaders still escapes unchanged", async () => {
    // Deliberately unchanged: only the classified case is claimed here. An
    // unclassified throw keeps its existing route out of handle().
    const handler = makeHandler(
      makeTransport({
        getHeaders: async () => {
          throw new Error("no credential configured");
        },
      })
    );
    const { c } = makeContext();

    expect(handler.handle(c, PAYLOAD)).rejects.toThrow("no credential configured");
  });
});

// ---------------------------------------------------------------------------
// Site 2 — the `forceRefreshAuth` catch, which wraps the 401-retry fetch too
// ---------------------------------------------------------------------------

describe("site 2: forceRefreshAuth", () => {
  /** Upstream answers 401 once, which is what opens the forced-refresh branch. */
  function stub401() {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "token expired" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("a connection failure during the forced refresh is not an authentication_error", async () => {
    stub401();
    const handler = makeHandler(
      makeTransport({
        forceRefreshAuth: async () => {
          throw wrappedConnectFailure("Could not reach https://auth.x.ai/oauth2/token");
        },
      })
    );
    const { c, captured } = makeContext();

    await handler.handle(c, PAYLOAD);

    expect(captured.status).not.toBe(401);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
  });

  test("the retry fetch inside the same try is covered too", async () => {
    // The forced refresh SUCCEEDS; the network dies on the retry request that
    // follows it — inside the same `try`, and previously reported as 401.
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: "token expired" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw CONNECT_FAILURE;
    }) as unknown as typeof fetch;

    const handler = makeHandler(makeTransport({ forceRefreshAuth: async () => {} }));
    const { c, captured } = makeContext();

    await handler.handle(c, PAYLOAD);

    expect(call).toBe(2);
    expect(captured.status).not.toBe(401);
    expect(captured.body?.error?.type).toBe("connection_error");
  });

  test("a connection failure during the forced refresh does not advance the chain", async () => {
    stub401();
    const handler = makeHandler(
      makeTransport({
        forceRefreshAuth: async () => {
          throw wrappedConnectFailure("Could not reach https://auth.x.ai/oauth2/token");
        },
      })
    );

    const { advanced, status } = await runInChain(handler);

    expect(advanced).toBe(false);
    expect(status).toBe(400);
  });

  test("an ordinary forced-refresh failure still answers 401", async () => {
    stub401();
    const handler = makeHandler(
      makeTransport({
        forceRefreshAuth: async () => {
          throw new Error("refresh token rejected");
        },
      })
    );
    const { c, captured } = makeContext();

    await handler.handle(c, PAYLOAD);

    expect(captured.status).toBe(401);
    expect(captured.body?.error?.type).toBe("authentication_error");
  });
});

// ---------------------------------------------------------------------------
// Site 3 — the parameter-recovery re-fetch, which had no `try` at all
// ---------------------------------------------------------------------------

describe("site 3: parameter-recovery re-fetch", () => {
  // Explicitly supply GrokModelDialect to exercise `recoverFromRejection`.
  // The id is unique to this file on purpose: the
  // dialect memoises "this model rejected reasoning_effort" at module scope,
  // and Bun shares that module across test files in a run.
  const MODEL = "grok-9-connfail-probe";
  const PARAM_REJECTION = `Model ${MODEL} does not support parameter reasoningEffort.`;
  const GROK_PAYLOAD = {
    ...PAYLOAD,
    model: MODEL,
    output_config: { effort: "high" },
  };

  test("a connection failure on the re-fetch answers connection_error, not an escape", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: PARAM_REJECTION } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw CONNECT_FAILURE;
    }) as unknown as typeof fetch;

    const handler = new ComposedHandler(makeTransport(), MODEL, MODEL, 8080, {
      dialect: new GrokModelDialect(MODEL),
    });
    const { c, captured } = makeContext();

    const response = await handler.handle(c, GROK_PAYLOAD);

    // Two calls means the recovery branch really did re-fetch — without this the
    // test would pass on a payload that never carried reasoning_effort at all.
    expect(call).toBe(2);
    expect(response.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
    // The network is what is wrong NOW; re-reporting the parameter complaint
    // would send the chain hunting for a provider that accepts it while the
    // machine is offline.
    expect(captured.body?.error?.message).not.toContain("reasoningEffort");
  });
});
