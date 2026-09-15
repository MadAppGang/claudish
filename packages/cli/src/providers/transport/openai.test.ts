import { describe, expect, test } from "bun:test";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { OpenAIProviderTransport } from "./openai.js";

const mockProvider: RemoteProvider = {
  name: "opencode-zen",
  baseUrl: "https://opencode.ai/zen",
  apiPath: "/v1/chat/completions",
  apiKeyEnvVar: "OPENCODE_API_KEY",
  prefixes: ["zen@"],
};

describe("OpenAIProviderTransport.getHeaders()", () => {
  test('authScheme "none" omits auth keys while preserving provider headers', async () => {
    const provider: RemoteProvider = {
      name: "keyless-openai",
      baseUrl: "https://gateway.example.com/v1",
      apiPath: "/chat/completions",
      apiKeyEnvVar: "CUSTOM_KEYLESS_OPENAI_KEY",
      prefixes: ["keyless-openai@"],
      authScheme: "none",
      headers: { "X-Team": "platform" },
    };

    // A non-empty sentinel makes the scheme, rather than an accidentally empty
    // key, responsible for suppressing both standard auth headers.
    const transport = new OpenAIProviderTransport(provider, "test-model", "must-not-leak");
    const headers = await transport.getHeaders();

    expect(headers["X-Team"]).toBe("platform");
    expect("Authorization" in headers).toBe(false);
    expect("x-api-key" in headers).toBe(false);
  });

  test('authScheme "x-api-key" still emits the declared key', async () => {
    const provider: RemoteProvider = {
      name: "x-api-key-openai",
      baseUrl: "https://gateway.example.com/v1",
      apiPath: "/chat/completions",
      apiKeyEnvVar: "CUSTOM_X_API_KEY_OPENAI_KEY",
      prefixes: ["x-api-key-openai@"],
      authScheme: "x-api-key",
    };

    const headers = await new OpenAIProviderTransport(
      provider,
      "test-model",
      "declared-x-api-key"
    ).getHeaders();

    expect(headers["x-api-key"]).toBe("declared-x-api-key");
    expect("Authorization" in headers).toBe(false);
  });
});

describe("OpenAIProviderTransport 429 retry (#66)", () => {
  test("retries on 429 with exponential backoff", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
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
  }, 15000); // 2s + 4s backoff

  test("respects Retry-After header", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;
    const startTime = Date.now();

    const response = await transport.enqueueRequest(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response('{"error":"rate limited"}', {
            status: 429,
            headers: { "Retry-After": "1" },
          })
        );
      }
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    const elapsed = Date.now() - startTime;
    expect(response.status).toBe(200);
    expect(callCount).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900); // ~1s Retry-After
  }, 10000);

  test("returns 429 response after max retries exhausted", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response('{"error":"rate limited"}', { status: 429 }));
    });

    expect(response.status).toBe(429);
    expect(callCount).toBe(3); // 1 initial + 2 retries (bounded budget)
  }, 10000);

  test("does not retry non-429 errors", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;

    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response('{"error":"bad request"}', { status: 400 }));
    });

    expect(response.status).toBe(400);
    expect(callCount).toBe(1); // No retry
  });

  test("skips retry on terminal 429 (billing/balance)", async () => {
    const transport = new OpenAIProviderTransport(mockProvider, "minimax-m2.5-free", "test-key");
    let callCount = 0;
    const startTime = Date.now();

    // GLM-style insufficient-balance error
    const body = JSON.stringify({
      error: {
        code: "1113",
        message: "Insufficient balance or no resource package. Please recharge.",
      },
    });
    const response = await transport.enqueueRequest(() => {
      callCount++;
      return Promise.resolve(new Response(body, { status: 429 }));
    });

    const elapsed = Date.now() - startTime;
    expect(response.status).toBe(429);
    expect(callCount).toBe(1); // No retry
    expect(elapsed).toBeLessThan(500); // No backoff sleep
  });
});

describe("isTerminal429", () => {
  test("detects insufficient balance variants", async () => {
    const { isTerminal429 } = await import("./openai.js");
    expect(isTerminal429('{"error":"Insufficient balance"}')).toBe(true);
    expect(isTerminal429('{"error":"insufficient_balance"}')).toBe(true);
    expect(isTerminal429('{"error":"insufficient_quota"}')).toBe(true);
    expect(isTerminal429('{"error":"You exceeded your current quota"}')).toBe(true);
    expect(isTerminal429('{"code":"1113"}')).toBe(true);
    expect(isTerminal429('{"code":1113}')).toBe(true);
  });

  test("retries unknown 429 bodies", async () => {
    const { isTerminal429 } = await import("./openai.js");
    expect(isTerminal429('{"error":"rate limit exceeded"}')).toBe(false);
    expect(isTerminal429('{"error":"too many requests"}')).toBe(false);
    expect(isTerminal429("")).toBe(false);
  });

  test("matches the real OpenAI insufficient_quota body (composed-handler remaps it to a visible 400)", async () => {
    const { isTerminal429 } = await import("./openai.js");
    // Exact shape OpenAI returns on a billing/quota failure. composed-handler
    // remaps this 429 → 400 invalid_request_error so Claude Code surfaces the
    // message instead of silently retrying.
    const realBody = JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    expect(isTerminal429(realBody)).toBe(true);
    // A genuine transient rate-limit must still be retried (not remapped).
    const transient = JSON.stringify({
      error: { message: "Rate limit reached for requests", code: "rate_limit_exceeded" },
    });
    expect(isTerminal429(transient)).toBe(false);
  });
});

/**
 * OpenCode Go rejects any request that carries no `x-opencode-session`:
 *
 *   400 {"type":"error","error":{"type":"MissingSessionID","message":
 *        "Error from provider (Console Go): Request is missing
 *         x-opencode-session and cannot be routed efficiently."}}
 *
 * Measured 2026-09-12 on `/v1/chat/completions`: `glm-5.3-flash` and
 * `deepseek-v4.1-flash` both return 200 with the header and this 400 without
 * it, so the header is the whole difference. Before the fix, every Go model
 * failed in Claudish with `zengo@…` despite a valid key.
 */
describe("OpenAIProviderTransport OpenCode session header", () => {
  const goProvider: RemoteProvider = {
    name: "opencode-zen-go",
    baseUrl: "https://opencode.ai/zen/go",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_GO_API_KEY",
    prefixes: ["zengo@"],
  };

  test("opencode-zen-go carries an x-opencode-session id and identifies itself", async () => {
    const headers = await new OpenAIProviderTransport(
      goProvider,
      "deepseek-v4.1-flash",
      "test-key"
    ).getHeaders();

    // A `claudish-<uuid>` shape, not an empty placeholder: the relay routes on
    // the value, so a constant or empty string would collapse every user onto
    // one routing bucket.
    expect(headers["x-opencode-session"]).toMatch(/^claudish-[0-9a-f-]{36}$/);
    // The relay asks clients to name themselves rather than present a generic
    // HTTP-library User-Agent.
    expect(headers["User-Agent"]).toMatch(/^claudish\//);
  });

  test("the id is stable across calls, so a retry cannot move routing mid-turn", async () => {
    const transport = new OpenAIProviderTransport(goProvider, "deepseek-v4.1-flash", "test-key");

    const first = await transport.getHeaders();
    const second = await transport.getHeaders();

    expect(second["x-opencode-session"]).toBe(first["x-opencode-session"]);
  });

  test("two conversations do not share an id", async () => {
    const a = await new OpenAIProviderTransport(goProvider, "m", "k").getHeaders();
    const b = await new OpenAIProviderTransport(goProvider, "m", "k").getHeaders();

    expect(a["x-opencode-session"]).not.toBe(b["x-opencode-session"]);
  });

  test("other providers are not given the header", async () => {
    const provider: RemoteProvider = {
      name: "some-openai-compatible",
      baseUrl: "https://gateway.example.com/v1",
      apiPath: "/chat/completions",
      apiKeyEnvVar: "CUSTOM_SOME_OPENAI_COMPATIBLE_KEY",
      prefixes: ["some@"],
    };

    const headers = await new OpenAIProviderTransport(provider, "m", "k").getHeaders();

    expect("x-opencode-session" in headers).toBe(false);
  });

  test("a provider-declared header still wins over the generated one", async () => {
    const provider: RemoteProvider = {
      ...goProvider,
      headers: { "x-opencode-session": "pinned-by-config" },
    };

    const headers = await new OpenAIProviderTransport(provider, "m", "k").getHeaders();

    expect(headers["x-opencode-session"]).toBe("pinned-by-config");
  });
});
