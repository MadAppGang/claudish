import { ModelAdapter, type AdapterResult } from "./model-adapter.js";
import { log } from "../logger";

// Qwen tool calling guidance — Qwen models sometimes emit tool calls as XML text
// instead of using the structured API mechanism
const QWEN_TOOL_GUIDANCE = `

TOOL CALLING FORMAT (CRITICAL FOR QWEN):
You MUST use proper OpenAI-style function calling. Do NOT output tool calls as XML text.
When you want to call a tool, use the API's tool_calls mechanism, NOT text like <function=...>.
The tool calls must be structured JSON in the API response, not XML in your text output.

If you cannot use structured tool_calls, format as JSON:
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}`;

// Qwen special tokens that should be stripped from output
const QWEN_SPECIAL_TOKENS = [
  "<|im_start|>",
  "<|im_end|>",
  "<|endoftext|>",
  "<|end|>",
  "assistant\n", // Role marker that sometimes leaks
];

export class QwenAdapter extends ModelAdapter {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // Strip Qwen special tokens that may leak through
    // This can happen when the model gets confused and outputs its chat template
    let cleanedText = textContent;
    for (const token of QWEN_SPECIAL_TOKENS) {
      cleanedText = cleanedText.replaceAll(token, "");
    }

    // Also handle partial tokens at chunk boundaries
    // e.g., "<|im_" at the end of one chunk and "start|>" at the beginning of next
    cleanedText = cleanedText.replace(/<\|[a-z_]*$/i, ""); // Partial at end
    cleanedText = cleanedText.replace(/^[a-z_]*\|>/i, ""); // Partial at start

    const wasTransformed = cleanedText !== textContent;
    if (wasTransformed && cleanedText.length === 0) {
      // Entire chunk was special tokens, skip it
      return {
        cleanedText: "",
        extractedToolCalls: [],
        wasTransformed: true,
      };
    }

    return {
      cleanedText,
      extractedToolCalls: [],
      wasTransformed,
    };
  }

  /**
   * Handle request preparation:
   * - Map reasoning parameters (thinking → enable_thinking)
   * - Override sampling params for local models (Qwen3 Instruct recommended)
   * - Inject /no_think toggle when CLAUDISH_QWEN_NO_THINK=1
   */
  override prepareRequest(request: any, originalRequest: any): any {
    if (originalRequest.thinking) {
      const { budget_tokens } = originalRequest.thinking;

      // Qwen specific parameters
      request.enable_thinking = true;
      request.thinking_budget = budget_tokens;

      log(
        `[QwenAdapter] Mapped budget ${budget_tokens} -> enable_thinking: true, thinking_budget: ${budget_tokens}`
      );

      // Cleanup: Remove raw thinking object
      delete request.thinking;
    }

    // Override sampling params for local models (detected by presence of temperature in request)
    if (request.temperature !== undefined) {
      request.temperature = 0.7;
      request.top_p = 0.8;
      request.top_k = 20;
      request.min_p = 0.0;
      request.repetition_penalty = 1.05;
    }

    // Qwen /no_think toggle
    if (process.env.CLAUDISH_QWEN_NO_THINK === "1" && request.messages?.length > 0) {
      const first = request.messages[0];
      if (first.role === "system" && typeof first.content === "string") {
        first.content = "/no_think\n\n" + first.content;
        log(`[QwenAdapter] Added /no_think to disable Qwen thinking mode`);
      }
    }

    // Qwen-specific tool calling guidance for local models
    if (request.tools?.length > 0 && request.messages?.length > 0) {
      const first = request.messages[0];
      if (first.role === "system" && typeof first.content === "string") {
        first.content += QWEN_TOOL_GUIDANCE;
      }
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return lower.includes("qwen") || lower.includes("alibaba");
  }

  getName(): string {
    return "QwenAdapter";
  }
}
