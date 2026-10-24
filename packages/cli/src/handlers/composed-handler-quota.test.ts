import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * PROVISIONAL: D8's real Codex metadata-prefix + quota capture must replace this
 * constructed frame before Phase 2 merges.
 */
const PROVISIONAL_QUOTA_SSE = `data: ${JSON.stringify({
  type: "error",
  error: {
    type: "api_error",
    code: "usage_limit_reached",
    message: "You've hit your usage limit. Please retry after 14:32.",
    resets_in_seconds: 120,
  },
})}\n\n`;

function makeContext(): {
  context: Context;
  captured: { body?: any; status?: number };
} {
  const captured: { body?: any; status?: number } = {};
  const context = {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) => {
      captured.body = body;
      captured.status = status;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
  } as unknown as Context;
  return { context, captured };
}

describe("ComposedHandler in-stream Codex quota", () => {
  test("surfaces structured 400/429 instead of an assistant [API Error] message", async () => {
    const transport: ProviderTransport = {
      name: "openai-codex",
      displayName: "OpenAI Codex",
      streamFormat: "openai-responses-sse",
      overrideStreamFormat: () => "openai-responses-sse",
      getEndpoint: () => "http://codex.test/v1/responses",
      getHeaders: async () => ({}),
    };
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls > 1) throw new Error("quota was incorrectly retried");
      return new Response(PROVISIONAL_QUOTA_SSE, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const handler = new ComposedHandler(transport, "gpt-5.1-codex", "gpt-5.1-codex", 8080, {});
    const { context, captured } = makeContext();

    const response = await handler.handle(context, {
      model: "gpt-5.1-codex",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    });
    const serialized = JSON.stringify(captured.body);

    expect(fetchCalls).toBe(1);
    expect(response.status).toBe(400);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.upstream_status).toBe(429);
    expect(captured.body?.error?.message).toContain("subscription usage limit reached");
    expect(serialized).not.toContain("[API Error");

    // Mutations caught: remove the sniffer's quota verdict/wiring (the parser
    // returns a successful assistant text block), or classify quota as retryable
    // (a second fetch occurs after backoff and the status becomes 503).
  }, 10_000);
});
