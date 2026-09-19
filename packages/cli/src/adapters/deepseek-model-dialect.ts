/**
 * DeepSeekModelDialect — Layer 2 dialect for DeepSeek models.
 *
 * Handles DeepSeek-specific quirks:
 * - V4 models (deepseek-v4-*, plus deepseek-chat/deepseek-reasoner as V4
 *   aliases) accept `reasoning_effort` (high|max only) + a `thinking` toggle.
 *   DeepSeek only honors high/max — low/medium remap UP to high; xhigh→max.
 * - Legacy (R1 / V3.x) models reason by model name with no knob → strip.
 */

import { log } from "../logger.js";
import { type AdapterResult, BaseAPIFormat, matchesModelFamily } from "./base-api-format.js";

export class DeepSeekModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * DeepSeek's OWN API reasoning knob — map Claude Code's effort to DeepSeek's
   * V4 controls, or strip on legacy models (which reason by model name only).
   *
   * Not called on the Anthropic wire. Measured 2026-08-02 against Alibaba's
   * Alibaba Token Plan endpoint (which serves deepseek-v4-*): a top-level
   * `reasoning_effort` is accepted with ANY value, including `"banana"` → 200,
   * i.e. it is not read at all there. BaseAPIFormat.applyAnthropicWireReasoning()
   * emits `output_config.effort` instead, clamped to the catalog's advertised
   * `["max","high"]` — which is the same remap this method hardcodes, but taken
   * from data.
   */
  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);

    if (effort && this.acceptsReasoningControls()) {
      if (effort === "none" || effort === "minimal") {
        // Disable thinking on V4+.
        request.thinking = { type: "disabled" };
        log(
          `[DeepSeekModelDialect] effort ${effort} -> thinking.type: disabled for ${this.modelId}`
        );
      } else {
        // CATALOG FIRST — the advertised ladder is data, not a guess. For
        // deepseek-v4 the catalog advertises ["max","high"], which is exactly
        // the remap below; taking it from the catalog means a future model that
        // advertises more rungs gets them without a code change.
        const reasoning = this.lookupReasoningCapability();
        const clamped =
          reasoning?.control === "effort" && reasoning.efforts?.length
            ? this.clampToAdvertisedEffort(effort, reasoning)
            : undefined;
        // Fallback ladder: DeepSeek honors only high|max — low/medium remap up
        // to high; xhigh→max.
        const value = clamped ?? (effort === "xhigh" || effort === "max" ? "max" : "high");
        request.reasoning_effort = value;
        log(
          `[DeepSeekModelDialect] effort ${effort} -> reasoning_effort: ${value} for ${this.modelId}`
        );
      }
      return request;
    }

    // Legacy DeepSeek (R1 / V3.x) or no effort signal: strip any raw thinking
    // object — the API rejects it (reasoning is model-name driven).
    if (request.thinking) {
      log(`[DeepSeekModelDialect] Stripping thinking object (not supported by ${this.modelId})`);
      delete request.thinking;
    }

    return request;
  }

  /**
   * Whether this DeepSeek model accepts explicit reasoning controls.
   *
   * A RULE (v4 or newer), not a pinned version. The previous gate tested
   * `includes("v4")`, which silently drops the user's effort setting the day
   * DeepSeek ships v5 — the same failure that hid grok-4.6's uncontrolled
   * reasoning, where an id postdating a hardcoded gate produced no error, no
   * log, and no symptom other than the model behaving differently than asked.
   *
   * Order matters: the catalog decides when it has an opinion, because it is
   * hosted and updates without a claudish release. The name rule below is the
   * cold-cache fallback.
   *
   * Legacy R1 / V3.x keep stripping — they reason by model name with no knob.
   */
  private acceptsReasoningControls(): boolean {
    const reasoning = this.lookupReasoningCapability();
    if (reasoning) return reasoning.supported === true && reasoning.control === "effort";

    const model = this.modelId.toLowerCase();
    // deepseek-chat / deepseek-reasoner are the moving aliases; they currently
    // point at V4-Flash (non-thinking / thinking).
    if (model.includes("deepseek-chat") || model.includes("deepseek-reasoner")) return true;
    // Any explicit version >= 4, so v5/v6/... work on arrival.
    const version = /(?:^|[^a-z0-9])v(\d+)/.exec(model);
    return version ? Number(version[1]) >= 4 : false;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "deepseek");
  }

  getName(): string {
    return "DeepSeekModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use DeepSeekModelDialect */
export { DeepSeekModelDialect as DeepSeekAdapter };
