import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createProxyServer } from "../src/proxy-server";

/**
 * Regression test for Grok xAI XML function call format issue
 *
 * ISSUE: Grok models sometimes output <xai:function_call> XML format as text
 * instead of using OpenAI's tool_calls JSON format. This breaks Claude Code.
 *
 * FIX: We inject a system message for Grok models forcing OpenAI format.
 *
 * This test validates that:
 * 1. The system message is correctly injected for Grok models
 * 2. The message warns against XML format
 * 3. The tools array is properly passed to OpenRouter
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key";
const TEST_PORT = 8339;

let proxyServer: Awaited<ReturnType<typeof createProxyServer>>;

beforeAll(async () => {
  proxyServer = await createProxyServer(
    TEST_PORT,
    OPENROUTER_API_KEY,
    "x-ai/grok-code-fast-1",
    false,
    undefined
  );
});

afterAll(async () => {
  if (proxyServer) {
    await proxyServer.shutdown();
  }
});

describe("Grok Tool Format Fix", () => {
  test("should inject system message for Grok models with tools", async () => {
    // Simulate Claude Code request with tools
    const claudeRequest = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: "Read the package.json file",
        },
      ],
      tools: [
        {
          name: "Read",
          description: "Read a file from the filesystem",
          input_schema: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "The absolute path to the file to read",
              },
            },
            required: ["file_path"],
          },
        },
      ],
    };

    // Mock fetch to capture the request sent to OpenRouter
    let capturedPayload: any = null;
    const originalFetch = global.fetch;
    global.fetch = async (url: any, options: any) => {
      if (typeof url === "string" && url.includes("openrouter")) {
        capturedPayload = JSON.parse(options.body);
        // Return a mock response to avoid actual API call
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Test response" },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return originalFetch(url, options);
    };

    try {
      // Make request to proxy
      const response = await fetch(`http://localhost:${TEST_PORT}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(claudeRequest),
      });

      // Wait for response
      await response.text();

      // Verify the payload sent to OpenRouter
      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.model).toBe("x-ai/grok-code-fast-1");
      expect(capturedPayload.messages).toBeDefined();
      expect(capturedPayload.tools).toBeDefined();
      expect(capturedPayload.tools.length).toBeGreaterThan(0);

      // CRITICAL: Verify system message was injected
      const firstMessage = capturedPayload.messages[0];
      expect(firstMessage.role).toBe("system");
      expect(firstMessage.content).toContain("OpenAI tool_calls format");
      expect(firstMessage.content).toContain("NEVER use XML format");
      expect(firstMessage.content).toContain("<xai:function_call>");

      console.log("✅ Grok tool format fix verified:");
      console.log("  - System message injected");
      console.log("  - Warns against XML format");
      console.log("  - Content:", firstMessage.content);
    } finally {
      // Restore original fetch
      global.fetch = originalFetch;
    }
  });

  test("should NOT inject system message for non-Grok models", async () => {
    // Create a non-Grok proxy
    const nonGrokProxy = await createProxyServer(
      8340,
      OPENROUTER_API_KEY,
      "openai/gpt-4",
      false,
      undefined
    );

    try {
      const claudeRequest = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: "Read the package.json file",
          },
        ],
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: {
                file_path: { type: "string" },
              },
              required: ["file_path"],
            },
          },
        ],
      };

      let capturedPayload: any = null;
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === "string" && url.includes("openrouter")) {
          capturedPayload = JSON.parse(options.body);
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: "Test response" },
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        return originalFetch(url, options);
      };

      try {
        const response = await fetch(`http://localhost:8340/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(claudeRequest),
        });

        await response.text();

        // Verify NO system message was injected for non-Grok models
        expect(capturedPayload).toBeDefined();
        const firstMessage = capturedPayload.messages[0];

        // Should be user message, NOT system message
        expect(firstMessage.role).toBe("user");
        expect(firstMessage.content).not.toContain("OpenAI tool_calls format");

        console.log("✅ Non-Grok model verified:");
        console.log("  - No system message injected");
        console.log("  - First message is user message");
      } finally {
        global.fetch = originalFetch;
      }
    } finally {
      await nonGrokProxy.shutdown();
    }
  });

  test("should append to existing system message if present", async () => {
    const claudeRequest = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: "You are a helpful coding assistant.",
      messages: [
        {
          role: "user",
          content: "Read the package.json file",
        },
      ],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
            required: ["file_path"],
          },
        },
      ],
    };

    let capturedPayload: any = null;
    const originalFetch = global.fetch;
    global.fetch = async (url: any, options: any) => {
      if (typeof url === "string" && url.includes("openrouter")) {
        capturedPayload = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Test response" },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return originalFetch(url, options);
    };

    try {
      const response = await fetch(`http://localhost:${TEST_PORT}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(claudeRequest),
      });

      await response.text();

      // Verify system message contains BOTH original and appended content
      expect(capturedPayload).toBeDefined();
      const firstMessage = capturedPayload.messages[0];
      expect(firstMessage.role).toBe("system");
      expect(firstMessage.content).toContain("helpful coding assistant");
      expect(firstMessage.content).toContain("OpenAI tool_calls format");
      expect(firstMessage.content).toContain("NEVER use XML format");

      console.log("✅ Existing system message verified:");
      console.log("  - Original content preserved");
      console.log("  - Tool format instruction appended");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// Export for documentation
export const GROK_FIX_DOCUMENTATION = {
  issue: "Grok outputs <xai:function_call> XML as text instead of tool_calls JSON",
  impact: "Claude Code UI gets stuck, tools don't execute",
  fix: "Inject system message forcing OpenAI tool_calls format",
  tested: "Regression test validates system message injection",
  discovered: "2025-11-11",
  severity: "CRITICAL",
};
