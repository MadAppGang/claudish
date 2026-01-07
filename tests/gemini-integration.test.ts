/**
 * Integration tests for Gemini thought signature workflow
 *
 * Tests the complete flow: extraction from OpenRouter responses → storage → retrieval → inclusion in tool results
 * Uses real data captured from OpenRouter API interactions
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { GeminiAdapter } from "../src/adapters/gemini-adapter";

describe("Gemini Integration Workflow", () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter("google/gemini-3-pro-preview");
  });

  describe("Complete Workflow", () => {
    it("should handle complete workflow from extraction to retrieval", () => {
      // Step 1: Simulate receiving streaming chunk with reasoning_details
      const streamingChunk = {
        id: "gen-1763985429-MxzWCknTGYuK9AfiX4QQ",
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_Bash_ZOJxtsiJqi9njkBUmCeV",
                  type: "reasoning.encrypted",
                  data: "CiQB4/H/XsukhAagMavyI3vfZtzB0lQLRD5TIh1OQyfMar/wzqoKaQHj8f9e7azlSwPXjAxZ3Vy+SA3Lozr6JjvJah7yLoz34Z44orOB9T5IM3acsExG0w2M+LdYDxSm3WfUqbUJTvs4EmG098y5FWCKWhMG1aVaHNGuQ5uytp+21m8BOw0Qw+Q9mEqd7TYK7gpjAePx/16yxZM4eAE4YppB66hLqV6qjWd6vEJ9lGIMbmqi+t5t4Se/HkBPizrcgbdaOd3Fje5GXRfb1vqv+nhuxWwOx+hAFczJWwtd8d6H/YloE38JqTSNt98sb0odCShJcNnVCjgB4/H/XoJS5Xrj4j5jSsnUSG+rvZi6NKV+La8QIur8jKEeBF0DbTnO+ZNiYzz9GokbPHjkIRKePA==",
                  format: "google-gemini-v1",
                  index: 0,
                },
              ],
            },
          },
        ],
      };

      // Step 2: Extract signatures (this is what proxy-server does)
      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(
        streamingChunk.choices[0].delta.reasoning_details
      );

      expect(extracted.size).toBe(1);
      expect(adapter.hasThoughtSignature("tool_Bash_ZOJxtsiJqi9njkBUmCeV")).toBe(true);

      // Step 3: Simulate tool result building (what proxy-server does later)
      // This is simulating the code at line ~388 in proxy-server.ts
      const toolResultMsg: any = {
        role: "tool",
        content: "command output here",
        tool_call_id: "tool_Bash_ZOJxtsiJqi9njkBUmCeV",
      };

      const signature = adapter.getThoughtSignature("tool_Bash_ZOJxtsiJqi9njkBUmCeV");
      if (signature) {
        toolResultMsg.extra_content = {
          google: {
            thought_signature: signature,
          },
        };
      }

      // Step 4: Verify the signature was included correctly
      expect(toolResultMsg.extra_content).toBeDefined();
      expect(toolResultMsg.extra_content.google).toBeDefined();
      expect(toolResultMsg.extra_content.google.thought_signature).toBe(
        "CiQB4/H/XsukhAagMavyI3vfZtzB0lQLRD5TIh1OQyfMar/wzqoKaQHj8f9e7azlSwPXjAxZ3Vy+SA3Lozr6JjvJah7yLoz34Z44orOB9T5IM3acsExG0w2M+LdYDxSm3WfUqbUJTvs4EmG098y5FWCKWhMG1aVaHNGuQ5uytp+21m8BOw0Qw+Q9mEqd7TYK7gpjAePx/16yxZM4eAE4YppB66hLqV6qjWd6vEJ9lGIMbmqi+t5t4Se/HkBPizrcgbdaOd3Fje5GXRfb1vqv+nhuxWwOx+hAFczJWwtd8d6H/YloE38JqTSNt98sb0odCShJcNnVCjgB4/H/XoJS5Xrj4j5jSsnUSG+rvZi6NKV+La8QIur8jKEeBF0DbTnO+ZNiYzz9GokbPHjkIRKePA=="
      );
    });

    it("should handle multiple tool calls in sequence", () => {
      // First tool call
      const firstChunk = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_Bash_first",
                  type: "reasoning.encrypted",
                  data: "signature-1",
                  format: "google-gemini-v1",
                  index: 0,
                },
              ],
            },
          },
        ],
      };

      adapter.extractThoughtSignaturesFromReasoningDetails(
        firstChunk.choices[0].delta.reasoning_details
      );

      // Second tool call (simulating a multi-turn conversation)
      const secondChunk = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_Bash_second",
                  type: "reasoning.encrypted",
                  data: "signature-2",
                  format: "google-gemini-v1",
                  index: 0,
                },
              ],
            },
          },
        ],
      };

      adapter.extractThoughtSignaturesFromReasoningDetails(
        secondChunk.choices[0].delta.reasoning_details
      );

      // Verify both signatures are stored
      expect(adapter.hasThoughtSignature("tool_Bash_first")).toBe(true);
      expect(adapter.hasThoughtSignature("tool_Bash_second")).toBe(true);

      // Verify we can retrieve both
      const sig1 = adapter.getThoughtSignature("tool_Bash_first");
      const sig2 = adapter.getThoughtSignature("tool_Bash_second");

      expect(sig1).toBe("signature-1");
      expect(sig2).toBe("signature-2");
    });

    it("should persist signatures across multiple extraction calls", () => {
      // Simulate progressive streaming with multiple chunks
      const chunk1 = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_1",
                  type: "reasoning.encrypted",
                  data: "sig-part-1",
                  format: "google-gemini-v1",
                  index: 0,
                },
              ],
            },
          },
        ],
      };

      adapter.extractThoughtSignaturesFromReasoningDetails(
        chunk1.choices[0].delta.reasoning_details
      );

      expect(adapter.getAllThoughtSignatures().size).toBe(1);

      // Simulate another chunk with same tool (should override)
      const chunk2 = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_1",
                  type: "reasoning.encrypted",
                  data: "sig-part-2",
                  format: "google-gemini-v1",
                  index: 0,
                },
              ],
            },
          },
        ],
      };

      adapter.extractThoughtSignaturesFromReasoningDetails(
        chunk2.choices[0].delta.reasoning_details
      );

      // Should still have 1 signature (overwritten)
      expect(adapter.getAllThoughtSignatures().size).toBe(1);
      expect(adapter.getThoughtSignature("tool_1")).toBe("sig-part-2");
    });
  });

  describe("OpenRouter Response Patterns", () => {
    it("should handle OpenRouter streaming response with mixed content types", () => {
      // OpenRouter sends both reasoning.text and reasoning.encrypted in same response
      const mixedChunk = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  format: "google-gemini-v1",
                  index: 0,
                  type: "reasoning.text",
                  text: "**Analyzing Command**\n\nDecided to use Bash tool...",
                },
                {
                  id: "tool_Bash_real",
                  format: "google-gemini-v1",
                  index: 0,
                  type: "reasoning.encrypted",
                  data: "CiQB4/H/XsukhAagMavyI3vfZtzB0lQLRD5TIh1OQyfMar/wzqoKaQHj8f9e7azlSwPXjAxZ3Vy+SA3Lozr6JjvJah7yLoz34Z44orOB9T5IM3acsExG0w2M+LdYDxSm3WfUqbUJTvs4EmG098y5FWCKWhMG1aVaHNGuQ5uytp+21m8BOw0Qw+Q9mEqd7TYK7gpjAePx/16yxZM4eAE4YppB66hLqV6qjWd6vEJ9lGIMbmqi+t5t4Se/HkBPizrcgbdaOd3Fje5GXRfb1vqv+nhuxWwOx+hAFczJWwtd8d6H/YloE38JqTSNt98sb0odCShJcNnVCjgB4/H/XoJS5Xrj4j5jSsnUSG+rvZi6NKV+La8QIur8jKEeBF0DbTnO+ZNiYzz9GokbPHjkIRKePA==",
                },
              ],
            },
          },
        ],
      };

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(
        mixedChunk.choices[0].delta.reasoning_details
      );

      // Should only extract encrypted type, not text type
      expect(extracted.size).toBe(1);
      expect(extracted.has("tool_Bash_real")).toBe(true);
      expect(extracted.has(undefined as any)).toBe(false);

      const signature = adapter.getThoughtSignature("tool_Bash_real");
      expect(signature).toBeTruthy();
      expect(signature).toContain("CiQB4/H/X");
    });

    it("should handle non-streaming response format", () => {
      // Non-streaming responses have same structure but in message.reasoning_details
      const nonStreamingResponse = {
        choices: [
          {
            message: {
              reasoning_details: [
                {
                  id: "tool_Bash_non_stream",
                  format: "google-gemini-v1",
                  index: 0,
                  type: "reasoning.encrypted",
                  data: "encrypted-signature-data-here",
                },
              ],
            },
          },
        ],
      };

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(
        nonStreamingResponse.choices[0].message.reasoning_details
      );

      expect(extracted.size).toBe(1);
      expect(adapter.getThoughtSignature("tool_Bash_non_stream")).toBe(
        "encrypted-signature-data-here"
      );
    });

    it("should handle parallel function calls", () => {
      // Gemini can make multiple tool calls in parallel
      const parallelChunk = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_Bash_parallel_1",
                  type: "reasoning.encrypted",
                  data: "sig-parallel-1",
                  format: "google-gemini-v1",
                  index: 0,
                },
                {
                  id: "tool_Bash_parallel_2",
                  type: "reasoning.encrypted",
                  data: "sig-parallel-2",
                  format: "google-gemini-v1",
                  index: 1,
                },
                {
                  id: "tool_Bash_parallel_3",
                  type: "reasoning.encrypted",
                  data: "sig-parallel-3",
                  format: "google-gemini-v1",
                  index: 2,
                },
              ],
            },
          },
        ],
      };

      const extracted = adapter.extractThoughtSignaturesFromReasoningDetails(
        parallelChunk.choices[0].delta.reasoning_details
      );

      expect(extracted.size).toBe(3);
      expect(adapter.hasThoughtSignature("tool_Bash_parallel_1")).toBe(true);
      expect(adapter.hasThoughtSignature("tool_Bash_parallel_2")).toBe(true);
      expect(adapter.hasThoughtSignature("tool_Bash_parallel_3")).toBe(true);

      // Verify all signatures are distinct
      const sigs = adapter.getAllThoughtSignatures();
      expect(sigs.get("tool_Bash_parallel_1")).toBe("sig-parallel-1");
      expect(sigs.get("tool_Bash_parallel_2")).toBe("sig-parallel-2");
      expect(sigs.get("tool_Bash_parallel_3")).toBe("sig-parallel-3");
    });
  });

  describe("Edge Cases", () => {
    it("should handle tool call with same ID as previous (override)", () => {
      const first = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_same_id",
                  type: "reasoning.encrypted",
                  data: "first-signature",
                  format: "google-gemini-v1",
                  index: 0,
                },
              ],
            },
          },
        ],
      };

      adapter.extractThoughtSignaturesFromReasoningDetails(
        first.choices[0].delta.reasoning_details
      );

      expect(adapter.getThoughtSignature("tool_same_id")).toBe("first-signature");

      // Second call with same ID
      const second = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_same_id",
                  type: "reasoning.encrypted",
                  data: "second-signature",
                  format: "google-gemini-v1",
                  index: 0,
                },
              ],
            },
          },
        ],
      };

      adapter.extractThoughtSignaturesFromReasoningDetails(
        second.choices[0].delta.reasoning_details
      );

      expect(adapter.getThoughtSignature("tool_same_id")).toBe("second-signature");
    });

    it("should handle reset between requests", () => {
      const firstRequest = {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  id: "tool_request_1",
                  type: "reasoning.encrypted",
                  data: "sig-request-1",
                  format: "google-gemini-v1",
                  index: 0,
                },
              ],
            },
          },
        ],
      };

      adapter.extractThoughtSignaturesFromReasoningDetails(
        firstRequest.choices[0].delta.reasoning_details
      );

      expect(adapter.hasThoughtSignature("tool_request_1")).toBe(true);

      // Reset (simulates new request)
      adapter.reset();

      expect(adapter.hasThoughtSignature("tool_request_1")).toBe(false);
      expect(adapter.getAllThoughtSignatures().size).toBe(0);
    });
  });
});
