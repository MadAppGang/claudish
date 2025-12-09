import { describe, it, expect } from "bun:test";
import { XMLToolCallParser } from "../../src/handlers/poe-handler";

describe("Poe Tool Call Streaming Simulation", () => {
  it("should simulate mixed content processing flow", () => {
    // Simulate what happens in a real streaming response

    // First chunk with text and tool calls mixed together
    const mixedContent1 = `I'll help you calculate that.

<function_calls>
<invoke name="calculator">
<parameter name="expression">2 + 2</parameter>
</invoke>
</function_calls>

Let me use the calculator first.`;

    // Check that it contains tool calls
    expect(XMLToolCallParser.containsToolCalls(mixedContent1)).toBe(true);

    // Parse tool calls
    const toolCalls1 = XMLToolCallParser.parseToolCalls(mixedContent1);
    expect(toolCalls1).toBeDefined();
    expect(toolCalls1!.length).toBe(1);
    expect(toolCalls1![0].function.name).toBe("calculator");

    // Get clean text (what would be cached and sent separately)
    const cleanText1 = XMLToolCallParser.removeToolCalls(mixedContent1);
    expect(cleanText1).toContain("I'll help you calculate that.");
    expect(cleanText1).toContain("Let me use the calculator first.");
    expect(cleanText1).not.toContain("<function_calls>");

    // Second chunk with more text
    const regularText = "The calculation is complete.";

    // This would be processed as regular text content
    expect(XMLToolCallParser.containsToolCalls(regularText)).toBe(false);

    // Third chunk with another tool call
    const mixedContent2 = `Now let me search for information:

<function_calls>
<invoke name="search_web">
<parameter name="query">mathematical operations</parameter>
</invoke>
</function_calls>

Here's what I found.`;

    const toolCalls2 = XMLToolCallParser.parseToolCalls(mixedContent2);
    expect(toolCalls2).toBeDefined();
    expect(toolCalls2!.length).toBe(1);
    expect(toolCalls2![0].function.name).toBe("search_web");

    const cleanText2 = XMLToolCallParser.removeToolCalls(mixedContent2);
    expect(cleanText2).toContain("Now let me search for information:");
    expect(cleanText2).toContain("Here's what I found.");
    expect(cleanText2).not.toContain("<function_calls>");
  });

  it("should handle edge case with only tool calls", () => {
    const onlyToolCalls = `<function_calls>
<invoke name="get_weather">
<parameter name="city">London</parameter>
</invoke>
</function_calls>`;

    expect(XMLToolCallParser.containsToolCalls(onlyToolCalls)).toBe(true);

    const toolCalls = XMLToolCallParser.parseToolCalls(onlyToolCalls);
    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBe(1);
    expect(toolCalls![0].function.name).toBe("get_weather");

    const cleanText = XMLToolCallParser.removeToolCalls(onlyToolCalls);
    expect(cleanText.trim()).toBe(""); // Should be empty when only tool calls
  });

  it("should handle edge case with text before and after multiple tool calls", () => {
    const complexContent = `Starting the process...

<function_calls>
<invoke name="validate">
<parameter name="input">user_data</parameter>
</invoke>
<invoke name="transform">
<parameter name="operation">normalize</parameter>
</invoke>
<invoke name="save">
<parameter name="destination">database</parameter>
</invoke>
</function_calls>

All done!`;

    expect(XMLToolCallParser.containsToolCalls(complexContent)).toBe(true);

    // Should detect all tool calls in single function_calls block
    const toolCalls = XMLToolCallParser.parseToolCalls(complexContent);
    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBe(3);
    expect(toolCalls![0].function.name).toBe("validate");
    expect(toolCalls![1].function.name).toBe("transform");
    expect(toolCalls![2].function.name).toBe("save");

    // Clean text should preserve all non-tool-call content
    const cleanText = XMLToolCallParser.removeToolCalls(complexContent);
    expect(cleanText).toContain("Starting the process...");
    expect(cleanText).toContain("All done!");
    expect(cleanText).not.toContain("<function_calls>");
  });

  it("should handle malformed XML without crashing", () => {
    const malformedContent = `Here's some content:

<function_calls>
<invoke name="broken_tool">
<parameter name="param1">value1
<parameter name="param2">value2</parameter>
</invoke>

Missing closing tags intentionally`;

    // Should detect that it contains (attempted) tool calls
    expect(XMLToolCallParser.containsToolCalls(malformedContent)).toBe(true);

    // But should fail to parse due to malformed XML
    const toolCalls = XMLToolCallParser.parseToolCalls(malformedContent);
    expect(toolCalls).toBeNull();

    // Clean text should still work
    const cleanText = XMLToolCallParser.removeToolCalls(malformedContent);
    expect(cleanText).toContain("Here's some content:");
    expect(cleanText).toContain("Missing closing tags intentionally");
  });

  it("should handle special characters in parameters", () => {
    const specialCharsContent = `<function_calls>
<invoke name="process_text">
<parameter name="input">Hello & goodbye! "Quotes" and 'apostrophes'</parameter>
<parameter name="options">{"special": true, "chars": "&<>'"}</parameter>
</invoke>
</function_calls>`;

    const toolCalls = XMLToolCallParser.parseToolCalls(specialCharsContent);
    expect(toolCalls).toBeDefined();
    expect(toolCalls!.length).toBe(1);

    const args = JSON.parse(toolCalls![0].function.arguments);
    expect(args.input).toBe('Hello & goodbye! "Quotes" and \'apostrophes\'');
    expect(args.options).toBe('{"special": true, "chars": "&<>\'"}');
  });
});