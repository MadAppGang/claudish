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
  test("antigravity renames the file and shell built-ins to the names agy sends", () => {
    const names = ["Bash", "Read", "Write", "Edit"];
    const { request: out } = aliasToolsForProvider({ tools: names.map(tool) }, "antigravity");
    expect(out.tools.map((t: any) => t.name)).toEqual([
      "run_command",
      "read_file",
      "write_file",
      "edit_file",
    ]);
  });

  test("antigravity renames the agent, question, search, message and workflow tools", () => {
    const names = ["Agent", "AskUserQuestion", "WebSearch", "SendMessage", "Workflow"];
    const { request: out } = aliasToolsForProvider({ tools: names.map(tool) }, "antigravity");
    expect(out.tools.map((t: any) => t.name)).toEqual([
      "invoke_subagent",
      "ask_question",
      "search_web",
      "send_message",
      "run_workflow",
    ]);
  });

  test("antigravity keeps the search and listing names of agy's other tool set", () => {
    const names = ["Grep", "Glob", "LS"];
    const { request: out } = aliasToolsForProvider({ tools: names.map(tool) }, "antigravity");
    expect(out.tools.map((t: any) => t.name)).toEqual(["grep_search", "find_by_name", "list_dir"]);
  });

  test("a renamed name is restored to the Claude Code name", () => {
    const names = ["Read", "Write", "Agent"];
    const { restore } = aliasToolsForProvider({ tools: names.map(tool) }, "antigravity");
    expect(["read_file", "write_file", "invoke_subagent"].map(restore)).toEqual(names);
  });

  test("every other tool keeps its name", () => {
    const names = ["TodoWrite", "Skill", "ToolSearch", "mcp__plugin_x__do"];
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

  test("keeps a schema with no properties and the tool_result id untouched", () => {
    const { request: out } = aliasToolsForProvider(request(), "antigravity");
    expect(out.tools[0].input_schema).toEqual({ type: "object" });
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

describe("aliasToolsForProvider: argument names", () => {
  const schema = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object",
    properties,
    required,
  });
  const str = { type: "string" };
  const num = { type: "number" };
  const fileTools = () => ({
    tools: [
      {
        name: "Bash",
        input_schema: schema(
          { command: str, timeout: num, description: str, run_in_background: { type: "boolean" } },
          ["command"]
        ),
      },
      {
        name: "Read",
        input_schema: schema({ file_path: str, offset: num, limit: num, pages: str }, [
          "file_path",
        ]),
      },
      { name: "Write", input_schema: schema({ file_path: str, content: str }, ["file_path"]) },
      {
        name: "Edit",
        input_schema: schema(
          { file_path: str, old_string: str, new_string: str, replace_all: { type: "boolean" } },
          ["file_path", "old_string", "new_string"]
        ),
      },
      { name: "TodoWrite", input_schema: schema({ file_path: str }, ["file_path"]) },
    ],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "ls", description: "List files", timeout: 9000 },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "Read",
            input: { file_path: "/a.txt", offset: 2, limit: 2 },
          },
          {
            type: "tool_use",
            id: "t3",
            name: "Edit",
            input: { file_path: "/a.txt", old_string: "x", new_string: "y" },
          },
          { type: "tool_use", id: "t4", name: "TodoWrite", input: { file_path: "/a.txt" } },
        ],
      },
    ],
  });

  test("the four file and shell tools declare the names agy declares", () => {
    const { request: out } = aliasToolsForProvider(fileTools(), "antigravity");
    const declared = (index: number) => out.tools[index].input_schema as any;
    expect(Object.keys(declared(0).properties)).toEqual([
      "CommandLine",
      "timeout",
      "toolSummary",
      "IsDaemon",
    ]);
    expect(declared(0).required).toEqual(["CommandLine"]);
    expect(Object.keys(declared(1).properties)).toEqual(["Path", "pages", "StartLine", "EndLine"]);
    expect(declared(1).required).toEqual(["Path"]);
    expect(Object.keys(declared(2).properties)).toEqual(["Path", "Content"]);
    expect(Object.keys(declared(3).properties)).toEqual([
      "Path",
      "Target",
      "Replacement",
      "replace_all",
    ]);
    expect(declared(3).required).toEqual(["Path", "Target", "Replacement"]);
  });

  test("a tool that is not renamed keeps its schema and its call's input", () => {
    const { request: out } = aliasToolsForProvider(fileTools(), "antigravity");
    expect(Object.keys((out.tools[4].input_schema as any).properties)).toEqual(["file_path"]);
    expect((out.messages[0].content as any[])[3].input).toEqual({ file_path: "/a.txt" });
  });

  test("a call in the history carries agy's names, a line range by its first and last line", () => {
    const { request: out } = aliasToolsForProvider(fileTools(), "antigravity");
    const calls = out.messages[0].content as any[];
    expect(calls[0].input).toEqual({
      CommandLine: "ls",
      toolSummary: "List files",
      timeout: 9000,
    });
    expect(calls[1].input).toEqual({ Path: "/a.txt", StartLine: 2, EndLine: 3 });
    expect(calls[2].input).toEqual({ Path: "/a.txt", Target: "x", Replacement: "y" });
  });

  test("a returned call's arguments go back to Claude Code's names", () => {
    const { restoreArguments } = aliasToolsForProvider(fileTools(), "antigravity");
    expect(
      restoreArguments("run_command", {
        CommandLine: "ls",
        WaitMsBeforeAsync: 5000,
        toolSummary: "List files",
        IsDaemon: true,
      })
    ).toEqual({
      command: "ls",
      WaitMsBeforeAsync: 5000,
      description: "List files",
      run_in_background: true,
    });
    expect(restoreArguments("read_file", { Path: "/a.txt", StartLine: 2, EndLine: 3 })).toEqual({
      file_path: "/a.txt",
      offset: 2,
      limit: 2,
    });
    expect(restoreArguments("read_file", { Path: "/a.txt", EndLine: 40 })).toEqual({
      file_path: "/a.txt",
      limit: 40,
    });
    expect(restoreArguments("write_file", { Path: "/a.txt", Content: "hi" })).toEqual({
      file_path: "/a.txt",
      content: "hi",
    });
    expect(
      restoreArguments("edit_file", { Path: "/a.txt", Target: "x", Replacement: "y" })
    ).toEqual({ file_path: "/a.txt", old_string: "x", new_string: "y" });
  });

  test("the round trip of a call's input is the input", () => {
    const applied = aliasToolsForProvider(fileTools(), "antigravity");
    const sent = applied.request.messages[0].content as any[];
    const given = fileTools().messages[0].content as any[];
    for (let i = 0; i < 3; i++) {
      expect(applied.restoreArguments(sent[i].name, sent[i].input)).toEqual(given[i].input);
    }
  });

  test("a custom tool under the native name keeps its arguments both ways", () => {
    const applied = aliasToolsForProvider(
      {
        tools: [{ name: "read_file", input_schema: schema({ file_path: str }, ["file_path"]) }],
        messages: [],
      },
      "antigravity"
    );
    expect(Object.keys((applied.request.tools[0].input_schema as any).properties)).toEqual([
      "file_path",
    ]);
    expect(applied.restoreArguments("read_file", { Path: "/a.txt" })).toEqual({ Path: "/a.txt" });
  });

  test("a provider with no alias returns the arguments as given", () => {
    const { restoreArguments } = aliasToolsForProvider(fileTools(), "openai");
    expect(restoreArguments("run_command", { CommandLine: "ls" })).toEqual({ CommandLine: "ls" });
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
