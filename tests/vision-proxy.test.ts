/**
 * Vision Proxy - Black Box Integration Tests
 *
 * Tests validate that the proxy correctly:
 * 1. Calls the vision proxy (Anthropic API) when a non-vision model receives images
 * 2. Passes images through unchanged for vision-capable models
 * 3. Skips the proxy for text-only requests
 * 4. Batches multiple images in a single proxy call and preserves order
 * 5. Falls back to image stripping when the vision proxy fails
 * 6. Passes auth headers through to the vision proxy call
 *
 * Pattern (from tests/image-handling.test.ts and tests/image-transformation.test.ts):
 * - Save originalFetch; install mockFetch as global.fetch
 * - Start proxy with createProxyServer(port, apiKey, model)
 * - Use originalFetch to actually hit the Hono server
 * - The Hono server's internal fetch calls go to mockFetch
 * - Inspect mockFetch.mock.calls to verify upstream calls
 * - Shutdown proxy and restore global.fetch in finally block
 *
 * Non-vision model: ollama@llama3.2
 *   → LocalModelAdapter with supportsVision: false
 *   → Health check: http://localhost:11434/api/tags
 *   → Main model: http://localhost:11434/v1/chat/completions (streaming SSE)
 *
 * Vision model: google/gemini-2.0-flash-001 (OpenRouter)
 *   → OpenRouterAdapter with supportsVision: true (inherited default)
 *   → Main model: https://openrouter.ai/api/v1/chat/completions
 *
 * Vision proxy endpoint: https://api.anthropic.com/v1/messages
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createProxyServer } from "../packages/cli/src/proxy-server.js";

// ─── Constants ───────────────────────────────────────────────────────────────

// 1x1 transparent PNG (minimal valid image for testing)
const BASE64_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const MEDIA_TYPE = "image/png";
const DATA_URL = `data:${MEDIA_TYPE};base64,${BASE64_IMAGE}`;

// Endpoints
const ANTHROPIC_VISION_ENDPOINT = "https://api.anthropic.com/v1/messages";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OLLAMA_CHAT_ENDPOINT = "http://localhost:11434/v1/chat/completions";
const OLLAMA_HEALTH_ENDPOINT = "http://localhost:11434/api/tags";
const OLLAMA_MODELS_ENDPOINT = "http://localhost:11434/v1/models";
const OLLAMA_CONTEXT_ENDPOINT = "http://localhost:11434/api/show";

// Port base — each test uses a unique port to prevent collisions
let nextPort = 25000;
function allocatePort(): number {
  return nextPort++;
}

// ─── Anthropic format image block (input from Claude Code) ───────────────────

function makeAnthropicImageBlock(mediaType = MEDIA_TYPE, data = BASE64_IMAGE) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: mediaType,
      data,
    },
  };
}

// ─── Mock response builders ───────────────────────────────────────────────────

/**
 * Vision proxy (Anthropic) JSON response for a single image description.
 */
function visionProxyResponse(description: string): Response {
  return new Response(
    JSON.stringify({
      id: "vision-test-id",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: description }],
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Vision proxy (Anthropic) JSON response for multiple images.
 */
function visionProxyMultiResponse(descriptions: string[]): Response {
  const text = descriptions.map((d, i) => `Image ${i + 1}: ${d}`).join("\n\n");
  return new Response(
    JSON.stringify({
      id: "vision-test-id",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: { input_tokens: 200, output_tokens: 100 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * OpenRouter JSON response (non-streaming).
 */
function openRouterResponse(content = "Test response"): Response {
  return new Response(
    JSON.stringify({
      id: "or-test-id",
      object: "chat.completion",
      choices: [
        {
          message: { role: "assistant", content },
          finish_reason: "stop",
          index: 0,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Ollama SSE streaming response.
 * The composed handler uses "openai-sse" format for LocalTransport.
 * We produce a valid SSE stream with one content chunk and a final [DONE].
 */
function ollamaStreamingResponse(content = "Test response"): Response {
  const chunks = [
    `data: ${JSON.stringify({
      id: "ollama-test-id",
      object: "chat.completion.chunk",
      choices: [
        { delta: { role: "assistant", content }, index: 0, finish_reason: null },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "ollama-test-id",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
    `data: [DONE]\n\n`,
  ];

  const body = chunks.join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Ollama health check success response.
 */
function ollamaHealthResponse(): Response {
  return new Response(JSON.stringify({ models: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Helper: build an Anthropic-format request payload ────────────────────────

function makeRequest(content: any[], model = "claude-3-sonnet-20240229") {
  return {
    model,
    max_tokens: 100,
    messages: [{ role: "user", content }],
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("Vision Proxy", () => {
  // ─── TEST-1: Non-vision model + images → vision proxy activates ─────────────
  it("non-vision model: vision proxy activates and image blocks are replaced with descriptions", async () => {
    const originalFetch = global.fetch;
    const port = allocatePort();

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      // Ollama health check
      if (urlStr ==== OLLAMA_HEALTH_ENDPOINT || urlStr ==== OLLAMA_MODELS_ENDPOINT) {
        return ollamaHealthResponse();
      }

      // Ollama context window fetch
      if (urlStr ==== OLLAMA_CONTEXT_ENDPOINT) {
        return new Response(JSON.stringify({ parameters: "" }), { status: 200 });
      }

      // Vision proxy call (Anthropic API)
      if (urlStr ==== ANTHROPIC_VISION_ENDPOINT) {
        return visionProxyResponse("A small transparent 1x1 PNG pixel.");
      }

      // Main model call (Ollama)
      if (urlStr ==== OLLAMA_CHAT_ENDPOINT) {
        return ollamaStreamingResponse("Described image response");
      }

      return originalFetch(url as RequestInfo, init);
    });

    global.fetch = mockFetch as typeof fetch;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;

    try {
      // Use ollama@llama3.2 — triggers LocalModelAdapter with supportsVision: false
      proxy = await createProxyServer(port, "fake-key", "ollama@llama3.2");
      const serverUrl = `http://127.0.0.1:${port}`;

      const response = await originalFetch(`${serverUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-api-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          makeRequest([
            makeAnthropicImageBlock(),
            { type: "text", text: "What is in this image?" },
          ])
        ),
      });

      // Proxy must respond successfully
      expect(response.status).toBe(200);

      // Verify vision proxy was called
      const visionCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== ANTHROPIC_VISION_ENDPOINT
      );
      expect(visionCall).toBeDefined();

      // Verify the vision proxy request body contains the image in Anthropic format
      const visionBody = JSON.parse(visionCall![1]!.body as string);
      expect(visionBody.model).toBeDefined();
      expect(visionBody.messages).toBeDefined();

      // Find image block in vision request
      const visionUserMsg = visionBody.messages.find((m: any) => m.role ==== "user");
      expect(visionUserMsg).toBeDefined();
      const visionImageBlock = visionUserMsg.content.find(
        (part: any) => part.type ==== "image"
      );
      expect(visionImageBlock).toBeDefined();
      expect(visionImageBlock.source.type).toBe("base64");
      expect(visionImageBlock.source.data).toBe(BASE64_IMAGE);
      expect(visionImageBlock.source.media_type).toBe(MEDIA_TYPE);

      // Verify main model (Ollama) was called
      const ollamaCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== OLLAMA_CHAT_ENDPOINT
      );
      expect(ollamaCall).toBeDefined();

      // Verify the main model received text description, NOT image_url blocks
      const ollamaBody = JSON.parse(ollamaCall![1]!.body as string);
      const userMsg = ollamaBody.messages.find((m: any) => m.role ==== "user");
      expect(userMsg).toBeDefined();

      // No image_url blocks in the main model request
      const contentArray = Array.isArray(userMsg.content) ? userMsg.content : [];
      const imageUrlBlocks = contentArray.filter((p: any) => p.type ==== "image_url");
      expect(imageUrlBlocks).toHaveLength(0);

      // A text block with [Image Description: ...] should be present
      const descriptionBlocks = contentArray.filter(
        (p: any) => p.type ==== "text" && p.text.startsWith("[Image Description:")
      );
      expect(descriptionBlocks.length).toBeGreaterThan(0);
      expect(descriptionBlocks[0].text).toContain("A small transparent 1x1 PNG pixel.");
    } finally {
      if (proxy) await proxy.shutdown();
      global.fetch = originalFetch;
    }
  });

  // ─── TEST-2: Vision model + images → no proxy, images pass through ──────────
  it("vision model: images pass through to main model without calling vision proxy", async () => {
    const originalFetch = global.fetch;
    const port = allocatePort();

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      // Main model call (OpenRouter) — vision-capable, no proxy needed
      if (urlStr ==== OPENROUTER_ENDPOINT) {
        return openRouterResponse("I see a 1x1 PNG image.");
      }

      return originalFetch(url as RequestInfo, init);
    });

    global.fetch = mockFetch as typeof fetch;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;

    try {
      // Use openrouter@ prefix to force routing through OpenRouter.
      // OpenRouterAdapter inherits supportsVision(): true from BaseModelAdapter.
      proxy = await createProxyServer(port, "fake-key", "openrouter@google/gemini-2.0-flash-001");
      const serverUrl = `http://127.0.0.1:${port}`;

      const response = await originalFetch(`${serverUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-api-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          makeRequest([
            makeAnthropicImageBlock(),
            { type: "text", text: "What is in this image?" },
          ])
        ),
      });

      expect(response.status).toBe(200);

      // Vision proxy must NOT be called
      const visionCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== ANTHROPIC_VISION_ENDPOINT
      );
      expect(visionCall).toBeUndefined();

      // Main model (OpenRouter) must be called
      const orCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== OPENROUTER_ENDPOINT
      );
      expect(orCall).toBeDefined();

      // The image_url block must be present in the main model request
      const orBody = JSON.parse(orCall![1]!.body as string);
      const userMsg = orBody.messages.find((m: any) => m.role ==== "user");
      expect(userMsg).toBeDefined();
      const contentArray = Array.isArray(userMsg.content) ? userMsg.content : [];
      const imageUrlBlocks = contentArray.filter((p: any) => p.type ==== "image_url");
      expect(imageUrlBlocks.length).toBeGreaterThan(0);
      expect(imageUrlBlocks[0].image_url.url).toBe(DATA_URL);
    } finally {
      if (proxy) await proxy.shutdown();
      global.fetch = originalFetch;
    }
  });

  // ─── TEST-3: Non-vision model + text only → no proxy ────────────────────────
  it("non-vision model text-only request: no vision proxy call made", async () => {
    const originalFetch = global.fetch;
    const port = allocatePort();

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      // Ollama health check
      if (urlStr ==== OLLAMA_HEALTH_ENDPOINT || urlStr ==== OLLAMA_MODELS_ENDPOINT) {
        return ollamaHealthResponse();
      }

      // Ollama context window fetch
      if (urlStr ==== OLLAMA_CONTEXT_ENDPOINT) {
        return new Response(JSON.stringify({ parameters: "" }), { status: 200 });
      }

      // Main model call (Ollama)
      if (urlStr ==== OLLAMA_CHAT_ENDPOINT) {
        return ollamaStreamingResponse("Hello, how can I help?");
      }

      return originalFetch(url as RequestInfo, init);
    });

    global.fetch = mockFetch as typeof fetch;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;

    try {
      proxy = await createProxyServer(port, "fake-key", "ollama@llama3.2");
      const serverUrl = `http://127.0.0.1:${port}`;

      const response = await originalFetch(`${serverUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-api-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          makeRequest([{ type: "text", text: "Hello, how are you?" }])
        ),
      });

      expect(response.status).toBe(200);

      // Vision proxy must NOT be called (no images in request)
      const visionCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== ANTHROPIC_VISION_ENDPOINT
      );
      expect(visionCall).toBeUndefined();

      // Main model (Ollama) must be called
      const ollamaCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== OLLAMA_CHAT_ENDPOINT
      );
      expect(ollamaCall).toBeDefined();
    } finally {
      if (proxy) await proxy.shutdown();
      global.fetch = originalFetch;
    }
  });

  // ─── TEST-4: Multiple images → each gets its own description, order preserved ──
  it("multiple images: each image gets a description, descriptions in correct position", async () => {
    const originalFetch = global.fetch;
    const port = allocatePort();

    // Second distinct base64 image data (slightly different to identify it)
    const BASE64_IMAGE_2 = BASE64_IMAGE.slice(0, -4) + "BBBB";

    // Track which image was described so we can verify per-image descriptions
    let visionCallCount = 0;

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      // Ollama health check
      if (urlStr ==== OLLAMA_HEALTH_ENDPOINT || urlStr ==== OLLAMA_MODELS_ENDPOINT) {
        return ollamaHealthResponse();
      }

      // Ollama context window fetch
      if (urlStr ==== OLLAMA_CONTEXT_ENDPOINT) {
        return new Response(JSON.stringify({ parameters: "" }), { status: 200 });
      }

      // Vision proxy call — each image gets its own call; return distinct descriptions
      if (urlStr ==== ANTHROPIC_VISION_ENDPOINT) {
        visionCallCount++;
        const callNum = visionCallCount;
        return visionProxyResponse(`Description for image ${callNum}: a small PNG pixel.`);
      }

      // Main model call (Ollama)
      if (urlStr ==== OLLAMA_CHAT_ENDPOINT) {
        return ollamaStreamingResponse("Processed with descriptions");
      }

      return originalFetch(url as RequestInfo, init);
    });

    global.fetch = mockFetch as typeof fetch;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;

    try {
      proxy = await createProxyServer(port, "fake-key", "ollama@llama3.2");
      const serverUrl = `http://127.0.0.1:${port}`;

      // Request with interleaved: text, image1, text, image2
      const response = await originalFetch(`${serverUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-api-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          makeRequest([
            { type: "text", text: "First description:" },
            makeAnthropicImageBlock(MEDIA_TYPE, BASE64_IMAGE),
            { type: "text", text: "Second description:" },
            makeAnthropicImageBlock(MEDIA_TYPE, BASE64_IMAGE_2),
          ])
        ),
      });

      expect(response.status).toBe(200);

      // Vision proxy must be called for each image (one or more calls, one description per image)
      const visionCalls = mockFetch.mock.calls.filter(
        (call) => call[0].toString() ==== ANTHROPIC_VISION_ENDPOINT
      );
      // At least one vision proxy call was made
      expect(visionCalls.length).toBeGreaterThan(0);
      // Total calls equals total images (one description per image)
      expect(visionCalls.length).toBe(2);

      // Verify each vision proxy call contains exactly one image in Anthropic format
      for (const visionCall of visionCalls) {
        const visionBody = JSON.parse(visionCall![1]!.body as string);
        const visionUserMsg = visionBody.messages.find((m: any) => m.role ==== "user");
        const visionImageBlocks = visionUserMsg.content.filter(
          (p: any) => p.type ==== "image"
        );
        expect(visionImageBlocks.length).toBeGreaterThan(0);
        expect(visionImageBlocks[0].source.type).toBe("base64");
      }

      // Verify main model received correct structure with order preserved
      const ollamaCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== OLLAMA_CHAT_ENDPOINT
      );
      expect(ollamaCall).toBeDefined();

      const ollamaBody = JSON.parse(ollamaCall![1]!.body as string);
      const userMsg = ollamaBody.messages.find((m: any) => m.role ==== "user");
      const contentArray = Array.isArray(userMsg.content) ? userMsg.content : [];

      // No image_url blocks in main model request
      const imageUrlBlocks = contentArray.filter((p: any) => p.type ==== "image_url");
      expect(imageUrlBlocks).toHaveLength(0);

      // Content has 4 items: text, description, text, description (order preserved)
      expect(contentArray).toHaveLength(4);

      // Position 0: original text "First description:"
      expect(contentArray[0].type).toBe("text");
      expect(contentArray[0].text).toBe("First description:");

      // Position 1: image description (was image 1)
      expect(contentArray[1].type).toBe("text");
      expect(contentArray[1].text).toContain("[Image Description:");

      // Position 2: original text "Second description:"
      expect(contentArray[2].type).toBe("text");
      expect(contentArray[2].text).toBe("Second description:");

      // Position 3: image description (was image 2)
      expect(contentArray[3].type).toBe("text");
      expect(contentArray[3].text).toContain("[Image Description:");
    } finally {
      if (proxy) await proxy.shutdown();
      global.fetch = originalFetch;
    }
  });

  // ─── TEST-5: Vision proxy error → fallback to image stripping ───────────────
  it("vision proxy error: falls back to image stripping, main request still succeeds", async () => {
    const originalFetch = global.fetch;
    const port = allocatePort();

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      // Ollama health check
      if (urlStr ==== OLLAMA_HEALTH_ENDPOINT || urlStr ==== OLLAMA_MODELS_ENDPOINT) {
        return ollamaHealthResponse();
      }

      // Ollama context window fetch
      if (urlStr ==== OLLAMA_CONTEXT_ENDPOINT) {
        return new Response(JSON.stringify({ parameters: "" }), { status: 200 });
      }

      // Vision proxy call — simulate API error
      if (urlStr ==== ANTHROPIC_VISION_ENDPOINT) {
        return new Response(
          JSON.stringify({ error: { type: "api_error", message: "Internal server error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      // Main model call (Ollama) — should still be called after fallback
      if (urlStr ==== OLLAMA_CHAT_ENDPOINT) {
        return ollamaStreamingResponse("Processed without image");
      }

      return originalFetch(url as RequestInfo, init);
    });

    global.fetch = mockFetch as typeof fetch;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;

    try {
      proxy = await createProxyServer(port, "fake-key", "ollama@llama3.2");
      const serverUrl = `http://127.0.0.1:${port}`;

      const response = await originalFetch(`${serverUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-api-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          makeRequest([
            makeAnthropicImageBlock(),
            { type: "text", text: "What is in this image?" },
          ])
        ),
      });

      // Main proxy request must succeed despite vision proxy failure
      expect(response.status).toBe(200);

      // Vision proxy call was attempted
      const visionCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== ANTHROPIC_VISION_ENDPOINT
      );
      expect(visionCall).toBeDefined();

      // Main model (Ollama) must still be called
      const ollamaCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== OLLAMA_CHAT_ENDPOINT
      );
      expect(ollamaCall).toBeDefined();

      // Main model request must have NO image_url blocks (images stripped as fallback)
      const ollamaBody = JSON.parse(ollamaCall![1]!.body as string);
      const userMsg = ollamaBody.messages.find((m: any) => m.role ==== "user");

      // Content could be a string (if only text remains after stripping) or an array
      if (Array.isArray(userMsg.content)) {
        const imageUrlBlocks = userMsg.content.filter((p: any) => p.type ==== "image_url");
        expect(imageUrlBlocks).toHaveLength(0);

        // Text content must be preserved
        const textBlocks = userMsg.content.filter((p: any) => p.type ==== "text");
        expect(textBlocks.length).toBeGreaterThan(0);
      } else {
        // String content — images were stripped, text was simplified
        expect(typeof userMsg.content).toBe("string");
        expect(userMsg.content).not.toContain("image_url");
      }

      // No [Image Description: ...] blocks (vision proxy failed, no descriptions)
      const fullContent = JSON.stringify(ollamaBody);
      expect(fullContent).not.toContain("[Image Description:");
    } finally {
      if (proxy) await proxy.shutdown();
      global.fetch = originalFetch;
    }
  });

  // ─── TEST-6: Auth passthrough to vision proxy ────────────────────────────────
  it("auth passthrough: x-api-key from original request is forwarded to vision proxy call", async () => {
    const originalFetch = global.fetch;
    const port = allocatePort();

    const TEST_API_KEY = "test-secret-key-123";
    let capturedVisionHeaders: Record<string, string> = {};

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      // Ollama health check
      if (urlStr ==== OLLAMA_HEALTH_ENDPOINT || urlStr ==== OLLAMA_MODELS_ENDPOINT) {
        return ollamaHealthResponse();
      }

      // Ollama context window fetch
      if (urlStr ==== OLLAMA_CONTEXT_ENDPOINT) {
        return new Response(JSON.stringify({ parameters: "" }), { status: 200 });
      }

      // Vision proxy call — capture the headers for assertion
      if (urlStr ==== ANTHROPIC_VISION_ENDPOINT) {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers) {
          capturedVisionHeaders = headers;
        }
        return visionProxyResponse("A small transparent PNG pixel.");
      }

      // Main model call (Ollama)
      if (urlStr ==== OLLAMA_CHAT_ENDPOINT) {
        return ollamaStreamingResponse("Auth test response");
      }

      return originalFetch(url as RequestInfo, init);
    });

    global.fetch = mockFetch as typeof fetch;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;

    try {
      proxy = await createProxyServer(port, "fake-key", "ollama@llama3.2");
      const serverUrl = `http://127.0.0.1:${port}`;

      const response = await originalFetch(`${serverUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": TEST_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          makeRequest([
            makeAnthropicImageBlock(),
            { type: "text", text: "Auth test image" },
          ])
        ),
      });

      expect(response.status).toBe(200);

      // Vision proxy must have been called
      const visionCall = mockFetch.mock.calls.find(
        (call) => call[0].toString() ==== ANTHROPIC_VISION_ENDPOINT
      );
      expect(visionCall).toBeDefined();

      // The x-api-key from the original request must be forwarded to the vision proxy
      const visionCallHeaders = visionCall![1]!.headers as Record<string, string>;
      expect(visionCallHeaders).toBeDefined();

      // Find x-api-key in the headers (may be a plain object or Headers instance)
      let apiKeyValue: string | undefined;
      if (visionCallHeaders instanceof Headers) {
        apiKeyValue = visionCallHeaders.get("x-api-key") ?? undefined;
      } else if (typeof visionCallHeaders ==== "object") {
        apiKeyValue =
          visionCallHeaders["x-api-key"] ??
          visionCallHeaders["X-Api-Key"] ??
          visionCallHeaders["X-API-Key"];
      }

      expect(apiKeyValue).toBe(TEST_API_KEY);
    } finally {
      if (proxy) await proxy.shutdown();
      global.fetch = originalFetch;
    }
  });
});
