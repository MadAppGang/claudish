/**
 * Layer A — which model ids the agent finally ran (routing.md § "MCP callers name a
 * recommended model"). claudish answers a bare name outside the recommended list with
 * `unknown_model:` (no model) or `not_recommended:` (a catalog model), and starts
 * nothing; `user_required_model` runs a model the user named exactly.
 *
 * The graded call is the LAST call of `tool` that started: its tool_result is not an
 * error and does not begin with `unknown_model:`, `not_recommended:` or `needs_effort:`.
 *
 * Score 1:
 *   expect: recommended  every model id it passed (team: `models` and `judges`; a
 *                        `provider@` is read by its canonical part) is in the
 *                        recommended list on disk at grading time
 *                        (~/.claudish/recommended-models-cache-v2.json, `models[].id`);
 *   expect: user-named   it passed `model` exactly, and marked it user-required:
 *                        `user_required_model: true` (create_session / run_prompt) or
 *                        `model` listed in `user_required_model` (team).
 * Score 0 otherwise, and when no call started.
 *
 * Evidence: `modelCheckBefore`, the unknown_model / not_recommended answers before the
 * started call; the first line of each; the ids finally passed.
 *
 * config:
 *   tool:   team | create_session | run_prompt
 *   expect: recommended | user-named
 *   model:  the exact id the user named (expect: user-named)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalOf, resultText, startCalls, type SessionLike, type Tool, type ToolCall } from "./effort-lib.ts";

type Ctx = {
  config?: Record<string, unknown>;
  assertion?: { args?: Record<string, unknown> };
  session?: SessionLike & { events?: { type?: string; tool_call_id?: string; tool_out?: unknown; result_ok?: boolean | null; result_tag?: string | null }[] };
};

const REFUSALS = ["unknown_model:", "not_recommended:", "needs_effort:"];

function recommendedIds(path = join(homedir(), ".claudish", "recommended-models-cache-v2.json")): { ids: Set<string>; generationId?: string } {
  const doc = JSON.parse(readFileSync(path, "utf8")) as { generationId?: string; models?: { id?: string }[] };
  return { ids: new Set((doc.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean)), generationId: doc.generationId };
}

function isErrorResult(session: Ctx["session"], call: ToolCall): boolean {
  const ev = (session?.events ?? []).find((e) => e.type === "tool_result" && e.tool_call_id === call.tool_call_id);
  return ev?.result_ok === false || ev?.result_tag === "err";
}

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function passedIds(call: ToolCall, tool: Tool): { models: string[]; userRequired: string[] | boolean } {
  const a = call.args ?? {};
  if (tool === "team") return { models: [...strings(a.models), ...strings(a.judges)], userRequired: strings(a.user_required_model) };
  const model = typeof a.model === "string" ? a.model : "";
  const ur = a.user_required_model;
  return { models: model ? [model] : [], userRequired: ur === true || ur === "true" };
}

export default function evaluate(_output: string, context: Ctx) {
  const cfg = { ...(context.assertion?.args ?? {}), ...((context.assertion?.args?.config as object) ?? {}), ...(context.config ?? {}) } as {
    tool: Tool;
    expect: "recommended" | "user-named";
    model?: string;
  };
  const session = context.session ?? {};
  const all = startCalls(session, cfg.tool);
  const firstLine = (c: ToolCall) => resultText(session, c).trimStart().split("\n")[0].slice(0, 300);
  const refused = (c: ToolCall) => REFUSALS.some((p) => resultText(session, c).trimStart().startsWith(p));
  let at = -1;
  for (let i = all.length - 1; i >= 0; i--) if (!refused(all[i]) && !isErrorResult(session, all[i])) { at = i; break; }
  const before = (at < 0 ? all : all.slice(0, at)).filter((c) => /^(unknown_model|not_recommended):/.test(resultText(session, c).trimStart()));
  const base = {
    tool: cfg.tool,
    expect: cfg.expect,
    startCalls: all.length,
    modelCheckBefore: before.length,
    modelCheckAnswers: before.map((c) => ({ args: c.args, answer: firstLine(c) })),
  };
  if (at < 0) {
    return {
      pass: false,
      score: 0,
      reason: `no ${cfg.tool} call started (${all.length} call(s), ${before.length} unknown_model/not_recommended)`,
      evidence: { ...base, lastAnswer: all.length ? firstLine(all[all.length - 1]) : null },
    };
  }
  const call = all[at];
  const { models, userRequired } = passedIds(call, cfg.tool);
  const evidence = { ...base, startedArgs: call.args, models, userRequiredModel: userRequired };
  if (models.length === 0) return { pass: false, score: 0, reason: `the started ${cfg.tool} call named no model`, evidence };

  if (cfg.expect === "user-named") {
    const want = String(cfg.model ?? "");
    const named = models.includes(want);
    const marked = Array.isArray(userRequired) ? userRequired.includes(want) : userRequired === true;
    const pass = named && marked;
    const reason = pass
      ? `ran ${want} with user_required_model${before.length ? ` after ${before.length} unknown_model/not_recommended answer(s)` : ""}`
      : !named
        ? `the started call ran ${models.join(", ")}, not the user-named ${want}`
        : `ran ${want} without marking it in user_required_model`;
    return { pass, score: pass ? 1 : 0, reason, evidence };
  }

  const { ids, generationId } = recommendedIds();
  const outside = models.filter((m) => !ids.has(canonicalOf(m)));
  const pass = outside.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `every id is recommended: ${models.join(", ")}${before.length ? ` (after ${before.length} unknown_model/not_recommended answer(s))` : ""}`
      : `not in the recommended list: ${outside.join(", ")}`,
    evidence: { ...evidence, recommendedGeneration: generationId ?? null, outside },
  };
}
