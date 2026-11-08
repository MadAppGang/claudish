/**
 * Built-in hook `plan-mode/plan-file-path`.
 *
 * Background (measured, not assumed). Claude Code 2.1.220's ExitPlanModeV2 takes
 * NO plan parameter — its advertised schema is `{allowedPrompts?}` and the tool
 * description says outright: "This tool does NOT take the plan content as a
 * parameter - it will read the plan from the file you wrote". CC's
 * `normalizeToolInput` injects `plan` from disk at the session's assigned path.
 *
 * So `ExitPlanMode({})` is CORRECT, and the real failure is upstream: the model
 * writes its plan somewhere else. gpt-5.6-sol produced a complete 12.9 KB plan
 * under a filename it invented; CC read the assigned path, found nothing, and
 * returned `plan: null`. That downgrades the approval dialog from the rich form
 * ("Here is Claude's plan" + `Yes, and bypass permissions` / `Yes, auto-accept
 * edits` / `Yes, manually approve edits`) to a bare "Exit plan mode?" yes/no —
 * and since the rich dialog is the only surface that offers permission
 * elevation on exit, the session always falls back to manual approval.
 *
 * Across 115 recorded ExitPlanMode calls the discriminator was exact: sessions
 * that wrote to the assigned path got the rich dialog 7/7, sessions that did not
 * got the degraded one 17/17. Native Claude models were 87/87 correct, so this
 * hook is scoped to foreign routes (`routes: "foreign"`, where nativeness is
 * `RouteInfo.native`: `claude-*` names and the `anthropic` provider, unless the
 * provider profile sets `forceForeignModel`).
 *
 * The request half rewrites the ExitPlanMode tool DESCRIPTION, because a tool
 * description is re-read at the instant the model decides to call the tool,
 * while the plan-mode reminder can sit ~180K tokens behind the current turn. The
 * action is applied at stage B, after tool conversion, so `--summarize-tools`
 * (first sentence, 150 characters) can never cut it.
 *
 * The tool half redirects a Write/Edit/NotebookEdit that is ALREADY aimed at
 * the plan directory onto the assigned plan file. It is armed only in plan
 * mode: outside it the hook cannot fire, so it must not make the seam hold
 * Write/Edit arguments, which would suppress incremental streaming of file
 * contents on every ordinary request.
 */

import {
  type RequestAction,
  type RequestContext,
  type ToolCallAction,
  type ToolCallContext,
  act,
} from "../public.js";
import type { BuiltinHook } from "../registry.js";

export const PLAN_MODE_HOOK_ID = "plan-mode/plan-file-path";

/** Tools that can create the plan file, and so can target the wrong path. */
export const PLAN_WRITE_TOOLS: ReadonlyArray<string> = ["Write", "Edit", "NotebookEdit"];

function directoryOf(filePath: string): string | undefined {
  const slash = filePath.lastIndexOf("/");
  return slash > 0 ? filePath.slice(0, slash) : undefined;
}

/** The text appended to the ExitPlanMode description. Unchanged from the behavior rule. */
export function planFileInstruction(planFilePath: string): string {
  return `

## Plan file for THIS session
Your plan MUST be written to exactly this path:
${planFilePath}
Do not invent a different filename, and do not derive one from the task. Claude Code reads only that exact path; a plan written anywhere else is invisible to it and the approval will show "No plan found".`;
}

/** The request handler, exported for unit tests. */
export function planModeRequest(ctx: RequestContext): RequestAction[] {
  const { planModeActive, planFilePath } = ctx.harness;
  if (!planModeActive || !planFilePath) return [];

  // Only speak up if the tool is actually on offer this turn.
  if (!ctx.request.tools.some((t) => t?.name === "ExitPlanMode")) return [];

  return [act.rewriteToolDescription("ExitPlanMode", planFileInstruction(planFilePath))];
}

/** The tool-call handler, exported for unit tests. */
export function planModeToolCall(ctx: ToolCallContext): ToolCallAction[] {
  const { planFilePath, planDir } = ctx.harness;
  if (!planFilePath || !planDir) return [];

  const filePath = ctx.tool.args.file_path;
  if (typeof filePath !== "string" || filePath === planFilePath) return [];

  // Only ever redirect writes that are ALREADY aimed at the plan directory. A
  // model writing source files, docs, or session artifacts elsewhere is doing
  // normal work and must not be touched.
  if (directoryOf(filePath) !== planDir) return [];

  return [
    act.repairToolArgs(
      { ...ctx.tool.args, file_path: planFilePath },
      `redirected ${ctx.tool.name} from ${filePath} to the session's assigned plan file ${planFilePath}`
    ),
  ];
}

export const planModeHook: BuiltinHook = {
  apiVersion: 1,
  id: PLAN_MODE_HOOK_ID,
  description:
    "Keep plan-mode writes on the plan file Claude Code assigned, and name that " +
    "path in the ExitPlanMode description.",
  defaultSeverity: "fix",
  // Native Claude models are already 87/87 on this; running the hook for them
  // would be pure risk with no upside.
  routes: "foreign",
  on: {
    request: planModeRequest,
    toolCall: {
      tools: PLAN_WRITE_TOOLS,
      armed: (ctx) => ctx.harness.planModeActive === true,
      handle: planModeToolCall,
    },
  },
};
