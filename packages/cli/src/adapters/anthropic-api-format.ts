/**
 * AnthropicAPIFormat — Layer 1 wire format for Anthropic Messages API.
 *
 * Identity transform for providers that speak native Anthropic/Claude API format.
 * Messages, tools, and payload are passed through as-is (no conversion to OpenAI format).
 * Used by: MiniMax, Kimi, Kimi Coding, Z.AI
 */

import type { StreamFormat } from "../providers/transport/types.js";
import { type AdapterResult, BaseAPIFormat } from "./base-api-format.js";
import { lookupModelMaxOutputTokens } from "./model-catalog.js";

/** Text of one inline system message, whatever content shape it arrived in. */
function systemText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => (typeof block?.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Split `role: "system"` entries out of the messages array.
 *
 * Returns the ORIGINAL array reference when there is nothing to hoist, so the
 * overwhelmingly common case allocates nothing and the payload is byte-identical
 * to what it was before this existed.
 */
export function hoistInlineSystem(messages: any[]): { messages: any[]; hoisted: string[] } {
  if (!Array.isArray(messages) || !messages.some((m) => m?.role === "system")) {
    return { messages, hoisted: [] };
  }
  const kept: any[] = [];
  const hoisted: string[] = [];
  for (const msg of messages) {
    if (msg?.role === "system") {
      const text = systemText(msg.content);
      // A system message with no extractable text is dropped rather than
      // hoisted as "": it would add a blank paragraph to the system prompt and
      // change the cached prefix for nothing.
      if (text) hoisted.push(text);
      continue;
    }
    kept.push(msg);
  }
  return { messages: kept, hoisted };
}

/**
 * Append hoisted text to whatever `system` already was.
 *
 * The array form is PRESERVED as an array. Claude Code sends system as blocks
 * carrying `cache_control`, and flattening them to one string would discard the
 * cache breakpoints — turning a fix for a 400 into a silent cost regression.
 */
export function mergeSystem(existing: unknown, hoisted: string[]): unknown {
  if (hoisted.length === 0) return existing;
  const merged = hoisted.join("\n\n");
  if (existing === undefined || existing === null || existing === "") return merged;
  if (Array.isArray(existing)) return [...existing, { type: "text", text: merged }];
  if (typeof existing === "string") return `${existing}\n\n${merged}`;
  return existing;
}

export class AnthropicAPIFormat extends BaseAPIFormat {
  constructor(modelId: string, _providerName?: string) {
    super(modelId);
    // _providerName retained for backward compat with call sites; no longer used.
  }

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  shouldHandle(_modelId: string): boolean {
    return false; // Not auto-selected; always explicitly passed
  }

  getName(): string {
    return "AnthropicAPIFormat";
  }

  /**
   * Pass through Claude messages, stripping Claude-internal content types
   * that non-Anthropic providers don't support (e.g. tool_reference from
   * the deferred tool loading / ToolSearch system).
   */
  override convertMessages(claudeRequest: any, _filterFn?: any): any[] {
    const messages = claudeRequest.messages || [];
    return messages.map((msg: any) => this.stripUnsupportedContentTypes(msg));
  }

  private stripUnsupportedContentTypes(message: any): any {
    if (!message.content || !Array.isArray(message.content)) {
      return message;
    }
    const filteredContent = message.content
      .map((block: any) => {
        // Strip tool_reference from tool_result content arrays
        if (block.type === "tool_result" && Array.isArray(block.content)) {
          const filtered = block.content.filter((c: any) => c.type !== "tool_reference");
          // Keep at least a minimal text block so tool_result content is never empty
          return {
            ...block,
            content: filtered.length > 0 ? filtered : [{ type: "text", text: "" }],
          };
        }
        return block;
      })
      .filter((block: any) => block.type !== "tool_reference");
    return { ...message, content: filteredContent };
  }

  /**
   * Pass through Claude tools as-is — no OpenAI conversion.
   */
  override convertTools(claudeRequest: any, _summarize?: boolean): any[] {
    return claudeRequest.tools || [];
  }

  /**
   * The `max_tokens` this request carries.
   *
   * The Messages API requires the field, but the inbound request may lack it
   * (MCP `run_prompt` and `compare_models` send none). An inbound value is kept
   * unchanged. A missing one is filled from the catalog's `maxOutputTokens` for
   * this model, never from a pinned number: the old `|| 4096` capped every
   * Messages connection at 4096 output tokens whenever the request had none.
   * With no published ceiling the field is omitted (an unknown value is sent
   * as nothing, ai-docs/architecture/wire.md "Output limit"); on a catalog
   * connection step 5w writes the final value from the connection either way.
   */
  private outputLimitFor(claudeRequest: any): number | undefined {
    const inbound = claudeRequest?.max_tokens;
    if (typeof inbound === "number") return inbound;
    if (this.modelId.includes("@")) return undefined;
    return lookupModelMaxOutputTokens(this.modelId);
  }

  /**
   * Rebuild the Anthropic-format payload from the claudeRequest.
   * This reconstructs the same payload that Claude Code originally sent,
   * with the model name replaced to match the target provider's model.
   */
  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    // Claude Code injects `role: "system"` entries INLINE in messages[] (system
    // reminders between turns). The Messages API takes `system` as a top-level
    // field and accepts only user/assistant in messages, so every
    // Anthropic-compatible provider — Z.AI, GLM, MiniMax, Kimi — answers 400.
    //
    // This belongs here rather than in ComposedHandler because it is a
    // wire-format legality rule, and this class IS the Anthropic wire format.
    // Put behind a provider check upstream and it would have to name every
    // anthropic-transport provider and stay current with the list.
    //
    // The OpenAI path never needed it: convertMessagesToOpenAI already hoists
    // system entries (openai-messages.ts:24), and Chat Completions accepts the
    // role anyway. `transformMessages()` in transform.ts does the same hoisting
    // and is EXPORTED BUT NEVER CALLED — dead since before this file existed.
    const { messages: cleanMessages, hoisted } = hoistInlineSystem(messages);

    const payload: any = {
      model: this.modelId,
      messages: cleanMessages,
      stream: true,
    };
    const maxTokens = this.outputLimitFor(claudeRequest);
    if (maxTokens !== undefined) payload.max_tokens = maxTokens;

    // APPEND, never replace. The reminders are additional context, and the real
    // system prompt is the expensive cached prefix — overwriting it would both
    // lose the user's instructions and blow the provider's prefix cache every
    // turn a reminder appears.
    const system = mergeSystem(claudeRequest.system, hoisted);
    if (system !== undefined) {
      payload.system = system;
    }
    if (tools.length > 0) {
      payload.tools = tools;
    }
    if (claudeRequest.thinking) {
      payload.thinking = claudeRequest.thinking;
    }
    if (claudeRequest.tool_choice) {
      payload.tool_choice = claudeRequest.tool_choice;
    }
    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }
    if (claudeRequest.stop_sequences) {
      payload.stop_sequences = claudeRequest.stop_sequences;
    }
    if (claudeRequest.metadata) {
      payload.metadata = claudeRequest.metadata;
    }

    return payload;
  }

  override getStreamFormat(): StreamFormat {
    return "anthropic-sse";
  }

  override supportsVision(): boolean {
    return true; // These providers handle vision natively
  }
}

// Backward-compatible alias
/** @deprecated Use AnthropicAPIFormat */
export { AnthropicAPIFormat as AnthropicPassthroughAdapter };
