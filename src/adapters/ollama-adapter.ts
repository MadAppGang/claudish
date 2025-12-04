/**
 * Ollama adapter for translating JSON tool calls to Claude Code tool_calls
 *
 * OllamaCloud models output tool calls in JSON format:
 * ```json
 * {"tool_call": {"name": "Read", "input": {"file_path": "/path/to/file.txt"}}}
 * ```
 *
 * This adapter translates that to Claude Code's expected tool_calls format.
 */

import { BaseModelAdapter, AdapterResult, ToolCall } from "./base-adapter";
import { log } from "../logger";

export class OllamaAdapter extends BaseModelAdapter {
  private textBuffer: string = "";
  private sentTextLength: number = 0; // Track how much text we've already sent

  /**
   * Create a tool call with a unique ID
   */
  private createToolCall(name: string, arguments_: Record<string, any>): ToolCall {
    return {
      id: `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`,
      name,
      arguments: arguments_,
    };
  }

  /**
   * Extract JSON object boundaries by counting braces
   */
  private extractJsonBoundaries(text: string, startIndex: number): { start: number; end: number } | null {
    let braceCount = 0;
    let foundStart = false;

    for (let i = startIndex; i < text.length; i++) {
      if (text[i] === '{') {
        braceCount++;
        foundStart = true;
      } else if (text[i] === '}') {
        braceCount--;
        if (foundStart && braceCount === 0) {
          return { start: startIndex, end: i + 1 };
        }
      }
    }
    return null;
  }

  /**
   * Parse and validate a tool call from JSON text
   */
  private parseToolCall(jsonText: string, seenToolCalls: Set<string>): ToolCall | null {
    try {
      let cleanedJson = jsonText.trim();
      
      // Remove trailing markdown code block markers
      cleanedJson = cleanedJson.replace(/```[a-z]*\s*$/g, '').trim();
      
      // Extract JSON if wrapped in extra characters
      const jsonMatch = cleanedJson.match(/\{\s*"tool_call"\s*:[\s\S]*\}/);
      if (jsonMatch) {
        cleanedJson = jsonMatch[0];
      }

      const parsed = JSON.parse(cleanedJson);
      if (parsed.tool_call?.name && parsed.tool_call?.input) {
        const toolKey = `${parsed.tool_call.name}:${JSON.stringify(parsed.tool_call.input)}`;
        if (!seenToolCalls.has(toolKey)) {
          seenToolCalls.add(toolKey);
          return this.createToolCall(parsed.tool_call.name, parsed.tool_call.input);
        }
      }
    } catch (e) {
      // Will try recovery methods
    }
    return null;
  }

  /**
   * Attempt to recover tool call from malformed JSON
   */
  private recoverToolCall(jsonText: string, seenToolCalls: Set<string>): ToolCall | null {
    // Method 1: Extract by JSON boundaries
    const jsonStart = jsonText.indexOf('{"tool_call"');
    if (jsonStart >= 0) {
      const boundaries = this.extractJsonBoundaries(jsonText, jsonStart);
      if (boundaries) {
        try {
          const extractedJson = jsonText.slice(boundaries.start, boundaries.end);
          const parsed = JSON.parse(extractedJson);
          if (parsed.tool_call?.name && parsed.tool_call?.input) {
            const toolKey = `${parsed.tool_call.name}:${JSON.stringify(parsed.tool_call.input)}`;
            if (!seenToolCalls.has(toolKey)) {
              seenToolCalls.add(toolKey);
              return this.createToolCall(parsed.tool_call.name, parsed.tool_call.input);
            }
          }
        } catch (e) {
          // Continue to next recovery method
        }
      }
    }

    // Method 2: Extract by name and input patterns
    const nameMatch = jsonText.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch) {
      const toolName = nameMatch[1];
      const inputPattern = /"input"\s*:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/;
      const inputMatch = jsonText.match(inputPattern);
      
      if (inputMatch) {
        try {
          const inputJson = `{${inputMatch[1]}}`;
          const parsedInput = JSON.parse(inputJson);
          const toolKey = `${toolName}:${JSON.stringify(parsedInput)}`;
          if (!seenToolCalls.has(toolKey)) {
            seenToolCalls.add(toolKey);
            return this.createToolCall(toolName, parsedInput);
          }
        } catch (e) {
          // Recovery failed
        }
      }
    }

    return null;
  }

  processTextContent(
    textContent: string,
    _accumulatedText: string
  ): AdapterResult {
    // Accumulate text to handle JSON split across multiple chunks
    this.textBuffer += textContent;

    // Pattern 1: JSON code blocks with tool_call (properly formatted)
    const jsonBlockPattern = /```json\s*\n\s*\{\s*"tool_call"\s*:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}\s*\}\s*```/gs;
    
    // Pattern 2: Malformed JSON mixed with markdown (e.g., {"tool_call```json)
    const malformedJsonPattern = /\{\s*"tool_call"\s*:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}\s*\}\s*```/gs;
    
    // Pattern 3: Standalone JSON (without code blocks) - most flexible
    const standaloneJsonPattern = /\{\s*"tool_call"\s*:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}\s*\}/gs;

    // Try all patterns
    const allMatches: Array<{ match: string; json: string }> = [];

    // Find properly formatted JSON code blocks
    let match: RegExpExecArray | null;
    while ((match = jsonBlockPattern.exec(this.textBuffer)) !== null) {
      allMatches.push({
        match: match[0],
        json: match[0].replace(/```json\s*|\s*```/g, '').trim()
      });
    }

    // Find malformed JSON mixed with markdown (e.g., {"tool_call": {...}}```json)
    while ((match = malformedJsonPattern.exec(this.textBuffer)) !== null) {
      const jsonPart = match[0].replace(/```.*$/, '').trim();
      allMatches.push({
        match: match[0],
        json: jsonPart
      });
    }

    // Find standalone JSON (only if not already in a code block)
    const codeBlockRanges: Array<{ start: number; end: number }> = [];
    let codeBlockMatch: RegExpExecArray | null;
    const codeBlockRegex = /```[^`]+```/g;
    while ((codeBlockMatch = codeBlockRegex.exec(this.textBuffer)) !== null) {
      codeBlockRanges.push({
        start: codeBlockMatch.index,
        end: codeBlockMatch.index + codeBlockMatch[0].length
      });
    }

    let standaloneMatch: RegExpExecArray | null;
    while ((standaloneMatch = standaloneJsonPattern.exec(this.textBuffer)) !== null) {
      // Check if this match is inside a code block
      const isInCodeBlock = codeBlockRanges.some(
        range => standaloneMatch!.index >= range.start && standaloneMatch!.index < range.end
      );

      if (!isInCodeBlock) {
        // Check if we already found this in a code block
        const alreadyFound = allMatches.some(m => m.match.includes(standaloneMatch![0]));
        if (!alreadyFound) {
          allMatches.push({ match: standaloneMatch[0], json: standaloneMatch[0] });
        }
      }
    }

    // If no matches found, check if we have a partial tool call
    if (allMatches.length === 0) {
      // Check if we have a partial tool call JSON
      const partialPattern = /\{\s*"tool_call"/;
      const hasPartialToolCall = partialPattern.test(this.textBuffer);

      if (hasPartialToolCall) {
        // Find where the partial tool call starts
        const partialMatch = this.textBuffer.match(/(.*?)\{\s*"tool_call"/);
        if (partialMatch) {
          // Send text before the partial tool call
          const textBeforePartial = partialMatch[1];
          const newText = textBeforePartial.slice(this.sentTextLength);
          this.sentTextLength = textBeforePartial.length;
          
          // Keep the partial tool call in buffer for next chunk
          this.textBuffer = this.textBuffer.slice(textBeforePartial.length);
          this.sentTextLength = 0; // Reset since we're starting a new buffer
          
          return {
            cleanedText: newText,
            extractedToolCalls: [],
            wasTransformed: false,
          };
        }
        
        // If we can't find the start, keep accumulating
        return {
          cleanedText: "",
          extractedToolCalls: [],
          wasTransformed: false,
        };
      }

      // Normal text, no tool calls - return only new text
      const newText = this.textBuffer.slice(this.sentTextLength);
      this.sentTextLength = this.textBuffer.length;
      
      return {
        cleanedText: newText,
        extractedToolCalls: [],
        wasTransformed: false,
      };
    }

    // Extract tool calls from JSON matches
    const toolCalls: ToolCall[] = [];
    const seenToolCalls = new Set<string>(); // Avoid duplicates
    const matchesToRemove: string[] = []; // Collect match strings for removal
    
    for (const { match: matchText, json: jsonText } of allMatches) {
      matchesToRemove.push(matchText); // Store for cleanup
      
      // Try normal parsing first
      let toolCall = this.parseToolCall(jsonText, seenToolCalls);
      
      // If normal parsing failed, try recovery methods
      if (!toolCall) {
        toolCall = this.recoverToolCall(jsonText, seenToolCalls);
      }
      
      if (toolCall) {
        toolCalls.push(toolCall);
        log(`[OllamaAdapter] Detected tool call: ${toolCall.name} with params: ${JSON.stringify(toolCall.arguments)}`);
      } else {
        log(`[OllamaAdapter] Failed to parse tool call JSON: ${jsonText.substring(0, 150)}...`);
      }
    }

    // Remove tool call JSON blocks from text
    let cleanedBuffer = this.textBuffer;
    for (const matchText of matchesToRemove) {
      cleanedBuffer = cleanedBuffer.replace(matchText, '');
    }

    // Clean up extra whitespace
    cleanedBuffer = cleanedBuffer.replace(/\n{3,}/g, '\n\n');

    // Update textBuffer to reflect removed tool calls (critical fix for Bug 1)
    this.textBuffer = cleanedBuffer;

    // Return only new cleaned text (incremental)
    const newCleanedText = cleanedBuffer.slice(this.sentTextLength);
    this.sentTextLength = cleanedBuffer.length;

    return {
      cleanedText: newCleanedText,
      extractedToolCalls: toolCalls,
      wasTransformed: toolCalls.length > 0,
    };
  }

  shouldHandle(modelId: string): boolean {
    // OllamaCloud models typically have -cloud suffix or :cloud tag
    return modelId.includes("-cloud") || modelId.includes(":cloud") || 
           (modelId.includes(":") && !modelId.includes("/"));
  }

  getName(): string {
    return "OllamaAdapter";
  }

  /**
   * Reset internal state (useful between requests)
   */
  reset(): void {
    this.textBuffer = "";
    this.sentTextLength = 0;
  }
}

