/**
 * Ported from behavior/rules/plan-mode.test.ts (`planFilePathRule.onRequest`).
 * The tool half (`onToolCall` → `on.toolCall`) is ported with the response seam.
 */

import { describe, expect, it } from "bun:test";
import type { HarnessFacts, RequestContext } from "../public.js";
import { BUILTIN_HOOKS } from "./index.js";
import { PLAN_MODE_HOOK_ID, planModeHook, planModeRequest } from "./plan-mode.js";

const assignedPath = "/workspace/.custom-plans/assigned-session.md";
const planDir = "/workspace/.custom-plans";

function requestContext(
  overrides: { harness?: HarnessFacts; tools?: Array<{ name: string; description?: string }> } = {}
): RequestContext {
  return {
    hookId: PLAN_MODE_HOOK_ID,
    severity: "fix",
    log: () => {},
    signal: new AbortController().signal,
    event: "request",
    host: { mode: "other" },
    route: { modelId: "gpt-5.6-codex", provider: "openai-codex", native: false },
    request: {
      model: "gpt-5.6-codex",
      stream: true,
      systemText: "",
      messages: [],
      tools: overrides.tools ?? [{ name: "ExitPlanMode", description: "Exit plan mode" }],
    },
    harness: overrides.harness ?? { planModeActive: true, planFilePath: assignedPath, planDir },
    session: null,
  };
}

describe("plan-mode/plan-file-path request handler", () => {
  it("returns no actions when plan mode is inactive", () => {
    expect(planModeRequest(requestContext({ harness: { planModeActive: false } }))).toEqual([]);
  });

  it("returns no actions when ExitPlanMode is not offered", () => {
    const ctx = requestContext({ tools: [{ name: "Write", description: "Write a file" }] });

    expect(planModeRequest(ctx)).toEqual([]);
  });

  it("appends the exact assigned path to the ExitPlanMode description", () => {
    const actions = planModeRequest(requestContext());

    expect(actions).toHaveLength(1);
    const [action] = actions;
    if (action?.type !== "rewriteToolDescription") {
      throw new Error("expected rewriteToolDescription action");
    }
    expect(action.tool).toBe("ExitPlanMode");
    expect(action.append).toContain(
      `Your plan MUST be written to exactly this path:\n${assignedPath}`
    );
  });
});

describe("plan-mode built-in definition", () => {
  it("keeps its id, defaults to fix, and is scoped to foreign routes", () => {
    expect(planModeHook.id).toBe("plan-mode/plan-file-path");
    expect(planModeHook.defaultSeverity).toBe("fix");
    expect(planModeHook.routes).toBe("foreign");
    expect(BUILTIN_HOOKS).toContain(planModeHook);
  });
});
