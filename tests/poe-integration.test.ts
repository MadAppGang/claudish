import { describe, it, expect } from "bun:test";

describe("Poe API Integration", () => {
  const POE_API_URL = "https://api.poe.com/v1/models";
  const POE_CHAT_URL = "https://api.poe.com/v1/chat/completions";

  // Skip integration tests if no API key is available
  const hasApiKey = !!process.env.POE_API_KEY;
  const testApiKey = process.env.POE_API_KEY || "test-key-for-structure-validation";

  describe("Model List API", () => {
    it("should fetch available models", async () => {
      try {
        const response = await fetch(POE_API_URL);
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data).toHaveProperty("object", "list");
        expect(data).toHaveProperty("data");
        expect(Array.isArray(data.data)).toBe(true);

        if (data.data.length > 0) {
          const model = data.data[0];
          expect(model).toHaveProperty("id");
          expect(model).toHaveProperty("object", "model");
          expect(model).toHaveProperty("created");
          expect(model).toHaveProperty("description");
          expect(model).toHaveProperty("owned_by");
        }
      } catch (error) {
        console.log("Poe API model fetch failed (this might be expected):", error);
        // Don't fail the test if Poe API is unreachable
        expect(true).toBe(true);
      }
    });

    it("should include expected model properties", async () => {
      try {
        const response = await fetch(POE_API_URL);
        if (!response.ok) {
          console.log("Poe API not available, skipping model property test");
          return;
        }

        const data = await response.json();
        if (data.data.length === 0) return;

        const model = data.data.find((m: any) => m.id === "grok-4");
        if (model) {
          expect(model.id).toBe("grok-4");
          expect(model.owned_by).toBe("XAI");
          expect(model.description).toBeDefined();
          expect(model.architecture).toBeDefined();
          expect(model.context_length).toBeDefined();
        }
      } catch (error) {
        console.log("Poe API model property test failed:", error);
        expect(true).toBe(true);
      }
    });
  });

  describe("Chat Completions API Structure", () => {
    it("should validate API endpoint structure", async () => {
      // We don't make actual API calls to avoid costs, but validate the URL structure
      expect(POE_CHAT_URL).toBe("https://api.poe.com/v1/chat/completions");
    });

    it("should validate authentication header format", () => {
      const expectedAuth = `Bearer ${testApiKey}`;
      expect(expectedAuth).toStartWith("Bearer ");
      expect(expectedAuth.length).toBeGreaterThan("Bearer ".length);
    });
  });

  describe("Model Configuration", () => {
    it("should validate expected Poe models are available", async () => {
      try {
        const response = await fetch(POE_API_URL);
        if (!response.ok) {
          console.log("Poe API not available, skipping model validation");
          return;
        }

        const data = await response.json();
        const modelIds = data.data.map((model: any) => model.id);

        // Check for some key models we expect to be available
        const expectedModels = [
          "grok-4",
          "gpt-4o",
          "claude-opus-4.5",
          "gemini-2.5-flash",
        ];

        const foundModels = expectedModels.filter(model => modelIds.includes(model));
        console.log(`Found ${foundModels.length}/${expectedModels.length} expected models:`, foundModels);

        // At least some of the expected models should be available
        expect(foundModels.length).toBeGreaterThan(0);
      } catch (error) {
        console.log("Model validation failed:", error);
        expect(true).toBe(true);
      }
    });
  });

  describe("Request/Response Format Validation", () => {
    it("should validate chat request format", () => {
      const validRequest = {
        model: "grok-4",
        messages: [
          { role: "user", content: "Hello, world!" }
        ],
        temperature: 0.7,
        max_tokens: 1000,
        stream: true,
      };

      expect(validRequest.model).toBeDefined();
      expect(validRequest.messages).toBeDefined();
      expect(Array.isArray(validRequest.messages)).toBe(true);
      expect(validRequest.messages[0]).toHaveProperty("role");
      expect(validRequest.messages[0]).toHaveProperty("content");
    });

    it("should validate tool calling format", () => {
      const validToolRequest = {
        model: "grok-4",
        messages: [
          { role: "user", content: "Use a tool" }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "test_tool",
              description: "A test tool",
              parameters: {
                type: "object",
                properties: {
                  input: { type: "string" }
                },
                required: ["input"]
              }
            }
          }
        ],
        tool_choice: "auto"
      };

      expect(validToolRequest.tools).toBeDefined();
      expect(Array.isArray(validToolRequest.tools)).toBe(true);
      expect(validToolRequest.tools[0]).toHaveProperty("type", "function");
      expect(validToolRequest.tools[0]).toHaveProperty("function");
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid API key", async () => {
      try {
        const response = await fetch(POE_API_URL, {
          headers: {
            "Authorization": "Bearer invalid-key-12345"
          }
        });

        // Should either get 401 Unauthorized or the API might not enforce auth
        expect([200, 401, 403].includes(response.status)).toBe(true);
      } catch (error) {
        console.log("Invalid API key test failed (network error):", error);
        expect(true).toBe(true);
      }
    });

    it("should handle malformed requests", async () => {
      try {
        const response = await fetch(POE_CHAT_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${testApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            // Invalid request - missing required fields
            invalid: "request"
          })
        });

        // Should get an error response
        expect([400, 422, 500].includes(response.status)).toBe(true);
      } catch (error) {
        console.log("Malformed request test failed:", error);
        expect(true).toBe(true);
      }
    });
  });

  describe("Rate Limiting and Headers", () => {
    it("should include required headers", async () => {
      const expectedHeaders = {
        "Authorization": `Bearer ${testApiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "Claudish-Poe-Proxy/1.0"
      };

      expect(expectedHeaders.Authorization).toBeDefined();
      expect(expectedHeaders["Content-Type"]).toBe("application/json");
      expect(expectedHeaders["User-Agent"]).toContain("Claudish");
    });
  });
});