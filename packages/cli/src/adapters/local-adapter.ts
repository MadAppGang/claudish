/**
 * LocalModelAdapter — adapter for local OpenAI-compatible providers.
 *
 * Wraps a model-specific adapter (Qwen, DeepSeek, etc.) and adds
 * local-model-specific behaviors:
 * - System prompt guidance (tool calling, conversation handling)
 * - Model-family sampling parameters (Qwen, DeepSeek, Llama, Mistral)
 * - max_tokens floor (8192) for meaningful responses
 * - Qwen /no_think toggle
 * - Strip cloud-only thinking params
 * - MLX simple format for message conversion
 */

import { BaseModelAdapter, type AdapterResult } from "./base-adapter.js";
import { AdapterManager } from "./adapter-manager.js";
import { log } from "../logger.js";

interface SamplingParams {
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  repetition_penalty: number;
}

export class LocalModelAdapter extends BaseModelAdapter {
  private innerAdapter: BaseModelAdapter;
  private providerName: string;

  constructor(modelId: string, providerName: string) {
    super(modelId);
    this.providerName = providerName;

    const manager = new AdapterManager(modelId);
    this.innerAdapter = manager.getAdapter();
  }

  // ─── Text processing delegates to inner adapter ───────────────────

  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return this.innerAdapter.processTextContent(textContent, accumulatedText);
  }

  shouldHandle(modelId: string): boolean {
    return true; // Always used explicitly
  }

  getName(): string {
    return `LocalModelAdapter(${this.innerAdapter.getName()})`;
  }

  override reset(): void {
    super.reset();
    this.innerAdapter.reset();
  }

  supportsVision(): boolean {
    return true;
  }

  // ─── Message conversion with system prompt guidance ─────────────────

  override convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    const useSimpleFormat = this.providerName === "mlx";
    const { convertMessagesToOpenAI } = require("../handlers/shared/openai-compat.js");
    const messages = convertMessagesToOpenAI(
      claudeRequest,
      this.modelId,
      filterIdentityFn,
      useSimpleFormat
    );

    // Add guidance to system prompt for local models
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content += this.buildSystemGuidance(claudeRequest.tools?.length || 0);
    }

    // Qwen /no_think toggle
    if (this.modelId.toLowerCase().includes("qwen") && process.env.CLAUDISH_QWEN_NO_THINK === "1") {
      if (messages.length > 0 && messages[0].role === "system") {
        messages[0].content = "/no_think\n\n" + messages[0].content;
        log(`[${this.getName()}] Added /no_think to disable Qwen thinking mode`);
      }
    }

    return messages;
  }

  // ─── Tool conversion ─────────────────────────────────────────────────

  override convertTools(claudeRequest: any, summarize = false): any[] {
    const { convertToolsToOpenAI } = require("../handlers/shared/openai-compat.js");
    return convertToolsToOpenAI(claudeRequest, summarize);
  }

  // ─── Payload with model-family sampling params ──────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const sampling = this.getSamplingParams();
    const requestedMaxTokens = claudeRequest.max_tokens || 4096;
    const effectiveMaxTokens = Math.max(requestedMaxTokens, 8192);

    log(
      `[${this.getName()}] Sampling: temp=${sampling.temperature}, top_p=${sampling.top_p}, top_k=${sampling.top_k}, max_tokens=${effectiveMaxTokens}`
    );

    const payload: any = {
      model: this.modelId,
      messages,
      temperature: sampling.temperature,
      top_p: sampling.top_p,
      top_k: sampling.top_k,
      min_p: sampling.min_p,
      repetition_penalty: sampling.repetition_penalty > 1 ? sampling.repetition_penalty : undefined,
      stream: true,
      max_tokens: effectiveMaxTokens,
      tools: tools.length > 0 ? tools : undefined,
      stream_options: { include_usage: true },
    };

    // Tool choice mapping from Claude format
    if (claudeRequest.tool_choice && tools.length > 0) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        payload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        payload.tool_choice = type;
      }
    }

    return payload;
  }

  // ─── Request post-processing ────────────────────────────────────────

  override prepareRequest(request: any, originalRequest: any): any {
    // Delegate to inner adapter (Qwen tool name truncation, etc.)
    this.innerAdapter.prepareRequest(request, originalRequest);

    // Merge inner adapter's tool name map
    for (const [k, v] of this.innerAdapter.getToolNameMap()) {
      this.toolNameMap.set(k, v);
    }

    // Strip cloud-only thinking params that local providers don't understand
    delete request.enable_thinking;
    delete request.thinking_budget;
    delete request.thinking;

    return request;
  }

  override getToolNameMap(): Map<string, string> {
    const map = new Map(super.getToolNameMap());
    for (const [k, v] of this.innerAdapter.getToolNameMap()) {
      map.set(k, v);
    }
    return map;
  }

  override getContextWindow(): number {
    return 32768; // Default — overridden by provider's dynamic context window fetch
  }

  // ─── Model-family sampling parameters ───────────────────────────────

  private getSamplingParams(): SamplingParams {
    const id = this.modelId.toLowerCase();

    if (id.includes("qwen")) {
      // Qwen3 Instruct recommended settings
      return { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, repetition_penalty: 1.05 };
    }
    if (id.includes("deepseek")) {
      return { temperature: 0.6, top_p: 0.95, top_k: 40, min_p: 0.0, repetition_penalty: 1.0 };
    }
    if (id.includes("llama")) {
      return { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repetition_penalty: 1.1 };
    }
    if (id.includes("mistral")) {
      return { temperature: 0.7, top_p: 0.9, top_k: 50, min_p: 0.0, repetition_penalty: 1.0 };
    }
    // Generic defaults
    return { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.0, repetition_penalty: 1.0 };
  }

  // ─── System prompt guidance ─────────────────────────────────────────

  private buildSystemGuidance(toolCount: number): string {
    let guidance = `

IMPORTANT INSTRUCTIONS FOR THIS MODEL:

1. OUTPUT BEHAVIOR:
- NEVER output your internal reasoning, thinking process, or chain-of-thought as visible text.
- Only output your final response, actions, or tool calls.
- Do NOT ramble or speculate about what the user might want.

2. CONVERSATION HANDLING:
- Always look back at the ORIGINAL user request in the conversation history.
- When you receive results from a Task/agent you called, SYNTHESIZE those results and continue fulfilling the user's original request.
- Do NOT ask "What would you like help with?" if there's already a user request in the conversation.
- Only ask for clarification if the FIRST user message in the conversation is unclear.
- After calling tools or agents, continue with the next step - don't restart or ask what to do.

3. CRITICAL - AFTER TOOL RESULTS:
- When you see tool results (like file lists, search results, or command output), ALWAYS continue working.
- Analyze the results and take the next action toward completing the user's request.
- If the user asked for "evaluation and suggestions", you MUST provide analysis and recommendations after seeing the data.
- NEVER stop after just calling one tool - continue until you've fully addressed the user's request.
- If you called a Glob/Search and got files, READ important files next, then ANALYZE, then SUGGEST improvements.`;

    if (toolCount > 0) {
      const isQwen = this.modelId.toLowerCase().includes("qwen");

      if (isQwen) {
        guidance += `

4. TOOL CALLING FORMAT (CRITICAL FOR QWEN):
You MUST use proper OpenAI-style function calling. Do NOT output tool calls as XML text.
When you want to call a tool, use the API's tool_calls mechanism, NOT text like <function=...>.
The tool calls must be structured JSON in the API response, not XML in your text output.

If you cannot use structured tool_calls, format as JSON:
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}

5. TOOL PARAMETER REQUIREMENTS:`;
      } else {
        guidance += `

4. TOOL CALLING REQUIREMENTS:`;
      }

      guidance += `
- When calling tools, you MUST include ALL required parameters. Incomplete tool calls will fail.
- For Task: always include "description" (3-5 words), "prompt" (detailed instructions), and "subagent_type"
- For Bash: always include "command" and "description"
- For Read/Write/Edit: always include the full "file_path"
- For Grep/Glob: always include "pattern"
- Ensure your tool call JSON is complete with all required fields before submitting.`;
    }

    return guidance;
  }
}
