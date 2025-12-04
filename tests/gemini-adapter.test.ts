/**
 * Unit tests for GeminiAdapter
 *
 * Tests thought signature extraction from OpenRouter's reasoning_details format,
 * based on real API responses captured during manual testing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { GeminiAdapter } from "../src/adapters/gemini-adapter";

describe("GeminiAdapter", () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter("google/gemini-3-pro-preview");
  });

  describe("Model Detection", () => {
    it("should handle google/gemini-3-pro-preview model", () => {
      expect(adapter.shouldHandle("google/gemini-3-pro-preview")).toBe(true);
    });

    it("should handle google/gemini-2.5-flash model", () => {
      expect(adapter.shouldHandle("google/gemini-2.5-flash")).toBe(true);
    });

    it("should handle gemini models without google/ prefix", () => {
      expect(adapter.shouldHandle("gemini-3-pro")).toBe(true);
    });

    it("should NOT handle non-Gemini models", () => {
      expect(adapter.shouldHandle("x-ai/grok-code-fast-1")).toBe(false);
      expect(adapter.shouldHandle("openai/gpt-5")).toBe(false);
      expect(adapter.shouldHandle("claude-sonnet")).toBe(false);
    });

    it("should return correct adapter name", () => {
      expect(adapter.getName()).toBe("GeminiAdapter");
    });
  });

  describe("Thought Signature Extraction", () => {
    it("should extract signatures from reasoning_details with encrypted type", () => {
      // Real response data from OpenRouter test
      const reasoningDetails = [
        {
          id: "tool_Bash_ZOJxtsiJqi9njkBUmCeV",
          type: "reasoning.encrypted",
          data: "CiQB4/H/XsukhAagMavyI3vfZtzB0lQLRD5TIh1OQyfMar/wzqoKaQHj8f9e7azlSwPXjAxZ3Vy+SA3Lozr6JjvJah7yLoz34Z44orOB9T5IM3acsExG0w2M+LdYDxSm3WfUqbUJTvs4EmG098y5FWCKWhMG1aVaHNGuQ5uytp+21m8BOw0Qw+Q9mEqd7TYK7gpjAePx/16yxZM4eAE4YppB66hLqV6qjWd6vEJ9lGIMbmqi+t5t4Se/HkBPizrcgbdaOd3Fje5GXRfb1vqv+nhuxWwOx+hAFczJWwtd8d6H/YloE38JqTSNt98sb0odCShJcNnVCjgB4/H/XoJS5Xrj4j5jSsnUSG+rvZi6NKV+La8QIur8jKEeBF0DbTnO+ZNiYzz9GokbPHjkIRKePA==",
          format: "google-gemini-v1",
          index: 0,
        },
      ];

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      expect(extracted.size).toBe(1);
      expect(extracted.has("tool_Bash_ZOJxtsiJqi9njkBUmCeV")).toBe(true);
      expect(extracted.get("tool_Bash_ZOJxtsiJqi9njkBUmCeV")).toBe(reasoningDetails[0].data);
    });

    it("should extract from multiple reasoning_details", () => {
      const reasoningDetails = [
        {
          id: "tool_1",
          type: "reasoning.encrypted",
          data: "signature-data-1",
          format: "google-gemini-v1",
          index: 0,
        },
        {
          id: "tool_2",
          type: "reasoning.encrypted",
          data: "signature-data-2",
          format: "google-gemini-v1",
          index: 1,
        },
      ];

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      expect(extracted.size).toBe(2);
      expect(extracted.get("tool_1")).toBe("signature-data-1");
      expect(extracted.get("tool_2")).toBe("signature-data-2");
    });

    it("should skip reasoning_details without encrypted type", () => {
      const reasoningDetails = [
        {
          id: "tool_1",
          type: "reasoning.encrypted",
          data: "signature-data-1",
          format: "google-gemini-v1",
          index: 0,
        },
        {
          id: "tool_2",
          type: "reasoning.text", // Not encrypted, should skip
          text: "thinking process...",
          format: "google-gemini-v1",
          index: 1,
        },
      ];

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      expect(extracted.size).toBe(1);
      expect(extracted.has("tool_1")).toBe(true);
      expect(extracted.has("tool_2")).toBe(false);
    });

    it("should skip reasoning_details without id", () => {
      const reasoningDetails = [
        {
          type: "reasoning.encrypted",
          data: "signature-data-1",
          format: "google-gemini-v1",
          index: 0,
          // Missing id
        },
      ];

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      expect(extracted.size).toBe(0);
    });

    it("should skip reasoning_details without data", () => {
      const reasoningDetails = [
        {
          id: "tool_1",
          type: "reasoning.encrypted",
          format: "google-gemini-v1",
          index: 0,
          // Missing data
        },
      ];

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      expect(extracted.size).toBe(0);
    });

    it("should handle empty reasoning_details array", () => {
      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails([]);
      expect(extracted.size).toBe(0);
    });

    it("should handle undefined reasoning_details", () => {
      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(undefined as any);
      expect(extracted.size).toBe(0);
    });
  });

  describe("Signature Storage", () => {
    it("should store extracted signatures internally", () => {
      const reasoningDetails = [
        {
          id: "tool_123",
          type: "reasoning.encrypted",
          data: "encrypted-signature-data",
          format: "google-gemini-v1",
          index: 0,
        },
      ];

      adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      expect(adapter.hasThoughtSignature("tool_123")).toBe(true);
      expect(adapter.getThoughtSignature("tool_123")).toBe("encrypted-signature-data");
    });

    it("should retrieve stored signatures", () => {
      const reasoningDetails = [
        {
          id: "tool_abc",
          type: "reasoning.encrypted",
          data: "test-signature-xyz",
          format: "google-gemini-v1",
          index: 0,
        },
      ];

      adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      const signature = adapter.getThoughtSignature("tool_abc");
      expect(signature).toBe("test-signature-xyz");
    });

    it("should return undefined for unknown tool call IDs", () => {
      const signature = adapter.getThoughtSignature("non-existent-tool");
      expect(signature).toBeUndefined();
    });

    it("should return false for hasThoughtSignature on unknown IDs", () => {
      expect(adapter.hasThoughtSignature("unknown-tool")).toBe(false);
    });

    it("should store multiple signatures", () => {
      const reasoningDetails1 = [
        {
          id: "tool_1",
          type: "reasoning.encrypted",
          data: "sig-1",
          format: "google-gemini-v1",
          index: 0,
        },
      ];

      const reasoningDetails2 = [
        {
          id: "tool_2",
          type: "reasoning.encrypted",
          data: "sig-2",
          format: "google-gemini-v1",
          index: 0,
        },
      ];

      adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails1);
      adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails2);

      expect(adapter.hasThoughtSignature("tool_1")).toBe(true);
      expect(adapter.hasThoughtSignature("tool_2")).toBe(true);
      expect(adapter.getThoughtSignature("tool_1")).toBe("sig-1");
      expect(adapter.getThoughtSignature("tool_2")).toBe("sig-2");
    });

    it("should override existing signatures with same tool_call_id", () => {
      const reasoningDetails1 = [
        {
          id: "tool_1",
          type: "reasoning.encrypted",
          data: "original-signature",
          format: "google-gemini-v1",
          index: 0,
        },
      ];

      const reasoningDetails2 = [
        {
          id: "tool_1",
          type: "reasoning.encrypted",
          data: "updated-signature",
          format: "google-gemini-v1",
          index: 0,
        },
      ];

      adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails1);
      adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails2);

      expect(adapter.getThoughtSignature("tool_1")).toBe("updated-signature");
    });
  });

  describe("Reset Functionality", () => {
    it("should clear all stored signatures on reset", () => {
      const reasoningDetails = [
        {
          id: "tool_1",
          type: "reasoning.encrypted",
          data: "sig-1",
          format: "google-gemini-v1",
          index: 0,
        },
        {
          id: "tool_2",
          type: "reasoning.encrypted",
          data: "sig-2",
          format: "google-gemini-v1",
          index: 1,
        },
      ];

      adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);
      expect(adapter.getAllThoughtSignatures().size).toBe(2);

      adapter.reset();

      expect(adapter.getAllThoughtSignatures().size).toBe(0);
      expect(adapter.hasThoughtSignature("tool_1")).toBe(false);
      expect(adapter.hasThoughtSignature("tool_2")).toBe(false);
    });
  });

  describe("Get All Signatures", () => {
    it("should return copy of all signatures", () => {
      const reasoningDetails = [
        {
          id: "tool_1",
          type: "reasoning.encrypted",
          data: "sig-1",
          format: "google-gemini-v1",
          index: 0,
        },
        {
          id: "tool_2",
          type: "reasoning.encrypted",
          data: "sig-2",
          format: "google-gemini-v1",
          index: 1,
        },
      ];

      adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      const allSignatures = adapter.getAllThoughtSignatures();
      expect(allSignatures.size).toBe(2);
      expect(allSignatures.get("tool_1")).toBe("sig-1");
      expect(allSignatures.get("tool_2")).toBe("sig-2");

      // Should be a copy (modifying doesn't affect internal state)
      allSignatures.set("tool_3", "sig-3");
      expect(adapter.getAllThoughtSignatures().size).toBe(2);
    });

    it("should return empty Map when no signatures stored", () => {
      const allSignatures = adapter.getAllThoughtSignatures();
      expect(allSignatures.size).toBe(0);
    });
  });

  describe("OpenRouter Real Data Test", () => {
    it("should extract from real OpenRouter streaming response structure", () => {
      // This is actual data from OpenRouter test (test-gemini-thought-signature.ts)
      const reasoningDetails = [
        {
          id: "tool_Bash_ZOJxtsiJqi9njkBUmCeV",
          type: "reasoning.encrypted",
          data: "CiQB4/H/XsukhAagMavyI3vfZtzB0lQLRD5TIh1OQyfMar/wzqoKaQHj8f9e7azlSwPXjAxZ3Vy+SA3Lozr6JjvJah7yLoz34Z44orOB9T5IM3acsExG0w2M+LdYDxSm3WfUqbUJTvs4EmG098y5FWCKWhMG1aVaHNGuQ5uytp+21m8BOw0Qw+Q9mEqd7TYK7gpjAePx/16yxZM4eAE4YppB66hLqV6qjWd6vEJ9lGIMbmqi+t5t4Se/HkBPizrcgbdaOd3Fje5GXRfb1vqv+nhuxWwOx+hAFczJWwtd8d6H/YloE38JqTSNt98sb0odCShJcNnVCjgB4/H/XoJS5Xrj4j5jSsnUSG+rvZi6NKV+La8QIur8jKEeBF0DbTnO+ZNiYzz9GokbPHjkIRKePA==",
          format: "google-gemini-v1",
          index: 0,
        },
      ];

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      expect(extracted.size).toBe(1);
      expect(extracted.has("tool_Bash_ZOJxtsiJqi9njkBUmCeV")).toBe(true);

      // Verify the signature data matches exactly
      const signature = extracted.get("tool_Bash_ZOJxtsiJqi9njkBUmCeV");
      expect(signature).toBe(reasoningDetails[0].data);
      expect(signature).toContain("CiQB4/H/X"); // Should start with encrypted prefix
      expect(signature.length).toBeGreaterThan(100); // Should be long (encrypted)
    });

    it("should handle OpenRouter's non-streaming response format", () => {
      // From test-non-streaming.ts - shows full response structure
      const reasoningDetails = [
        {
          format: "google-gemini-v1",
          index: 0,
          type: "reasoning.text",
          text: "**Analyzing Command Execution**\n\nI've decided on the Bash tool...",
        },
        {
          id: "tool_Bash_xCnVDMy3yKKLMmubLViZ",
          format: "google-gemini-v1",
          index: 0,
          type: "reasoning.encrypted",
          data: "CiQB4/H/Xpq6W/zfkirEV83BJOnpNRAEsRj3j95YOEooIPrBh1cKZgHj8f9eJ8A0IFVGYoG0HDJXG0MuH41sRRpJkvtF2vmnl36y0KOrmiKGnoKerQlRKodqdQBh1N04iwI8+9ULLbnnk/4YSpAi2/uh2xqOHnt2jluPJbnpZOJ1Cd+zHf7/VZqj1WZbEgpaAePx/158Zpu4rKl4VbaLLmuJfwoLFE58SrhoOqhpu52Fsw3JeEl4ezcOlxYkA91fFNVDcVaE9J3sdfeUUsP7c6EPNwKX0Roj4xGAn6R4THYoZaLRdBoaTt7bClEB4/H/Xm1hmM8Qwyj4XqSLOH1e4lbgYwYYECa0060K6z8YTS+wKaKkAWrk7WpDDovNzrTihw1aMvBy5oY0kVjhvKe0s48QiStQx/KBrwU3xfY=",
        },
      ];

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(reasoningDetails);

      // Should only extract the encrypted one, not the text one
      expect(extracted.size).toBe(1);
      expect(extracted.has("tool_Bash_xCnVDMy3yKKLMmubLViZ")).toBe(true);
      expect(extracted.has(undefined as any)).toBe(false);
    });
  });

  describe("processTextContent", () => {
    it("should pass through text unchanged (Gemini doesn't use special text formats)", () => {
      const result = adapter.processTextContent("Hello world", "");

      expect(result.cleanedText).toBe("Hello world");
      expect(result.extractedToolCalls).toEqual([]);
      expect(result.wasTransformed).toBe(false);
    });

    it("should handle empty text", () => {
      const result = adapter.processTextContent("", "");

      expect(result.cleanedText).toBe("");
      expect(result.extractedToolCalls).toEqual([]);
      expect(result.wasTransformed).toBe(false);
    });
  });
});
