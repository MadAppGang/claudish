import { describe, it, expect } from "bun:test";
import { XMLToolCallParser } from "../../src/handlers/poe-handler";

describe("Poe XML Tool Call Parser", () => {
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
    expect(toolCalls!.length).toBe(1);
    expect(toolCalls![0].function.name).toBe("calculator");
    expect(toolCalls![0].function.arguments).toContain("2 + 2");
  });

  it("should handle complex tool call parameters", () => {
    const text = `<function_calls>
<invoke name="search_web">
<parameter name="query">what is the weather today</parameter>
<parameter name="location">New York</parameter>
</invoke>
</function_calls>`;

    const toolCalls = XMLToolCallParser.parseToolCalls(text);
    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBe(1);
    expect(toolCalls![0].function.name).toBe("search_web");

    const args = JSON.parse(toolCalls![0].function.arguments);
    expect(args.query).toBe("what is the weather today");
    expect(args.location).toBe("New York");
  });

  it("should remove tool calls from text", () => {
    const text = "Before <function_calls><invoke name=\"test\"></invoke></function_calls> after";
    const cleanText = XMLToolCallParser.removeToolCalls(text);
    expect(cleanText).toBe("Before  after");
  });

  it("should preserve text around tool calls", () => {
    const text = `Let me help you calculate:

<function_calls>
<invoke name="calculator">
<parameter name="expression">2 + 2</parameter>
</invoke>
</function_calls>

The result should be 4.`;

    const cleanText = XMLToolCallParser.removeToolCalls(text);
    expect(cleanText).toContain("Let me help you calculate:");
    expect(cleanText).toContain("The result should be 4.");
    expect(cleanText).not.toContain("<function_calls>");
    expect(cleanText).not.toContain("2 + 2");
  });

  it("should handle multiple tool calls", () => {
    const text = `<function_calls>
<invoke name="calculator">
<parameter name="expression">2 + 2</parameter>
</invoke>
<invoke name="search">
<parameter name="query">test query</parameter>
</invoke>
</function_calls>`;

    const toolCalls = XMLToolCallParser.parseToolCalls(text);
    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBe(2);
    expect(toolCalls![0].function.name).toBe("calculator");
    expect(toolCalls![1].function.name).toBe("search");
  });

  it("should handle malformed XML gracefully", () => {
    const malformedText = "Some text <function_calls><invoke name=\"test\"> more text";
    const toolCalls = XMLToolCallParser.parseToolCalls(malformedText);
    expect(toolCalls).toBeNull();
  });

  it("should handle incomplete XML gracefully", () => {
    const incompleteText = "Some text <function_calls><invoke name=\"test\"></invoke> more text";
    const toolCalls = XMLToolCallParser.parseToolCalls(incompleteText);
    expect(toolCalls).toBeNull();
  });

  it("should generate unique IDs for tool calls", () => {
    const text = `<function_calls>
<invoke name="calculator">
<parameter name="expression">2 + 2</parameter>
</invoke>
</function_calls>`;

    const toolCalls1 = XMLToolCallParser.parseToolCalls(text);
    const toolCalls2 = XMLToolCallParser.parseToolCalls(text);

    expect(toolCalls1![0].id).toBeDefined();
    expect(toolCalls2![0].id).toBeDefined();
    expect(toolCalls1![0].id).not.toBe(toolCalls2![0].id); // Should be different due to timestamp
  });

  it("should handle JSON-like parameter values", () => {
    const text = `<function_calls>
<invoke name="process_data">
<parameter name="data">{\"key\": \"value\", \"number\": 123}</parameter>
</invoke>
</function_calls>`;

    const toolCalls = XMLToolCallParser.parseToolCalls(text);
    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBe(1);

    const args = JSON.parse(toolCalls![0].function.arguments);
    expect(args.data).toBe('{"key": "value", "number": 123}');
  });
});