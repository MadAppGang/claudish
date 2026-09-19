/**
 * GLMModelDialect — Layer 2 dialect for Zhipu AI GLM models.
 *
 * Handles GLM-specific quirks:
 * - Context window sizes per model variant (sourced from model-catalog.ts)
 * - Reasoning knob driven by the catalog: `control: "toggle"` → the
 *   `thinking:{type}` switch, `control: "effort"` (GLM-5.2 only, today) → the
 *   switch plus a clamped `reasoning_effort`. Pre-4.5 SKUs (glm-4, glm-4-plus,
 *   chatglm-*) reject `thinking` entirely → strip.
 * - Vision support detection (sourced from model-catalog.ts)
 */

import { log } from "../logger.js";
import { type AdapterResult, BaseAPIFormat, matchesModelFamily } from "./base-api-format.js";
import { type ReasoningCapability, lookupModel } from "./model-catalog.js";

export class GLMModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * GLM's OWN (Zhipu OpenAI-compatible) reasoning knob. This IS the path taken
   * by `glm@` AND by `gc@` (GLM Coding Plan): both map to glmProfile, i.e.
   * OpenAIProviderTransport + OpenAIAPIFormat — `gc@` just points at
   * /api/coding/paas/v4/chat/completions. Easy to get wrong, because `gc@` and
   * `zai@` both serve Z.AI GLM models; they differ in the WIRE, not the vendor.
   *
   * Not called on the Anthropic wire, which is `zai@` (z-ai →
   * anthropicCompatProfile, /api/anthropic/v1/messages) and `qtoken@glm-5.2` (Qwen
   * Plan, also anthropicCompatProfile, serves GLM alongside Qwen). There
   * BaseAPIFormat.applyAnthropicWireReasoning() takes over.
   *
   * ## Why this is catalog-driven and not a name test
   *
   * This used to gate the toggle on `/glm-4\.[56]/`, which was correct when
   * GLM-4.6 was the newest GLM and silently wrong from GLM-4.7 onward: every
   * later model failed the test, so its `thinking` object was STRIPPED and no
   * knob was sent at all. Measured on `gc@glm-5.2` before the fix — every one
   * of none/minimal/low/high/max produced an empty payload, which means the
   * user could not turn thinking off and could not ask for less of it; the
   * model simply ran at its own default (Max for 5.2).
   *
   * The catalog knows which models reason and how (`control: "toggle"` vs
   * `"effort"`), so ask it. GLM-5.2 is currently the only GLM with a
   * `reasoning_effort` parameter — that is a fact about the model, and it
   * belongs in the catalog, not in a regex here.
   */
  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);
    const reasoning = this.lookupReasoningCapability();

    if (effort && this.acceptsThinkingToggle(reasoning)) {
      if (effort === "none" || effort === "minimal") {
        request.thinking = { type: "disabled" };
        // Never leave a depth knob contradicting the off-switch.
        if (request.reasoning_effort !== undefined) delete request.reasoning_effort;
        log(`[GLMModelDialect] effort ${effort} -> thinking.type: disabled for ${this.modelId}`);
        return request;
      }

      request.thinking = { type: "enabled" };

      // A gradation knob only where the catalog says the model has one. GLM
      // takes OpenAI's `reasoning_effort` spelling on this wire, clamped into
      // the advertised set — the endpoint ACCEPTS all seven canonical levels
      // regardless, so an unclamped level would be silently misread.
      if (reasoning?.control === "effort" && reasoning.efforts?.length) {
        const level = this.clampToAdvertisedEffort(effort, reasoning);
        if (level) request.reasoning_effort = level;
        log(
          `[GLMModelDialect] effort ${effort} -> thinking: enabled, reasoning_effort: ${level ?? "(none advertised)"} for ${this.modelId} (advertised: ${reasoning.efforts.join("/")})`
        );
        return request;
      }

      log(`[GLMModelDialect] effort ${effort} -> thinking.type: enabled for ${this.modelId}`);
      return request;
    }

    // No effort signal, or a model that rejects `thinking` outright (glm-4,
    // glm-4-plus, chatglm-*): strip any raw thinking object.
    if (request.thinking) {
      log(`[GLMModelDialect] Stripping thinking object (not supported by ${this.modelId})`);
      delete request.thinking;
    }

    return request;
  }

  /**
   * Whether this model accepts the `thinking:{type}` toggle.
   *
   * The catalog is the authority. `lookupModelReasoning` returns undefined on a
   * COLD CACHE as well as for a genuinely unknown model, and its contract says
   * callers must then keep their existing behaviour — so the version rule below
   * is the fallback, never the primary.
   */
  private acceptsThinkingToggle(reasoning: ReasoningCapability | undefined): boolean {
    if (reasoning) return reasoning.supported !== false;
    return this.looksLikeThinkingCapableGlm();
  }

  /**
   * Cold-cache fallback: GLM-4.5 and newer accept the `thinking` toggle; the
   * pre-4.5 SKUs (glm-4, glm-4-plus, glm-4v, chatglm-*) reject it.
   *
   * Deliberately a RULE about version ordering rather than a list of ids, so a
   * GLM released tomorrow is handled correctly instead of silently falling into
   * the legacy branch — which is exactly how the old `/glm-4\.[56]/` test broke
   * on GLM-4.7.
   *
   * A vendor prefix is stripped first (`zhipu/glm-4.6`, `openrouter` style), so
   * this stays as wide as the unanchored regex it replaces.
   */
  private looksLikeThinkingCapableGlm(): boolean {
    const bare = this.modelId.toLowerCase().split("/").pop() ?? "";
    const match = /^glm-(\d+)(?:\.(\d+))?/.exec(bare);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = match[2] === undefined ? 0 : Number(match[2]);
    return major > 4 || (major === 4 && minor >= 5);
  }

  shouldHandle(modelId: string): boolean {
    return (
      matchesModelFamily(modelId, "glm-") ||
      matchesModelFamily(modelId, "chatglm-") ||
      modelId.toLowerCase().includes("zhipu/")
    );
  }

  getName(): string {
    return "GLMModelDialect";
  }

  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  override supportsVision(): boolean {
    return lookupModel(this.modelId)?.supportsVision ?? false;
  }
}

// Backward-compatible alias
/** @deprecated Use GLMModelDialect */
export { GLMModelDialect as GLMAdapter };
