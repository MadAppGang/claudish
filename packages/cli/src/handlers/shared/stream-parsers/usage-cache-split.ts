/**
 * Split an OpenAI-shaped `usage` object's `prompt_tokens` into the three
 * Anthropic input counters. (Absorbed from upstream f9baf2e, S4-c — with one
 * intended divergence, marked DIVERGENCE below.)
 *
 * `prompt_tokens` is the FULL context the provider billed for. OpenAI-compatible
 * providers report the cached portion of it as a SUBSET, under
 * `prompt_tokens_details`, and this fork's wire shaping already nets that share
 * out since #99 — but as a two-way split (input / cache_read). The three-way
 * split adds the cache-CREATION counter and centralizes the arithmetic so the
 * wire and the cost accounting derive it ONCE and cannot disagree.
 *
 * ## Field names: observed, never invented
 *
 * Keys read, all of which appear verbatim in captures or in this fork's own
 * pinned tests:
 *
 *   - `cached_tokens`        — OpenAI, z.ai/GLM Coding, xAI, Kimi; the #99 pin
 *                              (format-translation.test.ts, 900/1000).
 *   - `prompt_cache_hit_tokens` — DeepSeek. DIVERGENCE FROM UPSTREAM: f9baf2e
 *                              reads only `cached_tokens`; THIS fork has read
 *                              DeepSeek's spelling since #99 (pinned there:
 *                              750/1000 → 250/750), and absorbing upstream
 *                              verbatim would silently drop DeepSeek's cache
 *                              from the wire. Our two-spelling list wins that
 *                              convergence.
 *   - `cache_write_tokens`   — OpenRouter's cache-CREATION counter. No provider
 *                              on our lanes reports it (measured 2026-09-20: 0
 *                              occurrences in the committed corpus), so this is
 *                              0 here today, which is correct: nothing was
 *                              written. Plain OpenAI does not report cache
 *                              writes at all.
 *
 * A provider that spells all of these differently reports 0, and 0 is the
 * pre-change behaviour exactly — the split degrades to "all of it is ordinary
 * input", never to a wrong number.
 *
 * ## The invariant every consumer depends on
 *
 *   inputTokens + cacheReadTokens + cacheCreationTokens === promptTokens
 *
 * Claude Code re-derives the conversation size by summing those three
 * (verified against the client binary, 2.1.273:
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
 * used by the auto-compaction threshold and the context meter). A split whose
 * parts do not add back up therefore moves the client's idea of how full the
 * context is. The clamps below exist to hold the invariant against a provider
 * that reports a cached count larger than the prompt it belongs to.
 */

export interface PromptTokenSplit {
  /** The full context size — `prompt_tokens`, unchanged. NEVER the reduced value. */
  promptTokens: number;
  /** Uncached, freshly-read input: `promptTokens - cacheRead - cacheCreation`. */
  inputTokens: number;
  /** Tokens served from the provider's prompt cache. */
  cacheReadTokens: number;
  /** Tokens written INTO the provider's prompt cache this turn. */
  cacheCreationTokens: number;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Derive the three-way split from a provider `usage` object. Safe on `null`,
 * `undefined` and anything that is not an object: it runs on the stream's
 * closing path, where refusing to produce a number would cost the turn's
 * accounting entirely.
 */
export function splitPromptTokens(usage: unknown): PromptTokenSplit {
  const u = (usage ?? {}) as Record<string, unknown>;
  const promptTokens = nonNegativeInt(u.prompt_tokens);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;

  // DeepSeek spells the read counter top-level (#99); everyone else nests it.
  // `??` (not `||`): a provider REPORTING 0 has spoken — no fallback to the
  // other spelling — and only an absent key looks at DeepSeek's.
  const rawRead = nonNegativeInt(details.cached_tokens ?? u.prompt_cache_hit_tokens);
  // Clamped against the prompt, then against what is left, so the three parts
  // always sum back to `promptTokens` however the provider's numbers disagree.
  const cacheReadTokens = Math.min(rawRead, promptTokens);
  const cacheCreationTokens = Math.min(
    nonNegativeInt(details.cache_write_tokens),
    promptTokens - cacheReadTokens
  );

  return {
    promptTokens,
    inputTokens: promptTokens - cacheReadTokens - cacheCreationTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
