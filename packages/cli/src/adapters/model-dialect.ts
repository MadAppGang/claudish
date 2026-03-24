/**
 * ModelDialect — translates model-specific dialect differences.
 *
 * Each model family has its own dialect: context window sizes, parameter mappings
 * (thinking → reasoning_effort), vision support rules, tool name limits.
 * These are NOT format differences (those are APIFormat's job) but
 * per-model behavioral translations.
 */

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
  prepareRequest(request: any, originalRequest: any): any;

  /** Maximum tool name length, or null if unlimited */
  getToolNameLimit(): number | null;

  /** Dialect name for logging */
  getName(): string;
}
