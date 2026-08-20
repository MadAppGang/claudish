/**
 * GLMModelDialect — Layer 2 dialect for Zhipu AI GLM models.
 *
 * Handles GLM-specific quirks:
 * - Context window sizes per model variant (sourced from model-catalog.ts)
 * - Thinking control via CLAUDISH_GLM_THINKING (see prepareRequest)
 * - Vision support detection (sourced from model-catalog.ts)
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";
import type { PrepareRequestContext } from "./model-dialect.js";

type GlmThinkingPolicy = { kind: "passthrough" } | { kind: "disabled" };

// Read CLAUDISH_GLM_THINKING on every call rather than caching it (same
// rationale as QwenModelDialect): the fleet flips this during a budget
// crunch, and a cached value would need a restart of the proxy that is, at
// that exact moment, the thing keeping everyone working.
function readGlmThinkingPolicy(): GlmThinkingPolicy {
  const raw = (process.env.CLAUDISH_GLM_THINKING || "").trim().toLowerCase();
  if (raw === "disabled" || raw === "off" || raw === "false") return { kind: "disabled" };
  if (!raw || raw === "passthrough" || raw === "client" || raw === "default")
    return { kind: "passthrough" };
  log(`[GLMModelDialect] Unrecognized CLAUDISH_GLM_THINKING='${raw}', using 'passthrough'`);
  return { kind: "passthrough" };
}

export class GLMModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Thinking control, per wire.
   *
   * OpenAI wire (gc@ GLM Coding Plan — all fleet GLM traffic) — probed
   * 2026-08-20 against api.z.ai/api/coding/paas/v4/chat/completions on
   * glm-5.3, prompt "Reponds exactement: ok", max_tokens 500:
   *
   *   thinking absent            → 200, out 37, reasoning 131 chars (thinks by default)
   *   {"type":"enabled"}         → 200, out 41, reasoning 148 chars
   *   {"type":"disabled"}        → 200, out  3, reasoning   0 chars — the switch works
   *   enabled + budget_tokens    → 200, tolerated and ignored (GLM is binary,
   *                                unlike Qwen there is no budget control)
   *
   * The historical unconditional strip ("GLM doesn't support thinking params")
   * was a GLM-4.x-era artifact: it couldn't disable thinking in a crunch, and
   * it threw away the client's explicit ask. GLM thinking by default means
   * `passthrough` (the default) preserves today's effective behavior — the
   * policy's value is the `disabled` lever: 37→3 output tokens on a trivial
   * prompt when the Coding Plan's 5h window is burning.
   *
   *   passthrough (default) — forward the client's ask in the documented shape
   *                           (budget dropped: inert upstream); no ask, no field
   *   disabled              — force {"type":"disabled"} on every request
   *
   * Anthropic wire (zai@ direct): thinking behavior there is unprobed, so
   * passthrough keeps the historical strip rather than forwarding an
   * unverified field; only an explicit `disabled` policy sets anything.
   */
  override prepareRequest(request: any, originalRequest: any, ctx?: PrepareRequestContext): any {
    const policy = readGlmThinkingPolicy();

    if (ctx?.wireFormat === "anthropic-sse") {
      if (policy.kind === "disabled") {
        request.thinking = { type: "disabled" };
        log("[GLMModelDialect] anthropic wire: thinking disabled (CLAUDISH_GLM_THINKING=disabled)");
        return request;
      }
      if (originalRequest.thinking) {
        delete request.thinking;
      }
      return request;
    }

    // OpenAI wire
    delete request.thinking; // scrub any anthropic-shaped field, whatever set it
    if (policy.kind === "disabled") {
      request.thinking = { type: "disabled" };
      log("[GLMModelDialect] openai wire: thinking disabled (CLAUDISH_GLM_THINKING=disabled)");
      return request;
    }
    if (originalRequest.thinking) {
      request.thinking = { type: "enabled" };
      log("[GLMModelDialect] openai wire: thinking enabled (client asked)");
    }
    return request;
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
