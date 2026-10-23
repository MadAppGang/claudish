/**
 * Layer A — the calling agent's choice. Did the start call (team run, create_session
 * or run_prompt) pass, for every model it ran, exactly the sidecar's recommended level for the
 * Scenario's task-type column, and no effort for a model with no table entry?
 *
 * Score: the fraction of models whose effort is right. Pass: every model right, and
 * (when the Scenario names models) the call ran exactly those models.
 *
 * config:
 *   tool:   team | create_session | run_prompt
 *   column: the sidecar task type the prompt was written for (e.g. code_review)
 *   models: optional; the models the user named, as canonical ids ([] = none named)
 */
import { canonicalOf, newestEfforts, requested, startedCall, type Tool } from "./effort-lib.ts";

type Ctx = {
  config?: Record<string, unknown>;
  assertion?: { args?: Record<string, unknown> };
  session?: { calls?: { name: string; args: Record<string, unknown> }[] };
};

export default function evaluate(_output: string, context: Ctx) {
  const cfg = { ...(context.assertion?.args ?? {}), ...((context.assertion?.args?.config as object) ?? {}), ...(context.config ?? {}) } as {
    tool: Tool;
    column: string;
    models?: string[];
  };
  const { generationId, efforts } = newestEfforts();
  const { call, all: calls, needsEffortBefore } = startedCall(context.session ?? {}, cfg.tool);
  if (!call) {
    return { pass: false, score: 0, reason: `no ${cfg.tool} start call in the Session`, evidence: { generationId } };
  }
  // Graded on the call that started work (after any needs_effort answers).
  const req = requested(call, cfg.tool);
  const perModel: Record<string, { passed: string | null; expected: string | null; ok: boolean }> = {};
  for (const model of Object.keys(req.efforts)) {
    const expected = efforts[canonicalOf(model)]?.[cfg.column]?.effort ?? null;
    const passed = req.efforts[model] ?? null;
    const inModels = req.models.includes(model);
    perModel[model] = { passed, expected, ok: inModels && passed === expected };
  }
  const total = Object.keys(perModel).length;
  const right = Object.values(perModel).filter((m) => m.ok).length;
  const ranCanonical = req.models.map(canonicalOf).sort();
  // An empty list means the user named no exact ids (a family, or "pick one").
  const named = cfg.models && cfg.models.length > 0 ? [...cfg.models].sort() : null;
  const modelsMatch = named === null || JSON.stringify(ranCanonical) === JSON.stringify(named);
  const score = total === 0 ? 0 : right / total;
  const pass = total > 0 && right === total && modelsMatch;
  const wrong = Object.entries(perModel)
    .filter(([, m]) => !m.ok)
    .map(([k, m]) => `${k}: passed ${m.passed ?? "none"}, recommended ${m.expected ?? "none"}`);
  const reason = pass
    ? `${right}/${total} models carry the ${cfg.column} level (generation ${generationId})`
    : [
        `${right}/${total} models right for column ${cfg.column}`,
        ...wrong,
        modelsMatch ? "" : `ran ${ranCanonical.join(", ")}, the user named ${named?.join(", ")}`,
        req.note ?? "",
      ]
        .filter(Boolean)
        .join("; ");
  return {
    pass,
    score,
    reason,
    evidence: {
      generationId,
      column: cfg.column,
      startCalls: calls.length,
      needsEffortBefore: needsEffortBefore.length,
      args: call.args,
      perModel,
      modelsMatch,
      note: req.note,
    },
  };
}
