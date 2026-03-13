// REGRESSION: mm@MiniMax-M2.5 HTTP 401 — Fixed in /fix session dev-fix-20260306-023717-beb53cef
//
// Root cause: AnthropicCompatTransport.getHeaders() always sends "x-api-key" but
// MiniMax's /anthropic/v1/messages endpoint requires "Authorization: Bearer <key>".
// Fix: RemoteProvider.authScheme: "bearer" | "x-api-key" selects the correct auth header.
//
// REGRESSION: kimi-k2.5 turn 2 fails with "unsupported content type: tool_reference"
//
// Root cause: AnthropicPassthroughAdapter.convertMessages() passed tool_reference blocks
// as-is. tool_reference is a Claude Code-internal type for deferred tool loading (ToolSearch)
// and is not part of the Anthropic public API spec — Kimi rejects it with HTTP 400.
// Fix: stripUnsupportedContentTypes() filters tool_reference from tool_result content arrays.

import { describe, it, expect } from "bun:test";
import { AnthropicCompatTransport } from "./anthropic-compat.js";
import { AnthropicPassthroughAdapter } from "../../adapters/anthropic-passthrough-adapter.js";
import type { TransportConfig } from "./base.js";

const TEST_API_KEY = "test-key-abc123";

function makeConfig(overrides: Partial<TransportConfig> = {}): TransportConfig {
  return {
    name: "test",
    displayName: "Test",
    baseUrl: "https://api.example.com",
    apiPath: "/anthropic/v1/messages",
    apiKey: TEST_API_KEY,
    modelName: "",
    authScheme: "bearer",
    ...overrides,
  };
}

describe("AnthropicCompatTransport.getHeaders()", () => {
  it("returns Authorization: Bearer header when authScheme is 'bearer'", async () => {
    const transport = new AnthropicCompatTransport(makeConfig({
      name: "minimax",
      displayName: "MiniMax",
      baseUrl: "https://api.minimax.io",
      authScheme: "bearer",
    }));
    const headers = await transport.getHeaders();

    expect(headers["Authorization"]).toBe(`Bearer ${TEST_API_KEY}`);
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("returns x-api-key header when authScheme is 'x-api-key'", async () => {
    const transport = new AnthropicCompatTransport(makeConfig({
      name: "kimi",
      displayName: "Kimi",
      baseUrl: "https://api.moonshot.cn",
      authScheme: "x-api-key",
    }));
    const headers = await transport.getHeaders();

    expect(headers["x-api-key"]).toBe(TEST_API_KEY);
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("defaults to x-api-key when authScheme is undefined", async () => {
    const transport = new AnthropicCompatTransport(makeConfig({
      name: "zai",
      displayName: "Z.AI",
      baseUrl: "https://api.z.ai",
      authScheme: undefined,
      // authScheme omitted: AnthropicCompat overrides getHeaders, so base default doesn't matter.
      // The override treats non-"bearer" as x-api-key.
    }));
    const headers = await transport.getHeaders();

    expect(headers["x-api-key"]).toBe(TEST_API_KEY);
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("AnthropicPassthroughAdapter — tool_reference stripping", () => {
  const adapter = new AnthropicPassthroughAdapter("kimi-k2.5", "kimi");

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
