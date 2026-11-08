import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { NativeHandler } from "./native-handler.js";

/**
 * PROVISIONAL: replace these representative plan-window header values with a
 * real native Anthropic response-header capture from Phase V.
 */
const PASSTHROUGH_HEADERS = {
  "anthropic-ratelimit-unified-7d-utilization": "0.82",
  "anthropic-ratelimit-unified-7d-reset": "2026-09-13T00:00:00Z",
  "anthropic-ratelimit-input-tokens-limit": "200000",
  "retry-after": "17",
  "request-id": "req-native-test",
  "x-request-id": "xreq-native-test",
  "x-private-upstream": "must-not-pass",
};

const REQUEST_PAYLOAD = {
  model: "claude-sonnet-5",
  max_tokens: 16,
  messages: [{ role: "user", content: "hello" }],
};

// Captured provider data, kept beside the translation tests per testing.md.
const CAPTURED_ANTHROPIC_SUCCESS_SSE = readFileSync(
  join(import.meta.dir, "../test-fixtures/sse-responses/SEED-anthropic-text-only.sse"),
  "utf8"
);

async function exerciseNative(
  upstreamResponse: () => Response
): Promise<{ response: Response; upstreamUrl: string; upstreamBody: string }> {
  let upstreamUrl = "";
  let upstreamBody = "";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamUrl = request.url;
      // V18 mutation: strip or replace the inbound bearer when no pool is configured.
      expect(request.headers.get("authorization")).toBe("Bearer inbound-subscription-token");
      upstreamBody = await request.text();
      return upstreamResponse();
    },
  });
  const savedOverride = process.env.CLAUDISH_TEST_UPSTREAM;
  process.env.CLAUDISH_TEST_UPSTREAM = `api.anthropic.com=http://127.0.0.1:${upstream.port}`;

  try {
    const handler = new NativeHandler();
    const app = new Hono();
    app.post("/", async (context) => handler.handle(context, await context.req.json()));
    const liveResponse = await app.request("http://claudish.test/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer inbound-subscription-token",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(REQUEST_PAYLOAD),
    });
    // Drain while the loopback server is alive, then return an equivalent buffered
    // response so the caller can inspect either branch after cleanup.
    const bytes = await liveResponse.arrayBuffer();
    const response = new Response(bytes, {
      status: liveResponse.status,
      statusText: liveResponse.statusText,
      headers: liveResponse.headers,
    });
    return { response, upstreamUrl, upstreamBody };
  } finally {
    upstream.stop(true);
    if (savedOverride === undefined) delete process.env.CLAUDISH_TEST_UPSTREAM;
    else process.env.CLAUDISH_TEST_UPSTREAM = savedOverride;
  }
}

function expectPassthrough(response: Response): void {
  expect(response.headers.get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.82");
  expect(response.headers.get("anthropic-ratelimit-unified-7d-reset")).toBe("2026-09-13T00:00:00Z");
  expect(response.headers.get("anthropic-ratelimit-input-tokens-limit")).toBe("200000");
  expect(response.headers.get("retry-after")).toBe("17");
  expect(response.headers.get("request-id")).toBe("req-native-test");
  expect(response.headers.get("x-request-id")).toBe("xreq-native-test");
  expect(response.headers.get("x-private-upstream")).toBeNull();
}

describe("NativeHandler rate-limit header passthrough", () => {
  test("passes rate-limit, retry, and request ids through the JSON branch", async () => {
    const { response, upstreamUrl, upstreamBody } = await exerciseNative(
      () =>
        // PROVISIONAL: replace this JSON branch body with a captured non-streaming
        // native Anthropic response; the assertions here concern headers/status.
        new Response(
          JSON.stringify({
            id: "msg-native-json",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json", ...PASSTHROUGH_HEADERS },
          }
        )
    );

    expect(response.status).toBe(429);
    expectPassthrough(response);
    expect(new URL(upstreamUrl).pathname).toBe("/v1/messages");
    expect(JSON.parse(upstreamBody)).toEqual(REQUEST_PAYLOAD);

    // Mutations caught: collect headers only inside the stream branch, enumerate
    // only one unified-window spelling, or omit retry-after/request ids.
  });

  test("passes the same header set through the streaming branch", async () => {
    const { response, upstreamUrl, upstreamBody } = await exerciseNative(
      () =>
        new Response(CAPTURED_ANTHROPIC_SUCCESS_SSE, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", ...PASSTHROUGH_HEADERS },
        })
    );

    expect(response.status).toBe(200);
    expectPassthrough(response);
    expect(await response.text()).toBe(CAPTURED_ANTHROPIC_SUCCESS_SSE);
    expect(new URL(upstreamUrl).pathname).toBe("/v1/messages");
    expect(JSON.parse(upstreamBody)).toEqual(REQUEST_PAYLOAD);

    // Mutations caught: collect headers only inside the JSON branch or forget to
    // spread the shared collection into the streaming response.
  });
});
