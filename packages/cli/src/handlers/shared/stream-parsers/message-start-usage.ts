/**
 * Seed usage for the `message_start` event. (S4-b ae8c07f, absorbed verbatim.)
 *
 * A stream parser cannot know the real input-token count when it opens the
 * message — upstream only reports usage at the end of the stream, which we
 * then send on `message_delta`. Claude Code merges that delta over the
 * message_start value, but ONLY when the delta reports a positive count:
 *
 *   input_tokens: t.input_tokens != null && t.input_tokens > 0
 *     ? t.input_tokens : e.input_tokens
 *
 * So on any turn where the backend omits usage (a mid-stream error, a
 * truncated `response.completed`), whatever we put here is what Claude Code
 * records as the size of the conversation. A hardcoded small number made those
 * turns look empty, which disarms auto-compaction at exactly the moment it is
 * needed — the context sits at the cap while the client believes it holds
 * almost nothing, and the session hard-sticks at overflow. The same holds on
 * OUR wire whenever the netted `input_tokens` is 0 (a fully-cached turn): the
 * client keeps the seed then, so the seed has to be the right order of
 * magnitude.
 *
 * Carrying the previous turn's count forward keeps the estimate in the right
 * order of magnitude; 100 remains only as the genuinely-unknown first-turn
 * fallback.
 *
 * ## Why the two cache counters are seeded at 0 (S4-c)
 *
 * The merge rule above applies to EVERY usage key: a delta reporting
 * `cache_creation_input_tokens: 0` — every provider that does not report cache
 * WRITES, i.e. all of ours — falls back to whatever this seed carried. Leaving
 * the key out made that fallback `undefined`, and the client sums the three
 * input counters raw in places that do not coalesce, where an `undefined` turns
 * the conversation size into `NaN`. An explicit 0 changes no total anywhere
 * (it is the value every consumer already coalesced to) and removes that
 * hazard for every parser that seeds from here.
 */
export function messageStartUsage(priorInputTokens?: number): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  return {
    input_tokens: priorInputTokens && priorInputTokens > 0 ? priorInputTokens : 100,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}
