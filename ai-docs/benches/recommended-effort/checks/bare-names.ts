/**
 * Layer A — the model names the agent passed. Unless the user named a provider, every
 * model in the start call must be a bare name: no `provider@` shortcut (it pins one
 * route and skips the subscription-first routing chain) and no aggregator-qualified
 * id with a `/` (it pins that aggregator).
 *
 * Score: the fraction of models passed bare. Pass: all of them.
 *
 * config:
 *   tool:                team | create_session | run_prompt
 *   user_named_provider: optional, default false. true: `provider@` is what the user
 *                        asked for, so only the `/` rule applies
 */
import { requested, startedCall, type Tool } from "./effort-lib.ts";

type Ctx = {
  config?: Record<string, unknown>;
  assertion?: { args?: Record<string, unknown> };
  session?: { calls?: { name: string; args: Record<string, unknown> }[] };
};

export default function evaluate(_output: string, context: Ctx) {
  const cfg = { ...(context.assertion?.args ?? {}), ...((context.assertion?.args?.config as object) ?? {}), ...(context.config ?? {}) } as {
    tool: Tool;
    user_named_provider?: boolean;
  };
  const { call } = startedCall(context.session ?? {}, cfg.tool);
  if (!call) return { pass: false, score: 0, reason: `no ${cfg.tool} start call in the Session` };
  const calls = [call];
  const { models } = requested(call, cfg.tool);
  if (models.length === 0) return { pass: false, score: 0, reason: `the ${cfg.tool} call named no model`, evidence: { args: calls[0].args } };
  const perModel: Record<string, string> = {};
  for (const m of models) {
    if (m.includes("@") && !cfg.user_named_provider) perModel[m] = "provider@ shortcut";
    else if (m.includes("/")) perModel[m] = "aggregator-qualified id";
    else perModel[m] = "bare";
  }
  const bare = Object.values(perModel).filter((v) => v === "bare").length;
  const pass = bare === models.length;
  const offenders = Object.entries(perModel).filter(([, v]) => v !== "bare").map(([m, v]) => `${m} (${v})`);
  return {
    pass,
    score: bare / models.length,
    reason: pass ? `${bare}/${models.length} models passed bare` : `${bare}/${models.length} bare; not bare: ${offenders.join(", ")}`,
    evidence: { models, perModel, userNamedProvider: Boolean(cfg.user_named_provider), userRequiredProviderArg: calls[0].args?.user_required_provider ?? null },
  };
}
