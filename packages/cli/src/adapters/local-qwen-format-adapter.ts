/**
 * LocalQwenFormatAdapter — Qwen-family local model adapter.
 *
 * Overrides sampling parameters (Qwen3 Instruct recommended settings)
 * and adds /no_think toggle support for disabling Qwen thinking mode.
 */

import { LocalModelAdapter, type SamplingParams } from "./local-adapter.js";
import { log } from "../logger.js";

export class LocalQwenFormatAdapter extends LocalModelAdapter {
  protected override getSamplingParams(): SamplingParams {
    // Qwen3 Instruct recommended settings
    return { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, repetition_penalty: 1.05 };
  }

  protected override getToolGuidanceHeader(): string {
    return `

4. TOOL CALLING FORMAT (CRITICAL FOR QWEN):
You MUST use proper OpenAI-style function calling. Do NOT output tool calls as XML text.
When you want to call a tool, use the API's tool_calls mechanism, NOT text like <function=...>.
The tool calls must be structured JSON in the API response, not XML in your text output.

If you cannot use structured tool_calls, format as JSON:
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}

5. TOOL PARAMETER REQUIREMENTS:`;
  }

  override convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    const messages = super.convertMessages(claudeRequest, filterIdentityFn);

    // Qwen /no_think toggle
    if (process.env.CLAUDISH_QWEN_NO_THINK === "1") {
      if (messages.length > 0 && messages[0].role === "system") {
        messages[0].content = "/no_think\n\n" + messages[0].content;
        log(`[${this.getName()}] Added /no_think to disable Qwen thinking mode`);
      }
    }

    return messages;
  }
}
