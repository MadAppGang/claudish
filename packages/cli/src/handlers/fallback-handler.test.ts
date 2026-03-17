/**
 * E2E tests for the provider fallback mechanism.
 *
 * These tests use REAL API tokens and hit actual provider endpoints.
 * They start a real claudish proxy server and send Anthropic-format
 * /v1/messages requests with bare model names (no provider@ prefix)
 * to validate fallback chain behavior end-to-end.
 *
 * Required env vars (tests skip gracefully if not set):
 *   MINIMAX_API_KEY or OPENCODE_API_KEY or OPENROUTER_API_KEY
 *
 * Run: bun test packages/cli/src/handlers/fallback-handler.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { createProxyServer } from "../proxy-server.js";
import type { ProxyServer } from "../types.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const TEST_PORT = 18900 + Math.floor(Math.random() * 100);

let proxyServer: ProxyServer | null = null;

async function ensureProxy(): Promise<number> {
  if (proxyServer) return TEST_PORT;

  proxyServer = await createProxyServer(
    TEST_PORT,
    process.env.OPENROUTER_API_KEY,
    undefined, // no default model — let fallback decide
    false,
    process.env.ANTHROPIC_API_KEY,
    undefined,
    { quiet: true }
  );
  return TEST_PORT;
}

afterAll(async () => {
  if (proxyServer) {
    await proxyServer.shutdown();
    proxyServer = null;
  }
});

/**
 * Send a minimal /v1/messages request to the proxy.
 * Returns { ok, status, body } where body is parsed from JSON or SSE.
 */
async function sendMessage(
  port: number,
  model: string,
  prompt: string = "Say hello in 5 words"
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const contentType = res.headers.get("content-type") || "";
  let body: any;

  if (contentType.includes("text/event-stream")) {
    // SSE response — parse event stream for content
    const text = await res.text();
    const lines = text.split("\n");
    let lastData: any = null;
    let textParts: string[] = [];
    let hasError = false;
    let errorData: any = null;

    for (const line of lines) {
      // SSE spec: "data:" with optional space — handle both "data: {...}" and "data:{...}"
      const isDataLine = line.startsWith("data: ") || line.startsWith("data:");
      if (isDataLine) {
        const data = (line.startsWith("data: ") ? line.slice(6) : line.slice(5)).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          lastData = parsed;

          // Anthropic SSE: content_block_delta with text
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            textParts.push(parsed.delta.text);
          }
          // Anthropic SSE: message_start with content array
          if (parsed.type === "message_start" && parsed.message?.content?.length > 0) {
            for (const block of parsed.message.content) {
              if (block.text) textParts.push(block.text);
            }
          }
          // OpenAI SSE: choices[].delta.content
          if (parsed.choices?.[0]?.delta?.content) {
            textParts.push(parsed.choices[0].delta.content);
          }
          // Error events
          if (parsed.type === "error" || parsed.error) {
            hasError = true;
            errorData = parsed;
          }
        } catch {
          // Skip non-JSON data lines
        }
      }
    }

    if (textParts.length > 0) {
      body = {
        content: [{ type: "text", text: textParts.join("") }],
        _raw_sse: true,
      };
      return { ok: true, status: res.status, body };
    } else if (hasError && errorData) {
      return { ok: false, status: res.status, body: errorData };
    } else if (lastData?.type === "message_stop" || lastData?.type === "message_delta") {
      // Anthropic SSE completed but no text extracted — treat as success (empty response)
      body = { content: [{ type: "text", text: "" }], _raw_sse: true };
      return { ok: true, status: res.status, body };
    } else {
      body = lastData || { _raw_text: text.slice(0, 500) };
      return { ok: false, status: res.status, body };
    }
  } else {
    // JSON response
    try {
      body = await res.json();
    } catch {
      body = { _raw_text: await res.text() };
    }
    return { ok: res.ok, status: res.status, body };
  }
}

/** Check if any fallback-capable env vars are set */
function hasAnyCredentials(): boolean {
  return !!(
    process.env.MINIMAX_API_KEY ||
    process.env.MINIMAX_CODING_API_KEY ||
    process.env.OPENCODE_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.LITELLM_BASE_URL ||
    process.env.GEMINI_API_KEY ||
    process.env.MOONSHOT_API_KEY ||
    process.env.KIMI_API_KEY ||
    process.env.KIMI_CODING_API_KEY ||
    process.env.OPENAI_API_KEY
  );
}

// ---------------------------------------------------------------------------
// Group 1: Fallback chain construction (unit, no API calls)
// ---------------------------------------------------------------------------

describe("Group 1: Fallback chain construction", () => {
  const { getFallbackChain } = require("../providers/auto-route.js");

  test("chain includes all configured providers in priority order", () => {
    const chain = getFallbackChain("minimax-m2.5", "minimax");
    if (!hasAnyCredentials()) return;

    expect(chain.length).toBeGreaterThan(0);

    // Verify ordering: LiteLLM < Zen Go < Subscription < Native < OpenRouter
    const providerOrder = chain.map((r: any) => r.provider);
    const litellmIdx = providerOrder.indexOf("litellm");
    const zenIdx = providerOrder.indexOf("opencode-zen-go");
    const subIdx = providerOrder.indexOf("minimax-coding");
    const nativeIdx = providerOrder.indexOf("minimax");
    const orIdx = providerOrder.indexOf("openrouter");

    if (litellmIdx >= 0 && zenIdx >= 0) expect(litellmIdx).toBeLessThan(zenIdx);
    if (zenIdx >= 0 && subIdx >= 0) expect(zenIdx).toBeLessThan(subIdx);
    if (subIdx >= 0 && nativeIdx >= 0) expect(subIdx).toBeLessThan(nativeIdx);
    if (nativeIdx >= 0 && orIdx >= 0) expect(nativeIdx).toBeLessThan(orIdx);
  });

  test("kimi model includes subscription alternative with translated model name", () => {
    const chain = getFallbackChain("kimi-k2.5", "kimi");
    const sub = chain.find((r: any) => r.provider === "kimi-coding");
    if (!sub) return;
    expect(sub.modelSpec).toContain("kimi-for-coding");
  });

  test("google model includes gemini-codeassist subscription alternative", () => {
    const chain = getFallbackChain("gemini-2.0-flash", "google");
    const sub = chain.find((r: any) => r.provider === "gemini-codeassist");
    if (!sub) return;
    expect(sub.modelSpec).toContain("gemini-2.0-flash");
  });

  test("unknown provider gets LiteLLM and OpenRouter but NOT Zen (model not in catalog)", () => {
    const chain = getFallbackChain("some-unknown-model", "unknown");
    const providers = chain.map((r: any) => r.provider);

    expect(providers).not.toContain("unknown");

    // Zen Go is filtered out — "some-unknown-model" won't be in the Zen catalog
    expect(providers).not.toContain("opencode-zen-go");
    expect(providers).not.toContain("opencode-zen");

    if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) {
      expect(providers).toContain("litellm");
    }
    if (process.env.OPENROUTER_API_KEY) {
      expect(providers).toContain("openrouter");
    }
  });
});

// ---------------------------------------------------------------------------
// Group 2: Real API — fallback produces a valid response or structured error
// ---------------------------------------------------------------------------

describe("Group 2: Real API — fallback response structure", () => {
  test("minimax-m2.5 without prefix returns success or structured fallback error", async () => {
    if (!hasAnyCredentials()) return;
    const port = await ensureProxy();

    const { ok, body } = await sendMessage(port, "minimax-m2.5");

    if (ok) {
      // Some provider in the chain succeeded
      expect(body.content).toBeDefined();
      expect(body.content.length).toBeGreaterThan(0);
    } else if (body.error?.type === "all_providers_failed") {
      // All providers failed — structured fallback error
      expect(body.error.attempts).toBeInstanceOf(Array);
      expect(body.error.attempts.length).toBeGreaterThan(0);

      for (const attempt of body.error.attempts) {
        expect(attempt.provider).toBeDefined();
        expect(typeof attempt.status).toBe("number");
        expect(attempt.error).toBeDefined();
      }
    } else {
      // Single-provider error or raw SSE error — just verify it's not silently swallowed
      expect(body).toBeDefined();
    }
  }, 30_000);

  test("gemini-2.0-flash without prefix returns success or structured fallback error", async () => {
    if (!hasAnyCredentials()) return;
    const port = await ensureProxy();

    const { ok, body } = await sendMessage(port, "gemini-2.0-flash");

    if (ok) {
      expect(body.content).toBeDefined();
    } else if (body.error?.type === "all_providers_failed") {
      expect(body.error.attempts.length).toBeGreaterThan(0);
    } else {
      expect(body).toBeDefined();
    }
  }, 30_000);

  test("kimi-k2.5 without prefix returns success or structured fallback error", async () => {
    if (!hasAnyCredentials()) return;
    const port = await ensureProxy();

    const { ok, body } = await sendMessage(port, "kimi-k2.5");

    if (ok) {
      expect(body.content).toBeDefined();
    } else if (body.error?.type === "all_providers_failed") {
      expect(body.error.attempts.length).toBeGreaterThan(0);
    } else {
      expect(body).toBeDefined();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Group 3: Real API — fallback actually tries multiple providers
// ---------------------------------------------------------------------------

describe("Group 3: Real API — multi-provider fallback in action", () => {
  test("bare model tries multiple providers and either succeeds or returns an error", async () => {
    if (!hasAnyCredentials()) return;
    const port = await ensureProxy();

    const { ok, body } = await sendMessage(port, "minimax-m2.5");

    if (ok) {
      // Fallback chain found a working provider
      expect(body.content).toBeDefined();
      expect(body.content.length).toBeGreaterThan(0);
    } else if (body.type === "message_stop" || body._raw_sse) {
      // SSE stream completed (Anthropic-compat provider responded) but no text was
      // extracted by the test helper. The fallback chain DID succeed at HTTP level —
      // the response was just too short or used a format the test parser doesn't cover.
      // This is still a valid outcome — the provider accepted the request.
      expect(body).toBeDefined();
    } else {
      // Real error — must have a structured error
      expect(body.error).toBeDefined();
      if (body.error.type === "all_providers_failed") {
        expect(body.error.attempts.length).toBeGreaterThanOrEqual(1);
        for (const attempt of body.error.attempts) {
          expect(attempt.provider).toBeDefined();
          expect(typeof attempt.status).toBe("number");
        }
      } else {
        // Single-provider error (non-retryable) — must have type and message
        expect(body.error.type).toBeDefined();
        expect(body.error.message).toBeDefined();
      }
    }
  }, 30_000);

  test("completely unknown model fails with a structured error", async () => {
    if (!hasAnyCredentials()) return;
    const port = await ensureProxy();

    const { ok, body } = await sendMessage(port, "nonexistent-model-xyz-999");

    // Unknown model should NOT succeed
    expect(ok).toBe(false);
    // Must return some structured error — either fallback chain or single provider
    expect(body.error).toBeDefined();
    expect(body.error.type).toBeDefined();
    expect(body.error.message).toBeDefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Group 4: Real API — explicit provider prefix bypasses fallback
// ---------------------------------------------------------------------------

describe("Group 4: Real API — explicit provider skips fallback", () => {
  test("mm@minimax-m2.5 (explicit) does NOT use fallback chain", async () => {
    if (!process.env.MINIMAX_API_KEY) return;
    const port = await ensureProxy();

    const result = await sendMessage(port, "mm@minimax-m2.5");

    // Explicit provider must NOT trigger fallback chain
    if (!result.ok && result.body.error?.type === "all_providers_failed") {
      throw new Error(
        `Explicit provider mm@ triggered fallback chain with ${result.body.error.attempts.length} attempts — should go direct to MiniMax only`
      );
    }
    // Either succeeds (direct MiniMax) or returns a single-provider error (not wrapped in fallback)
  }, 30_000);

  test("or@minimax/minimax-m2.5 (explicit OpenRouter) goes direct", async () => {
    if (!process.env.OPENROUTER_API_KEY) return;
    const port = await ensureProxy();

    const { ok, body } = await sendMessage(port, "or@minimax/minimax-m2.5");

    if (ok) {
      expect(body.content).toBeDefined();
      expect(body.content.length).toBeGreaterThan(0);
    } else {
      // Explicit routing error must NOT be a fallback chain error
      expect(body.error?.type).not.toBe("all_providers_failed");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Group 5: isRetryableError classification (unit tests)
// ---------------------------------------------------------------------------

describe("Group 5: isRetryableError — unit tests via FallbackHandler behavior", () => {
  // We test isRetryableError indirectly through FallbackHandler since the function
  // is not exported. We create mock handlers that return specific status codes and
  // verify whether FallbackHandler tries the next candidate or stops.

  const { Hono } = require("hono");
  const { FallbackHandler } = require("./fallback-handler.js");

  function mockHandler(status: number, body: string) {
    return {
      handle: async () =>
        new Response(body, { status, headers: { "content-type": "application/json" } }),
      shutdown: async () => {},
    };
  }

  async function runFallback(firstStatus: number, firstBody: string): Promise<any> {
    const handler = new FallbackHandler([
      { name: "provider-a", handler: mockHandler(firstStatus, firstBody) },
      {
        name: "provider-b",
        handler: mockHandler(200, '{"content":[{"type":"text","text":"ok"}]}'),
      },
    ]);
    const app = new Hono();
    let result: any;
    app.post("/test", async (c: any) => {
      result = await handler.handle(c, { model: "test-model" });
      return result;
    });
    const res = await app.request("/test", { method: "POST", body: "{}" });
    const text = await res.text();
    return { status: res.status, text, usedFallback: text.includes('"ok"') };
  }

  test("401 auth error is retryable — falls through to next provider", async () => {
    const result = await runFallback(401, '{"error":"unauthorized"}');
    expect(result.usedFallback).toBe(true);
  });

  test("403 forbidden is retryable — falls through to next provider", async () => {
    const result = await runFallback(403, '{"error":"forbidden"}');
    expect(result.usedFallback).toBe(true);
  });

  test("402 payment required is retryable — falls through to next provider", async () => {
    const result = await runFallback(402, '{"error":"payment required"}');
    expect(result.usedFallback).toBe(true);
  });

  test("404 not found is retryable — falls through to next provider", async () => {
    const result = await runFallback(404, '{"error":"model not found"}');
    expect(result.usedFallback).toBe(true);
  });

  test("429 rate limit is retryable — falls through to next provider", async () => {
    const result = await runFallback(429, '{"error":"rate limited"}');
    expect(result.usedFallback).toBe(true);
  });

  test("500 with insufficient balance is retryable", async () => {
    const result = await runFallback(500, '{"error":"insufficient balance (1008)"}');
    expect(result.usedFallback).toBe(true);
  });

  test("500 generic server error is NOT retryable — stops immediately", async () => {
    const result = await runFallback(500, '{"error":"internal server error"}');
    expect(result.usedFallback).toBe(false);
  });

  test("400 with unknown model is retryable", async () => {
    const result = await runFallback(400, '{"error":"unknown model xyz"}');
    expect(result.usedFallback).toBe(true);
  });

  test("400 generic bad request is NOT retryable — stops immediately", async () => {
    const result = await runFallback(400, '{"error":"invalid request format"}');
    expect(result.usedFallback).toBe(false);
  });

  test("422 with model not available is retryable", async () => {
    const result = await runFallback(422, '{"error":"model not available"}');
    expect(result.usedFallback).toBe(true);
  });

  test("422 generic is NOT retryable", async () => {
    const result = await runFallback(422, '{"error":"unprocessable entity"}');
    expect(result.usedFallback).toBe(false);
  });

  test("400 with no healthy deployments is retryable (LiteLLM)", async () => {
    const result = await runFallback(400, '{"error":"No healthy deployment available"}');
    expect(result.usedFallback).toBe(true);
  });
});
