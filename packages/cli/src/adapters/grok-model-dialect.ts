/**
 * GrokModelDialect — Layer 2 dialect for xAI Grok models.
 *
 * Translates xAI XML function calls to Claude Code tool_calls:
 * <xai:function_call name="ToolName">
 *   <xai:parameter name="param1">value1</xai:parameter>
 *   <xai:parameter name="param2">value2</xai:parameter>
 * </xai:function_call>
 *
 * This dialect translates that to Claude Code's expected tool_calls format.
 */

import { log } from "../logger.js";
import {
  type AdapterResult,
  BaseAPIFormat,
  type EffortLevel,
  type ToolCall,
  matchesModelFamily,
} from "./base-api-format.js";
import {
  acceptsReasoningEffort,
  acceptsReasoningEffortValue,
  fallbackReasoningEffortValue,
  isReasoningEffortRejection,
  rejectedReasoningEffortValue,
  rememberReasoningEffortRejected,
  rememberReasoningEffortValueRejected,
} from "./grok-effort-support.js";
import { lookupModel } from "./model-catalog.js";

export class GrokModelDialect extends BaseAPIFormat {
  private xmlBuffer = "";

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    // Accumulate text to handle XML split across multiple chunks
    this.xmlBuffer += textContent;

    // Pattern to match complete xAI function calls
    const xmlPattern = /<xai:function_call name="([^"]+)">(.*?)<\/xai:function_call>/gs;
    const matches = [...this.xmlBuffer.matchAll(xmlPattern)];

    if (matches.length === 0) {
      // No complete XML function calls found yet
      // Check if we have a partial XML opening tag
      const hasPartialXml = this.xmlBuffer.includes("<xai:function_call");

      if (hasPartialXml) {
        // Keep accumulating, don't send text yet
        return {
          cleanedText: "",
          extractedToolCalls: [],
          wasTransformed: false,
        };
      }

      // Normal text, not XML
      const result = {
        cleanedText: this.xmlBuffer,
        extractedToolCalls: [],
        wasTransformed: false,
      };
      this.xmlBuffer = ""; // Clear buffer
      return result;
    }

    // Extract tool calls from XML
    const toolCalls: ToolCall[] = matches.map((match) => {
      const toolName = match[1];
      const xmlParams = match[2];

      return {
        id: `grok_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: toolName,
        arguments: this.parseXmlParameters(xmlParams),
      };
    });

    // Remove XML from text and get any remaining content
    let cleanedText = this.xmlBuffer;
    for (const match of matches) {
      cleanedText = cleanedText.replace(match[0], "");
    }

    // Clear buffer for next chunk
    this.xmlBuffer = "";

    return {
      cleanedText: cleanedText.trim(),
      extractedToolCalls: toolCalls,
      wasTransformed: true,
    };
  }

  /**
   * Handle request preparation — map Claude Code's effort to xAI
   * `reasoning_effort`.
   *
   * Gating is OPTIMISTIC and self-healing (see `grok-effort-support.ts` for the
   * measurements). This replaced an allowlist that decided the unknown case by
   * stripping: correct for every model it named, and silently wrong for every
   * model xAI shipped afterwards. `grok-4.6` was the casualty — it accepts the
   * parameter, never received it, and therefore ran at the provider's default
   * (near-`high`) tier with no way for the user to turn it down.
   */
  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);

    if (effort) {
      const value = this.effortToReasoningEffort(effort);
      if (value) {
        request.reasoning_effort = value;
        log(`[GrokModelDialect] reasoning_effort -> ${value} (from ${effort}) for ${this.modelId}`);
      } else {
        log(
          `[GrokModelDialect] Model ${this.modelId} does not accept reasoning_effort — stripping.`
        );
        if (request.reasoning_effort !== undefined) delete request.reasoning_effort;
      }
    }

    // Always remove raw thinking object for Grok to avoid API errors.
    if (request.thinking) delete request.thinking;

    return request;
  }

  /**
   * Map a canonical effort level to a Grok `reasoning_effort` value, or
   * undefined when this model does NOT accept the param (→ strip).
   *
   * Gates, most authoritative first:
   *   1. `acceptsReasoningEffort` — does this model take the parameter at all?
   *      Live evidence, then the hosted catalog, then optimistic name rules.
   *   2. The catalog's advertised ladder — clamp into `efforts[]` rather than
   *      guess. This is what makes a NEW model work without a claudish release:
   *      grok-4.6 advertises `xhigh/high/medium/low` (no `none`) and grok-4.3
   *      advertises `none`, and both come from the catalog, not from source.
   *   3. `acceptsReasoningEffortValue` — a value the live API has rejected this
   *      session, which covers a catalog that is cold, stale, or absent.
   */
  private effortToReasoningEffort(effort: EffortLevel): string | undefined {
    if (!acceptsReasoningEffort(this.modelId)) {
      return undefined; // positive evidence of rejection → strip
    }

    let value: string;

    // CATALOG FIRST — same rule OpenAIAPIFormat follows, and for the same
    // measured reason: a name rule is wrong in both directions.
    const reasoning = this.lookupReasoningCapability();
    const clamped = reasoning ? this.clampToAdvertisedEffort(effort, reasoning) : undefined;
    if (clamped) {
      value = clamped;
    } else {
      const model = this.modelId.toLowerCase();
      // grok-3-mini tier: low | high only. A documented, still-accurate ladder
      // for a legacy family that the catalog has no entry for.
      const isMini = model.includes("mini");
      if (isMini) {
        switch (effort) {
          case "high":
          case "xhigh":
          case "max":
            value = "high";
            break;
          default:
            // none/minimal/low/medium → low (mini has no none/medium).
            value = "low";
        }
      } else {
        switch (effort) {
          case "none":
            value = "none";
            break;
          case "minimal":
          case "low":
            value = "low";
            break;
          case "medium":
            value = "medium";
            break;
          default:
            value = "high";
        }
      }
    }

    // Step down past any value this model has already rejected this session.
    // Bounded by fallbackReasoningEffortValue always moving toward less
    // reasoning and terminating at null.
    let guard = 0;
    while (!acceptsReasoningEffortValue(this.modelId, value) && guard++ < 8) {
      const next = fallbackReasoningEffortValue(value);
      if (!next) return undefined; // nothing weaker left → send no param at all
      value = next;
    }

    return value;
  }

  /**
   * Recover from an upstream 4xx that rejected our optional reasoning parameter.
   *
   * Returns a payload to retry ONCE, or null when the error is not a parameter
   * rejection we can act on. This is what makes the optimistic default safe: an
   * unknown model costs at most one recovered round-trip instead of silently
   * losing its effort control forever.
   *
   * Narrowness matters — `grok-4.20-multi-agent-0309` also 400s, but because
   * multi-agent models are not served on chat completions at all. Retrying that
   * without the parameter fails identically, so it must not match here.
   */
  override recoverFromRejection(
    payload: any,
    errorText: string
  ): { payload: any; note: string } | null {
    if (payload?.reasoning_effort !== undefined) {
      // Case 1: the model does not take the parameter at all → drop it for good.
      if (isReasoningEffortRejection(errorText)) {
        rememberReasoningEffortRejected(this.modelId);
        const next = { ...payload };
        delete next.reasoning_effort;
        return { payload: next, note: `dropped reasoning_effort for ${this.modelId}` };
      }

      // Case 2: the parameter is fine but this VALUE is not → step down one rung.
      const rejected = rejectedReasoningEffortValue(errorText);
      if (rejected) {
        rememberReasoningEffortValueRejected(this.modelId, rejected);
        const fallback = fallbackReasoningEffortValue(rejected);
        const next = { ...payload };
        if (fallback) {
          next.reasoning_effort = fallback;
          return {
            payload: next,
            note: `reasoning_effort "${rejected}" -> "${fallback}" for ${this.modelId}`,
          };
        }
        delete next.reasoning_effort;
        return { payload: next, note: `dropped unsupported reasoning_effort for ${this.modelId}` };
      }
    }

    // Not about reasoning_effort (or none was sent): let the base try its own
    // speculative parameters. Dropping this delegation would silently remove
    // stop/top_p recovery for every grok model.
    return super.recoverFromRejection(payload, errorText);
  }

  /**
   * Parse xAI parameter XML format to JSON arguments
   * Handles: <xai:parameter name="key">value</xai:parameter>
   */
  private parseXmlParameters(xmlContent: string): Record<string, any> {
    const params: Record<string, any> = {};
    const paramPattern = /<xai:parameter name="([^"]+)">([^<]*)<\/xai:parameter>/g;

    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical RegExp.exec() iteration idiom
    while ((match = paramPattern.exec(xmlContent)) !== null) {
      const paramName = match[1];
      const paramValue = match[2];

      // Try to parse as JSON (for objects/arrays), otherwise use as string
      try {
        params[paramName] = JSON.parse(paramValue);
      } catch {
        // Not valid JSON, use as string
        params[paramName] = paramValue;
      }
    }

    return params;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "grok") || modelId.toLowerCase().includes("x-ai/");
  }

  getName(): string {
    return "GrokModelDialect";
  }

  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  /**
   * Reset internal state (useful between requests).
   *
   * `super.reset()` is load-bearing: it mints this request's tool-name
   * bindings. Without it they accumulate for the life of the process, because
   * this override used to replace the base entirely — harmless while nothing
   * encoded names, not harmless now.
   */
  override reset(): void {
    super.reset();
    this.xmlBuffer = "";
  }
}

// Backward-compatible alias
/** @deprecated Use GrokModelDialect */
export { GrokModelDialect as GrokAdapter };
