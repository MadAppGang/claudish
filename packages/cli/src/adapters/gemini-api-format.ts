/**
 * GeminiAPIFormat — Layer 1 wire format for Google Gemini generateContent API.
 *
 * Handles Gemini-specific transformations:
 * - Message conversion: Claude → Gemini parts format (user→user, assistant→model)
 * - Tool conversion: Claude tools → Gemini function declarations
 * - Payload building: generationConfig, systemInstruction, thinkingConfig
 * - thoughtSignature tracking across requests (required for Gemini 3/2.5 thinking)
 *
 * Visible text is NOT filtered — see processTextContent for why the old
 * regex-based reasoning stripper was removed.
 *
 * Used with GeminiProviderTransport (direct API) and AntigravityProviderTransport (OAuth).
 */

import { mapToolChoiceToGemini } from "../handlers/shared/format/openai-tools.js";
import { convertToolsToGemini } from "../handlers/shared/gemini-schema.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";
import {
  type AdapterResult,
  BaseAPIFormat,
  type EffortLevel,
  matchesModelFamily,
} from "./base-api-format.js";

export class GeminiAPIFormat extends BaseAPIFormat {
  /**
   * Map of tool_use_id → { name, thoughtSignature }.
   * Persists across requests (NOT cleared in reset) because Gemini requires
   * thoughtSignatures from previous responses to be echoed back in subsequent requests.
   */
  private toolCallMap = new Map<string, { name: string; thoughtSignature?: string }>();

  // ─── Message Conversion (Claude → Gemini parts) ─────────────────

  override convertMessages(claudeRequest: any, _filterIdentityFn?: (s: string) => string): any[] {
    const messages: any[] = [];

    if (claudeRequest.messages) {
      for (const msg of claudeRequest.messages) {
        if (msg.role === "user") {
          const parts = this.convertUserParts(msg);
          if (parts.length > 0) messages.push({ role: "user", parts });
        } else if (msg.role === "assistant") {
          const parts = this.convertAssistantParts(msg);
          if (parts.length > 0) messages.push({ role: "model", parts });
        }
      }
    }

    return messages;
  }

  private convertUserParts(msg: any): any[] {
    const parts: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
        } else if (block.type === "tool_result") {
          const toolInfo = this.toolCallMap.get(block.tool_use_id);
          if (!toolInfo) {
            log(
              `[GeminiAPIFormat] Warning: No function name found for tool_use_id ${block.tool_use_id}`
            );
            continue;
          }

          // Extract images from array content and send as separate inlineData parts.
          // Claude sends tool_results like browser_screenshot as [{type:"text",...},{type:"image",...}].
          // Gemini can't interpret images embedded in a JSON string — they need inlineData parts.
          if (Array.isArray(block.content)) {
            const textParts: string[] = [];
            const imageParts: any[] = [];

            for (const item of block.content) {
              if (item.type === "image" && item.source?.data) {
                imageParts.push({
                  inlineData: {
                    mimeType: item.source.media_type,
                    data: item.source.data,
                  },
                });
              } else if (item.type === "text") {
                textParts.push(item.text);
              }
            }

            parts.push({
              functionResponse: {
                name: toolInfo.name,
                response: {
                  content: textParts.join("\n") || "OK",
                },
              },
            });

            // Append image parts after the functionResponse
            parts.push(...imageParts);
          } else {
            parts.push({
              functionResponse: {
                name: toolInfo.name,
                response: {
                  content:
                    typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content),
                },
              },
            });
          }
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }

    return parts;
  }

  private convertAssistantParts(msg: any): any[] {
    const parts: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          // Look up stored thoughtSignature for this tool call
          const toolInfo = this.toolCallMap.get(block.id);
          let thoughtSignature = toolInfo?.thoughtSignature;

          // If no signature found, use dummy to skip validation.
          // Required for Gemini 3/2.5 with thinking enabled.
          // Handles session recovery, migrations, or first request with history.
          if (!thoughtSignature) {
            thoughtSignature = "skip_thought_signature_validator";
            log(
              `[GeminiAPIFormat] Using dummy thoughtSignature for tool ${block.name} (${block.id})`
            );
          }

          const functionCallPart: any = {
            functionCall: {
              name: block.name,
              args: block.input,
            },
          };

          if (thoughtSignature) {
            functionCallPart.thoughtSignature = thoughtSignature;
          }

          // Ensure tool is tracked in our map (for tool_result lookups)
          if (!this.toolCallMap.has(block.id)) {
            this.toolCallMap.set(block.id, { name: block.name, thoughtSignature });
          }

          parts.push(functionCallPart);
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }

    return parts;
  }

  // ─── Tool Conversion ──────────────────────────────────────────────

  override convertTools(claudeRequest: any, _summarize = false): any[] {
    const result = convertToolsToGemini(claudeRequest.tools);
    return result || [];
  }

  // ─── Payload Building ─────────────────────────────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      contents: messages,
      generationConfig: {
        temperature: claudeRequest.temperature ?? 1,
        maxOutputTokens: claudeRequest.max_tokens,
      },
    };

    // System instruction
    if (claudeRequest.system) {
      let systemContent = Array.isArray(claudeRequest.system)
        ? claudeRequest.system.map((i: any) => i.text || i).join("\n\n")
        : claudeRequest.system;

      // Gemini-specific reasoning suppression
      systemContent += `\n\nCRITICAL INSTRUCTION FOR OUTPUT FORMAT:
1. Keep ALL internal reasoning INTERNAL. Never output your thought process as visible text.
2. Do NOT start responses with phrases like "Wait, I'm...", "Let me think...", "Okay, so..."
3. Only output: final responses, tool calls, and code. Nothing else.`;

      payload.systemInstruction = { parts: [{ text: systemContent }] };
    }

    // Tools — convertTools returns Gemini format [{functionDeclarations: [...]}] or []
    if (tools && tools.length > 0) {
      payload.tools = tools;

      // `toolConfig` is Gemini's `tool_choice`, and this format had none at all
      // — every forced-tool turn ran as if the caller had said `auto`. Gated on
      // there being tools: a functionCallingConfig with nothing to call is a
      // request-level 400.
      const toolConfig = mapToolChoiceToGemini(claudeRequest.tool_choice);
      if (toolConfig) {
        payload.toolConfig = toolConfig;
        log(
          `[GeminiAPIFormat] toolConfig.mode -> ${toolConfig.functionCallingConfig.mode} for ${this.modelId}`
        );
      }
    }

    // Thinking/reasoning configuration.
    // output_config.effort (modern Claude Code) takes priority; the legacy
    // thinking.budget_tokens path is the fallback. Gemini 3 and Gemini 2.5 use
    // DIFFERENT controls — and Gemini 3 400s if both thinkingLevel and
    // thinkingBudget are sent, so we only ever emit one.
    const effort = this.resolveEffortLevel(claudeRequest);
    if (effort) {
      if (matchesModelFamily(this.modelId, "gemini-3")) {
        payload.generationConfig.thinkingConfig = {
          thinkingLevel: this.effortToThinkingLevel(effort),
        };
        log(
          `[GeminiAPIFormat] thinkingLevel -> ${payload.generationConfig.thinkingConfig.thinkingLevel} (from ${effort}) for ${this.modelId}`
        );
      } else {
        const budget = this.budgetWithinOutputCap(
          this.effortToThinkingBudget(effort),
          claudeRequest.max_tokens
        );
        if (budget === undefined) {
          log(
            `[GeminiAPIFormat] thinking omitted (from ${effort}): max_tokens ${claudeRequest.max_tokens} leaves no valid budget for ${this.modelId}`
          );
        } else {
          payload.generationConfig.thinkingConfig = { thinkingBudget: budget };
          log(`[GeminiAPIFormat] thinkingBudget -> ${budget} (from ${effort}) for ${this.modelId}`);
        }
      }
    } else if (claudeRequest.thinking) {
      // Legacy fallback: raw thinking.budget_tokens.
      const { budget_tokens } = claudeRequest.thinking;

      if (matchesModelFamily(this.modelId, "gemini-3")) {
        // Gemini 3 uses thinking_level
        payload.generationConfig.thinkingConfig = {
          thinkingLevel: budget_tokens >= 16000 ? "high" : "low",
        };
      } else {
        // Gemini 2.5 uses thinking_budget
        payload.generationConfig.thinkingConfig = {
          thinkingBudget: Math.min(budget_tokens, GeminiAPIFormat.MAX_GEMINI_BUDGET),
        };
      }
    }

    return payload;
  }

  /** Gemini 2.5 thinkingBudget ceiling (live API caps ~24576 even where docs say 32768). */
  private static readonly MAX_GEMINI_BUDGET = 24576;

  /** Anthropic's smallest accepted `thinking.budget_tokens`. */
  private static readonly MIN_CLAUDE_BUDGET = 1024;

  /**
   * Keep a Claude model's thinking budget below its output cap.
   *
   * Antigravity serves Claude through this Gemini-shaped request and hands the
   * budget to Anthropic, which requires `budget_tokens < max_tokens` and
   * `budget_tokens >= 1024`. The effort tiers ignore max_tokens, so a user who
   * lowers CLAUDE_CODE_MAX_OUTPUT_TOKENS got a 400 on every turn: max_tokens
   * 16000 with effort high (budget 16384), and 8000 with effort medium (8192),
   * both returned "`max_tokens` must be greater than `thinking.budget_tokens`"
   * (measured 2026-09-19 on claude-sonnet-4-6).
   *
   * An over-cap budget becomes half of max_tokens, not max_tokens - 1: the budget
   * shares the cap with the visible answer, and a budget one token under the cap
   * is valid but can leave the answer nothing. Returns undefined when half the
   * cap is under Anthropic's minimum, and the caller then sends no thinking config.
   *
   * Gemini models are returned unchanged: none was measured to enforce this.
   */
  private budgetWithinOutputCap(budget: number, maxTokens: unknown): number | undefined {
    if (!this.modelId.toLowerCase().startsWith("claude")) return budget;
    if (typeof maxTokens !== "number" || budget < maxTokens) return budget;
    const fitted = Math.floor(maxTokens / 2);
    return fitted >= GeminiAPIFormat.MIN_CLAUDE_BUDGET ? fitted : undefined;
  }

  /**
   * Gemini 3 `thinkingLevel` (string). Accepted values: minimal | low | medium |
   * high. Note: original Gemini 3 Pro lacks `minimal` (→low) and `medium`
   * (→high); we emit the documented level and let model-specific gates degrade.
   */
  private effortToThinkingLevel(effort: EffortLevel): string {
    switch (effort) {
      case "none":
      case "minimal":
        return "minimal";
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
      case "xhigh":
      case "max":
        return "high";
      default:
        return "high";
    }
  }

  /**
   * Gemini 2.5 `thinkingBudget` (int). 0 = off (Flash/Lite only; Pro min 128,
   * can't disable). Token tiers per the research §4.3, capped at MAX_GEMINI_BUDGET.
   */
  private effortToThinkingBudget(effort: EffortLevel): number {
    switch (effort) {
      case "none":
      case "minimal":
        return 0;
      case "low":
        return 1024;
      case "medium":
        return 8192;
      case "high":
        return 16384;
      case "xhigh":
      case "max":
        return GeminiAPIFormat.MAX_GEMINI_BUDGET; // 24576
      default:
        return 8192;
    }
  }

  // ─── Tool Call Registration (called by stream parser) ─────────────

  /**
   * Register a tool call from the streaming response.
   * Stores the tool ID, name, and thoughtSignature for use in subsequent requests.
   */
  registerToolCall(toolId: string, name: string, thoughtSignature?: string): void {
    this.toolCallMap.set(toolId, { name, thoughtSignature });
    if (thoughtSignature) {
      log(`[GeminiAPIFormat] Captured thoughtSignature for tool ${name} (${toolId})`);
    }
  }

  // ─── Text Processing (reasoning filter) ───────────────────────────

  /**
   * Visible text passes through UNCHANGED.
   *
   * This used to run 35 regexes over the model's prose to strip "leaked"
   * reasoning ("Wait, I'm...", "Let me think...", "Okay, so..."). That was a
   * real fix in Dec 2025 (commit 523c0e4, the "Wait, I'm scaling tools" loop):
   * Gemini 2.x had no reasoning channel and no thinking budget, so it reasoned
   * in the only channel it had — the answer.
   *
   * Both conditions are gone:
   *  1. `thinkingConfig` (buildPayload below, added 9 days later in 2b0064d)
   *     gives the model a real place to think, which is what actually stops
   *     the leak. Prevention, not post-hoc deletion. NOTE this applies to the
   *     direct `g@`/`ag@` paths only — `or@gemini-*` builds its payload in
   *     OpenRouterAPIFormat and never reaches this buildPayload, so there the
   *     protection is OpenRouter's own reasoning handling, not this.
   *  2. Reasoning no longer arrives as visible text. Gemini 3.x returns it as
   *     an opaque `thoughtSignature` on a part whose `text` is "" — measured
   *     on a real capture: `thoughtsTokenCount: 57` with zero reasoning text
   *     on the wire. gemini-sse.ts consumes that signature only to echo it
   *     back on tool calls; there is no reasoning text to strip. (A
   *     `thought: true` flag would carry text, but only if `includeThoughts`
   *     were requested, and claudish never sets it.)
   *
   * And the filter could not be made correct: it asked "is this string
   * reasoning or an answer?", but for a reply like "OK" that bit does not
   * exist in the string. It deleted `"OK"`, `"Okay"`, `"Hmmm, ...anything"`
   * and any line opening `"First, I..."` — returning an EMPTY text block,
   * which the stream parser could not distinguish from "no output", so the
   * turn completed successfully with a blank answer and exit code 0.
   */
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return { cleanedText: textContent, extractedToolCalls: [], wasTransformed: false };
  }

  // ─── Format metadata ─────────────────────────────────────────────

  override getStreamFormat(): StreamFormat {
    return "gemini-sse";
  }

  /**
   * No per-request state to reset since the reasoning filter was removed.
   * NOTE: toolCallMap is intentionally NOT cleared — it persists across requests
   * because Gemini requires thoughtSignatures from previous responses.
   */
  override reset(): void {
    // Do NOT clear toolCallMap or toolNameMap
  }

  override getContextWindow(): number {
    return 1_048_576; // Gemini models have 1M context (2^20 tokens)
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "gemini") || modelId.toLowerCase().includes("google/");
  }

  getName(): string {
    return "GeminiAPIFormat";
  }

  /**
   * Extract thought signatures from reasoning_details (OpenRouter path).
   * Not used in the native Gemini path — only relevant when Gemini models
   * are accessed through OpenRouter which translates to OpenAI format.
   */
  extractThoughtSignaturesFromReasoningDetails(
    reasoningDetails: any[] | undefined
  ): Map<string, string> {
    const extracted = new Map<string, string>();
    if (!reasoningDetails || !Array.isArray(reasoningDetails)) return extracted;

    for (const detail of reasoningDetails) {
      if (detail?.type === "reasoning.encrypted" && detail.id && detail.data) {
        this.toolCallMap.set(detail.id, {
          name: this.toolCallMap.get(detail.id)?.name || "",
          thoughtSignature: detail.data,
        });
        extracted.set(detail.id, detail.data);
      }
    }

    return extracted;
  }

  /** Get a thought signature for a specific tool call ID */
  getThoughtSignature(toolCallId: string): string | undefined {
    return this.toolCallMap.get(toolCallId)?.thoughtSignature;
  }

  /** Check if we have a thought signature for a tool call */
  hasThoughtSignature(toolCallId: string): boolean {
    return this.toolCallMap.has(toolCallId) && !!this.toolCallMap.get(toolCallId)?.thoughtSignature;
  }

  /** Get all stored thought signatures */
  getAllThoughtSignatures(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [id, info] of this.toolCallMap) {
      if (info.thoughtSignature) result.set(id, info.thoughtSignature);
    }
    return result;
  }
}

// Backward-compatible alias
/** @deprecated Use GeminiAPIFormat */
export { GeminiAPIFormat as GeminiAdapter };
