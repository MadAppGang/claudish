/**
 * OllamaAPIFormat — Layer 1 wire format for OllamaCloud API.
 *
 * Converts Claude messages to OllamaCloud's simple format:
 * - All content reduced to plain strings (no structured blocks)
 * - Tool calls/results inlined as text markers
 * - No images (OllamaCloud doesn't support vision)
 * - No tool schema support
 */

import { BaseAPIFormat, type AdapterResult } from "./base-api-format.js";
import type { StreamFormat } from "../providers/transport/types.js";

export class OllamaAPIFormat extends BaseAPIFormat {
  constructor(modelId: string) {
    super(modelId);
  }

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  getName(): string {
    return "OllamaAPIFormat";
  }

  /**
   * Convert Claude messages to OllamaCloud's simple string format.
   * System message is prepended as first message.
   */
  override convertMessages(claudeRequest: any, _filterFn?: any): any[] {
    const messages: any[] = [];

    // System message
    if (claudeRequest.system) {
      const content = Array.isArray(claudeRequest.system)
        ? claudeRequest.system.map((i: any) => i.text || i).join("\n\n")
        : claudeRequest.system;
      messages.push({ role: "system", content });
    }

    if (claudeRequest.messages) {
      for (const msg of claudeRequest.messages) {
        if (msg.role === "user") {
          messages.push(this.processUserMessage(msg));
        } else if (msg.role === "assistant") {
          messages.push(this.processAssistantMessage(msg));
        }
      }
    }

    return messages;
  }

  /**
   * OllamaCloud doesn't support tools — return empty array.
   */
  override convertTools(_claudeRequest: any, _summarize?: boolean): any[] {
    return [];
  }

  /**
   * Build Ollama native format payload.
   */
  override buildPayload(_claudeRequest: any, messages: any[], _tools: any[]): any {
    return {
      model: this.modelId,
      messages,
      stream: true,
    };
  }

  override getStreamFormat(): StreamFormat {
    return "ollama-jsonl";
  }

  override getContextWindow(): number {
    return 0; // Unknown — OllamaCloud doesn't report context window
  }

  override supportsVision(): boolean {
    return false;
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private processUserMessage(msg: any): any {
    if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          const resultContent =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          textParts.push(`[Tool Result]: ${resultContent}`);
        }
        // Skip images — OllamaCloud doesn't support vision
      }
      return { role: "user", content: textParts.join("\n\n") };
    }
    return { role: "user", content: msg.content };
  }

  private processAssistantMessage(msg: any): any {
    if (Array.isArray(msg.content)) {
      const strings: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          strings.push(block.text);
        } else if (block.type === "tool_use") {
          strings.push(`[Tool Call: ${block.name}]: ${JSON.stringify(block.input)}`);
        }
      }
      return { role: "assistant", content: strings.join("\n") };
    }
    return { role: "assistant", content: msg.content };
  }
}

// Backward-compatible alias
/** @deprecated Use OllamaAPIFormat */
export { OllamaAPIFormat as OllamaCloudAdapter };
