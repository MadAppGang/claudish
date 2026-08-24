// REGRESSION: mm@MiniMax-M2.5 HTTP 401 — Fixed in /fix session dev-fix-20260306-023717-beb53cef
//
// Root cause: AnthropicCompatProvider.getHeaders() always sends "x-api-key" but
// MiniMax's /anthropic/v1/messages endpoint requires "Authorization: Bearer <key>".
// Fix: RemoteProvider.authScheme: "bearer" | "x-api-key" selects the correct auth header.
//
// REGRESSION: kimi-k2.5 turn 2 fails with "unsupported content type: tool_reference"
//
// Root cause: AnthropicAPIFormat.convertMessages() passed tool_reference blocks
// as-is. tool_reference is a Claude Code-internal type for deferred tool loading (ToolSearch)
// and is not part of the Anthropic public API spec — Kimi rejects it with HTTP 400.
// Fix: stripUnsupportedContentTypes() filters tool_reference from tool_result content arrays.

import { describe, it, test, expect } from "bun:test";
import { AnthropicCompatProvider, AnthropicProviderTransport } from "./anthropic-compat.js";
import { AnthropicAPIFormat } from "../../adapters/anthropic-api-format.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";

const TEST_API_KEY = "test-key-abc123";

describe("AnthropicCompatProvider.getHeaders()", () => {
  it("returns Authorization: Bearer header when authScheme is 'bearer'", async () => {
    const provider: RemoteProvider = {
      name: "minimax",
      baseUrl: "https://api.minimaxi.com",
      apiPath: "/anthropic/v1/messages",
      apiKeyEnvVar: "MINIMAX_API_KEY",
      prefixes: ["mm@", "mmax@"],
      authScheme: "bearer",
    };

    const transport = new AnthropicCompatProvider(provider, TEST_API_KEY);
    const headers = await transport.getHeaders();

    expect(headers["Authorization"]).toBe(`Bearer ${TEST_API_KEY}`);
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("returns x-api-key header when authScheme is 'x-api-key'", async () => {
    const provider: RemoteProvider = {
      name: "kimi",
      baseUrl: "https://api.moonshot.cn",
      apiPath: "/anthropic/v1/messages",
      apiKeyEnvVar: "KIMI_API_KEY",
      prefixes: ["kimi@", "moon@"],
      authScheme: "x-api-key",
    };

    const transport = new AnthropicCompatProvider(provider, TEST_API_KEY);
    const headers = await transport.getHeaders();

    expect(headers["x-api-key"]).toBe(TEST_API_KEY);
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("defaults to x-api-key when authScheme is undefined", async () => {
    const provider: RemoteProvider = {
      name: "zai",
      baseUrl: "https://api.z.ai",
      apiPath: "/anthropic/v1/messages",
      apiKeyEnvVar: "ZAI_API_KEY",
      prefixes: ["zai@"],
      // authScheme intentionally omitted — legacy / default behavior
    };

    const transport = new AnthropicCompatProvider(provider, TEST_API_KEY);
    const headers = await transport.getHeaders();

    expect(headers["x-api-key"]).toBe(TEST_API_KEY);
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("AnthropicProviderTransport.enqueueRequest 429 retry (+ jitter)", () => {
  const provider: RemoteProvider = {
    name: "zai",
    baseUrl: "https://api.z.ai",
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "ZAI_API_KEY",
    prefixes: ["zai@"],
  };

  test("retries on HTTP 429 then returns the eventual success", async () => {
    const transport = new AnthropicProviderTransport(provider, "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(new Response('{"error":"rate limited"}', { status: 429 }));
      }
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    expect(response.status).toBe(200);
    expect(callCount).toBe(3); // 2 retries + 1 success
  }, 15000); // 2s + 4s backoff (+ up to 2s jitter)

  test("does not retry non-429 responses", async () => {
    const transport = new AnthropicProviderTransport(provider, "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response('{"error":"bad request"}', { status: 400 }));
    });

    expect(response.status).toBe(400);
    expect(callCount).toBe(1); // No retry
  });
});

describe("AnthropicAPIFormat — tool_reference stripping", () => {
  const adapter = new AnthropicAPIFormat("kimi-k2.5", "kimi");

  it("strips tool_reference blocks from tool_result content", () => {
    const request = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "ts_0", name: "ToolSearch", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "ts_0",
              content: [
                { type: "tool_reference", tool_name: "Read" },
                { type: "tool_reference", tool_name: "Edit" },
              ],
            },
          ],
        },
      ],
    };

    const messages = adapter.convertMessages(request);
    const toolResult = messages[1].content[0];
    expect(toolResult.type).toBe("tool_result");
    // tool_reference blocks stripped, replaced with minimal text placeholder
    expect(toolResult.content).toEqual([{ type: "text", text: "" }]);
  });

  it("preserves non-tool_reference content inside tool_result", () => {
    const request = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "ts_1",
              content: [
                { type: "text", text: "result text" },
                { type: "tool_reference", tool_name: "Glob" },
              ],
            },
          ],
        },
      ],
    };

    const messages = adapter.convertMessages(request);
    const toolResult = messages[0].content[0];
    expect(toolResult.content).toEqual([{ type: "text", text: "result text" }]);
  });

  it("passes through messages with no tool_reference unchanged", () => {
    const request = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ],
    };

    const messages = adapter.convertMessages(request);
    expect(messages).toEqual(request.messages);
  });

  it("handles messages with string content unchanged", () => {
    const request = {
      messages: [{ role: "user", content: "plain string" }],
    };

    const messages = adapter.convertMessages(request);
    expect(messages[0].content).toBe("plain string");
  });
});

describe("AnthropicProviderTransport 429 backoff releases the concurrency slot", () => {
  // Same defect and same fix as OpenAIProviderTransport. It bites harder here:
  // these providers (Z.AI, MiniMax, Kimi) share ONE key across the cluster, so
  // they throttle in synchronized bursts — exactly when holding a slot through
  // the backoff blocks the most traffic.
  const provider: RemoteProvider = {
    name: "glm",
    displayName: "GLM",
    baseUrl: "https://api.z.ai",
    apiPath: "/api/anthropic/v1/messages",
    transport: "anthropic",
  };

  test("a request in 429 backoff does not block another request to the same provider", async () => {
    const transport = new AnthropicProviderTransport(provider, TEST_API_KEY, 1);
    const order: string[] = [];

    let aCalls = 0;
    const a = transport
      .enqueueRequest(() => {
        aCalls++;
        if (aCalls === 1) {
          return Promise.resolve(
            new Response('{"error":"rate limited"}', {
              status: 429,
              headers: { "Retry-After": "1" },
            })
          );
        }
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      })
      .then(() => order.push("A"));

    await new Promise((r) => setTimeout(r, 100));

    const b = transport
      .enqueueRequest(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })))
      .then(() => order.push("B"));

    await Promise.all([a, b]);

    expect(order).toEqual(["B", "A"]);
    expect(aCalls).toBe(2);
  }, 15000);

  test("still caps concurrent fetches at maxConcurrency", async () => {
    const transport = new AnthropicProviderTransport(provider, TEST_API_KEY, 2);
    let inFlight = 0;
    let peak = 0;

    const fire = () =>
      transport.enqueueRequest(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return new Response('{"ok":true}', { status: 200 });
      });

    await Promise.all([fire(), fire(), fire(), fire(), fire()]);

    expect(peak).toBe(2);
  });
});

describe("AnthropicProviderTransport 429 quota-wall short-circuit", () => {
  const provider: RemoteProvider = {
    name: "minimax-coding",
    baseUrl: "https://api.minimaxi.com",
    apiPath: "/anthropic/v1/messages",
    transport: "anthropic",
    authScheme: "bearer",
  };
  // MiniMax counts down to its reset; the word that arms the predicate is "quota".
  const WALL = '{"error":{"message":"Your quota has been exhausted, resets in 3h"}}';
  const BURST = '{"error":{"message":"too many requests, retry shortly"}}';

  test("a quota wall skips the jittered ladder", async () => {
    const transport = new AnthropicProviderTransport(provider, TEST_API_KEY);
    let callCount = 0;
    const startTime = Date.now();

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response(WALL, { status: 429 }));
    });

    expect(response.status).toBe(429);
    expect(callCount).toBe(1);
    expect(Date.now() - startTime).toBeLessThan(1000);
    expect(await response.text()).toBe(WALL); // body preserved for the caller
  }, 10000);

  test("a BURST still walks the ladder — jitter path unaffected", async () => {
    const transport = new AnthropicProviderTransport(provider, TEST_API_KEY);
    let callCount = 0;
    const startTime = Date.now();

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(new Response(BURST, { status: 429 }));
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    expect(response.status).toBe(200);
    expect(callCount).toBe(2);
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(1900); // 2s rung + jitter
  }, 15000);
});
