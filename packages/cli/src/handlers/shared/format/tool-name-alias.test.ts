import { describe, expect, test } from "bun:test";
import { GeminiAPIFormat } from "../../../adapters/gemini-api-format.js";
import { applyStageB } from "../../../hooks/actions.js";
import { aliasToolsForProvider } from "./tool-name-alias.js";

const tool = (name: string) => ({
  name,
  description: `${name}.`,
  input_schema: { type: "object" },
});

const request = () => ({
  model: "gemini-4-carbon",
  tools: [tool("Bash"), tool("TodoWrite")],
  messages: [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Running it." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "t2", name: "TodoWrite", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }],
    },
  ],
});

describe("aliasToolsForProvider: which names change", () => {
  test("antigravity renames the six built-ins to agy's own names", () => {
    const names = ["Bash", "Write", "Edit", "Grep", "Glob", "LS"];
    const { request: out } = aliasToolsForProvider({ tools: names.map(tool) }, "antigravity");
    expect(out.tools.map((t: any) => t.name)).toEqual([
      "run_command",
      "write_to_file",
      "edit_file",
      "grep_search",
      "find_by_name",
      "list_dir",
    ]);
  });

  test("Read and every other tool keep their names", () => {
    const names = ["Read", "TodoWrite", "mcp__plugin_x__do"];
    const { request: out } = aliasToolsForProvider({ tools: names.map(tool) }, "antigravity");
    expect(out.tools.map((t: any) => t.name)).toEqual(names);
  });

  test("a provider with no alias changes nothing, and both maps are identity", () => {
    for (const provider of ["openrouter", "devin", "google-gemini"]) {
      const applied = aliasToolsForProvider(request(), provider);
      expect(applied.request).toEqual(request());
      expect(applied.forward("Bash")).toBe("Bash");
      expect(applied.restore("run_command")).toBe("run_command");
    }
  });
});

describe("aliasToolsForProvider on a request", () => {
  test("renames tool definitions and assistant tool_use names, leaving unaliased ones", () => {
    const { request: out } = aliasToolsForProvider(request(), "antigravity");
    expect(out.tools[0].name).toBe("run_command");
    expect(out.tools[1].name).toBe("TodoWrite");
    const toolUses = (out.messages[0].content as any[]).filter((b: any) => b.type === "tool_use");
    expect(toolUses[0].name).toBe("run_command");
    expect(toolUses[1].name).toBe("TodoWrite");
  });

  test("keeps the input schema, the tool_use input and the tool_result id untouched", () => {
    const { request: out } = aliasToolsForProvider(request(), "antigravity");
    expect(out.tools[0].input_schema).toEqual({ type: "object" });
    const bash = (out.messages[0].content as any[]).find(
      (b: any) => b.type === "tool_use" && b.name === "run_command"
    );
    expect(bash.input).toEqual({ command: "ls" });
    expect((out.messages[1].content as any[])[0].tool_use_id).toBe("t1");
  });

  test("renames a forced tool_choice with its definition", () => {
    const { request: out } = aliasToolsForProvider(
      { ...request(), tool_choice: { type: "tool", name: "Bash" } },
      "antigravity"
    );
    expect(out.tool_choice).toEqual({ type: "tool", name: "run_command" });
  });

  test("leaves a tool_choice with no name, or an unaliased name, as given", () => {
    for (const choice of [{ type: "auto" }, { type: "any" }, { type: "tool", name: "TodoWrite" }]) {
      const { request: out } = aliasToolsForProvider(
        { ...request(), tool_choice: choice },
        "antigravity"
      );
      expect(out.tool_choice).toEqual(choice);
    }
  });

  test("does not mutate the request it is given", () => {
    const original = { ...request(), tool_choice: { type: "tool", name: "Bash" } };
    const copy = structuredClone(original);
    aliasToolsForProvider(original, "antigravity");
    expect(original).toEqual(copy);
  });

  test("round trip: restore recovers every declared name", () => {
    const before = request();
    const { request: out, restore, forward } = aliasToolsForProvider(before, "antigravity");
    expect(out.tools.map((t: any) => restore(t.name))).toEqual(before.tools.map((t) => t.name));
    expect(before.tools.map((t) => forward(t.name))).toEqual(out.tools.map((t: any) => t.name));
  });
});

describe("aliasToolsForProvider: a request that already declares a native name", () => {
  test("a custom run_command with no Bash is not restored to Bash", () => {
    const applied = aliasToolsForProvider({ tools: [tool("run_command")] }, "antigravity");
    expect(applied.request.tools[0].name).toBe("run_command");
    expect(applied.restore("run_command")).toBe("run_command");
  });

  test("Bash beside a custom run_command keeps its name: no name is declared twice", () => {
    const applied = aliasToolsForProvider(
      { tools: [tool("Bash"), tool("run_command"), tool("Edit")] },
      "antigravity"
    );
    const names = applied.request.tools.map((t: any) => t.name);
    expect(names).toEqual(["Bash", "run_command", "edit_file"]);
    expect(new Set(names).size).toBe(names.length);
    expect(applied.restore("run_command")).toBe("run_command");
    expect(applied.restore("edit_file")).toBe("Edit");
    expect(applied.forward("Bash")).toBe("Bash");
  });
});

describe("the aliased request through the Gemini adapter", () => {
  test("a forced tool_choice names a declared function", () => {
    const adapter = new GeminiAPIFormat("gemini-4-carbon");
    const { request: out } = aliasToolsForProvider(
      { ...request(), tool_choice: { type: "tool", name: "Bash" } },
      "antigravity"
    );
    const wire = adapter.buildPayload(out, adapter.convertMessages(out), adapter.convertTools(out));
    const declared = wire.tools[0].functionDeclarations.map((d: any) => d.name);
    const allowed = wire.toolConfig.functionCallingConfig.allowedFunctionNames;
    expect(allowed).toEqual(["run_command"]);
    expect(declared).toContain("run_command");
  });

  test("a stored tool call and its result carry one name on the next request", () => {
    // What the gemini-sse parser stores for a response that called `run_command`.
    const adapter = new GeminiAPIFormat("gemini-4-carbon");
    adapter.registerToolCall("t1", "run_command", "sig");
    const { request: out } = aliasToolsForProvider(request(), "antigravity");
    const contents = adapter.convertMessages(out);
    const names = contents
      .flatMap((m: any) => m.parts)
      .map((p: any) => p.functionCall?.name ?? p.functionResponse?.name)
      .filter((n: unknown) => n === "run_command" || n === "Bash");
    expect(names).toEqual(["run_command", "run_command"]);
  });
});

describe("one conversation whose declared tools change between requests", () => {
  const history = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
  ];
  const pairOn = (adapter: GeminiAPIFormat, tools: any[]) => {
    const { request: out } = aliasToolsForProvider({ tools, messages: history }, "antigravity");
    return adapter
      .convertMessages(out)
      .flatMap((m: any) => m.parts)
      .map((p: any) => p.functionCall?.name ?? p.functionResponse?.name);
  };

  test("a custom run_command appears: the call and its result both go back to Bash", () => {
    const adapter = new GeminiAPIFormat("gemini-4-carbon");
    adapter.registerToolCall("t1", "run_command", "sig1");
    expect(pairOn(adapter, [tool("Bash")])).toEqual(["run_command", "run_command"]);
    expect(pairOn(adapter, [tool("Bash"), tool("run_command")])).toEqual(["Bash", "Bash"]);
    expect(adapter.getThoughtSignature("t1")).toBe("sig1");
  });

  test("a custom run_command disappears: the call and its result both become run_command", () => {
    const adapter = new GeminiAPIFormat("gemini-4-carbon");
    adapter.registerToolCall("t1", "Bash", "sig1");
    expect(pairOn(adapter, [tool("Bash"), tool("run_command")])).toEqual(["Bash", "Bash"]);
    expect(pairOn(adapter, [tool("Bash")])).toEqual(["run_command", "run_command"]);
    expect(adapter.getThoughtSignature("t1")).toBe("sig1");
  });
});

describe("hook description actions on an aliased request", () => {
  const action = { type: "rewriteToolDescription", tool: "Bash", append: " NOTE" };

  test("an action on a renamed tool still matches through `forward`", () => {
    const adapter = new GeminiAPIFormat("gemini-4-carbon");
    const applied = aliasToolsForProvider({ tools: [tool("Bash")] }, "antigravity");
    const claudeTools = applied.request.tools;
    const wireTools = adapter.convertTools(applied.request);
    const results = applyStageB(
      claudeTools,
      wireTools,
      [{ action } as any],
      new Map(),
      applied.forward
    );
    expect(results.map((r) => r.decision)).toEqual(["matched"]);
    expect(claudeTools[0].description).toBe("Bash. NOTE");
    // The journal names the tool the hook asked for, not the wire name.
    expect((results[0].action as any).tool).toBe("Bash");
  });

  test("without the name map the same action finds no tool", () => {
    const applied = aliasToolsForProvider({ tools: [tool("Bash")] }, "antigravity");
    const results = applyStageB(applied.request.tools, null, [{ action } as any]);
    expect(results.map((r) => [r.decision, r.detail])).toEqual([["invalid", "unknown_tool"]]);
  });
});
