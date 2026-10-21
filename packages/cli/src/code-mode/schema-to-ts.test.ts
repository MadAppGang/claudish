import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MAX_SCHEMA_DEPTH, schemaToTs } from "./schema-to-ts.js";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: string[];
  items?: Schema;
  description?: string;
};
const capture = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/code-mode/claude-code-request-body.json", import.meta.url),
    "utf8"
  )
) as { tools: Array<{ name: string; parameters: Schema }> };
const schemaFor = (name: string) => {
  const tool = capture.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`captured tool missing: ${name}`);
  return tool.parameters;
};

describe("schema-to-ts from real Claude Code tool schemas", () => {
  test("renders every captured schema without depending on a pinned tool count", () => {
    expect(capture.tools.length).toBeGreaterThan(0);
    for (const tool of capture.tools) {
      const rendered = schemaToTs(tool.parameters);
      expect(typeof rendered).toBe("string");
      expect(rendered.length).toBeGreaterThan(0);
    }
  });

  test("Read file_path is required, offset is optional, and descriptions become comments", () => {
    const rendered = schemaToTs(schemaFor("Read"));
    expect(rendered).toMatch(/\bfile_path\s*:\s*string/);
    expect(rendered).not.toMatch(/\bfile_path\s*\?/);
    expect(rendered).toMatch(/\boffset\s*\?\s*:\s*number/);
    expect(rendered).toContain(`// ${schemaFor("Read").properties!.file_path!.description}`);
  });

  test("Agent enum values are literal unions and retain the optional property", () => {
    const schema = schemaFor("Agent");
    const rendered = schemaToTs(schema);
    expect(rendered).toMatch(/\bmodel\s*\?\s*:/);
    for (const value of schema.properties!.model!.enum!)
      expect(rendered).toContain(JSON.stringify(value));
    expect(rendered).toContain(" | ");
  });

  test("ReportFindings arrays retain nested object fields and their requiredness", () => {
    const rendered = schemaToTs(schemaFor("ReportFindings"));
    expect(rendered).toMatch(/\bfindings\s*:/);
    expect(rendered).toMatch(/\bfile\s*:\s*string/);
    expect(rendered).toMatch(/\bline\s*\?\s*:\s*number/);
    expect(rendered).toMatch(/Array<|\[\]/);
  });

  test.each(["anyOf", "oneOf"])("renders %s alternatives as a union", (keyword) => {
    // Derived structural schema: the captured Agent.model enum plus Read.offset.
    const schema = {
      [keyword]: [schemaFor("Agent").properties!.model, schemaFor("Read").properties!.offset],
    };
    const rendered = schemaToTs(schema);
    expect(rendered).toContain("number");
    expect(rendered).toContain(" | ");
    for (const value of schemaFor("Agent").properties!.model!.enum!)
      expect(rendered).toContain(JSON.stringify(value));
  });

  test("object nesting beyond four levels degrades to unknown, not unlimited expansion", () => {
    expect(MAX_SCHEMA_DEPTH).toBe(4);
    // Derived structural input: wrap the real Read schema, never fabricate a request body.
    let deep: Schema = schemaFor("Read");
    for (let index = 0; index < 6; index++) {
      deep = { type: "object", properties: { nested: deep }, required: ["nested"] };
    }
    const rendered = schemaToTs(deep);
    expect(rendered).toContain("unknown");
    expect(rendered).not.toContain("file_path");
    expect(schemaToTs(schemaFor("Read"))).toContain("file_path");
  });
});
