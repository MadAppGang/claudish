// REGRESSION: mm@MiniMax-M2.5 HTTP 401 — Fixed in /fix session dev-fix-20260306-023717-beb53cef
//
// Root cause: AnthropicCompatProvider.getHeaders() always sends "x-api-key" but
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
import { AnthropicCompatProvider } from "./anthropic-compat.js";
import { AnthropicPassthroughAdapter } from "../../adapters/anthropic-passthrough-adapter.js";
import type { RemoteProvider } from "../../../handlers/shared/remote-provider-types.js";

const TEST_API_KEY = "test-key-abc123";

describe("AnthropicCompatProvider.getHeaders()", () => {
  it("returns Authorization: Bearer header when authScheme is 'bearer'", async () => {
    const provider: RemoteProvider = {
      name: "minimax",
      baseUrl: "https://api.minimax.io",
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
