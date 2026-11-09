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
