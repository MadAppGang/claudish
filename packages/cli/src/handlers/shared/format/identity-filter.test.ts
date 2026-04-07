import { describe, it, expect } from "bun:test";
import { filterIdentity } from "./identity-filter.js";

describe("filterIdentity", () => {
  describe("x-anthropic-billing-header stripping", () => {
    it("strips billing header with cch hash", () => {
      const input = "Some system prompt\nx-anthropic-billing-header: cc_version=2.1.92.a35; cc_entrypoint=cli; cch=8ae40;\nMore content";
      const result = filterIdentity(input);
      expect(result).not.toContain("x-anthropic-billing-header");
      expect(result).toContain("More content");
    });

    it("strips billing header with different cch values", () => {
      const result1 = filterIdentity("prefix\nx-anthropic-billing-header: cc_version=2.1.92; cch=8ae40;\nsuffix");
      const result2 = filterIdentity("prefix\nx-anthropic-billing-header: cc_version=2.1.92; cch=4e20a;\nsuffix");
      // After stripping, both should produce identical output
      expect(result1).toBe(result2);
    });

    it("handles header at start of content", () => {
      const input = "x-anthropic-billing-header: cc_version=2.1.92; cch=abc;\nRest of prompt";
      const result = filterIdentity(input);
      expect(result).not.toContain("x-anthropic-billing-header");
      expect(result).toContain("Rest of prompt");
    });

    it("handles header at end of content without trailing newline", () => {
      const input = "Some prompt\nx-anthropic-billing-header: cc_version=2.1.92; cch=abc;";
      const result = filterIdentity(input);
      expect(result).not.toContain("x-anthropic-billing-header");
    });

    it("preserves surrounding content intact", () => {
      const input = "Line 1\nx-anthropic-billing-header: cc_version=2.1.92; cch=abc;\nLine 3";
      const result = filterIdentity(input);
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 3");
    });
  });

  describe("Claude identity replacement", () => {
    it("replaces Claude Code identity", () => {
      const result = filterIdentity("You are Claude Code, Anthropic's official CLI tool.");
      expect(result).toContain("This is Claude Code, an AI-powered CLI tool");
      expect(result).not.toContain("Anthropic's official CLI");
    });

    it("replaces model name reference", () => {
      const result = filterIdentity("You are powered by the model named Claude 3.5 Sonnet.");
      expect(result).toContain("You are powered by an AI model.");
    });

    it("strips claude_background_info blocks", () => {
      const result = filterIdentity("Before\n<claude_background_info>secret</claude_background_info>\nAfter");
      expect(result).not.toContain("claude_background_info");
      expect(result).not.toContain("secret");
    });

    it("prepends non-Claude identity instruction", () => {
      const result = filterIdentity("Hello");
      expect(result).toMatch(/^IMPORTANT: You are NOT Claude/);
    });
  });
});
