import { describe, expect, it } from "bun:test";
import {
  type MutableClaudeRequest,
  type PlannedAction,
  applyStageA,
  applyStageB,
  applyToolCallActions,
  validateAction,
} from "./actions.js";
import { type RequestAction, type ToolCallAction, act } from "./public.js";

const plan = (hookId: string, action: RequestAction): PlannedAction<RequestAction> => ({
  hookId,
  action,
});

function request(overrides: Partial<MutableClaudeRequest> = {}): MutableClaudeRequest {
  return {
    system: "base",
    messages: [
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret plan", signature: "sig" },
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "plan" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "plan contents" }],
      },
    ],
    tools: [
      { name: "Read", description: "Read a file", input_schema: { type: "object" } },
      { name: "Write", description: "Write a file", input_schema: { type: "object" } },
      { name: "ExitPlanMode", description: "Exit.", input_schema: { type: "object" } },
    ],
    ...overrides,
  };
}

describe("validateAction", () => {
  it("allows only the event's actions", () => {
    expect(validateAction("request", act.injectSystemNote("x")).ok).toBe(true);
    expect(validateAction("request", act.appendText("x"))).toEqual({
      ok: false,
      reason: "not_allowed:appendText",
    });
    expect(validateAction("responseEnd", act.injectUserTurn("go")).ok).toBe(true);
    expect(validateAction("sessionBlocked", act.injectUserTurn("go")).ok).toBe(false);
    expect(validateAction("sessionEnd", act.warn("w")).ok).toBe(true);
  });

  it("restricts an observe-mode toolCall hook to warn", () => {
    expect(
      validateAction("toolCall", act.repairToolArgs({ a: 1 }, "r"), { observe: true })
    ).toEqual({ ok: false, reason: "observe_only" });
    expect(validateAction("toolCall", act.warn("w"), { observe: true }).ok).toBe(true);
  });

  it("rejects non-actions and unknown types", () => {
    expect(validateAction("request", null)).toEqual({ ok: false, reason: "not_an_action" });
    expect(validateAction("request", { type: "launchMissiles" })).toEqual({
      ok: false,
      reason: "not_allowed:launchMissiles",
    });
  });

  it("refuses an injectUserTurn starting with a slash once leading whitespace is ignored", () => {
    expect(validateAction("sessionIdle", act.injectUserTurn(" /clear"))).toEqual({
      ok: false,
      reason: "slash_command",
    });
    expect(validateAction("sessionIdle", act.injectUserTurn("\n\t/compact"))).toEqual({
      ok: false,
      reason: "slash_command",
    });
    expect(validateAction("sessionIdle", act.injectUserTurn("run a/b")).ok).toBe(true);
  });

  it("enforces text limits", () => {
    expect(validateAction("request", act.injectSystemNote(""))).toEqual({
      ok: false,
      reason: "empty_text",
    });
    expect(validateAction("request", act.injectSystemNote("x".repeat(20_000))).ok).toBe(true);
    expect(validateAction("request", act.injectSystemNote("x".repeat(20_001))).ok).toBe(false);
    expect(validateAction("request", act.rewriteToolDescription("T", "x".repeat(4_001))).ok).toBe(
      false
    );
    expect(validateAction("sessionIdle", act.injectUserTurn("x".repeat(100_001))).ok).toBe(false);
  });

  it("checks replaceToolSchema shape and size", () => {
    expect(
      validateAction("request", {
        type: "replaceToolSchema",
        tool: "Write",
        inputSchema: { type: "array" },
      })
    ).toEqual({ ok: false, reason: "schema_not_object" });
    expect(
      validateAction(
        "request",
        act.replaceToolSchema("Write", { type: "object", description: "x".repeat(70_000) })
      )
    ).toEqual({ ok: false, reason: "schema_too_large" });
    expect(
      validateAction("request", act.replaceToolSchema("Write", { type: "object", f: () => 1 }))
    ).toEqual({ ok: false, reason: "schema_not_json" });
  });

  it("checks annotateTurn key and value", () => {
    expect(validateAction("responseEnd", act.annotateTurn("files.read", ["a", 1])).ok).toBe(true);
    expect(validateAction("responseEnd", act.annotateTurn("Bad Key", 1))).toEqual({
      ok: false,
      reason: "invalid_key",
    });
    expect(validateAction("responseEnd", act.annotateTurn("k", "x".repeat(17_000)))).toEqual({
      ok: false,
      reason: "value_too_large",
    });
  });

  it("checks repairToolArgs and a regex find", () => {
    expect(validateAction("toolCall", act.repairToolArgs({ a: 1 }, "why")).ok).toBe(true);
    expect(validateAction("toolCall", { type: "repairToolArgs", args: [1], reason: "r" })).toEqual({
      ok: false,
      reason: "args_not_object",
    });
    expect(validateAction("request", act.replaceMessageText("(", "x", { regex: true }))).toEqual({
      ok: false,
      reason: "invalid_regex",
    });
    expect(
      validateAction("request", {
        type: "replaceMessageText",
        find: "a",
        replace: "b",
        roles: ["system"],
      })
    ).toEqual({ ok: false, reason: "invalid_roles" });
  });
});

describe("applyStageA — system notes", () => {
  it("appends to a string system as a new paragraph, once per identical text", () => {
    const req = request();
    const { results } = applyStageA(req, [
      plan("a", act.injectSystemNote("NOTE")),
      plan("b", act.injectSystemNote("NOTE")),
    ]);
    expect(req.system).toBe("base\n\nNOTE");
    expect(results.map((r) => [r.hookId, r.decision])).toEqual([
      ["a", "matched"],
      ["b", "superseded"],
    ]);
  });

  it("appends a text block to an array system without mutating the original array", () => {
    const original = [{ type: "text", text: "base" }];
    const req = request({ system: original });
    applyStageA(req, [plan("a", act.injectSystemNote("NOTE"))]);
    expect(req.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: "NOTE" },
    ]);
    expect(original.length).toBe(1);
  });

  it("sets the system prompt when the request has none", () => {
    const req = request({ system: undefined });
    applyStageA(req, [plan("a", act.injectSystemNote("NOTE"))]);
    expect(req.system).toBe("NOTE");
  });
});

describe("applyStageA — message text", () => {
  it("appendUserText lands at the end of the last user message, after tool_result", () => {
    const req = request();
    applyStageA(req, [plan("a", act.appendUserText("REMINDER"))]);
    const last = req.messages?.[2];
    expect(last.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "plan contents" },
      { type: "text", text: "REMINDER" },
    ]);
  });

  it("appendUserText normalises a string content to blocks first", () => {
    const req = request({ messages: [{ role: "user", content: "hi" }] });
    applyStageA(req, [plan("a", act.appendUserText("there"))]);
    expect(req.messages?.[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "there" },
    ]);
  });

  it("appendUserText with no user message is invalid", () => {
    const req = request({ messages: [{ role: "assistant", content: "x" }] });
    const { results } = applyStageA(req, [plan("a", act.appendUserText("x"))]);
    expect(results[0]).toMatchObject({ decision: "invalid", detail: "no_user_message" });
  });

  it("identical appended texts are applied once", () => {
    const req = request({ messages: [{ role: "user", content: "q" }] });
    const { results } = applyStageA(req, [
      plan("a", act.appendUserText("same")),
      plan("b", act.appendUserText("same")),
    ]);
    expect(req.messages?.[0].content.length).toBe(2);
    expect(results.map((r) => r.decision)).toEqual(["matched", "superseded"]);
  });

  it("never touches tool_use, tool_result or thinking, and defaults roles to user", () => {
    const req = request();
    const before = structuredClone(req.messages);
    applyStageA(req, [plan("a", act.replaceMessageText("plan", "PLAN"))]);
    // User string content was edited; the assistant turn (default roles) was not.
    expect(req.messages?.[0].content).toBe("first question");
    expect(req.messages?.[1]).toEqual(before?.[1]);
    // tool_result content is never edited even though it contains "plan".
    expect(req.messages?.[2]).toEqual(before?.[2]);

    applyStageA(req, [
      plan("a", act.replaceMessageText("check", "verify", { roles: ["assistant"] })),
    ]);
    const blocks = req.messages?.[1].content;
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "secret plan", signature: "sig" });
    expect(blocks[1]).toEqual({ type: "text", text: "let me verify" });
    expect(blocks[2].input).toEqual({ path: "plan" });
  });

  it("inserts a literal $500 verbatim and expands $1 in regex mode", () => {
    const req = request({ messages: [{ role: "user", content: "cost N, name: Ada Lovelace" }] });
    applyStageA(req, [
      plan("a", act.replaceMessageText("N", "$500")),
      plan("b", act.replaceMessageText("(\\w+) (\\w+)$", "$2 $1", { regex: true })),
    ]);
    expect(req.messages?.[0].content).toBe("cost $500, name: Lovelace Ada");
  });

  it("drops an emptied text block, and reverts an edit that would empty a message", () => {
    const req = request({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "DROP" },
            { type: "text", text: "keep" },
          ],
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "DROP" },
      ],
    });
    const { results } = applyStageA(req, [plan("a", act.removeMessageText("DROP"))]);
    expect(req.messages?.[0].content).toEqual([{ type: "text", text: "keep" }]);
    expect(req.messages?.[2].content).toBe("DROP");
    expect(results[0]).toMatchObject({ decision: "matched", detail: "empty_message_reverted:1" });
  });

  it("reports invalid empty_message when every changed message was reverted", () => {
    const req = request({ messages: [{ role: "user", content: "only" }] });
    const { results } = applyStageA(req, [plan("a", act.removeMessageText("only"))]);
    expect(req.messages?.[0].content).toBe("only");
    expect(results[0]).toMatchObject({ decision: "invalid", detail: "empty_message" });
  });

  it("applies message edits sequentially in effective order", () => {
    const req = request({ messages: [{ role: "user", content: "a" }] });
    applyStageA(req, [
      plan("a", act.replaceMessageText("a", "b")),
      plan("b", act.replaceMessageText("b", "c")),
      plan("c", act.appendUserText("d")),
    ]);
    expect(req.messages?.[0].content).toEqual([
      { type: "text", text: "c" },
      { type: "text", text: "d" },
    ]);
  });

  it("does not mutate the original message objects", () => {
    const original = { role: "user", content: [{ type: "text", text: "x" }] };
    const req = request({ messages: [original] });
    applyStageA(req, [plan("a", act.replaceMessageText("x", "y"))]);
    expect(original.content[0]?.text).toBe("x");
    expect(req.messages?.[0]).not.toBe(original);
  });
});

describe("applyStageA — tools", () => {
  it("removeTool is refused while a message holds a tool_use of that tool", () => {
    const req = request();
    const { results } = applyStageA(req, [plan("a", act.removeTool("Read"))]);
    expect(results[0]).toMatchObject({ decision: "invalid", detail: "tool_in_history" });
    expect(req.tools?.map((t) => t.name)).toEqual(["Read", "Write", "ExitPlanMode"]);
  });

  it("removes a tool, and supersedes every other action on it", () => {
    const req = request();
    const stage = applyStageA(req, [
      plan("a", act.replaceToolSchema("Write", { type: "object", properties: {} })),
      plan("b", act.removeTool("Write")),
      plan("c", act.removeTool("Write")),
      plan("d", act.rewriteToolDescription("Write", " more")),
    ]);
    expect(req.tools?.map((t) => t.name)).toEqual(["Read", "ExitPlanMode"]);
    expect(stage.results.map((r) => [r.hookId, r.decision, r.detail])).toEqual([
      ["a", "superseded", "tool_removed"],
      ["b", "matched", undefined],
      ["c", "superseded", "already_removed"],
    ]);
    const stageB = applyStageB(req.tools ?? [], null, stage.held, stage.removedTools);
    expect(stageB[0]).toMatchObject({
      hookId: "d",
      decision: "superseded",
      detail: "tool_removed",
    });
  });

  it("replaceToolSchema: first wins per tool; an unknown tool is invalid", () => {
    const original = request().tools?.[1];
    const req = request();
    const { results } = applyStageA(req, [
      plan("a", act.replaceToolSchema("Write", { type: "object", properties: { a: {} } })),
      plan("b", act.replaceToolSchema("Write", { type: "object", properties: { b: {} } })),
      plan("c", act.replaceToolSchema("Nope", { type: "object" })),
    ]);
    expect(req.tools?.[1].input_schema).toEqual({ type: "object", properties: { a: {} } });
    expect(original?.input_schema).toEqual({ type: "object" });
    expect(results.map((r) => [r.hookId, r.decision, r.detail])).toEqual([
      ["a", "matched", undefined],
      ["b", "superseded", undefined],
      ["c", "invalid", "unknown_tool"],
    ]);
  });

  it("removeTool on an unknown tool is invalid", () => {
    const { results } = applyStageA(request(), [plan("a", act.removeTool("Nope"))]);
    expect(results[0]).toMatchObject({ decision: "invalid", detail: "unknown_tool" });
  });

  it("holds description actions for stage B in effective order", () => {
    const { held } = applyStageA(request(), [
      plan("a", act.rewriteToolDescription("Write", " A")),
      plan("b", act.injectSystemNote("x")),
      plan("c", act.replaceToolDescription("Read", "R")),
      plan("d", act.warn("ignored here")),
    ]);
    expect(held.map((h) => h.hookId)).toEqual(["a", "c"]);
  });
});

describe("applyStageB — tool descriptions", () => {
  const claudeTools = () => [
    { name: "ExitPlanMode", description: "Exit plan mode." },
    { name: "Write", description: "Write." },
  ];
  // Chat Completions shape wraps in `function`; Responses shape does not.
  const chatTools = () => [
    { type: "function", function: { name: "ExitPlanMode", description: "Exit plan mode." } },
    { type: "function", function: { name: "Write", description: "Write." } },
  ];

  it("applies to both representations, after conversion", () => {
    const claude = claudeTools();
    const converted = chatTools();
    const results = applyStageB(claude, converted, [
      plan("plan", act.rewriteToolDescription("ExitPlanMode", " Write to /p.md first.")),
    ]);
    expect(claude[0]?.description).toBe("Exit plan mode. Write to /p.md first.");
    expect(converted[0]?.function.description).toBe("Exit plan mode. Write to /p.md first.");
    expect(results[0]).toMatchObject({ decision: "matched" });
  });

  it("appends after a summarised converted description, keeping the full append", () => {
    const claude = [{ name: "ExitPlanMode", description: "Long. Very long description." }];
    // What --summarize-tools left on the converted side: the first sentence.
    const converted = [{ name: "ExitPlanMode", description: "Long." }];
    const append = " IMPORTANT: the plan file is /exact/path.md; write it there.";
    applyStageB(claude, converted, [plan("p", act.rewriteToolDescription("ExitPlanMode", append))]);
    expect(converted[0]?.description).toBe(`Long.${append}`);
  });

  it("first description action per tool wins across append and replace", () => {
    const claude = claudeTools();
    const results = applyStageB(claude, chatTools(), [
      plan("a", act.replaceToolDescription("Write", "NEW")),
      plan("b", act.rewriteToolDescription("Write", " more")),
    ]);
    expect(claude[1]?.description).toBe("NEW");
    expect(results.map((r) => r.decision)).toEqual(["matched", "superseded"]);
  });

  it("an unknown tool is invalid; a capped tool changes the Claude copy only", () => {
    const claude = claudeTools();
    const converted = [chatTools()[0]];
    const results = applyStageB(claude, converted, [
      plan("a", act.rewriteToolDescription("Nope", " x")),
      plan("b", act.rewriteToolDescription("Write", " x")),
    ]);
    expect(results.map((r) => [r.decision, r.detail])).toEqual([
      ["invalid", "unknown_tool"],
      ["matched", "capped"],
    ]);
    expect(claude[1]?.description).toBe("Write. x");
  });

  it("applies once when both representations are the same array (native)", () => {
    const tools = claudeTools();
    applyStageB(tools, tools, [plan("a", act.rewriteToolDescription("Write", " x"))]);
    expect(tools[1]?.description).toBe("Write. x");
    const solo = claudeTools();
    applyStageB(solo, null, [plan("a", act.rewriteToolDescription("Write", " x"))]);
    expect(solo[1]?.description).toBe("Write. x");
  });

  it("replaces array elements instead of mutating tool objects", () => {
    const claude = claudeTools();
    const original = claude[1];
    applyStageB(claude, null, [plan("a", act.rewriteToolDescription("Write", " x"))]);
    expect(original?.description).toBe("Write.");
    expect(claude[1]).not.toBe(original);
  });
});

describe("applyToolCallActions", () => {
  it("first repairToolArgs wins; later ones are superseded", () => {
    const items: PlannedAction<ToolCallAction>[] = [
      { hookId: "a", action: act.repairToolArgs({ file_path: "/a" }, "a") },
      { hookId: "b", action: act.repairToolArgs({ file_path: "/b" }, "b") },
    ];
    const out = applyToolCallActions(items);
    expect(out.args).toEqual({ file_path: "/a" });
    expect(out.results.map((r) => r.decision)).toEqual(["matched", "superseded"]);
  });

  it("returns no args when nothing repaired", () => {
    expect(applyToolCallActions([{ hookId: "a", action: act.warn("w") }])).toEqual({
      results: [],
    });
  });
});
