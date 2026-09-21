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
 *   - `input_tokens` /       — the Responses API's spelling of the same two
 *     `input_tokens_details`   quantities (#186, Codex lane). `prompt_tokens ??
 *                              input_tokens` and `prompt_tokens_details ??
 *                              input_tokens_details`, same `??` rule as below:
 *                              a wire that REPORTS a key has spoken; only an
 *                              absent key looks at the other spelling. A wire
 *                              carrying both (none of ours does) reads
 *                              chat-completions' first.
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
  // The Responses wire spells the same quantities `input_tokens` /
  // `input_tokens_details` (#186). `??`: a wire reporting the chat-completions
  // spelling has spoken; only its absence looks at the Responses one.
  const promptTokens = nonNegativeInt(u.prompt_tokens ?? u.input_tokens);
  const details = (u.prompt_tokens_details ?? u.input_tokens_details ??
    {}) as Record<string, unknown>;

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

/**
 * Anthropic `usage` fields derived from a provider `usage` object — openai-sse
 * (#99/#101/#179) and openai-responses-sse (#186) share this ONE shaper, so
 * the fullyCached rule and the three-key contract cannot drift apart between
 * lanes. Moved here from openai-sse.ts when the Codex lane became its second
 * caller; the body is that function verbatim, widened only where marked.
 *
 * OpenAI reports `prompt_tokens` as the FULL input — cached and uncached
 * together — and, where the provider caches, breaks the cached share out
 * beside it. Anthropic splits that same total across `input_tokens` (the part
 * billed at full rate) and `cache_read_input_tokens` (cache hits). Emitting
 * `prompt_tokens` as `input_tokens` *and* the cached count as
 * `cache_read_input_tokens` therefore counts the cached share TWICE — and the
 * client's context gauge sums the fields, so such a session would compact far
 * too early. Net it out and the total is preserved.
 *
 * Not netting would also corrupt our own accounting: `harness-injection-measure.py`
 * sums `input + cache_creation + cache_read` as the context size, so doubling
 * the cache inflates every openai-lane request there. The openai lane is ~72%
 * of the hub's volume and its cache was entirely invisible before #99 — the
 * `openai-sse` parser never read the upstream's cache field at all.
 */
export function toAnthropicUsage(u: any): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  // (S4-c) The two-way #99 netting became a three-way split derived in ONE
  // place — see above for the field spellings and the sum invariant every
  // consumer depends on.
  const split = splitPromptTokens(u);
  // One degenerate turn is sent UNSPLIT, and this is not a special case so much
  // as the client's merge rule read honestly.
  //
  // Claude Code only lets a delta value override its running total when that
  // value is GREATER THAN ZERO (2.1.273: `n.input_tokens !== null &&
  // n.input_tokens > 0 ? n.input_tokens : e.input_tokens`). So on a turn whose
  // input is entirely cache — possible only when the request repeats one
  // already cached, i.e. a retry — an `input_tokens: 0` is DISCARDED and the
  // message_start seed (the PREVIOUS turn's full context) survives beside a
  // full-size `cache_read_input_tokens`. The client would then sum the two and
  // believe the conversation is roughly twice its real size. Reporting that
  // turn as ordinary input keeps the client's sum exactly equal to
  // `prompt_tokens`, which is the invariant that matters.
  const fullyCached = split.promptTokens > 0 && split.inputTokens === 0;
  return {
    input_tokens: fullyCached ? split.promptTokens : split.inputTokens,
    // (#186 widening) chat-completions says `completion_tokens`, the Responses
    // wire says `output_tokens` — same `??` rule, a reported key has spoken.
    output_tokens: Number(u?.completion_tokens ?? u?.output_tokens) || 0,
    cache_read_input_tokens: fullyCached ? 0 : split.cacheReadTokens,
    // All three input keys ship TOGETHER, unconditionally, and that is not
    // stylistic: the client reconstructs the conversation size by SUMMING them
    // (2.1.273 binary), so a reduced `input_tokens` without its two siblings
    // understates the context by exactly the cached portion — the one shape
    // that reproduces the failure #99 fixed. `splitPromptTokens` guarantees
    // the three sum back to `prompt_tokens`.
    cache_creation_input_tokens: fullyCached ? 0 : split.cacheCreationTokens,
  };
}
