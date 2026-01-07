/**
 * Unit tests for Gemini and OpenAI handler message conversion
 */

import { describe, test, expect } from "bun:test";

// Test the conversion logic by importing the handlers
import { GeminiHandler } from "../src/handlers/gemini-handler";
import { OpenAIHandler } from "../src/handlers/openai-handler";
import type { RemoteProvider } from "../src/handlers/shared/remote-provider-types";

const mockGeminiProvider: RemoteProvider = {
  name: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiPath: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
  apiKeyEnvVar: "GEMINI_API_KEY",
  prefixes: ["g/", "gemini/"],
  capabilities: {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsJsonMode: false,
    supportsReasoning: true,
  },
};

const mockOpenAIProvider: RemoteProvider = {
  name: "openai",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/chat/completions",
  apiKeyEnvVar: "OPENAI_API_KEY",
  prefixes: ["oai/", "openai/"],
  capabilities: {
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsJsonMode: true,
    supportsReasoning: true,
  },
};

describe("GeminiHandler", () => {
  test("should instantiate correctly", () => {
    const handler = new GeminiHandler(mockGeminiProvider, "gemini-2.5-flash", "fake-key", 3000);
    expect(handler).toBeDefined();
    expect(typeof handler.handle).toBe("function");
    expect(typeof handler.shutdown).toBe("function");
  });

  test("should have correct API endpoint", () => {
    const handler = new GeminiHandler(mockGeminiProvider, "gemini-2.5-flash", "fake-key", 3000);
    // Access private method via any cast for testing
    const endpoint = (handler as any).getApiEndpoint();
    expect(endpoint).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
  });

  test("should track tool call mappings", () => {
    const handler = new GeminiHandler(mockGeminiProvider, "gemini-2.5-flash", "fake-key", 3000);

    // Simulate converting an assistant message with tool_use
    const assistantMsg = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me read that file." },
        { type: "tool_use", id: "toolu_123", name: "Read", input: { file_path: "/test.txt" } }
      ]
    };

    // Call convertAssistantMessageParts (private method)
    const parts = (handler as any).convertAssistantMessageParts(assistantMsg);

    // Verify parts were created
    expect(parts.length).toBe(2);
    expect(parts[0].text).toBe("Let me read that file.");
    expect(parts[1].functionCall.name).toBe("Read");

    // Verify tool call was tracked in map
    const toolCallMap = (handler as any).toolCallMap;
    expect(toolCallMap.get("toolu_123")).toBe("Read");
  });
});

describe("OpenAIHandler", () => {
  test("should instantiate correctly", () => {
    const handler = new OpenAIHandler(mockOpenAIProvider, "gpt-4o", "fake-key", 3000);
    expect(handler).toBeDefined();
    expect(typeof handler.handle).toBe("function");
    expect(typeof handler.shutdown).toBe("function");
  });

  test("should have correct API endpoint", () => {
    const handler = new OpenAIHandler(mockOpenAIProvider, "gpt-4o", "fake-key", 3000);
    // Access private method via any cast for testing
    const endpoint = (handler as any).getApiEndpoint();
    expect(endpoint).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("should set correct context window for different models", () => {
    const gpt4o = new OpenAIHandler(mockOpenAIProvider, "gpt-4o", "fake-key", 3000);
    expect((gpt4o as any).contextWindow).toBe(128000);

    const gpt5 = new OpenAIHandler(mockOpenAIProvider, "gpt-5", "fake-key", 3000);
    expect((gpt5 as any).contextWindow).toBe(256000);

    const o1 = new OpenAIHandler(mockOpenAIProvider, "o1", "fake-key", 3000);
    expect((o1 as any).contextWindow).toBe(200000);

    const gpt35 = new OpenAIHandler(mockOpenAIProvider, "gpt-3.5-turbo", "fake-key", 3000);
    expect((gpt35 as any).contextWindow).toBe(16385);
  });

  test("should detect reasoning model support", () => {
    const gpt4o = new OpenAIHandler(mockOpenAIProvider, "gpt-4o", "fake-key", 3000);
    expect((gpt4o as any).supportsReasoning()).toBe(false);

    const o1 = new OpenAIHandler(mockOpenAIProvider, "o1", "fake-key", 3000);
    expect((o1 as any).supportsReasoning()).toBe(true);

    const o3 = new OpenAIHandler(mockOpenAIProvider, "o3-mini", "fake-key", 3000);
    expect((o3 as any).supportsReasoning()).toBe(true);
  });
});
