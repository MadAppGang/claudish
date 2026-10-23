/**
 * Measurement (used as a readout): did claudish answer a start call with
 * needs_effort, and how did the agent recover?
 *
 * Score 1 when the call that started work carries, for every model, the
 * Scenario column's level: either first time (no needs_effort) or on the retry after
 * needs_effort. Score 0 otherwise, including no start call at all.
 *
 * Evidence: how many needs_effort answers came before the started call, the first
 * needs_effort text (clipped), and which task-type column(s) the started call's
 * levels are consistent with (every model with a row must match that column).
 *
 * config:
 *   tool:   team | create_session | run_prompt
 *   column: the Scenario's task type
 */
import { canonicalOf, clip, newestEfforts, requested, resultText, startedCall, type Tool } from "./effort-lib.ts";

type Ctx = {
  config?: Record<string, unknown>;
  assertion?: { args?: Record<string, unknown> };
  session?: Parameters<typeof startedCall>[0];
};

export default function evaluate(_output: string, context: Ctx) {
  const cfg = { ...(context.assertion?.args ?? {}), ...((context.assertion?.args?.config as object) ?? {}), ...(context.config ?? {}) } as {
    tool: Tool;
    column: string;
  };
  const session = context.session ?? {};
  const { generationId, efforts } = newestEfforts();
  const { call, all, needsEffortBefore } = startedCall(session, cfg.tool);
  if (!call) return { pass: false, score: 0, reason: `no ${cfg.tool} start call in the Session`, evidence: { needsEffortBefore: 0 } };
  const req = requested(call, cfg.tool);
  const withRow = req.models.filter((m) => efforts[canonicalOf(m)]);
  const columns = new Set(withRow.flatMap((m) => Object.keys(efforts[canonicalOf(m)])));
  const consistent = withRow.length === 0 ? [] : [...columns].filter((col) => withRow.every((m) => efforts[canonicalOf(m)]?.[col]?.effort === req.efforts[m]));
  const noRowClean = req.models.filter((m) => !efforts[canonicalOf(m)]).every((m) => req.efforts[m] === undefined);
  const right = withRow.every((m) => efforts[canonicalOf(m)]?.[cfg.column]?.effort === req.efforts[m]) && noRowClean;
  const n = needsEffortBefore.length;
  const story = n === 0 ? "no needs_effort" : `${n} needs_effort answer(s), then ${right ? "a retry with" : "a retry WITHOUT"} the ${cfg.column} levels`;
  return {
    pass: right,
    score: right ? 1 : 0,
    reason: `${story}; levels consistent with column(s): ${consistent.join(", ") || "none"}`,
    evidence: {
      generationId,
      column: cfg.column,
      needsEffortBefore: n,
      startCalls: all.length,
      firstNeedsEffortText: n > 0 ? clip(resultText(session, needsEffortBefore[0]), 1200) : null,
      startedArgs: call.args,
      consistentColumns: consistent,
    },
  };
}
