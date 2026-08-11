/**
 * ModelDialect — translates model-specific dialect differences.
 *
 * Each model family has its own dialect: context window sizes, parameter mappings
 * (thinking → reasoning_effort), vision support rules, tool name limits.
 * These are NOT format differences (those are APIFormat's job) but
 * per-model behavioral translations.
 */

import type { StreamFormat } from "../providers/transport/types.js";

/**
 * What a dialect needs to know about the wire it is writing onto.
 *
 * A dialect translates the *model's* quirks, but the correct translation can
 * depend on the *format* underneath: Qwen's reasoning switch is
 * `enable_thinking` on the OpenAI-compatible endpoint and Anthropic's native
 * `thinking` object on the Anthropic-compatible one — and each endpoint ignores
 * the other's form. Without this hint a dialect can only guess, and guessing
 * wrong is silent (the parameter is dropped, not rejected).
 *
 * Optional everywhere: dialects that do not care simply ignore it.
 */
export interface PrepareRequestContext {
  /** Resolved stream format of the transport this payload is headed for. */
  wireFormat?: StreamFormat;
}

export interface ModelDialect {
  /** Context window size for this model (tokens) */
  getContextWindow(): number;

  /** Whether this model supports vision/image input */
  supportsVision(): boolean;

  /**
   * Translate model-specific request parameters.
   * E.g., thinking.budget_tokens → reasoning_effort for OpenAI,
   * thinking → reasoning_split for MiniMax, strip thinking for GLM.
   */
  prepareRequest(request: any, originalRequest: any, ctx?: PrepareRequestContext): any;

  /** Maximum tool name length, or null if unlimited */
  getToolNameLimit(): number | null;

  /** Check if this dialect handles the given model ID */
  shouldHandle(modelId: string): boolean;

  /** Dialect name for logging */
  getName(): string;
}
