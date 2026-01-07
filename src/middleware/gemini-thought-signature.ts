/**
 * Gemini Thought Signature Middleware
 *
 * Handles thought_signature persistence for Gemini 3 Pro models.
 *
 * Gemini 3 Pro requires thought_signatures to be preserved across requests:
 * 1. When Gemini responds with tool_calls, it includes thought_signatures
 * 2. These signatures MUST be included in subsequent requests when sending conversation history
 * 3. Missing signatures result in 400 validation errors
 *
 * This middleware:
 * - Extracts thought_signatures from Gemini responses (both streaming and non-streaming)
 * - Stores them in persistent in-memory cache
 * - Injects signatures into assistant tool_calls when building requests
 * - Injects signatures into tool result messages
 *
 * References:
 * - https://ai.google.dev/gemini-api/docs/thought-signatures
 * - https://openrouter.ai/docs/use-cases/reasoning-tokens#preserving-reasoning-blocks
 */

import { log, isLoggingEnabled, logStructured } from "../logger.js";
import type {
  ModelMiddleware,
  RequestContext,
  NonStreamingResponseContext,
  StreamChunkContext,
} from "./types.js";

export class GeminiThoughtSignatureMiddleware implements ModelMiddleware {
  readonly name = "GeminiThoughtSignature";

  /**
   * Persistent cache for Gemini reasoning details
   *
   * CRITICAL: Gemini 3 Pro requires the ENTIRE reasoning_details array to be preserved
   * and sent back in subsequent requests. Storing just thought_signatures is insufficient.
   *
   * Maps: assistant_message_id -> { reasoning_details: array, tool_call_ids: Set }
   */
  private persistentReasoningDetails = new Map<
    string,
    {
      reasoning_details: any[];
      tool_call_ids: Set<string>;
    }
  >();

  shouldHandle(modelId: string): boolean {
    return modelId.includes("gemini") || modelId.includes("google/");
  }

  onInit(): void {
    log("[Gemini] Thought signature middleware initialized");
  }

  /**
   * Before Request: Inject reasoning_details into assistant messages
   *
   * CRITICAL: Gemini 3 Pro requires the ENTIRE reasoning_details array to be preserved
   * in assistant messages. This is how OpenRouter communicates thought_signatures to Gemini.
   *
   * Modifies:
   * - Assistant messages with tool_calls: Add reasoning_details array
   */
  beforeRequest(context: RequestContext): void {
    if (this.persistentReasoningDetails.size === 0) {
      return; // No reasoning details to inject
    }

    if (isLoggingEnabled()) {
      logStructured("[Gemini] Injecting reasoning_details", {
        cacheSize: this.persistentReasoningDetails.size,
        messageCount: context.messages.length,
      });
    }

    let injected = 0;

    for (const msg of context.messages) {
      // Inject reasoning_details into assistant messages with tool_calls
      if (msg.role === "assistant" && msg.tool_calls) {
        // Find matching reasoning_details by checking tool_call_ids
        for (const [msgId, cached] of this.persistentReasoningDetails.entries()) {
          // Check if any tool_call_id matches
          const hasMatchingToolCall = msg.tool_calls.some((tc: any) =>
            cached.tool_call_ids.has(tc.id)
          );

          if (hasMatchingToolCall) {
            msg.reasoning_details = cached.reasoning_details;
            injected++;

            if (isLoggingEnabled()) {
              logStructured("[Gemini] Reasoning details added to assistant message", {
                message_id: msgId,
                reasoning_blocks: cached.reasoning_details.length,
                tool_calls: msg.tool_calls.length,
              });
            }
            break; // Only inject once per message
          }
        }

        if (!msg.reasoning_details && isLoggingEnabled()) {
          log(`[Gemini] WARNING: No reasoning_details found for assistant message with tool_calls`);
          log(`[Gemini] Tool call IDs: ${msg.tool_calls.map((tc: any) => tc.id).join(", ")}`);
        }
      }
    }

    if (isLoggingEnabled() && injected > 0) {
      logStructured("[Gemini] Signature injection complete", {
        injected,
        cacheSize: this.persistentReasoningDetails.size,
      });

      // DEBUG: Log the actual messages being sent to understand structure
      log("[Gemini] DEBUG: Messages after injection:");
      for (let i = 0; i < context.messages.length; i++) {
        const msg = context.messages[i];
        log(
          `[Gemini] Message ${i}: role=${msg.role}, has_content=${!!msg.content}, has_tool_calls=${!!msg.tool_calls}, tool_call_id=${msg.tool_call_id || "N/A"}`
        );
        if (msg.role === "assistant" && msg.tool_calls) {
          log(`  - Assistant has ${msg.tool_calls.length} tool call(s), content="${msg.content}"`);
          for (const tc of msg.tool_calls) {
            log(
              `    * Tool call: ${tc.id}, function=${tc.function?.name}, has extra_content: ${!!tc.extra_content}, has thought_signature: ${!!tc.extra_content?.google?.thought_signature}`
            );
            if (tc.extra_content) {
              log(`      extra_content keys: ${Object.keys(tc.extra_content).join(", ")}`);
              if (tc.extra_content.google) {
                log(`      google keys: ${Object.keys(tc.extra_content.google).join(", ")}`);
                log(
                  `      thought_signature length: ${tc.extra_content.google.thought_signature?.length || 0}`
                );
              }
            }
          }
        } else if (msg.role === "tool") {
          log(
            `  - Tool result: tool_call_id=${msg.tool_call_id}, has extra_content: ${!!msg.extra_content}`
          );
        }
      }
    }
  }

  /**
   * After Non-Streaming Response: Extract reasoning_details from response
   */
  afterResponse(context: NonStreamingResponseContext): void {
    const response = context.response;
    const message = response?.choices?.[0]?.message;

    if (!message) {
      return;
    }

    const reasoningDetails = message.reasoning_details || [];
    const toolCalls = message.tool_calls || [];

    if (reasoningDetails.length > 0 && toolCalls.length > 0) {
      // Generate a unique ID for this assistant message
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      // Extract tool_call_ids
      const toolCallIds = new Set(toolCalls.map((tc: any) => tc.id).filter(Boolean));

      // Store the full reasoning_details array
      this.persistentReasoningDetails.set(messageId, {
        reasoning_details: reasoningDetails,
        tool_call_ids: toolCallIds,
      });

      logStructured("[Gemini] Reasoning details saved (non-streaming)", {
        message_id: messageId,
        reasoning_blocks: reasoningDetails.length,
        tool_calls: toolCallIds.size,
        total_cached_messages: this.persistentReasoningDetails.size,
      });
    }
  }

  /**
   * After Stream Chunk: Accumulate reasoning_details from deltas
   *
   * CRITICAL: Gemini sends reasoning_details across multiple chunks.
   * We need to accumulate the FULL array to preserve for the next request.
   */
  afterStreamChunk(context: StreamChunkContext): void {
    const delta = context.delta;
    if (!delta) return;

    // Accumulate reasoning_details from this chunk
    if (delta.reasoning_details && delta.reasoning_details.length > 0) {
      if (!context.metadata.has("reasoning_details")) {
        context.metadata.set("reasoning_details", []);
      }
      const accumulated = context.metadata.get("reasoning_details");
      accumulated.push(...delta.reasoning_details);

      if (isLoggingEnabled()) {
        logStructured("[Gemini] Reasoning details accumulated", {
          chunk_blocks: delta.reasoning_details.length,
          total_blocks: accumulated.length,
        });
      }
    }

    // Track tool_call_ids for associating with reasoning_details
    if (delta.tool_calls) {
      if (!context.metadata.has("tool_call_ids")) {
        context.metadata.set("tool_call_ids", new Set());
      }
      const toolCallIds = context.metadata.get("tool_call_ids");
      for (const tc of delta.tool_calls) {
        if (tc.id) {
          toolCallIds.add(tc.id);
        }
      }
    }
  }

  /**
   * After Stream Complete: Save accumulated reasoning_details to persistent cache
   */
  afterStreamComplete(metadata: Map<string, any>): void {
    const reasoningDetails = metadata.get("reasoning_details") || [];
    const toolCallIds = metadata.get("tool_call_ids") || new Set();

    if (reasoningDetails.length > 0 && toolCallIds.size > 0) {
      // Generate a unique ID for this assistant message
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      // Store the full reasoning_details array with associated tool_call_ids
      this.persistentReasoningDetails.set(messageId, {
        reasoning_details: reasoningDetails,
        tool_call_ids: toolCallIds,
      });

      logStructured("[Gemini] Streaming complete - reasoning details saved", {
        message_id: messageId,
        reasoning_blocks: reasoningDetails.length,
        tool_calls: toolCallIds.size,
        total_cached_messages: this.persistentReasoningDetails.size,
      });
    }
  }
}
