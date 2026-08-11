/**
 * QwenModelDialect — Layer 2 dialect for Qwen (Alibaba) models.
 *
 * Handles Qwen-specific quirks:
 * - Strips special tokens from output
 * - Maps thinking → enable_thinking + thinking_budget params
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import type { PrepareRequestContext } from "./model-dialect.js";
import { log } from "../logger.js";

type ThinkingPolicy =
  | { kind: "disabled" }
  | { kind: "passthrough" }
  | { kind: "budget"; budget: number };

/**
 * Read CLAUDISH_QWEN_THINKING on every call rather than caching it: the fleet
 * flips this during a budget crunch, and a cached value would need a restart of
 * a proxy that is, at that exact moment, the thing keeping everyone working.
 */
function readThinkingPolicy(): ThinkingPolicy {
  const raw = (process.env.CLAUDISH_QWEN_THINKING || "").trim().toLowerCase();
  if (!raw || raw === "disabled" || raw === "off" || raw === "false") return { kind: "disabled" };
  if (raw === "passthrough" || raw === "client" || raw === "default") return { kind: "passthrough" };
  const m = raw.match(/^budget:(\d+)$/);
  if (m) {
    const budget = Number.parseInt(m[1], 10);
    if (Number.isFinite(budget) && budget > 0) return { kind: "budget", budget };
  }
  log(`[QwenModelDialect] Unrecognized CLAUDISH_QWEN_THINKING='${raw}', using 'disabled'`);
  return { kind: "disabled" };
}

// Qwen special tokens that should be stripped from output
const QWEN_SPECIAL_TOKENS = [
  "<|im_start|>",
  "<|im_end|>",
  "<|endoftext|>",
  "<|end|>",
  "assistant\n", // Role marker that sometimes leaks
];

export class QwenModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // Strip Qwen special tokens that may leak through
    // This can happen when the model gets confused and outputs its chat template
    let cleanedText = textContent;
    for (const token of QWEN_SPECIAL_TOKENS) {
      cleanedText = cleanedText.replaceAll(token, "");
    }

    // Also handle partial tokens at chunk boundaries
    // e.g., "<|im_" at the end of one chunk and "start|>" at the beginning of next
    cleanedText = cleanedText.replace(/<\|[a-z_]*$/i, ""); // Partial at end
    cleanedText = cleanedText.replace(/^[a-z_]*\|>/i, ""); // Partial at start

    const wasTransformed = cleanedText !== textContent;
    if (wasTransformed && cleanedText.length === 0) {
      // Entire chunk was special tokens, skip it
      return {
        cleanedText: "",
        extractedToolCalls: [],
        wasTransformed: true,
      };
    }

    return {
      cleanedText,
      extractedToolCalls: [],
      wasTransformed,
    };
  }

  /**
   * Handle request preparation - specifically for mapping reasoning parameters
   *
   * Two wires, two switches, and each ignores the other's:
   *
   * - OpenAI-compatible endpoint (`/compatible-mode/v1`): `enable_thinking` +
   *   `thinking_budget`.
   * - Anthropic-compatible endpoint (`/apps/anthropic`): the native `thinking`
   *   object. Measured against Qwen Cloud Token Plan on 2026-08-11:
   *   `enable_thinking: false` is silently ignored there (67 in / 48 out, still
   *   emitting a thinking block), while `thinking: {type: "disabled"}` works
   *   (31 in / 1 out on the same prompt). Converting to `enable_thinking` on
   *   that wire therefore *deletes the only switch that works*.
   *
   * Qwen reasons by default, so an unset `thinking` is not neutral — it is
   * "think, at length". On a trivial prompt the reasoning/answer ratio measured
   * ~15:1, and the plan deducts credits on output. CLAUDISH_QWEN_THINKING makes
   * that a policy rather than an accident:
   *
   *   disabled    (default) — force `thinking: {type: "disabled"}`
   *   passthrough           — send exactly what the client asked for
   *   budget:<n>            — force an enabled block capped at <n> tokens
   *
   * The default is `disabled` because this fork routes Qwen as a *budget*
   * failover target: it is chosen when a metered plan is running out, which is
   * precisely when paying for 15× more reasoning tokens than answer tokens is
   * the wrong trade. Set `passthrough` to restore stock behavior.
   */
  override prepareRequest(request: any, originalRequest: any, ctx?: PrepareRequestContext): any {
    const policy = readThinkingPolicy();

    if (ctx?.wireFormat === "anthropic-sse") {
      // Native Anthropic wire — keep `thinking` in its native shape, and never
      // emit enable_thinking/thinking_budget (ignored, and pure noise upstream).
      delete request.enable_thinking;
      delete request.thinking_budget;

      if (policy.kind === "passthrough") {
        if (originalRequest.thinking) request.thinking = originalRequest.thinking;
        return request;
      }
      if (policy.kind === "budget") {
        request.thinking = { type: "enabled", budget_tokens: policy.budget };
        log(`[QwenModelDialect] anthropic wire: thinking enabled, budget ${policy.budget}`);
        return request;
      }
      request.thinking = { type: "disabled" };
      log("[QwenModelDialect] anthropic wire: thinking disabled (CLAUDISH_QWEN_THINKING=disabled)");
      return request;
    }

    // OpenAI-compatible wire — the historical mapping.
    if (policy.kind === "disabled") {
      request.enable_thinking = false;
      delete request.thinking_budget;
      delete request.thinking;
      log("[QwenModelDialect] openai wire: enable_thinking=false");
      return request;
    }

    if (policy.kind === "budget") {
      request.enable_thinking = true;
      request.thinking_budget = policy.budget;
      delete request.thinking;
      log(`[QwenModelDialect] openai wire: enable_thinking=true, budget ${policy.budget}`);
      return request;
    }

    if (originalRequest.thinking) {
      const { budget_tokens } = originalRequest.thinking;

      // Qwen specific parameters
      request.enable_thinking = true;
      request.thinking_budget = budget_tokens;

      log(
        `[QwenModelDialect] Mapped budget ${budget_tokens} -> enable_thinking: true, thinking_budget: ${budget_tokens}`
      );

      // Cleanup: Remove raw thinking object
      delete request.thinking;
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "qwen") || matchesModelFamily(modelId, "alibaba");
  }

  getName(): string {
    return "QwenModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use QwenModelDialect */
export { QwenModelDialect as QwenAdapter };
