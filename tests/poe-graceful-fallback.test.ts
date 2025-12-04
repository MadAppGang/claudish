import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getAllModelsForSearch } from "../src/model-selector.js";

// Mock the POE_MODEL_INFO
const mockPoeModelInfo = {
  "poe/grok-code-fast-1": {
    name: "Grok Code Fast 1",
    description: "Fast Grok model specialized for coding tasks via Poe",
    priority: 14,
    provider: "Poe",
  },
  "poe/gpt-4o": {
    name: "GPT-4O via Poe",
    description: "GPT-4O model available through Poe",
    priority: 10,
    provider: "Poe",
  },
};

// Mock the config module
mock.module("../src/config.js", () => ({
  POE_MODEL_INFO: mockPoeModelInfo,
}));

describe("Poe API Graceful Fallback Integration", () => {
  beforeEach(() => {
    // Reset any global state before each test
  });

  afterEach(() => {
    // Clean up after each test
    if (global.fetch.mockRestore) {
      global.fetch.mockRestore();
    }
  });

  describe("Graceful Fallback Behavior", () => {
    it("should include static Poe models even when API fails", async () => {
      // Mock fetch to simulate API failure
      global.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
        })
      );

      const models = await getAllModelsForSearch();
      const poeModels = models.filter((m) => m.id.startsWith("poe/"));

      // Should include our static models even when API fails
      expect(poeModels.length).toBeGreaterThan(0);
      expect(poeModels.some((m) => m.id === "poe/grok-code-fast-1")).toBe(true);
      expect(poeModels.some((m) => m.id === "poe/gpt-4o")).toBe(true);
    });

    it("should handle network errors gracefully", async () => {
      // Mock fetch to simulate network error
      global.fetch = mock(() => {
        throw new Error("Network unreachable");
      });

      const models = await getAllModelsForSearch();
      const poeModels = models.filter((m) => m.id.startsWith("poe/"));

      // Should still include static models despite network error
      expect(poeModels.length).toBeGreaterThan(0);
      expect(poeModels.some((m) => m.id === "poe/grok-code-fast-1")).toBe(true);
    });

    it("should include all required model properties in fallback models", async () => {
      global.fetch = mock(() => {
        throw new Error("API failure");
      });

      const models = await getAllModelsForSearch();
      const grokModel = models.find((m) => m.id === "poe/grok-code-fast-1");

      expect(grokModel).toBeDefined();
      expect(grokModel?.name).toBe("Grok Code Fast 1");
      expect(grokModel?.description).toBe("Fast Grok model specialized for coding tasks via Poe");
      expect(grokModel?.provider).toBe("Poe");
      expect(grokModel?.contextLength).toBe(128000);
      expect(grokModel?.supportsTools).toBe(true);
      expect(grokModel?.supportsReasoning).toBe(true);
      expect(grokModel?.pricing?.input).toBe("N/A");
      expect(grokModel?.pricing?.output).toBe("N/A");
    });
  });

  describe("Static Model Configuration", () => {
    it("should correctly identify reasoning-capable models", async () => {
      global.fetch = mock(() => {
        throw new Error("API failure");
      });

      const models = await getAllModelsForSearch();
      const grokModel = models.find((m) => m.id === "poe/grok-code-fast-1");
      const gptModel = models.find((m) => m.id === "poe/gpt-4o");

      // Grok models should support reasoning
      expect(grokModel?.supportsReasoning).toBe(true);

      // GPT models typically don't support reasoning unless specified
      expect(gptModel?.supportsReasoning).toBe(false);
    });
  });

  describe("API Integration Scenarios", () => {
    it("should use API data when available", async () => {
      // Mock successful API response
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            data: [
              {
                id: "api-test-model",
                name: "API Test Model",
                description: "Model from API",
                context_length: 200000,
                pricing: { prompt: 0.001, completion: 0.002 },
              },
            ],
          }),
        })
      );

      const models = await getAllModelsForSearch();
      const apiModel = models.find((m) => m.id === "poe/api-test-model");

      expect(apiModel).toBeDefined();
      expect(apiModel?.name).toBe("API Test Model");
      expect(apiModel?.contextLength).toBe(200000);
    });

    it("should handle malformed API responses gracefully", async () => {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => {
            throw new Error("Invalid JSON");
          },
        })
      );

      const models = await getAllModelsForSearch();
      const poeModels = models.filter((m) => m.id.startsWith("poe/"));

      // Should fall back to static models
      expect(poeModels.length).toBeGreaterThan(0);
      expect(poeModels.some((m) => m.id === "poe/grok-code-fast-1")).toBe(true);
    });
  });
});
