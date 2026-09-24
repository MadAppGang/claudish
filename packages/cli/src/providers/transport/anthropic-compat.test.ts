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

import { afterEach, describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { AnthropicAPIFormat } from "../../adapters/anthropic-api-format.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { getProviderByName, toRemoteProvider } from "../provider-definitions.js";
import { anthropicCompatProfile } from "../provider-profiles.js";
import { AnthropicProviderTransport } from "./anthropic-compat.js";

const TEST_API_KEY = "test-key-abc123";

describe("AnthropicProviderTransport.getHeaders()", () => {
  it("returns Authorization: Bearer header when authScheme is 'bearer'", async () => {
    const provider: RemoteProvider = {
      name: "minimax",
      baseUrl: "https://api.minimax.io",
      apiPath: "/anthropic/v1/messages",
      apiKeyEnvVar: "MINIMAX_API_KEY",
      prefixes: ["mm@", "mmax@"],
      authScheme: "bearer",
    };

    const transport = new AnthropicProviderTransport(provider, TEST_API_KEY);
    const headers = await transport.getHeaders();

    expect(headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
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

    const transport = new AnthropicProviderTransport(provider, TEST_API_KEY);
    const headers = await transport.getHeaders();

    expect(headers["x-api-key"]).toBe(TEST_API_KEY);
    expect(headers.Authorization).toBeUndefined();
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

    const transport = new AnthropicProviderTransport(provider, TEST_API_KEY);
    const headers = await transport.getHeaders();

    expect(headers["x-api-key"]).toBe(TEST_API_KEY);
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it('omits auth keys for authScheme "none" while preserving provider headers', async () => {
    const provider: RemoteProvider = {
      name: "keyless-anthropic",
      baseUrl: "https://gateway.example.com",
      apiPath: "/v1/messages",
      apiKeyEnvVar: "CUSTOM_KEYLESS_ANTHROPIC_KEY",
      prefixes: ["keyless-anthropic@"],
      authScheme: "none",
      headers: { "X-Team": "platform" },
    };

    // A non-empty sentinel proves the explicit scheme wins over the key value.
    const headers = await new AnthropicProviderTransport(provider, "must-not-leak").getHeaders();

    expect(headers["X-Team"]).toBe("platform");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect("Authorization" in headers).toBe(false);
    expect("x-api-key" in headers).toBe(false);
  });
});

describe("AnthropicProviderTransport.transformPayload(): request-level cache_control", () => {
  const topLevel: RemoteProvider = {
    name: "kimi",
    baseUrl: "https://api.moonshot.ai",
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    prefixes: ["kimi/"],
    cacheControlPlacement: "top-level",
  };
  const transport = new AnthropicProviderTransport(topLevel, TEST_API_KEY);
  const hour = { type: "ephemeral", ttl: "1h" };
  const fiveMinutes = { type: "ephemeral" };

  it("lifts a breakpoint to the request level and leaves the block markers in place", () => {
    const system = [{ type: "text", text: "You are Claude Code.", cache_control: hour }];
    const out = transport.transformPayload({ model: "kimi-k3", system, messages: [] });

    expect(out.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out.system).toEqual(system);
  });

  it("writes a breakpoint without a ttl at Anthropic's 5m default", () => {
    const out = transport.transformPayload({
      model: "kimi-k3",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: fiveMinutes }] },
      ],
    });

    expect(out.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("keeps the longest TTL any breakpoint asked for", () => {
    const out = transport.transformPayload({
      model: "kimi-k3",
      tools: [{ name: "Read", input_schema: { type: "object" }, cache_control: fiveMinutes }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "file body", cache_control: hour }],
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "next", cache_control: fiveMinutes }] },
      ],
    });

    expect(out.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("adds nothing to a request that asked for no caching", () => {
    const payload = {
      model: "kimi-k3",
      system: [{ type: "text", text: "You are Claude Code." }],
      messages: [{ role: "user", content: "hi" }],
    };

    expect(transport.transformPayload(payload)).toEqual(payload);
    expect("cache_control" in transport.transformPayload(payload)).toBe(false);
  });

  it("honours the client's own request-level field, which the payload is rebuilt without", () => {
    const out = transport.transformPayload(
      { model: "kimi-k3", messages: [{ role: "user", content: "hi" }] },
      { cache_control: hour }
    );

    expect(out.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("sends only type and ttl, whatever else a breakpoint carries", () => {
    const out = transport.transformPayload({
      model: "kimi-k3",
      system: [{ type: "text", text: "sys", cache_control: { ...hour, evict_on_complete: true } }],
      messages: [],
    });

    expect(out.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps an explicit cache_control already on the payload", () => {
    const explicit = { type: "ephemeral", ttl: "5m" };
    const out = transport.transformPayload({
      model: "kimi-k3",
      cache_control: explicit,
      system: [{ type: "text", text: "sys", cache_control: hour }],
      messages: [],
    });

    expect(out.cache_control).toBe(explicit);
  });

  it("returns the payload untouched for an endpoint that reads block markers", () => {
    const blocks = new AnthropicProviderTransport(
      { ...topLevel, cacheControlPlacement: undefined },
      TEST_API_KEY
    );
    const payload = {
      model: "MiniMax-M2.5",
      system: [{ type: "text", text: "sys", cache_control: hour }],
      messages: [],
    };

    expect(blocks.transformPayload(payload)).toBe(payload);
  });

  it("applies to the Kimi API endpoint and not to Kimi Code's", () => {
    const payload = {
      model: "kimi-k3",
      system: [{ type: "text", text: "sys", cache_control: hour }],
      messages: [],
    };
    const through = (name: string) =>
      new AnthropicProviderTransport(
        toRemoteProvider(getProviderByName(name)!),
        TEST_API_KEY
      ).transformPayload(payload);

    expect(through("kimi").cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(through("kimi-coding")).toBe(payload);
  });
});

describe("kimi@: cache_control on the wire", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const context = {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context;

  const hour = { type: "ephemeral", ttl: "1h" };
  const claudeCodeTurn = {
    model: "claude-opus-5-5",
    max_tokens: 64,
    system: [{ type: "text", text: "You are Claude Code.", cache_control: hour }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: hour }] }],
  };

  async function sendToKimi(modelParams?: Record<string, unknown>): Promise<any[]> {
    const sent: any[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (!String(url).endsWith("/anthropic/v1/messages"))
        return new Response(null, { status: 404 });
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "stub" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const handler = anthropicCompatProfile.createHandler({
      provider: toRemoteProvider(getProviderByName("kimi")!),
      modelName: "kimi-k3",
      apiKey: TEST_API_KEY,
      targetModel: "kimi@kimi-k3",
      port: 8080,
      sharedOpts: modelParams ? { modelParams } : {},
    });
    await handler!.handle(context, structuredClone(claudeCodeTurn));
    return sent;
  }

  it("sends a Claude Code turn's breakpoints as the request-level field", async () => {
    const [body] = await sendToKimi();

    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps a cache_control given with --model-params", async () => {
    const [body] = await sendToKimi({ cache_control: { type: "ephemeral", ttl: "5m" } });

    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
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
