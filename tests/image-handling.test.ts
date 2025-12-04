import { describe, expect, it, mock } from "bun:test";
import { createProxyServer } from "../src/proxy-server";

describe("Image Handling", () => {
  const PORT = 4000;

  // Mock data - 1x1 transparent PNG
  const base64Image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const mediaType = "image/png";

  it("should transform Anthropic image format to OpenAI image_url format", async () => {
    // Save original fetch
    const originalFetch = global.fetch;

    // Create a mock for fetch to intercept OpenRouter calls
    const mockFetch = mock((url, options) => {
      // Intercept OpenRouter API calls
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "test-id",
              choices: [
                {
                  message: {
                    role: "assistant", // OpenRouter/OpenAI returns role: assistant in message, not delta for non-streaming
                    content: "I see a 1x1 pixel image.",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }

      // Pass through other calls (like the request to the proxy itself)
      // Note: We need to use valid URL check or just catch-all
      return originalFetch(url, options);
    });

    // Replace global fetch
    global.fetch = mockFetch;

    let proxy;

    try {
      // Start proxy
      proxy = await createProxyServer(PORT, "fake-key", "test-model");
      const serverUrl = `http://127.0.0.1:${PORT}`;

      // Send request with image to proxy
      // We use originalFetch here to actually hit the Hono server running on localhost
      // (The Hono server will then call global.fetch, which is our mock)
      const response = await originalFetch(`${serverUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-sonnet-20240229",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: base64Image,
                  },
                },
                {
                  type: "text",
                  text: "What is this?",
                },
              ],
            },
          ],
          max_tokens: 100,
        }),
      });

      const result = await response.json();

      // 1. Verify proxy response is successful
      expect(response.status).toBe(200);
      expect(result.content[0].text).toBe("I see a 1x1 pixel image.");

      // 2. Verify OpenRouter request structure
      // Find the call to OpenRouter in the mock's history
      const openRouterCall = mockFetch.mock.calls.find(
        (call) => call[0] === "https://openrouter.ai/api/v1/chat/completions"
      );

      expect(openRouterCall).toBeDefined();

      // Parse the body sent to OpenRouter
      const requestBody = JSON.parse(openRouterCall[1].body);

      // Check message content
      const userMessage = requestBody.messages.find((m) => m.role === "user");
      expect(userMessage).toBeDefined();

      // Find the image part (should be converted to image_url)
      const imagePart = userMessage.content.find((c) => c.type === "image_url");
      expect(imagePart).toBeDefined();

      // Verify structure matches OpenAI format: { type: "image_url", image_url: { url: "data..." } }
      expect(imagePart.image_url).toBeDefined();
      expect(imagePart.image_url.url).toBe(`data:${mediaType};base64,${base64Image}`);

      // Verify text is preserved
      const textPart = userMessage.content.find((c) => c.type === "text");
      expect(textPart).toBeDefined();
      expect(textPart.text).toBe("What is this?");
    } finally {
      // Cleanup
      if (proxy) await proxy.shutdown();
      global.fetch = originalFetch;
    }
  });
});
