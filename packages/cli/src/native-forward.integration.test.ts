// HTTP-level test of the native passthrough's request side. Drives the REAL
// proxy over loopback and stubs the outbound `fetch`, so the request
// NativeHandler sends to api.anthropic.com is captured exactly: its URL, its
// headers and its body text.

import { afterEach, describe, expect, test } from "bun:test";
import { createProxyServer } from "./proxy-server.js";

const realFetch = globalThis.fetch.bind(globalThis);

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Replace global fetch: capture + canned-answer api.anthropic.com, neutralize everything else. */
function stubFetch(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("api.anthropic.com")) {
      calls.push({
        url,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: String(init?.body),
      });
      if (url.includes("/v1/messages/count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

// Spacing JSON.stringify never produces, so a re-serialisation shows.
const RAW =
  '{ "model" : "claude-opus-4-8", "max_tokens":64,\n  "messages": [ {"role": "user", "content": "hi"} ] }';

describe("native passthrough request (HTTP)", () => {
  let proxy: Awaited<ReturnType<typeof createProxyServer>> | null = null;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (proxy) await proxy.shutdown();
    proxy = null;
  });

  test("forwards Claude Code's headers, query string and body bytes unchanged", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });

    const res = await realFetch(`${proxy.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-oauth-token",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "session-http-1",
        "x-app": "cli",
      },
      body: RAW,
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(calls[0]!.body).toBe(RAW);
    expect(calls[0]!.headers["x-claude-code-session-id"]).toBe("session-http-1");
    expect(calls[0]!.headers["x-app"]).toBe("cli");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-oauth-token");
    expect(calls[0]!.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers).not.toHaveProperty("Content-Type");
    expect(calls[0]!.headers).not.toHaveProperty("host");
    expect(calls[0]!.headers).not.toHaveProperty("content-length");
  });

  test("forwards only the beta query parameter, never a credential in the query", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });

    const res = await realFetch(`${proxy.url}/v1/messages?beta=true&access_token=x&key=y`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-oauth-token" },
      body: RAW,
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  test("sends the new serialisation when the proxy rewrote the payload", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      classifier: { enabled: true, model: "claude-sonnet-5" },
    });
    const classifierRaw =
      '{ "model" : "claude-opus-4-8", "max_tokens":64, "system": [ {"type": "text", "text": "You are a security monitor for autonomous AI coding agents. Decide whether the tool call is safe."} ], "messages": [ {"role": "user", "content": "classify"} ] }';

    const res = await realFetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-oauth-token" },
      body: classifierRaw,
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.body);
    expect(sent.model).toBe("claude-sonnet-5");
    expect(calls[0]!.body).toBe(JSON.stringify(sent));
  });
});

describe("native count_tokens request (HTTP)", () => {
  let proxy: Awaited<ReturnType<typeof createProxyServer>> | null = null;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (proxy) await proxy.shutdown();
    proxy = null;
  });

  test("forwards Claude Code's allowed headers, the beta parameter and the body bytes", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });

    const res = await realFetch(`${proxy.url}/v1/messages/count_tokens?beta=true&access_token=x`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-oauth-token",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "session-count-1",
        "x-app": "cli",
        Cookie: "session=gateway-cookie",
        "X-Gateway-Token": "gateway-secret",
      },
      body: RAW,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    expect(calls[0]!.body).toBe(RAW);
    expect(calls[0]!.headers["x-claude-code-session-id"]).toBe("session-count-1");
    expect(calls[0]!.headers["x-app"]).toBe("cli");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-oauth-token");
    expect(calls[0]!.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    const names = Object.keys(calls[0]!.headers).map((name) => name.toLowerCase());
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("x-gateway-token");
    expect(names).not.toContain("host");
    expect(names).not.toContain("content-length");
  });

  test("sends an inbound bearer named by Connection, not the fallback key", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(
      0,
      undefined,
      undefined,
      false,
      "sk-ant-fallback-key",
      undefined,
      { quiet: true }
    );

    const res = await realFetch(`${proxy.url}/v1/messages/count_tokens?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-oauth-token",
        Connection: "authorization",
      },
      body: RAW,
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer test-oauth-token");
    expect(calls[0]!.headers).not.toHaveProperty("x-api-key");
    expect(calls[0]!.headers).not.toHaveProperty("connection");
  });

  test("sends the fallback key when the request arrived with no auth", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(
      0,
      undefined,
      undefined,
      false,
      "sk-ant-fallback-key",
      undefined,
      { quiet: true }
    );

    const res = await realFetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: RAW,
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant-fallback-key");
    expect(calls[0]!.headers).not.toHaveProperty("authorization");
  });
});

for (const route of ["/v1/messages", "/v1/messages/count_tokens"]) {
  describe(`native credential pair on ${route} (HTTP)`, () => {
    const OAUTH_BEARER = "Bearer sk-ant-oat-forward-test";
    const API_KEY = "sk-ant-inbound-key";
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | null = null;

    afterEach(async () => {
      globalThis.fetch = realFetch;
      if (proxy) await proxy.shutdown();
      proxy = null;
    });

    async function send(auth: Record<string, string>): Promise<CapturedCall> {
      const calls = stubFetch();
      proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
        quiet: true,
      });
      const res = await realFetch(`${proxy.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: RAW,
      });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      return calls[0]!;
    }

    test("sends only the bearer when an OAuth bearer arrives with an x-api-key", async () => {
      const call = await send({ authorization: OAUTH_BEARER, "x-api-key": API_KEY });
      expect(call.headers.authorization).toBe(OAUTH_BEARER);
      expect(call.headers).not.toHaveProperty("x-api-key");
    });

    test("sends an x-api-key that arrives alone", async () => {
      const call = await send({ "x-api-key": API_KEY });
      expect(call.headers["x-api-key"]).toBe(API_KEY);
      expect(call.headers).not.toHaveProperty("authorization");
    });

    test("sends an OAuth bearer that arrives alone", async () => {
      const call = await send({ authorization: OAUTH_BEARER });
      expect(call.headers.authorization).toBe(OAUTH_BEARER);
      expect(call.headers).not.toHaveProperty("x-api-key");
    });

    test("sends both when the bearer is not an OAuth token", async () => {
      const call = await send({ authorization: "Bearer gateway-token", "x-api-key": API_KEY });
      expect(call.headers.authorization).toBe("Bearer gateway-token");
      expect(call.headers["x-api-key"]).toBe(API_KEY);
    });

    test("sends both when an api key helper's value fills both headers", async () => {
      const call = await send({ authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY });
      expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(call.headers["x-api-key"]).toBe(API_KEY);
    });
  });
}
