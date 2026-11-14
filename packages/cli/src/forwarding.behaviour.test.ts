import { expect, test } from "bun:test";
import { Hono } from "hono";
import { KEY, LOGIN, MODEL, isolatedFile } from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const {
    buildForwardRequest,
    LOGIN_ONLY_SIGNING,
    CLAUDE_SUBSCRIPTION_NO_LOGIN,
    CLAUDE_SUBSCRIPTION_API_KEY_REQUEST,
  } = await import("./handlers/shared/anthropic-forward.js");
  const { CLAUDISH_PLACEHOLDER_AUTH_TOKEN } = await import("./auth/claudish-placeholder.js");
  const { acquireSigningLease, redactSigningValues } = await import("./redact.js");
  const { createProxyServer } = await import("./proxy-server.js");
  type Signing = Parameters<typeof buildForwardRequest>[3];
  async function forward(signing: Signing, headers: Record<string, string> = {}) {
    const app = new Hono();
    app.post("/t", async (c) =>
      c.json(
        await buildForwardRequest(
          c,
          await c.req.json(),
          "https://api.anthropic.com/v1/messages",
          signing
        )
      )
    );
    const response = await app.request("/t", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", ...headers },
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  const payload = { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };

  test("B-59 forwards only login bearers under login-only signing", async () => {
    expect(await forward(LOGIN_ONLY_SIGNING)).toEqual({ refused: CLAUDE_SUBSCRIPTION_NO_LOGIN });
    expect(await forward(LOGIN_ONLY_SIGNING, { "x-api-key": KEY })).toEqual({
      refused: CLAUDE_SUBSCRIPTION_API_KEY_REQUEST,
    });
    expect(await forward(LOGIN_ONLY_SIGNING, { authorization: "Bearer gw-token-fake" })).toEqual({
      refused: CLAUDE_SUBSCRIPTION_NO_LOGIN,
    });
    const good = await forward(LOGIN_ONLY_SIGNING, {
      authorization: "Bearer " + LOGIN,
      "x-api-key": KEY,
    });
    expect(good.headers.authorization).toBe("Bearer " + LOGIN);
    expect(good.headers["x-api-key"]).toBeUndefined();
    expect(good.url).toBe("https://api.anthropic.com/v1/messages");
    expect(good.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("B-60 selects launch-key and inbound credentials without combining them", async () => {
    for (const bearer of [
      "Bearer " + CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
      "Bearer " + LOGIN,
      "Bearer gw-token-fake",
    ]) {
      const out = await forward(
        { kind: "launch-key", key: () => KEY },
        { authorization: bearer, "x-api-key": "other-fake-key" }
      );
      expect(out.headers["x-api-key"]).toBe(KEY);
      expect(out.headers.authorization).toBeUndefined();
    }
    const fallback = await forward({
      kind: "inbound",
      fallbackKey: async () => "fallback-fake-value",
    });
    expect(fallback.headers["x-api-key"]).toBe("fallback-fake-value");
    const forbidden = async () => {
      throw new Error("inbound credentials must not read a fallback key");
    };
    const login = await forward(
      { kind: "inbound", fallbackKey: forbidden },
      { authorization: "Bearer " + LOGIN, "x-api-key": KEY }
    );
    expect(login.headers.authorization).toBe("Bearer " + LOGIN);
    expect(login.headers["x-api-key"]).toBeUndefined();
    const key = await forward({ kind: "inbound", fallbackKey: forbidden }, { "x-api-key": KEY });
    expect(key.headers["x-api-key"]).toBe(KEY);
    expect(key.headers.authorization).toBeUndefined();
  });

  test("B-74 rejects unsigned subscription requests before the upstream", async () => {
    const received: Array<{ headers: Headers; body: unknown }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        received.push({ headers: req.headers, body: await req.json() });
        return Response.json({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        });
      },
    });
    const previous = process.env.CLAUDISH_TEST_UPSTREAM;
    process.env.CLAUDISH_TEST_UPSTREAM = upstream.url.origin;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;
    try {
      proxy = await createProxyServer(0, undefined, MODEL, true, undefined, undefined, {
        nativeSigning: LOGIN_ONLY_SIGNING,
      });
      const headerCases: Record<string, string>[] = [{}, { "x-api-key": KEY }];
      for (const headers of headerCases) {
        const response = await fetch(proxy.url + "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          type: "error",
          error: {
            type: "authentication_error",
            message: expect.stringContaining("Claude subscription session:"),
          },
        });
        expect(received).toEqual([]);
      }
      const response = await fetch(proxy.url + "/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + LOGIN,
          "x-api-key": KEY,
        },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(received).toHaveLength(1);
      expect(received[0].headers.get("authorization")).toBe("Bearer " + LOGIN);
      expect(received[0].headers.has("x-api-key")).toBe(false);
      expect(received[0].body).toEqual(payload);
    } finally {
      await proxy?.shutdown();
      upstream.stop(true);
      if (previous === undefined) delete process.env.CLAUDISH_TEST_UPSTREAM;
      else process.env.CLAUDISH_TEST_UPSTREAM = previous;
    }
  }, 20_000);

  test("B-87 redacts all encoded signing forms but never holds short values", () => {
    const key = 'plain"fake\\value0123';
    const once = JSON.stringify(key).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    const lease = acquireSigningLease();
    try {
      lease.add([key, "1234567"]);
      for (const form of [key, once, twice, encodeURIComponent(key)])
        expect(redactSigningValues("prefix " + form + " suffix")).toBe("prefix [redacted] suffix");
      expect(redactSigningValues("prefix 1234567 suffix")).toBe("prefix 1234567 suffix");
    } finally {
      lease.release();
    }
    expect(lease.released).toBe(true);
    expect(redactSigningValues(key)).toBe(key);
  });

  test("B-88 redacts an upstream echo using the forwarding signing lease", async () => {
    const key = "plainfakevalue0123456789";
    const received: { key: string | null } = { key: null };
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        received.key = req.headers.get("x-api-key");
        return Response.json(
          { type: "error", error: { type: "authentication_error", message: "rejected " + key } },
          { status: 401 }
        );
      },
    });
    const previous = process.env.CLAUDISH_TEST_UPSTREAM;
    process.env.CLAUDISH_TEST_UPSTREAM = upstream.url.origin;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;
    try {
      proxy = await createProxyServer(0, undefined, MODEL, true, undefined, undefined, {
        nativeSigning: { kind: "launch-key", key: () => key },
        claudeApiMainModel: MODEL,
      });
      const response = await fetch(proxy.url + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      expect(received.key).toBe(key);
      expect(text).not.toContain(key);
      expect(text).toContain("[redacted]");
    } finally {
      await proxy?.shutdown();
      upstream.stop(true);
      if (previous === undefined) delete process.env.CLAUDISH_TEST_UPSTREAM;
      else process.env.CLAUDISH_TEST_UPSTREAM = previous;
    }
  }, 20_000);
});
