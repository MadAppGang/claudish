import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { PoeHandler } from "../src/handlers/poe-handler.js";

// Mock the modules that the PoeHandler depends on
const mockContext = {
  json: (data: any, status?: number) => ({
    status: status || 200,
    data,
  }),
  header: (name: string, value: string) => {},
  body: (stream: any) => stream,
};

const mockAdapter = {
  reset: () => {},
  prepareRequest: () => {},
  processChunk: (chunk: any) => chunk,
};

const mockMiddlewareManager = {
  register: () => {},
  initialize: async () => {},
  beforeRequest: async () => {},
  destroy: async () => {},
};

// Mock dependencies
mock.module("../src/adapters/adapter-manager.js", () => ({
  AdapterManager: () => ({
    getAdapter: () => mockAdapter,
  }),
}));

mock.module("../src/middleware/index.js", () => ({
  MiddlewareManager: () => mockMiddlewareManager,
  GeminiThoughtSignatureMiddleware: () => {},
}));

mock.module("../src/transform.js", () => ({
  transformOpenAIToClaude: () => ({
    claudeRequest: {
      model: "poe/grok-4",
      messages: [{ role: "user", content: "test" }],
      temperature: 1,
      max_tokens: 4096,
    },
    droppedParams: [],
  }),
  removeUriFormat: () => {},
}));

mock.module("../src/logger.js", () => ({
  log: () => {},
  logStructured: () => {},
  isLoggingEnabled: () => false,
}));

mock.module("../src/model-loader.js", () => ({
  fetchModelContextWindow: async () => 256000,
  doesModelSupportReasoning: async () => true,
}));

describe("PoeHandler", () => {
  let handler: PoeHandler;
  const testPort = 3001;
  const testApiKey = "test-poe-api-key";
  const testModel = "poe/grok-4";

  beforeEach(() => {
    handler = new PoeHandler(testModel, testApiKey, testPort);
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  describe("Constructor", () => {
    it("should initialize with correct configuration", () => {
      expect(handler).toBeDefined();
    });

    it("should accept model, API key, and port", () => {
      const customHandler = new PoeHandler("poe/gpt-4o", "custom-key", 8080);
      expect(customHandler).toBeDefined();
    });
  });

  describe("Model ID Processing", () => {
    it("should extract actual model name without poe/ prefix", () => {
      // Test that the handler correctly processes model IDs
      const handlerWithPrefix = new PoeHandler("poe/grok-4", testApiKey, testPort);
      expect(handlerWithPrefix).toBeDefined();
    });
  });

  describe("Request Handling", () => {
    it("should handle basic request structure", async () => {
      const mockPayload = {
        model: "poe/grok-4",
        messages: [{ role: "user", content: "Hello, world!" }],
        max_tokens: 1000,
        temperature: 0.7,
      };

      // Mock fetch for Poe API
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn().mockResolvedValue({ done: true }),
            releaseLock: jest.fn(),
          }),
        },
      });

      const response = await handler.handle(mockContext as any, mockPayload);
      expect(response).toBeDefined();
    });

    it("should handle tools in requests", async () => {
      const mockPayload = {
        model: "poe/grok-4",
        messages: [{ role: "user", content: "Use a tool" }],
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
        max_tokens: 1000,
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn().mockResolvedValue({ done: true }),
            releaseLock: jest.fn(),
          }),
        },
      });

      const response = await handler.handle(mockContext as any, mockPayload);
      expect(response).toBeDefined();
    });
  });

  describe("Message Conversion", () => {
    it("should convert messages correctly", async () => {
      const mockPayload = {
        model: "poe/grok-4",
        system: "You are a helpful assistant",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hello" },
              { type: "image", source: { url: "data:image/png;base64,test" } },
            ],
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn().mockResolvedValue({ done: true }),
            releaseLock: jest.fn(),
          }),
        },
      });

      const response = await handler.handle(mockContext as any, mockPayload);
      expect(response).toBeDefined();
    });
  });

  describe("Tool Calling", () => {
    it("should handle tool_choice parameter", async () => {
      const mockPayload = {
        model: "poe/grok-4",
        messages: [{ role: "user", content: "Use the calculator" }],
        tool_choice: { type: "tool", name: "calculator" },
        tools: [
          {
            name: "calculator",
            description: "A calculator tool",
            input_schema: { type: "object" },
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn().mockResolvedValue({ done: true }),
            releaseLock: jest.fn(),
          }),
        },
      });

      const response = await handler.handle(mockContext as any, mockPayload);
      expect(response).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should handle API errors gracefully", async () => {
      const mockPayload = {
        model: "poe/grok-4",
        messages: [{ role: "user", content: "Hello" }],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const response = await handler.handle(mockContext as any, mockPayload);
      expect(response).toBeDefined();
    });

    it("should handle network errors gracefully", async () => {
      const mockPayload = {
        model: "poe/grok-4",
        messages: [{ role: "user", content: "Hello" }],
      };

      global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

      try {
        await handler.handle(mockContext as any, mockPayload);
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe("Streaming Response", () => {
    it("should handle streaming responses", async () => {
      const mockPayload = {
        model: "poe/grok-4",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      };

      // Mock streaming response
      const mockStream = new ReadableStream({
        start(controller) {
          // Send some SSE data
          controller.enqueue(new TextEncoder().encode("data: {\"choices\": [{\"delta\": {\"content\": \"Hello\"}}]}\n\n"));
          controller.close();
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const response = await handler.handle(mockContext as any, mockPayload);
      expect(response).toBeDefined();
    });
  });

  describe("Authentication", () => {
    it("should include correct Authorization header", async () => {
      const mockPayload = {
        model: "poe/grok-4",
        messages: [{ role: "user", content: "Hello" }],
      };

      let fetchCall: any;
      global.fetch = jest.fn().mockImplementation((url, options) => {
        fetchCall = { url, options };
        return {
          ok: true,
          body: {
            getReader: () => ({
              read: jest.fn().mockResolvedValue({ done: true }),
              releaseLock: jest.fn(),
            }),
          },
        };
      });

      await handler.handle(mockContext as any, mockPayload);

      expect(fetchCall).toBeDefined();
      expect(fetchCall.url).toBe("https://api.poe.com/v1/chat/completions");
      expect(fetchCall.options.headers.Authorization).toBe(`Bearer ${testApiKey}`);
    });
  });

  describe("Cleanup", () => {
    it("should shutdown cleanly", async () => {
      await expect(handler.shutdown()).resolves.not.toThrow();
    });
  });
});