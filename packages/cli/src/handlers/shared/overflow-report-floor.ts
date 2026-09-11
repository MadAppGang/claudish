/**
 * The `input_tokens` a context-overflow turn must REPORT.
 *
 * Both ingress lanes ask the same question — when a provider refuses a prompt for
 * size, what count does the client's context gauge get told? That gauge is what
 * triggers Claude Code's auto-compact, and any answer below its threshold leaves
 * the session re-sending the same oversized prompt forever.
 *
 * The provider does not always state the numbers. OpenAI's Responses wording
 * ("Your input exceeds the context window of this model. Please adjust your input
 * and try again.", observed 2026-09-11 on the gpt-5.6-sol lane) names neither the
 * used count nor the limit, so extraction yields nothing and the natural fallback
 * is 0 — which is the wedge exactly. This floor bounds the report from below
 * independently of what the body says.
 *
 * Default 280 000 is the fleet compaction threshold (CLAUDE_CODE_AUTO_COMPACT_WINDOW,
 * 2026-09): reporting at or above it is what makes the NEXT turn compact.
 * `CLAUDISH_OVERFLOW_REPORT_FLOOR=0` disables the floor and reports raw numbers.
 *
 * Deliberately a leaf module with no imports: `openai-responses-sse.ts` (the parser)
 * and `context-overflow.ts` (the Composed-handler interception) both need it, and
 * the latter already imports the former — sharing the helper here keeps that edge
 * one-directional instead of closing an import cycle.
 */

export function overflowReportFloor(): number {
  const raw = process.env.CLAUDISH_OVERFLOW_REPORT_FLOOR;
  if (raw === undefined) return 280_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 280_000;
  return Math.floor(n);
}

/** The `input_tokens` to report: the largest of body-stated, estimated, floor. */
export function overflowReportedTokens(
  used: number | undefined,
  estimate: number,
  floor: number
): number {
  return Math.max(used ?? 0, estimate, floor);
}
