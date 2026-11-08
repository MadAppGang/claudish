/**
 * Ported 1:1 from behavior/rules/plan-mode.test.ts: `planFilePathRule.onRequest`
 * → `on.request`, `planFilePathRule.onToolCall` → `on.toolCall.handle`, and the
 * rule's `armed` gate → `on.toolCall.armed`.
 */

import { describe, expect, it } from "bun:test";
import type { HarnessFacts, RequestContext, ToolCallContext } from "../public.js";
import { BUILTIN_HOOKS } from "./index.js";
import {
  PLAN_MODE_HOOK_ID,
  PLAN_WRITE_TOOLS,
  planModeHook,
  planModeRequest,
  planModeToolCall,
} from "./plan-mode.js";

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
    prior: [],
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

function toolCallContext(
  args: Record<string, unknown>,
  harness: HarnessFacts = { planModeActive: true, planFilePath: assignedPath, planDir }
): ToolCallContext {
  return {
    ...requestContext({ harness }),
    event: "toolCall",
    tool: { id: "toolu_1", name: "Write", args, rawArgs: JSON.stringify(args) },
  } as unknown as ToolCallContext;
}

describe("plan-mode/plan-file-path toolCall handler", () => {
  it("redirects an invented filename inside the assigned plan directory", () => {
    const actions = planModeToolCall(
      toolCallContext({ file_path: `${planDir}/invented-name.md`, content: "# Plan" })
    );

    expect(actions).toHaveLength(1);
    const [action] = actions;
    if (action?.type !== "repairToolArgs") throw new Error("expected repairToolArgs action");
    expect(action.args).toEqual({ file_path: assignedPath, content: "# Plan" });
  });

  it("does not touch a normal project file outside the plan directory", () => {
    expect(
      planModeToolCall(
        toolCallContext({ file_path: "/workspace/src/implementation.ts", content: "source" })
      )
    ).toEqual([]);
  });

  it("does not touch the already-correct assigned path", () => {
    expect(
      planModeToolCall(toolCallContext({ file_path: assignedPath, content: "# Correct plan" }))
    ).toEqual([]);
  });

  it("ignores missing and non-string file_path values", () => {
    expect(planModeToolCall(toolCallContext({ content: "missing" }))).toEqual([]);
    expect(planModeToolCall(toolCallContext({ file_path: 42, content: "number" }))).toEqual([]);
    expect(planModeToolCall(toolCallContext({ file_path: null, content: "null" }))).toEqual([]);
  });

  it("does nothing without a plan file path and directory", () => {
    expect(
      planModeToolCall(toolCallContext({ file_path: `${planDir}/x.md` }, { planModeActive: true }))
    ).toEqual([]);
  });
});

describe("plan-mode built-in definition", () => {
  it("intercepts the write tools, armed only in plan mode", () => {
    const tc = planModeHook.on?.toolCall;
    expect(tc?.tools).toEqual(PLAN_WRITE_TOOLS);
    expect(tc?.tools).toEqual(["Write", "Edit", "NotebookEdit"]);
    expect(tc?.observe).toBeUndefined();
    expect(tc?.armed?.(requestContext())).toBe(true);
    // Outside plan mode it must not make the seam hold Write/Edit arguments.
    expect(tc?.armed?.(requestContext({ harness: { planModeActive: false } }))).toBe(false);
  });

  it("keeps its id, defaults to fix, and is scoped to foreign routes", () => {
    expect(planModeHook.id).toBe("plan-mode/plan-file-path");
    expect(planModeHook.defaultSeverity).toBe("fix");
    expect(planModeHook.routes).toBe("foreign");
    expect(BUILTIN_HOOKS).toContain(planModeHook);
  });
});
