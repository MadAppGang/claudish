import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ToolNameTable, normalizeToolIdent } from "./tool-names.js";

const capture = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/code-mode/claude-code-request-body.json", import.meta.url),
    "utf8"
  )
) as { tools: Array<{ name: string }> };
const names = capture.tools.map((tool) => tool.name);
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

describe("code-mode tool names", () => {
  test("every captured name has a valid identifier and a reversible mapping unless reported skipped", () => {
    expect(names.length).toBeGreaterThan(0);
    const table = new ToolNameTable(names);
    expect(table.size + table.skipped.length).toBe(names.length);
    for (const original of names) {
      expect(normalizeToolIdent(original)).toMatch(identifier);
      if (table.skipped.includes(original)) continue;
      const ident = table.identFor(original)!;
      expect(ident).toMatch(identifier);
      expect(table.nameFor(ident)).toBe(original);
      expect(table.has(ident)).toBe(true);
    }
    expect(table.entries().map((entry) => entry.name)).toEqual(
      names.filter((name) => !table.skipped.includes(name))
    );
  });

  test("normalization also produces identifiers for punctuation and leading digits", () => {
    for (const name of ["9-file", "a.b", "a b", "tool$valid", "_"]) {
      expect(normalizeToolIdent(name)).toMatch(identifier);
    }
  });

  test("later colliding names are skipped and reported without replacing the first mapping", () => {
    // Derived from the captured MCP tool name and its normalized spelling.
    const first = names.find((name) => name.includes("-"))!;
    expect(first).toBeDefined();
    const second = normalizeToolIdent(first);
    expect(first).not.toBe(second);
    const table = new ToolNameTable([first, second, "Read"]);
    expect(table.skipped).toEqual([second]);
    expect(table.size).toBe(2);
    expect(table.identFor(first)).toBe(second);
    expect(table.nameFor(second)).toBe(first);
    expect(table.identFor(second)).toBeUndefined();
    expect(table.entries()).toEqual([
      { ident: second, name: first },
      { ident: "Read", name: "Read" },
    ]);
    expect(table.has("absent_tool")).toBe(false);
    expect(table.nameFor("absent_tool")).toBeUndefined();
  });
});
