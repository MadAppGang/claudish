/**
 * LocalModelAdapter: format adapter for local OpenAI-compatible providers.
 *
 * Wire format: OpenAI Chat Completions (the base FormatAdapter default),
 * with local-specific additions:
 * - System prompt guidance (tool calling, conversation handling)
 * - Generic default sampling parameters (overridden by ModelAdapters)
 * - max_tokens floor (8192) for meaningful responses
 * - Capability-based tool stripping (non-tool models)
 * - Strip cloud-only thinking params
 * - MLX simple format for message conversion
 *
 * Model-family-specific behavior (sampling params, Qwen /no_think, special
 * token stripping) is handled by ModelAdapters (QwenAdapter, DeepSeekAdapter,
 * LlamaAdapter, MistralAdapter) which run after this FormatAdapter.
 */

import { FormatAdapter } from "./format-adapter.js";
import type { ProviderCapabilities } from "../handlers/shared/remote-provider-types.js";
import { log } from "../logger.js";

export class LocalModelAdapter extends FormatAdapter {
  private capabilities: ProviderCapabilities;
  private providerName: string;

  constructor(modelId: string, providerName: string, capabilities: ProviderCapabilities) {
    super(modelId);
    this.providerName = providerName;
    this.capabilities = capabilities;
  }

  getName(): string {
    return `LocalModelAdapter`;
  }

  override supportsVision(): boolean {
    return this.capabilities.supportsVision;
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
      messages[0].content += this.buildSystemGuidance(
        this.capabilities.supportsTools
          ? (claudeRequest.tools?.length || 0)
          : 0
      );
    }

    return messages;
  }

  // ─── Tool conversion with capability check ──────────────────────────

  override convertTools(claudeRequest: any, summarize = false): any[] {
    if (!this.capabilities.supportsTools) {
      log(`[${this.getName()}] Tools stripped (not supported)`);
      return [];
    }
    const { convertToolsToOpenAI } = require("../handlers/shared/openai-compat.js");
    return convertToolsToOpenAI(claudeRequest, summarize);
  }

  // ─── Payload with generic default sampling ──────────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const requestedMaxTokens = claudeRequest.max_tokens || 4096;
    const effectiveMaxTokens = Math.max(requestedMaxTokens, 8192);

    log(
      `[${this.getName()}] max_tokens=${effectiveMaxTokens}`
    );

    const payload: any = {
      model: this.modelId,
      messages,
      // Generic defaults — ModelAdapters override per model family in prepareRequest()
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.0,
      stream: this.capabilities.supportsStreaming,
      max_tokens: effectiveMaxTokens,
      tools: tools.length > 0 ? tools : undefined,
      stream_options: this.capabilities.supportsStreaming
        ? { include_usage: true }
        : undefined,
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
    // FormatAdapter base handles tool name truncation
    super.prepareRequest(request, originalRequest);

    // Strip cloud-only thinking params that local providers don't understand
    delete request.enable_thinking;
    delete request.thinking_budget;
    delete request.thinking;

    return request;
  }

  override getContextWindow(): number {
    return 32768; // Default, overridden by provider's dynamic context window fetch
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
      guidance += `

4. TOOL CALLING REQUIREMENTS:
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
