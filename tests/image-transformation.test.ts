import { describe, expect, it, mock, spyOn } from "bun:test";
import { createProxyServer } from "../src/proxy-server";

// Mock fetch globally
const originalFetch = global.fetch;
const mockFetch = mock(async (url: string | Request | URL, init?: RequestInit) => {
  return new Response(
    JSON.stringify({
      id: "test-id",
      choices: [
        {
          message: {
            content: "Response content",
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }),
    { status: 200 }
  );
});

// Helper to parse the request bodysent to OpenRouter
async function captureOpenRouterRequest(requestPayload: any): Promise<any> {
  // Reset mock
  mockFetch.mockClear();
  global.fetch = mockFetch;

  // Create server instance with a random port to avoid collisions
  const randomPort = 30000 + Math.floor(Math.random() * 10000);
  const server = await createProxyServer(randomPort, "test-api-key", "test-model");
  const port = server.port;

  try {
    // Send request to proxy
    await originalFetch(`http://localhost:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "dummy-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestPayload),
    });

    // Verify fetch was called with OpenRouter URL
    const calls = mockFetch.mock.calls;
    const openRouterCall = calls.find(
      (call) => call[0].toString() === "https://openrouter.ai/api/v1/chat/completions"
    );

    if (!openRouterCall) {
      throw new Error("OpenRouter API was not called");
    }

    // Parse the body sent to OpenRouter
    const requestBody = JSON.parse(openRouterCall[1].body as string);
    return requestBody;
  } finally {
    await server.shutdown();
    global.fetch = originalFetch;
  }
}

describe("Image Transformation", () => {
  it("should transform Anthropic image block to OpenAI image_url format", async () => {
    // Anthropic request payload with image
    const anthropicRequest = {
      model: "claude-3-sonnet-20240229",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "/9j/4AAQSkZJRg...", // Shortened base64 data
              },
            },
            {
              type: "text",
              text: "What is in this image?",
            },
          ],
        },
      ],
    };

    // Execute test
    const openRouterBody = await captureOpenRouterRequest(anthropicRequest);

    // Validation
    expect(openRouterBody).toBeDefined();
    expect(openRouterBody.messages).toHaveLength(1);

    const message = openRouterBody.messages[0];
    expect(message.role).toBe("user");
    expect(message.content).toHaveLength(2);

    // Verify image part transformation
    const imagePart = message.content[0];
    expect(imagePart.type).toBe("image_url");
    expect(imagePart.image_url).toBeDefined();
    expect(imagePart.image_url.url).toBe("data:image/jpeg;base64,/9j/4AAQSkZJRg...");

    // Verify text part remains unchanged
    const textPart = message.content[1];
    expect(textPart.type).toBe("text");
    expect(textPart.text).toBe("What is in this image?");
  });

  it("should handle multiple images in one message", async () => {
    const anthropicRequest = {
      model: "claude-3-sonnet-20240229",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "png-data-1",
              },
            },
            {
              type: "text",
              text: "Compare these two.",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "jpeg-data-2",
              },
            },
          ],
        },
      ],
    };

    const openRouterBody = await captureOpenRouterRequest(anthropicRequest);

    const content = openRouterBody.messages[0].content;
    expect(content).toHaveLength(3);

    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url.url).toBe("data:image/png;base64,png-data-1");

    expect(content[1].type).toBe("text");
    expect(content[1].text).toBe("Compare these two.");

    expect(content[2].type).toBe("image_url");
    expect(content[2].image_url.url).toBe("data:image/jpeg;base64,jpeg-data-2");
  });

  it("should handle images mixed with tool results correctly", async () => {
    const anthropicRequest = {
      model: "claude-3-sonnet-20240229",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "Tool output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/webp",
                data: "webp-data",
              },
            },
          ],
        },
      ],
    };

    const openRouterBody = await captureOpenRouterRequest(anthropicRequest);

    // Should have separated into tool message and user message
    // But in the code it puts them all in one "messages" array, effectively splitting them
    // The current implementation pushes tool messages FIRST, then user message with content

    // Expecting:
    // 1. Tool message (role: tool)
    // 2. User message (role: user) with image

    expect(openRouterBody.messages).toHaveLength(2);

    const toolMsg = openRouterBody.messages[0];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toBe("Tool output");

    const userMsg = openRouterBody.messages[1];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toHaveLength(1);
    expect(userMsg.content[0].type).toBe("image_url");
    expect(userMsg.content[0].image_url.url).toBe("data:image/webp;base64,webp-data");
  });

  it("should handle complex scenario with simulated files (large text) and images", async () => {
    // Simulate a scenario where user provides a file content and an image of the UI
    const fileContent = "function test() { return true; }".repeat(100); // Simulate generic code file

    const anthropicRequest = {
      model: "google/gemini-3-pro-preview",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Here is the current implementation of the component:\n\n<file_content path="src/Component.tsx">\n${fileContent}\n</file_content>`,
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "ui-screenshot-data",
              },
            },
            {
              type: "text",
              text: "Does this code match the screenshot?",
            },
          ],
        },
      ],
    };

    const openRouterBody = await captureOpenRouterRequest(anthropicRequest);

    const message = openRouterBody.messages[0];
    expect(message.content).toHaveLength(3);

    // Check file content text preservation
    expect(message.content[0].type).toBe("text");
    expect(message.content[0].text).toContain('<file_content path="src/Component.tsx">');
    expect(message.content[0].text).toHaveLength(
      anthropicRequest.messages[0].content[0].text.length
    );

    // Check image
    expect(message.content[1].type).toBe("image_url");
    expect(message.content[1].image_url.url).toBe("data:image/png;base64,ui-screenshot-data");

    // Check prompt text
    expect(message.content[2].type).toBe("text");
    expect(message.content[2].text).toBe("Does this code match the screenshot?");
  });
});
