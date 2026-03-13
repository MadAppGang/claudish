import { LocalFormatAdapter, type SamplingParams } from "./local-format-adapter.js";
import { log } from "../logger.js";

export class LocalQwenFormatAdapter extends LocalFormatAdapter {
  getName(): string {
    return "LocalQwenFormatAdapter";
  }

  protected override getSamplingParams(): SamplingParams {
    return { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, repetition_penalty: 1.05 };
  }

  protected override modifyMessages(messages: any[]): void {
    // Qwen /no_think toggle
    if (process.env.CLAUDISH_QWEN_NO_THINK === "1") {
      if (messages.length > 0 && messages[0].role === "system") {
        messages[0].content = "/no_think\n\n" + messages[0].content;
        log(`[${this.getName()}] Added /no_think to disable Qwen thinking mode`);
      }
    }
  }

  protected override getToolGuidance(): string {
    return `

4. TOOL CALLING FORMAT (CRITICAL FOR QWEN):
You MUST use proper OpenAI-style function calling. Do NOT output tool calls as XML text.
When you want to call a tool, use the API's tool_calls mechanism, NOT text like <function=...>.
The tool calls must be structured JSON in the API response, not XML in your text output.

If you cannot use structured tool_calls, format as JSON:
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}

5. TOOL PARAMETER REQUIREMENTS:`;
  }
}
