/**
 * Base class for API format implementations (Layer 1) and model dialect
 * implementations (Layer 2).
 *
 * Different models have different quirks that need translation:
 * - Grok: XML function calls instead of JSON tool_calls
 * - Deepseek: May have its own format
 * - Others: Future model-specific behaviors
 */

import {
  type ToolNameBindings,
  encodeToolName,
  newToolNameBindings,
} from "./tool-name-utils.js";
import type { ModelPricing } from "../handlers/shared/remote-provider-types.js";
import { getModelPricing } from "../handlers/shared/remote-provider-types.js";
import type { StreamFormat } from "../providers/transport/types.js";
import type { APIFormat } from "./api-format.js";
import type { ModelDialect, PrepareRequestContext } from "./model-dialect.js";
import { lookupModel } from "./model-catalog.js";

/**
 * OpenAI validates a function name against `^[a-zA-Z0-9_-]{1,64}$` on both the
 * Chat Completions and the Responses shape. 64 is that limit, not a guess about
 * any one model. (S4-b 2e18042)
 */
const OPENAI_TOOL_NAME_LIMIT = 64;

/**
 * Match a model ID against a model family name, handling vendor-prefixed IDs.
 *
 * Matches: "grok-beta", "x-ai/grok-beta", "openrouter/x-ai/grok-beta"
 * Does NOT match: "qwen-grok-hybrid" (grok is not at a family boundary)
 *
 * @param modelId - The full model ID (may include vendor prefix)
 * @param family - The family name to match (e.g., "grok", "deepseek", "qwen")
 */
export function matchesModelFamily(modelId: string, family: string): boolean {
  const lower = modelId.toLowerCase();
  const fam = family.toLowerCase();
  return lower.startsWith(fam) || lower.includes(`/${fam}`);
}
import { convertMessagesToOpenAI } from "../handlers/shared/format/openai-messages.js";
import { convertToolsToOpenAI } from "../handlers/shared/format/openai-tools.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface AdapterResult {
  /** Cleaned text content (with XML/special formats removed) */
  cleanedText: string;
  /** Extracted tool calls from special formats */
  extractedToolCalls: ToolCall[];
  /** Whether any transformation was done */
  wasTransformed: boolean;
}

export abstract class BaseAPIFormat implements APIFormat, ModelDialect {
  protected modelId: string;

  /**
   * The wire this format was composed into, when the composed handler told us.
   *
   * A dialect self-selects by model name and cannot know its wire — its own
   * `getStreamFormat()` answers "openai-sse" whatever it was composed into, so
   * under Ollama's JSONL wire or Qwen Plan's Anthropic one it would otherwise
   * encode tool names that wire's parser has no map to decode. The COMPOSED
   * wire wins when it was supplied. (S4-b 2e18042)
   */
  protected readonly wireFormat?: StreamFormat;

  /**
   * This request's tool-name bindings, in both directions.
   *
   * PER REQUEST, and REPLACED rather than cleared — never mutated after it has
   * been handed out. Handlers are cached one per model while `claudish serve`
   * hosts several conversations, so the instance is shared: clearing the map
   * that request A's parser is still decoding with, because request B started,
   * turns A's tool calls into names nothing recognises — and `keepOnlyRealTools`
   * then drops them with no error anywhere. `reset()` mints a new pair; the old
   * one stays whole for whoever is still reading it. (S4-b 2e18042)
   */
  protected toolNameBindings: ToolNameBindings = newToolNameBindings();

  constructor(modelId: string, wireFormat?: StreamFormat) {
    this.modelId = modelId;
    this.wireFormat = wireFormat;
  }

  /**
   * Process text content and extract any model-specific tool call formats
   * @param textContent - The raw text content from the model
   * @param accumulatedText - The accumulated text so far (for multi-chunk parsing)
   * @returns Cleaned text and any extracted tool calls
   */
  abstract processTextContent(textContent: string, accumulatedText: string): AdapterResult;

  /**
   * Check if this format/dialect should be used for the given model
   */
  abstract shouldHandle(modelId: string): boolean;

  /**
   * Get name for logging
   */
  abstract getName(): string;

  /**
   * Maximum tool name length this request's wire accepts, or null for no limit.
   *
   * A RULE about the wire, not a roster of adapters. OpenAI validates a function
   * name against `^[a-zA-Z0-9_-]{1,64}$` on both of its shapes, so every
   * OpenAI-shaped wire gets 64 and everything else gets null. Before this, the
   * method returned null on every adapter except Xiaomi, so nothing else
   * truncated at all — and a real 65-character MCP name
   * (`mcp__plugin_browser-use_browser-use__retry_with_browser_use_agent`) fails
   * the WHOLE request, not just that tool.
   *
   * The composed-wire check comes FIRST and is load-bearing (see {@link wireFormat}).
   */
  getToolNameLimit(): number | null {
    const wire = this.wireFormat ?? this.getStreamFormat();
    return wire === "openai-sse" || wire === "openai-responses-sse" ? OPENAI_TOOL_NAME_LIMIT : null;
  }

  /**
   * This request's decode map (encoded → original).
   *
   * Read it ONCE, immediately after `prepareRequest`, and thread that reference
   * onward — do not re-read it after an `await`. `reset()` replaces the
   * bindings, so a later read on a shared handler returns the NEXT request's
   * map.
   */
  getToolNameMap(): Map<string, string> {
    return this.toolNameBindings.byEncoded;
  }

  /**
   * Restore a possibly-encoded tool name to its original.
   */
  restoreToolName(name: string): string {
    return this.toolNameBindings.byEncoded.get(name) || name;
  }

  /**
   * Handle any request preparation before sending to the model
   * Useful for mapping parameters like thinking budget -> reasoning_effort
   * @param request - The OpenRouter payload being prepared
   * @param originalRequest - The original Claude-format request
   * @param ctx - Optional wire-format context (see PrepareRequestContext)
   * @returns The modified request payload
   */
  prepareRequest(request: any, originalRequest: any, ctx?: PrepareRequestContext): any {
    // Tool-name encoding lives in the TEMPLATE, not in a subclass hook, so
    // every adapter gets it exactly once and no subclass can lose it by
    // overriding prepareRequest without calling super — which is how it came
    // to be on OpenAIAPIFormat and Xiaomi alone. (S4-b 2e18042)
    this.encodeToolNames(request);
    return request;
  }

  /**
   * Reset internal state between requests (prevents state contamination)
   */
  reset(): void {
    // REPLACE, never clear: a parser from the previous request may still be
    // decoding with the old map. See {@link toolNameBindings}.
    this.toolNameBindings = newToolNameBindings();
  }

  // ─── ComposedHandler integration (Phase 1c) ───────────────────────
  // These methods have sensible defaults so existing implementations continue
  // to work unchanged. Override in specific classes as needed.

  /**
   * Convert Claude-format messages to the target API format.
   * Default: delegates to convertMessagesToOpenAI.
   * Override for non-OpenAI formats (e.g., Gemini parts-based format).
   * @param reasoningRoundtrip - Threads the DeepSeek requirement: emit
   *   reasoning_content on every assistant message (see openai-messages.ts).
   */
  convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string, reasoningRoundtrip = false): any[] {
    return convertMessagesToOpenAI(claudeRequest, this.modelId, filterIdentityFn, false, reasoningRoundtrip);
  }

  /**
   * Convert Claude tools to the target API format.
   * Default: OpenAI function-calling format.
   */
  convertTools(claudeRequest: any, summarize = false): any[] {
    return convertToolsToOpenAI(claudeRequest, summarize);
  }

  /**
   * Build the full request payload for the target API.
   * Default: OpenAI Chat Completions format.
   * Override for Gemini (generateContent), Anthropic passthrough, etc.
   */
  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      stream: true,
    };
    if (tools.length > 0) {
      payload.tools = tools;
    }
    if (claudeRequest.max_tokens) {
      payload.max_tokens = claudeRequest.max_tokens;
    }
    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }
    return payload;
  }

  /**
   * The stream format this format's target API returns.
   * Default: "openai-sse" (most common format).
   * Override for Anthropic passthrough ("anthropic-sse"), Gemini ("gemini-sse"), etc.
   */
  getStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  /**
   * Context window size for this model (tokens).
   * Used for token tracking and context-left-percent calculation.
   */
  getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  /**
   * Pricing info for this model. Used by TokenTracker.
   * Default: delegates to the centralized getModelPricing.
   */
  getPricing(providerName: string): ModelPricing {
    return getModelPricing(providerName, this.modelId);
  }

  /**
   * Whether this model supports vision/image input.
   */
  supportsVision(): boolean {
    return true;
  }

  /**
   * Whether thinking blocks should be filtered from the SSE response.
   * Override to return true for providers whose thinking blocks leak to the user.
   */
  shouldFilterThinking(): boolean {
    return false;
  }

  /**
   * Whether thinking blocks in message history MUST be preserved (not stripped)
   * so the OpenAI-format converter can round-trip them as `reasoning_content`.
   *
   * Providers that enforce reasoning_content echo-back on every assistant turn
   * (DeepSeek) return true. Default false: strip — Anthropic thinking signatures
   * are meaningless (and corrupting) to non-native anthropic-transport providers
   * like GLM/MiniMax, and ComposedHandler strips them from history by default.
   * Returning true opts the model out of that strip so the converter sees the
   * thinking block and re-emits reasoning_content on the outbound payload.
   */
  preserveThinkingInHistory(): boolean {
    return false;
  }

  /**
   * Rewrite every tool name in this payload into what the wire accepts, and
   * record the way back.
   *
   * THREE places carry a tool name, and all three must agree or the request is
   * worse than it was before:
   *
   *   1. `tools[]` — what the model may call. Both shapes: Chat Completions
   *      `{type:"function", function:{name}}` and the Responses API's flat
   *      `{type:"function", name}`.
   *   2. The HISTORY — `messages[]` assistant `tool_calls`. A history naming a
   *      tool that is not in `tools[]` is rejected by strict endpoints and
   *      confuses every other one.
   *   3. `tool_choice` — pointing at a name the model was never offered is a
   *      400 on the first forced-tool turn.
   *
   * Encoding runs on the BUILT payload rather than inside each builder because
   * that is where all three live, and because the map has to be minted
   * somewhere both the payload and the parser can see.
   *
   * Idempotent: an already-encoded name transforms to itself and is bound to
   * itself, so a delegating adapter that runs this after its inner adapter
   * already did changes nothing. (S4-b 2e18042)
   */
  protected encodeToolNames(request: any): void {
    const limit = this.getToolNameLimit();
    if (!limit || !request) return;

    const encode = (name: string) => encodeToolName(name, limit, this.toolNameBindings);

    if (Array.isArray(request.tools)) {
      for (const tool of request.tools) {
        if (tool?.function?.name) {
          tool.function.name = encode(tool.function.name);
        } else if (tool?.name) {
          tool.name = encode(tool.name);
        }
      }
    }

    if (Array.isArray(request.messages)) {
      for (const msg of request.messages) {
        if (msg?.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
        for (const tc of msg.tool_calls) {
          if (tc?.function?.name) tc.function.name = encode(tc.function.name);
        }
      }
    }

    // Responses API history. `input` holds `function_call` items rather than an
    // assistant message with `tool_calls`, so the branch above cannot see them.
    if (Array.isArray(request.input)) {
      for (const item of request.input) {
        if (item?.type === "function_call" && item.name) item.name = encode(item.name);
      }
    }

    const choice = request.tool_choice;
    if (choice && typeof choice === "object") {
      // `{type:"function", function:{name}}` (chat) and `{type:"function", name}`
      // (responses). The string forms — "auto"/"none"/"required" — name nothing.
      if (choice.function?.name) {
        choice.function.name = encode(choice.function.name);
      } else if (choice.name) {
        choice.name = encode(choice.name);
      }
    }
  }
}

/**
 * Default format/dialect that does no transformation
 */
export class DefaultAPIFormat extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  shouldHandle(modelId: string): boolean {
    return false; // Default is fallback
  }

  getName(): string {
    return "DefaultAPIFormat";
  }
}

// ─── Backward-compatible aliases ──────────────────────────────────────────────
// Keep old names as aliases so legacy code referencing them still compiles
// during the transition. These can be removed in a future cleanup pass.

/** @deprecated Use BaseAPIFormat */
export const BaseModelAdapter = BaseAPIFormat;
export type BaseModelAdapter = BaseAPIFormat;

/** @deprecated Use DefaultAPIFormat */
export const DefaultAdapter = DefaultAPIFormat;
export type DefaultAdapter = DefaultAPIFormat;
