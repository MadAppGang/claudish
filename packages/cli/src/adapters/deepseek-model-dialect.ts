/**
 * DeepSeekModelDialect — Layer 2 dialect for DeepSeek models.
 *
 * Handles DeepSeek-specific quirks:
 * - Thinking control via CLAUDISH_DEEPSEEK_THINKING (see prepareRequest)
 * - reasoning_content round-trip preservation (see preserveThinkingInHistory)
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import { log } from "../logger.js";

type DeepSeekThinkingPolicy = { kind: "passthrough" } | { kind: "disabled" };

// Read CLAUDISH_DEEPSEEK_THINKING on every call rather than caching it (same
// rationale as Qwen and GLM): the fleet flips this during a budget crunch, and
// a cached value would need a restart of the proxy that is, at that exact
// moment, the thing keeping everyone working.
function readDeepSeekThinkingPolicy(): DeepSeekThinkingPolicy {
  const raw = (process.env.CLAUDISH_DEEPSEEK_THINKING || "").trim().toLowerCase();
  if (raw === "disabled" || raw === "off" || raw === "false") return { kind: "disabled" };
  if (!raw || raw === "passthrough" || raw === "client" || raw === "default")
    return { kind: "passthrough" };
  log(`[DeepSeekModelDialect] Unrecognized CLAUDISH_DEEPSEEK_THINKING='${raw}', using 'passthrough'`);
  return { kind: "passthrough" };
}

export class DeepSeekModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Thinking control.
   *
   * The historical code deleted `thinking` unconditionally, on the stated
   * grounds that "DeepSeek doesn't support thinking params via API options".
   * That is empirically false — probed 2026-09-01 against
   * api.deepseek.com/chat/completions on deepseek-v4-flash-vision-exp:
   *
   *   thinking absent             → out  31, reasoning 115 chars (thinks by default)
   *   {"type":"disabled"}         → out   1, reasoning   0 chars — the switch works
   *   reasoning_effort:"none"     → out   1, reasoning   0 chars — equivalent
   *   enable_thinking:false       → out  34, reasoning 128 chars — IGNORED (Qwen's
   *                                 spelling; do not use it here)
   *
   * On a realistic agentic load (two tools declared, a prompt requiring a tool
   * choice) the same switch took output 213 → 92 tokens (-57%) and latency
   * 2459 → 1336ms, with an identical tool call. DeepSeek reasons by default and
   * the PAYG plan bills on output, so this is the lever that matters while the
   * cascade's last step is carrying fleet sonnet traffic.
   *
   *   passthrough (default) — preserve historical behavior: strip the client's
   *                           thinking object, let DeepSeek reason by default
   *   disabled              — force {"type":"disabled"} on every request
   *
   * Safety: disabling thinking does NOT break the reasoning_content round-trip
   * that preserveThinkingInHistory() exists for. Probed the same day with a
   * history carrying reasoning_content plus {"type":"disabled"}: HTTP 200
   * (255 → 122 output tokens), no "must be passed back" rejection.
   */
  override prepareRequest(request: any, originalRequest: any): any {
    const policy = readDeepSeekThinkingPolicy();

    // Scrub any anthropic-shaped field first, whatever set it.
    delete request.thinking;

    if (policy.kind === "disabled") {
      request.thinking = { type: "disabled" };
      // Never leave a depth knob contradicting the off-switch — the same rule
      // GLM's dialect applies (upstream 19cdaa6f). `OpenAIAPIFormat` runs first
      // and may have already set `reasoning_effort`, so the pair can go out
      // together and OpenCode Zen answers `400 "thinking.type='disabled'
      // conflicts with a non-'none' reasoning_effort"` for deepseek-v4.1-flash
      // (measured 2026-09-19 upstream; the same request with effort "low"
      // returns 200).
      if (request.reasoning_effort !== undefined) delete request.reasoning_effort;
      log("[DeepSeekModelDialect] thinking disabled (CLAUDISH_DEEPSEEK_THINKING=disabled)");
      return request;
    }

    if (originalRequest.thinking) {
      log("[DeepSeekModelDialect] Stripping thinking object (policy=passthrough)");
    }
    return request;
  }

  /**
   * DeepSeek thinks automatically and REQUIRES reasoning_content to be echoed
   * back on every assistant turn that produced reasoning. Stripping the thinking
   * block from history makes the OpenAI-format converter omit reasoning_content,
   * which DeepSeek rejects with HTTP 400 "The reasoning_content in the thinking
   * mode must be passed back to the API". Preserve the block so the converter
   * can round-trip it.
   */
  override preserveThinkingInHistory(): boolean {
    return true;
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
