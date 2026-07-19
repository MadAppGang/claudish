// HTTP-level integration test for classifier passthrough. Drives the REAL proxy
// server (Hono + @hono/node-server) over loopback and stubs the outbound `fetch`
// so NativeHandler's call to api.anthropic.com is intercepted — no real network,
// no credentials. Validates the routing short-circuit end to end: reroute to
// native, model rewrite, `thinking` strip (Risk R1), and verbatim forwarding of
// the system array (incl. the billing block) and the inbound OAuth header.

import { afterEach, describe, expect, test } from "bun:test";
import { createProxyServer } from "./proxy-server.js";

const realFetch = globalThis.fetch.bind(globalThis);

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
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
      const headers: Record<string, string> = {};
      const h = (init?.headers ?? {}) as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
      calls.push({ url, headers, body: JSON.parse(init?.body as string) });
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "allow" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // Neutralize background warmers (pricing / recommended / catalog) and anything else.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const CLASSIFIER_BODY = {
  model: "claude-opus-4-8",
  thinking: { type: "enabled", budget_tokens: 1024 },
  temperature: 0,
  max_tokens: 64,
  system: [
    { type: "text", text: "x-anthropic-billing-header: opaque-billing-token" },
    {
      type: "text",
      text: "You are a security monitor for autonomous AI coding agents. Decide whether the tool call is safe.",
    },
  ],
  messages: [{ role: "user", content: "classify this tool call" }],
};

describe("classifier passthrough (HTTP)", () => {
  let proxy: Awaited<ReturnType<typeof createProxyServer>> | null = null;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (proxy) await proxy.shutdown();
    proxy = null;
  });

  test("reroutes classifier → native: rewrites model, strips thinking, preserves system + OAuth", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      classifier: { enabled: true, model: "claude-sonnet-5" },
    });

    const res = await realFetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-oauth-token",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(CLASSIFIER_BODY),
    });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const fwd = calls[0];
    expect(fwd.url).toContain("api.anthropic.com/v1/messages");
    // Model rewritten to the configured classifier model.
    expect(fwd.body.model).toBe("claude-sonnet-5");
    // thinking stripped (Risk R1); other sampling params left intact.
    expect(fwd.body.thinking).toBeUndefined();
    expect(fwd.body.temperature).toBe(0);
    // system array forwarded VERBATIM, including the x-anthropic-billing-header block.
    expect(fwd.body.system).toEqual(CLASSIFIER_BODY.system);
    // Inbound Claude Max OAuth + anthropic-beta forwarded to Anthropic.
    expect(fwd.headers.authorization).toBe("Bearer test-oauth-token");
    expect(fwd.headers["anthropic-beta"]).toContain("claude-code-20250219");
  });

  test("does NOT rewrite a non-classifier request (model + thinking preserved)", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      classifier: { enabled: true, model: "claude-sonnet-5" },
    });

    const normalBody = {
      model: "claude-opus-4-8",
      thinking: { type: "enabled", budget_tokens: 1024 },
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 64,
    };
    const res = await realFetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-oauth-token" },
      body: JSON.stringify(normalBody),
    });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1); // claude-opus-4-8 is itself native → still hits Anthropic...
    expect(calls[0].body.model).toBe("claude-opus-4-8"); // ...but NOT rewritten
    expect(calls[0].body.thinking).toEqual(normalBody.thinking); // and thinking preserved
  });

  test("opt-in off: classifier-shaped request is NOT rewritten", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      classifier: { enabled: false, model: "claude-sonnet-5" },
    });

    const res = await realFetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-oauth-token" },
      body: JSON.stringify(CLASSIFIER_BODY),
    });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].body.model).toBe("claude-opus-4-8"); // untouched — gate is off
    expect(calls[0].body.thinking).toEqual(CLASSIFIER_BODY.thinking); // untouched
  });
});
