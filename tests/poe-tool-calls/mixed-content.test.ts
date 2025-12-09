import { describe, it, expect, beforeEach } from "bun:test";
import { PoeHandler, XMLToolCallParser } from "../../src/handlers/poe-handler";

describe("Poe Handler Tool Call Processing", () => {
  let handler: PoeHandler;

  beforeEach(() => {
    handler = new PoeHandler("test-api-key");
  });

  describe("transformChunk", () => {
    it("should handle content with XML tool calls", () => {
      const contentWithToolCall = `Let me help you with that.

<function_calls>
<invoke name="calculator">
<parameter name="expression">2 + 2</parameter>
</invoke>
</function_calls>

The result is 4.`;

      const chunk = {
        choices: [{
          delta: {
            content: contentWithToolCall
          }
        }]
      };

      const result = (handler as any).transformChunk(chunk);

      expect(result).toBeDefined();
      expect(result.type).toBe("tool_calls");
      expect(result.tool_calls).toBeDefined();
      expect(result.tool_calls.length).toBe(1);
      expect(result.tool_calls[0].function.name).toBe("calculator");
      expect(result.tool_calls[0].function.arguments).toContain("2 + 2");

      // Check that clean text is cached
      expect(chunk.choices[0].delta._cachedCleanText).toBeDefined();
      expect(chunk.choices[0].delta._cachedCleanText).toContain("Let me help you with that.");
      expect(chunk.choices[0].delta._cachedCleanText).toContain("The result is 4.");
      expect(chunk.choices[0].delta._cachedCleanText).not.toContain("<function_calls>");
    });

    it("should handle content without tool calls normally", () => {
      const regularContent = "This is just regular text content.";

      const chunk = {
        choices: [{
          delta: {
            content: regularContent
          }
        }]
      };

      const result = (handler as any).transformChunk(chunk);

      expect(result).toBeDefined();
      expect(result.type).toBe("content_block_delta");
      expect(result.delta.text).toBe(regularContent);
      expect(chunk.choices[0].delta._cachedCleanText).toBeUndefined();
    });

    it("should handle empty tool calls gracefully", () => {
      const contentWithEmptyToolCall = `Some text
<function_calls>
</function_calls>
More text`;

      const chunk = {
        choices: [{
          delta: {
            content: contentWithEmptyToolCall
          }
        }]
      };

      const result = (handler as any).transformChunk(chunk);

      expect(result).toBeDefined();
      expect(result.type).toBe("content_block_delta");
      expect(result.delta.text).toBe("Some text\nMore text");
    });

    it("should handle multiple tool calls", () => {
      const contentWithMultipleTools = `Let me use multiple tools:

<function_calls>
<invoke name="calculator">
<parameter name="expression">2 + 2</parameter>
</invoke>
<invoke name="search">
<parameter name="query">test query</parameter>
</invoke>
</function_calls>

Done!`;

      const chunk = {
        choices: [{
          delta: {
            content: contentWithMultipleTools
          }
        }]
      };

      const result = (handler as any).transformChunk(chunk);

      expect(result).toBeDefined();
      expect(result.type).toBe("tool_calls");
      expect(result.tool_calls.length).toBe(2);
      expect(result.tool_calls[0].function.name).toBe("calculator");
      expect(result.tool_calls[1].function.name).toBe("search");

      // Check that clean text is cached
      expect(chunk.choices[0].delta._cachedCleanText).toBeDefined();
      expect(chunk.choices[0].delta._cachedCleanText).toContain("Let me use multiple tools:");
      expect(chunk.choices[0].delta._cachedCleanText).toContain("Done!");
    });
  });

  describe("XMLToolCallParser", () => {

    it("should detect tool calls in text", () => {
      const text = "Some text <function_calls><invoke name=\"test\"></invoke></function_calls> more text";
      expect(XMLToolCallParser.containsToolCalls(text)).toBe(true);
    });

    it("should not detect tool calls in regular text", () => {
      const text = "This is just regular text without any function calls";
      expect(XMLToolCallParser.containsToolCalls(text)).toBe(false);
    });

    it("should parse tool calls correctly", () => {
      const text = `<function_calls>
<invoke name="calculator">
<parameter name="expression">2 + 2</parameter>
</invoke>
</function_calls>`;

      const toolCalls = XMLToolCallParser.parseToolCalls(text);
      expect(toolCalls).toBeDefined();
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].function.name).toBe("calculator");
      expect(toolCalls[0].function.arguments).toContain("2 + 2");
    });

    it("should remove tool calls from text", () => {
      const text = "Before <function_calls><invoke name=\"test\"></invoke></function_calls> after";
      const cleanText = XMLToolCallParser.removeToolCalls(text);
      expect(cleanText).toBe("Before  after");
    });

    it("should handle malformed XML gracefully", () => {
      const malformedText = "Some text <function_calls><invoke name=\"test\"> more text";
      const toolCalls = XMLToolCallParser.parseToolCalls(malformedText);
      expect(toolCalls).toBeNull();
    });
  });
});