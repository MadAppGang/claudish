/**
 * CodexAPIFormat — Layer 1 wire format for the OpenAI Responses API (Codex models).
 *
 * The Codex Responses API is a distinct wire format from Chat Completions:
 * - Uses 'input' instead of 'messages'
 * - Uses 'instructions' instead of 'system' messages
 * - Uses 'max_output_tokens' instead of 'max_tokens'
 * - Tools are flattened (no 'function' wrapper)
 * - SSE events use different event names (response.output_text.delta etc.)
 *
 * This format handles Codex models only. All other OpenAI models use OpenAIAPIFormat.
 */

import { mapToolChoiceToResponsesAPI } from "../handlers/shared/format/openai-tools.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";
import {
  type AdapterResult,
  BaseAPIFormat,
  type EffortLevel,
  matchesModelFamily,
} from "./base-api-format.js";
import { reasoningForCall } from "./reasoning-cache.js";

/**
 * Normalize model name for ChatGPT backend API.
 *
 * The ChatGPT backend accepts most model names directly. This function only
 * strips provider prefixes to avoid passing "cx@gpt-5" or "openai/gpt-5" style
 * names to the API.
 *
 * @param modelId - Original model name (e.g., "gpt-4.5", "cx@gpt-4.5", "openai/gpt-5-codex")
 * @returns Normalized model name for the ChatGPT backend
 */
export function normalizeCodexModel(modelId: string | undefined): string {
  if (!modelId) return "gpt-5.2";

  // Strip provider prefix if present (e.g., "cx@gpt-4.5" → "gpt-4.5", "openai/gpt-5-codex" → "gpt-5-codex")
  const strippedModel = modelId.includes("@")
    ? modelId.split("@").pop()!
    : modelId.includes("/")
      ? modelId.split("/").pop()!
      : modelId;

  return strippedModel.trim();
}

export class CodexAPIFormat extends BaseAPIFormat {
  /**
   * `false` builds the GENERIC Responses body every Responses connection
   * accepts (catalog 3.7.0 R8): no `store`, no `include`. Those two are ChatGPT
   * Codex behaviour and stay on the Codex subscription only. The output limit,
   * reasoning and verbosity are not this body's business on a catalog
   * connection either: the wire shaper (`ComposedHandler` step 5w) removes what
   * is written here and writes what the connection publishes.
   */
  private readonly codexExtras: boolean;

  constructor(modelId: string, wireFormat?: StreamFormat, options: { codexExtras?: boolean } = {}) {
    super(modelId, wireFormat);
    this.codexExtras = options.codexExtras ?? true;
  }

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  shouldHandle(modelId: string): boolean {
    // Two valid Codex naming patterns:
    //  - prefix:  "codex", "codex-mini", "openai/codex-foo"
    //  - suffix:  "gpt-5-codex", "gpt-5.2-codex", "openai/gpt-5-codex"
    // The suffix form is what the openai-codex provider's nativeModelPatterns
    // matches (/codex$/i), so the format adapter must agree — otherwise the
    // request gets routed to the Codex /v1/responses endpoint but shaped as
    // a Chat Completions body, which the server 400s.
    if (matchesModelFamily(modelId, "codex")) return true;
    const lower = modelId.toLowerCase();
    return /(^|\/)[a-z0-9.+-]*-codex$/.test(lower);
  }

  getName(): string {
    return "CodexAPIFormat";
  }

  override getStreamFormat(): StreamFormat {
    return "openai-responses-sse";
  }

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const convertedMessages = this.convertMessagesToResponsesAPI(messages);
    const replayedReasoning = convertedMessages.filter((i: any) => i.type === "reasoning").length;
    if (replayedReasoning > 0) {
      log(`[CodexAPIFormat] replaying ${replayedReasoning} cached reasoning item(s)`);
    }
    const normalizedModel = normalizeCodexModel(this.modelId);

    // Strip IDs from message items (stateless mode doesn't support server-side state)
    const strippedMessages = convertedMessages.map((item: any) => {
      const { id, ...rest } = item;
      return rest;
    });

    // BUG FIX: this used to hardcode reasoning.effort = "medium", ignoring
    // Claude Code's effort signal entirely. Now read it and clamp per the
    // Codex (Responses API) model gates; default stays "medium" when absent.
    const effort = this.resolveCodexEffort(claudeRequest);

    const payload: any = {
      model: normalizedModel,
      input: strippedMessages,
      stream: true,
      ...(this.codexExtras ? { store: false, include: ["reasoning.encrypted_content"] } : {}),
      reasoning: {
        effort,
        summary: "auto",
      },
      text: {
        verbosity: "medium",
      },
    };

    if (claudeRequest.system) {
      payload.instructions = claudeRequest.system;
    }

    if (claudeRequest.max_tokens) {
      // Codex API doesn't support max_tokens - use default
      // payload.max_tokens = Math.max(16, claudeRequest.max_tokens);
    }

    if (tools.length > 0) {
      payload.tools = tools.map((tool: any) => {
        if (tool.type === "function" && tool.function) {
          return {
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          };
        }
        return tool;
      });

      // The Responses API spells tool_choice as Chat Completions does, except
      // that the function form is flat. Gated on there being tools, for the
      // same reason Gemini is.
      const toolChoice = mapToolChoiceToResponsesAPI(claudeRequest.tool_choice);
      if (toolChoice !== undefined) {
        payload.tool_choice = toolChoice;
      }
    }

    return payload;
  }

  // ─── Private helpers ───────────────────────────────────────────────

  /**
   * Resolve Claude Code's effort signal to a Codex Responses-API
   * `reasoning.effort` value. Codex models accept the OpenAI set
   * `none | low | medium | high | xhigh` but NOT `minimal` (codex drops it)
   * and `max` doesn't exist (ceiling is xhigh). `xhigh` is documented only on
   * gpt-5.1-codex-max. `none` is valid on the gpt-5.1-codex family.
   *
   * Default is "medium" when Claude Code sends no effort signal (the historical
   * Codex default — preserved so behavior is unchanged for non-effort requests).
   */
  private resolveCodexEffort(claudeRequest: any): string {
    const level = this.resolveEffortLevel(claudeRequest);
    if (!level) return "medium"; // historical default

    const value = this.clampCodexEffort(level);
    log(`[CodexAPIFormat] reasoning.effort -> ${value} (from ${level}) for ${this.modelId}`);
    return value;
  }

  /** gpt-5.1-codex-max (and later codex-max), plus the gpt-5.6 family —
   *  the models accepting xhigh on the Responses API. */
  private acceptsXhigh(): boolean {
    const m = this.modelId.toLowerCase();
    return /codex.*max/.test(m) || /gpt-5\.6/.test(m);
  }

  /** gpt-5.6 family — first OpenAI models with a native `max` effort
   *  (catalog-confirmed: efforts=[max,xhigh,high,medium,low,none]). */
  private acceptsMax(): boolean {
    return /gpt-5\.6/.test(this.modelId.toLowerCase());
  }

  /** gpt-5.1+ codex family and the gpt-5.6 family — accept `none`. */
  private isCodex51Plus(): boolean {
    const m = this.modelId.toLowerCase();
    return /gpt-5\.[1-9].*codex/.test(m) || /gpt-5\.6/.test(m);
  }

  private clampCodexEffort(level: EffortLevel): string {
    switch (level) {
      case "none":
        // `none` valid on the gpt-5.1-codex family; older codex → low.
        return this.isCodex51Plus() ? "none" : "low";
      case "minimal":
        return "low"; // codex drops `minimal`
      case "low":
      case "medium":
      case "high":
        return level;
      case "xhigh":
        return this.acceptsXhigh() ? "xhigh" : "high";
      case "max":
        // gpt-5.6 takes native max; older codex has no max → xhigh/high.
        if (this.acceptsMax()) return "max";
        return this.acceptsXhigh() ? "xhigh" : "high";
      default:
        return "medium";
    }
  }

  /**
   * Convert Chat Completions format messages to Responses API format.
   * System messages go to 'instructions' field (handled by buildPayload).
   */
  private convertMessagesToResponsesAPI(messages: any[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue; // Goes to instructions field

      if (msg.role === "tool") {
        result.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        });
        continue;
      }

      if (msg.role === "assistant" && msg.tool_calls) {
        if (msg.content) {
          const textContent =
            typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          if (textContent) {
            result.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: textContent }],
            });
          }
        }
        for (const toolCall of msg.tool_calls) {
          if (toolCall.type === "function") {
            // Replay the reasoning that produced this call, immediately before
            // it — OpenAI's guidance is to pass reasoning items back alongside
            // function outputs so the model continues its chain of thought
            // instead of re-deriving it (see reasoning-cache.ts for the measured
            // ~6x reduction in reasoning tokens).
            const reasoning = reasoningForCall(toolCall.id);
            if (reasoning?.length) result.push(...reasoning);

            result.push({
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
              status: "completed",
            });
          }
        }
        continue;
      }

      if (typeof msg.content === "string") {
        result.push({
          type: "message",
          role: msg.role,
          content: [
            {
              type: msg.role === "user" ? "input_text" : "output_text",
              text: msg.content,
            },
          ],
        });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const convertedContent = msg.content.map((block: any) => {
          if (block.type === "text") {
            return {
              type: msg.role === "user" ? "input_text" : "output_text",
              text: block.text,
            };
          }
          if (block.type === "image_url") {
            const imageUrl =
              typeof block.image_url === "string"
                ? block.image_url
                : block.image_url?.url || block.image_url;
            return { type: "input_image", image_url: imageUrl };
          }
          return block;
        });
        result.push({ type: "message", role: msg.role, content: convertedContent });
        continue;
      }

      if (msg.role) {
        result.push({ type: "message", ...msg });
      } else {
        result.push(msg);
      }
    }

    return result;
  }
}

// Backward-compatible alias
/** @deprecated Use CodexAPIFormat */
export { CodexAPIFormat as CodexAdapter };
