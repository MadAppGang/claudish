import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_EXEC_TOOL_BUDGET,
  EXEC_TOOL_GRAMMAR,
  type ExecToolDefinition,
  renderExecTool,
} from "./exec-tool.js";

const readData = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test-fixtures/code-mode/${name}`, import.meta.url), "utf8"));
const officialExec = readData("exec-tool.json") as {
  format: ExecToolDefinition["format"];
};
const captured = readData("claude-code-request-body.json") as {
  tools: Array<{ name: string; description: string; parameters: unknown }>;
};
// Derived from the real captured function schemas: only the schema field changes name
// from Responses `parameters` to Claude Code `input_schema`; the schemas are unchanged.
const tools = captured.tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
}));

const sizedTools = () => {
  const schema = captured.tools.find((tool) => tool.name === "CronDelete")!.parameters;
  // Derived structural tool-list inputs: real names and schema, enlarged descriptions
  // to exercise policy byte limits independently of today's tool count/descriptions.
  return captured.tools.slice(0, 16).map((tool) => ({
    name: tool.name,
    description: "é".repeat(1750),
    input_schema: schema,
  }));
};

describe("freeform exec tool", () => {
  test("grammar is byte-for-byte the official captured grammar", () => {
    const rendered = renderExecTool(tools);
    expect(rendered.tool.type).toBe("custom");
    expect(rendered.tool.name).toBe("exec");
    expect(rendered.tool.format).toEqual(officialExec.format);
    expect(Buffer.from(EXEC_TOOL_GRAMMAR).equals(Buffer.from(officialExec.format.definition))).toBe(
      true
    );
    expect(rendered.tool.description).toMatch(/\btext\(/);
    expect(rendered.tool.description).toContain("exit()");
    expect(rendered.tool.description).toContain("ALL_TOOLS");
    expect(rendered.tool.description).toContain("Promise.allSettled");
  });

  test("ALL_TOOLS retains full schemas and descriptions even when every declaration is deferred", () => {
    const rendered = renderExecTool(tools, { perToolBytes: 1, totalBytes: 1 });
    const accepted = tools.filter((tool) => !rendered.names.skipped.includes(tool.name as string));
    expect(rendered.allTools).toEqual(
      accepted.map((tool) => ({
        name: rendered.names.identFor(tool.name)!,
        description: tool.description,
        inputSchema: tool.input_schema,
      }))
    );
    expect(rendered.deferred).toEqual(accepted.map((tool) => tool.name as string));
    expect(rendered.tool.description).toContain("Deferred tools");
    for (const tool of accepted) {
      expect(rendered.tool.description).toContain(rendered.names.identFor(tool.name as string)!);
    }
  });

  test("per-tool byte ceiling defers an oversize declaration but not a later small tool", () => {
    expect(DEFAULT_EXEC_TOOL_BUDGET.perToolBytes).toBe(6144);
    // Derived schema: repeat the real Read.file_path property, making the declaration
    // alone exceed 6 KiB regardless of how prose descriptions are shortened.
    const readSchema = captured.tools.find((tool) => tool.name === "Read")!.parameters as {
      properties: { file_path: unknown };
    };
    const oversized = {
      ...tools[0]!,
      description: "Large structural schema",
      input_schema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 300 }, (_, index) => [
            `file_path_${index}`,
            readSchema.properties.file_path,
          ])
        ),
      },
    };
    const small = tools.find((tool) => tool.name === "CronDelete")!;
    const rendered = renderExecTool([oversized, small]);
    expect(rendered.deferred).toEqual([oversized.name as string]);
    expect(rendered.tool.description).toContain(`### \`${small.name}\``);
    expect(rendered.tool.description).not.toContain(`### \`${oversized.name}\``);
    expect(rendered.allTools.map((tool) => tool.name)).toEqual([
      rendered.names.identFor(oversized.name as string)!,
      rendered.names.identFor(small.name as string)!,
    ]);
  });

  test("total byte budget counts UTF-8 sections in request order", () => {
    const pair = sizedTools().slice(0, 2);
    const individual = pair.map((tool) => renderExecTool([tool], { totalBytes: 6144 }));
    for (const rendered of individual) expect(rendered.deferred).toEqual([]);
    const together = renderExecTool(pair, { totalBytes: 6144 });
    expect(together.deferred).toEqual([pair[1]!.name]);
    expect(together.tool.description).toContain(`### \`${pair[0]!.name}\``);
    expect(together.tool.description).not.toContain(`### \`${pair[1]!.name}\``);
    expect(together.allTools.map((tool) => tool.name)).toEqual(
      pair.map((tool) => together.names.identFor(tool.name)!)
    );
  });

  test("default total limit is 48 KiB and overflow stays deferred, not removed from ALL_TOOLS", () => {
    expect(DEFAULT_EXEC_TOOL_BUDGET.totalBytes).toBe(49152);
    const inputs = sizedTools();
    const unbounded = renderExecTool(inputs, { totalBytes: 1_000_000 });
    expect(unbounded.deferred).toEqual([]);
    const bounded = renderExecTool(inputs);
    expect(bounded.deferred.length).toBeGreaterThan(0);
    const firstDeferred = inputs.findIndex((tool) => tool.name === bounded.deferred[0]);
    expect(firstDeferred).toBeGreaterThan(0);
    expect(bounded.deferred).toEqual(inputs.slice(firstDeferred).map((tool) => tool.name));
    expect(bounded.allTools).toEqual(unbounded.allTools);
  });
});
