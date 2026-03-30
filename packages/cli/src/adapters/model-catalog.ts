/**
 * Centralized model metadata catalog.
 *
 * Eliminates scattered hardcoded model metadata across adapter files.
 * All dialects look up context windows, vision support, and other
 * model-specific metadata from this single source of truth.
 */

export interface ModelEntry {
  /** Model family pattern — checked with string.includes() against lowercased modelId */
  pattern: string;
  /** Context window in tokens */
  contextWindow: number;
  /** Whether model supports vision/image input */
  supportsVision?: boolean; // default: true (from BaseAPIFormat)
  /** Temperature range constraint */
  temperatureRange?: { min: number; max: number };
  /** Tool name length limit */
  toolNameLimit?: number;
  /** Maximum number of tools allowed per request */
  maxToolCount?: number;
}

/**
 * Static model catalog — ordered by specificity (most-specific patterns first).
 * Checked in order; first match wins.
 */
export const MODEL_CATALOG: ModelEntry[] = [
  // ── Grok ────────────────────────────────────────────
  { pattern: "grok-4.20", contextWindow: 2_000_000 },
  { pattern: "grok-4-20", contextWindow: 2_000_000 },
  { pattern: "grok-4.1-fast", contextWindow: 2_000_000 },
  { pattern: "grok-4-1-fast", contextWindow: 2_000_000 },
  { pattern: "grok-4-fast", contextWindow: 2_000_000 },
  { pattern: "grok-code-fast", contextWindow: 256_000 },
  { pattern: "grok-4", contextWindow: 256_000 },
  { pattern: "grok-3", contextWindow: 131_072 },
  { pattern: "grok-2", contextWindow: 131_072 },
  { pattern: "grok", contextWindow: 131_072 },

  // ── GLM ─────────────────────────────────────────────
  { pattern: "glm-5.1", contextWindow: 128_000, supportsVision: true },
  { pattern: "glm-5-turbo", contextWindow: 202_752 },
  { pattern: "glm-5", contextWindow: 80_000, supportsVision: true },
  { pattern: "glm-4.7-flash", contextWindow: 202_752 },
  { pattern: "glm-4.7", contextWindow: 202_752 },
  { pattern: "glm-4.6v", contextWindow: 131_072, supportsVision: true },
  { pattern: "glm-4.6", contextWindow: 204_800 },
  { pattern: "glm-4.5v", contextWindow: 65_536, supportsVision: true },
  { pattern: "glm-4.5-flash", contextWindow: 131_072 },
  { pattern: "glm-4.5-air", contextWindow: 131_072 },
  { pattern: "glm-4.5", contextWindow: 131_072 },
  { pattern: "glm-4v-plus", contextWindow: 128_000, supportsVision: true },
  { pattern: "glm-4v", contextWindow: 128_000, supportsVision: true },
  { pattern: "glm-4-long", contextWindow: 1_000_000 },
  { pattern: "glm-4-plus", contextWindow: 128_000 },
  { pattern: "glm-4-flash", contextWindow: 128_000 },
  { pattern: "glm-4-32b", contextWindow: 128_000 },
  { pattern: "glm-4", contextWindow: 128_000 },
  { pattern: "glm-3-turbo", contextWindow: 128_000 },
  { pattern: "glm-", contextWindow: 131_072, supportsVision: false },

  // ── MiniMax ─────────────────────────────────────────
  { pattern: "minimax-01", contextWindow: 1_000_000, supportsVision: false },
  { pattern: "minimax-m1", contextWindow: 1_000_000, supportsVision: false },
  {
    pattern: "minimax",
    contextWindow: 204_800,
    supportsVision: false,
    temperatureRange: { min: 0.01, max: 1.0 },
  },

  // ── OpenAI ──────────────────────────────────────────
  { pattern: "gpt-5.4", contextWindow: 1_050_000, maxToolCount: 128 },
  { pattern: "gpt-5", contextWindow: 400_000, maxToolCount: 128 },
  { pattern: "o1", contextWindow: 200_000, maxToolCount: 128 },
  { pattern: "o3", contextWindow: 200_000, maxToolCount: 128 },
  { pattern: "o4", contextWindow: 200_000, maxToolCount: 128 },
  { pattern: "gpt-4o", contextWindow: 128_000, maxToolCount: 128 },
  { pattern: "gpt-4-turbo", contextWindow: 128_000, maxToolCount: 128 },
  { pattern: "gpt-3.5", contextWindow: 16_385, maxToolCount: 128 },

  // ── Kimi ────────────────────────────────────────────
  { pattern: "kimi-k2.5", contextWindow: 262_144 },
  { pattern: "kimi-k2-5", contextWindow: 262_144 },
  { pattern: "kimi-k2", contextWindow: 131_000 },
  { pattern: "kimi", contextWindow: 131_072 },

  // ── Xiaomi/MiMo ─────────────────────────────────────
  { pattern: "xiaomi", contextWindow: 200_000, toolNameLimit: 64 },
  { pattern: "mimo", contextWindow: 200_000, toolNameLimit: 64 },
];

/**
 * Look up model info from the catalog.
 *
 * Matches against the lowercased model ID. Also handles vendor-prefixed IDs
 * like "x-ai/grok-beta" by checking the segment after the last "/".
 *
 * Returns the first matching entry, or undefined if no match.
 */
export function lookupModel(modelId: string): ModelEntry | undefined {
  const lower = modelId.toLowerCase();
  // Also handle vendor-prefixed IDs like "x-ai/grok-beta" — check after last "/"
  const unprefixed = lower.includes("/") ? lower.substring(lower.lastIndexOf("/") + 1) : lower;

  for (const entry of MODEL_CATALOG) {
    if (unprefixed.includes(entry.pattern) || lower.includes(entry.pattern)) {
      return entry;
    }
  }
  return undefined;
}

/** Default context window when no catalog match */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Default vision support when no catalog match */
export const DEFAULT_SUPPORTS_VISION = true;
