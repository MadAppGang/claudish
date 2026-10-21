// HTTP-level test of a passthrough session's proxy. Drives the REAL proxy over
// loopback with the outbound `fetch` stubbed, so what claudish sends to
// api.anthropic.com, and what it hands back to Claude Code, is observed on the
// wire rather than read from the handler.

import { afterEach, describe, expect, test } from "bun:test";
import { createProxyServer } from "./proxy-server.js";

const realFetch = globalThis.fetch.bind(globalThis);

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Answer api.anthropic.com with `reply` and record what reached it; neutralize the rest. */
function stubAnthropic(reply: () => Response): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.anthropic.com")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const raw = init?.body;
    const body =
      raw === undefined || raw === null
        ? undefined
        : typeof raw === "string"
          ? raw
          : new TextDecoder().decode(raw as ArrayBuffer);
    sent.push({ url, method: init?.method ?? "GET", headers, body });
    return reply();
  }) as typeof fetch;
  return sent;
}

// Spacing JSON.stringify would never produce: a re-serialisation would show.
const RAW_BODY =
  '{"model": "claude-opus-5-5", "max_tokens": 16, "system": [{"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.280; cch=abcde;"}], "messages": [{"role": "user", "content": "hi"}]}';

const CLAUDE_CODE_HEADERS = {
  "content-type": "application/json",
  authorization: "Bearer test-oauth-token",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,server-side-fallback-2026-06-01",
  "anthropic-version": "2023-06-01",
  "x-app": "cli",
  "x-claude-code-session-id": "session-1",
  "x-claude-code-request-class": "main",
  "anthropic-usage-limit": "slow",
};

describe("passthrough session proxy (HTTP)", () => {
  let proxy: Awaited<ReturnType<typeof createProxyServer>> | null = null;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (proxy) await proxy.shutdown();
    proxy = null;
  });

  const start = async (passthrough: boolean) => {
    proxy = await createProxyServer(0, undefined, undefined, true, undefined, undefined, {
      quiet: true,
      passthrough,
    });
    return proxy;
  };

  test("a message reaches Anthropic as Claude Code sent it, query and headers included", async () => {
    const sent = stubAnthropic(
      () =>
        new Response('{"type":"message"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "anthropic-ratelimit-unified-status": "allowed_warning",
            "anthropic-ratelimit-unified-representative-claim": "seven_day",
            "request-id": "req_1",
          },
        })
    );
    const { url } = await start(true);

    const res = await realFetch(`${url}/v1/messages?beta=true`, {
      method: "POST",
      headers: CLAUDE_CODE_HEADERS,
      body: RAW_BODY,
    });

    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(sent[0].body).toBe(RAW_BODY);
    for (const [name, value] of Object.entries(CLAUDE_CODE_HEADERS)) {
      expect(sent[0].headers[name]).toBe(value);
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed_warning");
    expect(res.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("seven_day");
    expect(res.headers.get("request-id")).toBe("req_1");
    expect(await res.text()).toBe('{"type":"message"}');
  });

  test("Anthropic's refusal comes back with its own status and headers", async () => {
    stubAnthropic(
      () =>
        new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
            "anthropic-ratelimit-unified-status": "rejected",
          },
        })
    );
    const { url } = await start(true);

    const res = await realFetch(`${url}/v1/messages?beta=true`, {
      method: "POST",
      headers: CLAUDE_CODE_HEADERS,
      body: RAW_BODY,
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
    expect(await res.text()).toBe('{"type":"error","error":{"type":"rate_limit_error"}}');
  });

  test("a streamed answer keeps Anthropic's headers", async () => {
    const stream = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    stubAnthropic(
      () =>
        new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "anthropic-ratelimit-unified-status": "allowed",
          },
        })
    );
    const { url } = await start(true);

    const res = await realFetch(`${url}/v1/messages?beta=true`, {
      method: "POST",
      headers: CLAUDE_CODE_HEADERS,
      body: RAW_BODY,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
    expect(await res.text()).toBe(stream);
  });

  test("count_tokens carries Claude Code's auth and returns Anthropic's status", async () => {
    const sent = stubAnthropic(
      () =>
        new Response('{"type":"error","error":{"type":"authentication_error"}}', {
          status: 401,
          headers: { "content-type": "application/json" },
        })
    );
    const { url } = await start(true);

    const res = await realFetch(`${url}/v1/messages/count_tokens?beta=true`, {
      method: "POST",
      headers: CLAUDE_CODE_HEADERS,
      body: RAW_BODY,
    });

    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    expect(sent[0].headers.authorization).toBe("Bearer test-oauth-token");
    expect(sent[0].body).toBe(RAW_BODY);
    expect(res.status).toBe(401);
  });

  test("a path the proxy does not serve is Anthropic's to answer", async () => {
    const sent = stubAnthropic(() => new Response(null, { status: 200 }));
    const { url } = await start(true);

    const res = await realFetch(`${url}/api/hello`, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(sent.length).toBe(1);
    expect(sent[0].method).toBe("HEAD");
    expect(sent[0].url).toBe("https://api.anthropic.com/api/hello");
  });

  test("outside a passthrough session an unserved path stays unanswered", async () => {
    const sent = stubAnthropic(() => new Response(null, { status: 200 }));
    const { url } = await start(false);

    const res = await realFetch(`${url}/api/hello`, { method: "HEAD" });

    expect(res.status).toBe(404);
    expect(sent.length).toBe(0);
  });
});
