import { describe, expect, test } from "bun:test";
import { GrokAdapter } from "../src/adapters/grok-adapter";

/**
 * Unit tests for GrokAdapter XML translation
 *
 * Tests the core XML parsing functionality that translates
 * Grok's <xai:function_call> format to Claude Code tool_calls
 */

describe("GrokAdapter XML Parser", () => {
  test("should detect and parse simple xAI function call", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    const xmlText =
      '<xai:function_call name="Read"><xai:parameter name="file_path">/path/to/file</xai:parameter></xai:function_call>';

    const result = adapter.processTextContent(xmlText, xmlText);

    expect(result.wasTransformed).toBe(true);
    expect(result.extractedToolCalls).toHaveLength(1);
    expect(result.extractedToolCalls[0].name).toBe("Read");
    expect(result.extractedToolCalls[0].arguments.file_path).toBe("/path/to/file");
    expect(result.extractedToolCalls[0].id).toContain("grok_");
    expect(result.cleanedText).toBe(""); // XML should be removed
  });

  test("should handle multiple parameters", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    const xmlText = `<xai:function_call name="Bash">
      <xai:parameter name="command">npm install</xai:parameter>
      <xai:parameter name="timeout">30000</xai:parameter>
    </xai:function_call>`;

    const result = adapter.processTextContent(xmlText, xmlText);

    expect(result.extractedToolCalls).toHaveLength(1);
    expect(result.extractedToolCalls[0].name).toBe("Bash");
    expect(result.extractedToolCalls[0].arguments.command).toBe("npm install");
    expect(result.extractedToolCalls[0].arguments.timeout).toBe(30000); // Parsed as number
  });

  test("should handle text before and after XML", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    const xmlText =
      'Let me read that file. <xai:function_call name="Read"><xai:parameter name="file_path">/test.txt</xai:parameter></xai:function_call> Done!';

    const result = adapter.processTextContent(xmlText, xmlText);

    expect(result.wasTransformed).toBe(true);
    expect(result.extractedToolCalls).toHaveLength(1);
    expect(result.extractedToolCalls[0].name).toBe("Read");
    expect(result.cleanedText).toBe("Let me read that file.  Done!");
  });

  test("should handle multiple function calls", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    const xmlText =
      '<xai:function_call name="Read"><xai:parameter name="file_path">/a.txt</xai:parameter></xai:function_call><xai:function_call name="Read"><xai:parameter name="file_path">/b.txt</xai:parameter></xai:function_call>';

    const result = adapter.processTextContent(xmlText, xmlText);

    expect(result.extractedToolCalls).toHaveLength(2);
    expect(result.extractedToolCalls[0].name).toBe("Read");
    expect(result.extractedToolCalls[0].arguments.file_path).toBe("/a.txt");
    expect(result.extractedToolCalls[1].name).toBe("Read");
    expect(result.extractedToolCalls[1].arguments.file_path).toBe("/b.txt");
  });

  test("should handle partial XML (no complete tag)", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    // First chunk: partial opening
    const chunk1 = '<xai:function_call name="Read"><xai:par';
    const result1 = adapter.processTextContent(chunk1, chunk1);

    expect(result1.wasTransformed).toBe(false);
    expect(result1.extractedToolCalls).toHaveLength(0);
    expect(result1.cleanedText).toBe(""); // Buffered, not sent yet

    // Second chunk: complete the tag
    const chunk2 = 'ameter name="file_path">/test.txt</xai:parameter></xai:function_call>';
    const accumulated = chunk1 + chunk2;
    const result2 = adapter.processTextContent(chunk2, accumulated);

    expect(result2.wasTransformed).toBe(true);
    expect(result2.extractedToolCalls).toHaveLength(1);
    expect(result2.extractedToolCalls[0].name).toBe("Read");
  });

  test("should handle normal text without XML", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    const normalText = "This is just regular text without any XML.";
    const result = adapter.processTextContent(normalText, normalText);

    expect(result.wasTransformed).toBe(false);
    expect(result.extractedToolCalls).toHaveLength(0);
    expect(result.cleanedText).toBe(normalText);
  });

  test("should handle JSON parameter values", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    const xmlText =
      '<xai:function_call name="Edit"><xai:parameter name="options">{"replace_all":true}</xai:parameter></xai:function_call>';

    const result = adapter.processTextContent(xmlText, xmlText);

    expect(result.extractedToolCalls).toHaveLength(1);
    expect(result.extractedToolCalls[0].arguments.options).toEqual({ replace_all: true });
  });

  test("shouldHandle() returns true for Grok models", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    expect(adapter.shouldHandle("x-ai/grok-code-fast-1")).toBe(true);
    expect(adapter.shouldHandle("x-ai/grok-4")).toBe(true);
    expect(adapter.shouldHandle("grok-beta")).toBe(true);
    expect(adapter.shouldHandle("openai/gpt-4")).toBe(false);
    expect(adapter.shouldHandle("anthropic/claude-sonnet-4.5")).toBe(false);
  });

  test("getName() returns correct adapter name", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");
    expect(adapter.getName()).toBe("GrokAdapter");
  });

  test("reset() clears internal buffer", () => {
    const adapter = new GrokAdapter("x-ai/grok-code-fast-1");

    // Process partial XML
    adapter.processTextContent(
      '<xai:function_call name="Read">',
      '<xai:function_call name="Read">'
    );

    // Reset
    adapter.reset();

    // Process normal text - should work cleanly
    const result = adapter.processTextContent("Normal text", "Normal text");
    expect(result.cleanedText).toBe("Normal text");
  });
});

// Export for documentation
export const GROK_ADAPTER_DOCUMENTATION = {
  purpose: "Translate Grok's xAI XML format to Claude Code tool_calls",
  format:
    "<xai:function_call name='ToolName'><xai:parameter name='key'>value</xai:parameter></xai:function_call>",
  handles: ["x-ai/grok-code-fast-1", "x-ai/grok-4", "grok-*"],
  tested: "Unit tests validate XML parsing, multi-chunk handling, and edge cases",
  discovered: "2025-11-11",
  status: "IMPLEMENTED",
};
