import { describe, expect, mock, test } from "bun:test";
import { createProxyServer } from "../src/proxy-server.js";

// Mock fetch to simulate OpenRouter response
const originalFetch = global.fetch;

describe("Gemini Thinking Block Compatibility", () => {
  test("Should transform Gemini reasoning into safe text format (prevent R.map crash)", async () => {
    const port = 8899; // Use different port
    const model = "google/gemini-3-pro-preview";

    // Mock OpenRouter response with reasoning details
    global.fetch = mock(async (url, options) => {
      if (url.toString().includes("openrouter.ai")) {
        // Return a streaming response matching Gemini structure
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();

            // Chunk 1: Reasoning (Thinking)
            const chunk1 = {
              id: "msg_123",
              model: model,
              choices: [
                {
                  delta: {
                    reasoning: "This is a thought process.",
                    role: "assistant",
                  },
                },
              ],
            };

            // Chunk 2: Content
            const chunk2 = {
              id: "msg_123",
              model: model,
              choices: [
                {
                  delta: {
                    content: "Here is the result.",
                  },
                },
              ],
            };

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`));
            setTimeout(() => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }, 10);
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return originalFetch(url, options);
    });

    // Start proxy
    const proxy = await createProxyServer(port, "fake-key", model);

    try {
      // Make request to proxy
      const response = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
          stream: true,
        }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let output = "";
      let hasThinkingBlock = false;
      let hasTextBlock = false;
      let textContent = "";

      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;
        output += decoder.decode(value);
      }

      // Analyze SSE events
      const events = output.split("\n\n");
      for (const event of events) {
        if (event.includes("content_block_start")) {
          const data = JSON.parse(event.split("data: ")[1]);

          // Assertion: Should NEVER receive "thinking" type
          if (data.content_block?.type === "thinking") {
            hasThinkingBlock = true;
          }
          if (data.content_block?.type === "text") {
            hasTextBlock = true;
            if (data.content_block?.text) {
              textContent += data.content_block.text;
            }
          }
        }
        if (event.includes("content_block_delta")) {
          const data = JSON.parse(event.split("data: ")[1]);
          if (data.delta?.type === "text_delta") {
            textContent += data.delta.text;
          }
        }
      }

      // Assertions
      expect(hasThinkingBlock).toBe(false); // CRITICAL: Must be false to prevent crash
      expect(hasTextBlock).toBe(true); // Must contain text

      // Verify thinking content is HIDDEN from client (but processed internally)
      expect(textContent).not.toContain("<thinking>");
      expect(textContent).not.toContain("This is a thought process.");
      expect(textContent).not.toContain("</thinking>");

      // Verify regular content follows
      expect(textContent).toContain("Here is the result.");

      // Un-mock fetch
      global.fetch = originalFetch;
    } finally {
      await proxy.shutdown();
      global.fetch = originalFetch;
    }
  });
});
