import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import type { RequestAuth } from "../auth/credentials/types.js";
import type { ProviderTransport, SignRequestContext } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface CapturedJson {
  body?: unknown;
  status?: number;
}

function makeContext(): { context: Context; captured: CapturedJson } {
  const captured: CapturedJson = {};
  const context = {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number, headers?: HeadersInit) => {
      captured.body = body;
      captured.status = status;
      return new Response(JSON.stringify(body), { status: status ?? 200, headers });
    },
  } as unknown as Context;
  return { context, captured };
}

// Captured provider data, kept beside the translation tests per testing.md.
const CAPTURED_OPENAI_SUCCESS_SSE = readFileSync(
  join(import.meta.dir, "../test-fixtures/sse-responses/SEED-openai-text-only.sse"),
  "utf8"
);
const CAPTURED_RESPONSES_SUCCESS_SSE = readFileSync(
  join(import.meta.dir, "../test-fixtures/sse-responses/gpt-5.6-sol-responses-turn1.sse"),
  "utf8"
);

/**
 * PROVISIONAL: replace this constructed overload frame with the request-path
 * capture from D8 once that real Codex failure is available.
 */
const PROVISIONAL_OVERLOAD_SSE = `data: ${JSON.stringify({
  type: "error",
  error: {
    type: "api_error",
    code: "server_is_overloaded",
    message: "The server is overloaded. Please try again later.",
  },
})}\n\n`;

function auth(account: string, arm: "oauth" | "api-key" = "oauth"): RequestAuth {
  return {
    arm,
    endpoint: `http://upstream.test/${account}`,
    headers: {
      Authorization: `Bearer ${account}`,
      "x-account": account,
    },
    transformPayload: (payload) => ({ ...payload, signed_by: account }),
  };
}

function expectOAuthResignContexts(contexts: SignRequestContext[], codex = false): void {
  expect(contexts).toHaveLength(2);
  expect(contexts[0]).toMatchObject({ requireOAuth: false });
  expect(contexts[0].forceRefresh).toBeUndefined();
  expect(contexts[1]).toMatchObject({
    forceRefresh: true,
    requireOAuth: true,
    exclude: [],
    rejected: { headers: { Authorization: "Bearer stale-account" } },
  });
  if (codex) {
    expect(contexts[0].selectionContext).toMatchObject({
      provider: "openai-codex",
      failed: expect.any(Map),
      leaseFailures: expect.any(Map),
      reauthAttempts: expect.any(Map),
    });
    expect(contexts[1].selectionContext).toBe(contexts[0].selectionContext);
  } else {
    expect(contexts[0].selectionContext).toBeUndefined();
    expect(contexts[1].selectionContext).toBeUndefined();
  }
  // Mutations caught: omit rejected, requireOAuth or request-local selection evidence.
}

function requestPayload(marker: string): Record<string, unknown> {
  return {
    model: "auth-test-model",
    max_tokens: 16,
    messages: [{ role: "user", content: marker }],
  };
}

function bodyHash(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("expected the test request body to be JSON text");
  return createHash("sha256").update(body).digest("hex");
}

describe("ComposedHandler request signing", () => {
  test("a 401 on OAuth re-signs exactly once and rebuilds endpoint and headers", async () => {
    const signContexts: SignRequestContext[] = [];
    const stale = auth("stale-account");
    const fresh = auth("fresh-account");
    const transport: ProviderTransport = {
      name: "auth-test",
      displayName: "Auth Test",
      streamFormat: "openai-sse",
      // v14 rebase: the handler re-signs only through forceRefreshAuth.
      async forceRefreshAuth(ctx) {
        return { auth: await this.signRequest!({ ...ctx, forceRefresh: true }) };
      },
      signRequest: async (ctx) => {
        signContexts.push({ ...ctx });
        return ctx.forceRefresh ? fresh : stale;
      },
      transformPayload: (payload, _claudeRequest, artifact) =>
        artifact?.auth?.transformPayload?.(payload) ?? payload,
      getEndpoint: (_model, artifact) => artifact?.auth?.endpoint ?? "http://wrong-endpoint.test",
      getHeaders: async (_claudeRequest, artifact) => ({ ...(artifact?.auth?.headers ?? {}) }),
    };
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "expired bearer" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(CAPTURED_OPENAI_SUCCESS_SSE, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const handler = new ComposedHandler(transport, "auth-test-model", "auth-test-model", 8080, {});
    const { context } = makeContext();
    const response = await handler.handle(context, requestPayload("refresh me"));
    const body = (await response.json()) as { content?: Array<{ text?: string }> };

    expectOAuthResignContexts(signContexts, transport.name === "openai-codex");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual([
      "http://upstream.test/stale-account",
      "http://upstream.test/fresh-account",
    ]);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer stale-account");
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBe("Bearer fresh-account");
    expect(calls[0].init?.body).toBe(calls[1].init?.body);
    expect(body.content?.[0]?.text).toBe("Hello, I'm a test model.");

    // Mutations caught: remove the forceRefreshAuth 401 branch, omit
    // forceRefresh:true, or rebuild only headers while retaining the old endpoint.
  });

  for (const scenario of [
    {
      name: "401",
      status: 401,
      body: { error: { message: "the refreshed bearer is also rejected" } },
      hint: "Check API key / OAuth credentials.",
    },
    {
      name: "terminal 429",
      status: 429,
      body: {
        error: {
          message: "Token Plan usage limit reached: upgrade or wait for the next cycle.",
        },
      },
      hint: "Plan limit reached",
    },
  ]) {
    test(`a ${scenario.name} after one re-sign is remapped to a terminal 400`, async () => {
      const signContexts: SignRequestContext[] = [];
      const stale = auth("stale-account");
      const fresh = auth("fresh-account");
      const transport: ProviderTransport = {
        name: "auth-test",
        displayName: "Auth Test",
        streamFormat: "openai-sse",
        // v14 rebase: the handler re-signs only through forceRefreshAuth.
        async forceRefreshAuth(ctx) {
          return { auth: await this.signRequest!({ ...ctx, forceRefresh: true }) };
        },
        signRequest: async (ctx) => {
          signContexts.push({ ...ctx });
          return ctx.forceRefresh ? fresh : stale;
        },
        getEndpoint: (_model, artifact) => artifact?.auth?.endpoint ?? "http://wrong-endpoint.test",
        getHeaders: async (_claudeRequest, artifact) => ({ ...(artifact?.auth?.headers ?? {}) }),
      };
      const calls: FetchCall[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, init });
        if (calls.length === 1) {
          return new Response(JSON.stringify({ error: { message: "expired bearer" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(scenario.body), {
          status: scenario.status,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const handler = new ComposedHandler(
        transport,
        "auth-test-model",
        "auth-test-model",
        8080,
        {}
      );
      const { context, captured } = makeContext();
      const response = await handler.handle(context, requestPayload(`retry ${scenario.name}`));

      expectOAuthResignContexts(signContexts, transport.name === "openai-codex");
      expect(calls).toHaveLength(2);
      expect(response.status).toBe(400);
      expect(captured.status).toBe(400);
      expect((captured.body as any)?.error?.upstream_status).toBe(scenario.status);
      expect((captured.body as any)?.error?.message).toContain(scenario.hint);

      // Mutation caught: return retryResp directly or enter the 401 branch again.
      // Either leaks the raw 401/429 or records a third signing context.
    });
  }

  test("a forced re-sign failure is a terminal 400 with the login hint", async () => {
    const signContexts: SignRequestContext[] = [];
    const stale = auth("stale-account");
    const refreshError = Object.assign(
      new Error("OpenAI Codex login expired — run `claudish login codex` to sign in again."),
      { terminal: true, upstreamStatus: 401 }
    );
    const transport: ProviderTransport = {
      name: "openai-codex",
      displayName: "OpenAI Codex",
      streamFormat: "openai-sse",
      // v14 rebase: the handler re-signs only through forceRefreshAuth.
      async forceRefreshAuth(ctx) {
        return { auth: await this.signRequest!({ ...ctx, forceRefresh: true }) };
      },
      signRequest: async (ctx) => {
        signContexts.push({ ...ctx });
        if (ctx.forceRefresh) throw refreshError;
        return stale;
      },
      getEndpoint: (_model, artifact) => artifact?.auth?.endpoint ?? "http://wrong-endpoint.test",
      getHeaders: async (_claudeRequest, artifact) => ({ ...(artifact?.auth?.headers ?? {}) }),
    };
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: { message: "expired bearer" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const handler = new ComposedHandler(transport, "auth-test-model", "auth-test-model", 8080, {});
    const { context, captured } = makeContext();
    const response = await handler.handle(context, requestPayload("refresh throws"));

    expectOAuthResignContexts(signContexts, transport.name === "openai-codex");
    expect(calls).toHaveLength(1);
    expect(response.status).toBe(400);
    expect(captured.status).toBe(400);
    expect(response.headers.get("x-claudish-auth-verdict")).toBe("terminal");
    expect((captured.body as any)?.error?.type).toBe("invalid_request_error");
    expect((captured.body as any)?.error?.upstream_status).toBe(401);
    expect((captured.body as any)?.error?.message).toContain("claudish login codex");

    // Mutation caught: restore the bare-401 catch or retry the refresh. The client
    // status changes to 401 or a third signing context/outbound call appears.
  });

  test("stream-head re-issues use the re-signed endpoint and bearer with identical bytes", async () => {
    const signContexts: SignRequestContext[] = [];
    const stale = auth("stale-account");
    const fresh = auth("fresh-account");
    const transport: ProviderTransport = {
      name: "openai-codex",
      displayName: "OpenAI Codex",
      streamFormat: "openai-responses-sse",
      async forceRefreshAuth(ctx) {
        return { auth: await this.signRequest!({ ...ctx, forceRefresh: true }) };
      },
      overrideStreamFormat: () => "openai-responses-sse",
      signRequest: async (ctx) => {
        signContexts.push({ ...ctx });
        return ctx.forceRefresh ? fresh : stale;
      },
      transformPayload: (payload, _claudeRequest, artifact) =>
        artifact?.auth?.transformPayload?.(payload) ?? payload,
      getEndpoint: (_model, artifact) => artifact?.auth?.endpoint ?? "http://wrong-endpoint.test",
      getHeaders: async (_claudeRequest, artifact) => ({ ...(artifact?.auth?.headers ?? {}) }),
    };
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("http://upstream.test/")) return new Response(null, { status: 404 });
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "expired bearer" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (calls.length === 2) {
        return new Response(PROVISIONAL_OVERLOAD_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(CAPTURED_RESPONSES_SUCCESS_SSE, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    expect((await fetch("http://foreign.test/catalog")).status).toBe(404);
    const handler = new ComposedHandler(transport, "gpt-5.1-codex", "gpt-5.1-codex", 8080, {});
    const response = await handler.handle(makeContext().context, {
      ...requestPayload("refresh then overload"),
      model: "gpt-5.1-codex",
      stream: true,
    });
    await response.text();

    expectOAuthResignContexts(signContexts, transport.name === "openai-codex");
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual([
      "http://upstream.test/stale-account",
      "http://upstream.test/fresh-account",
      "http://upstream.test/fresh-account",
    ]);
    expect(calls.map((call) => new Headers(call.init?.headers).get("authorization"))).toEqual([
      "Bearer stale-account",
      "Bearer fresh-account",
      "Bearer fresh-account",
    ]);
    expect(new Set(calls.map((call) => bodyHash(call.init?.body))).size).toBe(1);

    // Mutation caught: make doFetch close over the pre-refresh endpoint/headers.
    // The third call then re-sends the rejected bearer (and often the old host).
  }, 10_000);

  test("a 401 on the api-key arm is not re-signed", async () => {
    const signContexts: SignRequestContext[] = [];
    const metered = auth("metered-key", "api-key");
    const transport: ProviderTransport = {
      name: "auth-test",
      displayName: "Auth Test",
      streamFormat: "openai-sse",
      // v14 rebase: the handler re-signs only through forceRefreshAuth.
      async forceRefreshAuth(ctx) {
        return { auth: await this.signRequest!({ ...ctx, forceRefresh: true }) };
      },
      signRequest: async (ctx) => {
        signContexts.push({ ...ctx });
        return metered;
      },
      getEndpoint: (_model, artifact) => artifact?.auth?.endpoint ?? "http://wrong-endpoint.test",
      getHeaders: async (_claudeRequest, artifact) => ({ ...(artifact?.auth?.headers ?? {}) }),
    };
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const handler = new ComposedHandler(transport, "auth-test-model", "auth-test-model", 8080, {});
    const { context, captured } = makeContext();
    await handler.handle(context, requestPayload("bad key"));

    expect(signContexts).toHaveLength(1);
    expect(signContexts[0]).toMatchObject({ requireOAuth: false });
    expect(signContexts[0].forceRefresh).toBeUndefined();
    expect(signContexts[0].selectionContext).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(captured.status).toBe(400);

    // Mutation caught: drop the `auth.arm === "oauth"` guard. That mutant signs
    // and sends a second metered request even though refresh cannot repair a key.
  });

  test("keeps auth identity request-scoped under an explicit two-request barrier", async () => {
    let releaseSignings: () => void = () => {};
    let reportBothSigning: () => void = () => {};
    const signingGate = new Promise<void>((resolve) => {
      releaseSignings = resolve;
    });
    const bothSigningsStarted = new Promise<void>((resolve) => {
      reportBothSigning = resolve;
    });
    const artifacts = [auth("token-A"), auth("token-B")];
    let signCalls = 0;
    let sharedAuth: RequestAuth | undefined;

    // This transport deliberately keeps a shared fallback slot, modelling the old
    // cachedAuth hazard. Correct code always passes the request-local artifact, so
    // the fallback is never observed. If the explicit threading is removed, both
    // requests read whichever sign completed last.
    const transport: ProviderTransport = {
      name: "auth-test",
      displayName: "Auth Test",
      streamFormat: "openai-sse",
      // v14 rebase: the handler re-signs only through forceRefreshAuth.
      async forceRefreshAuth(ctx) {
        return { auth: await this.signRequest!({ ...ctx, forceRefresh: true }) };
      },
      signRequest: async () => {
        const index = signCalls++;
        if (signCalls === 2) reportBothSigning();
        await signingGate;
        const artifact = artifacts[index];
        sharedAuth = artifact;
        return artifact;
      },
      transformPayload: (payload, _claudeRequest, artifact) => {
        const selected = artifact?.auth ?? sharedAuth;
        return { ...payload, signed_by: selected?.headers["x-account"] };
      },
      getEndpoint: (_model, artifact) => {
        const selected = artifact?.auth ?? sharedAuth;
        return selected?.endpoint ?? "http://wrong-endpoint.test";
      },
      getHeaders: async (_claudeRequest, artifact) => ({
        ...((artifact?.auth ?? sharedAuth)?.headers ?? {}),
      }),
    };
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return new Response(CAPTURED_OPENAI_SUCCESS_SSE, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const handler = new ComposedHandler(transport, "auth-test-model", "auth-test-model", 8080, {});
    const first = handler.handle(makeContext().context, requestPayload("request-A"));
    const second = handler.handle(makeContext().context, requestPayload("request-B"));

    await bothSigningsStarted;
    releaseSignings();
    const responses = await Promise.all([first, second]);
    await Promise.all(responses.map((response) => response.arrayBuffer()));

    expect(signCalls).toBe(2);
    expect(calls).toHaveLength(2);
    const observed = new Map<
      string,
      { authorization: string | null; endpoint: string; signedBy?: string }
    >();
    for (const call of calls) {
      const body = JSON.parse(String(call.init?.body)) as {
        signed_by?: string;
        messages?: Array<{ content?: string }>;
      };
      const serialized = JSON.stringify(body);
      const marker = ["request-A", "request-B"].find((candidate) => serialized.includes(candidate));
      expect(marker).toBeDefined();
      observed.set(marker!, {
        authorization: new Headers(call.init?.headers).get("authorization"),
        endpoint: call.url,
        signedBy: body.signed_by,
      });
    }
    expect(Object.fromEntries(observed)).toEqual({
      "request-A": {
        authorization: "Bearer token-A",
        endpoint: "http://upstream.test/token-A",
        signedBy: "token-A",
      },
      "request-B": {
        authorization: "Bearer token-B",
        endpoint: "http://upstream.test/token-B",
        signedBy: "token-B",
      },
    });

    // Mutation caught: restoring a single shared cachedAuth artifact makes request A
    // reuse token-B after the barrier, instead of carrying its own token-A artifact.
  });
});
