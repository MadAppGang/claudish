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
import { filterIdentity } from "../handlers/shared/openai-compat.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { type AdapterResult, BaseAPIFormat } from "./base-api-format.js";
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

  /** Never selected by model name: the connection's `wire.api` chooses Responses. */
  shouldHandle(_modelId: string): boolean {
    return false;
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
    // The ChatGPT Codex backend knows bare ids only; every other Responses host
    // gets the connection's exact wire id.
    const model = this.codexExtras ? normalizeCodexModel(this.modelId) : this.modelId;

    // Strip IDs from message items (stateless mode doesn't support server-side state)
    const strippedMessages = convertedMessages.map((item: any) => {
      const { id, ...rest } = item;
      return rest;
    });

    // No output limit, reasoning effort or verbosity here: on a catalog
    // connection those are the wire's (step 5w), and nothing else may choose
    // them. The old name-based effort ladder and its "medium" default are gone.
    const payload: any = {
      model,
      input: strippedMessages,
      stream: true,
      ...(this.codexExtras ? { store: false, include: ["reasoning.encrypted_content"] } : {}),
    };

    // Flattened (a block array joined with "\n\n", as the Chat Completions
    // converter does) and identity-filtered, as Gemini filters its system
    // instruction. Sent raw before, the field carried Claude Code's "You are
    // Claude Code, Anthropic's official CLI" identity to a non-Claude model;
    // the filtered system message convertMessages builds never reaches the
    // Responses payload (convertMessagesToResponsesAPI skips it).
    if (claudeRequest.system) {
      const system = Array.isArray(claudeRequest.system)
        ? claudeRequest.system
            .map((block: { text?: string } | string) =>
              typeof block === "string" ? block : block.text || ""
            )
            .join("\n\n")
        : claudeRequest.system;
      payload.instructions = filterIdentity(system);
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
