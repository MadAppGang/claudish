/**
 * S4-b lot B2 — strict envelope parsing + schema-driven normalization (4a0948c).
 *
 * Anchors:
 *  - parseFunctionTagEnvelope reads `<function=NAME><parameter=P>V` as what it
 *    is — a delimited envelope — tried FIRST and strict: the whole trimmed
 *    response must be function blocks. Anything else returns null and the six
 *    loose patterns run as before. The loose Pattern 0's two failure modes
 *    (LAST value of a repeated parameter wins; a trailing `</function>` is
 *    swallowed into the value) disappear on the strict path.
 *  - Three schema-driven normalizations, in order: renameToDeclaredKeys (a
 *    value moves ONLY from a key the schema does not declare onto one it
 *    declares, that is required, and that is absent), applySchemaDefaults
 *    (absent REQUIRED keys take the client's own `default` — tool-agnostic
 *    survival of `ToolSearch.max_results = 5`), coerceToSchema (declared
 *    types; full-string numeric test so "3abc" never becomes 3; a FAILED
 *    coercion keeps the original).
 *  - `repaired: true` means exactly "a default or a rename was applied" —
 *    never "invented" and never coercion alone.
 *  - missingRequired: presence is KEY PRESENCE, never truthiness. An empty
 *    string is a present value a model may legitimately mean (live incident:
 *    `Edit{new_string:""}` — a deletion — rejected as "missing").
 *
 * Non-vacuity: written before the implementation.
 */

import { describe, expect, test } from "bun:test";
import {
  applySchemaDefaults,
  coerceToSchema,
  missingRequired,
  renameToDeclaredKeys,
} from "./schema-validate.js";
import { parseFunctionTagEnvelope, extractToolCallsFromText } from "./tool-call-recovery.js";

describe("S4-b lot B2: parseFunctionTagEnvelope (4a0948c)", () => {
  test("a pure envelope parses strictly, values trimmed", () => {
    const calls = parseFunctionTagEnvelope(
      "<function=Bash><parameter=command>ls -la</parameter></function>"
    );
    expect(calls).not.toBeNull();
    expect(calls!.length).toBe(1);
    expect(calls![0].name).toBe("Bash");
    expect(calls![0].arguments).toEqual({ command: "ls -la" });
  });

  test("two blocks parse as two calls", () => {
    const calls = parseFunctionTagEnvelope(
      "<function=Read><parameter=file_path>/a</parameter></function>\n" +
        "<function=Bash><parameter=command>ls</parameter></function>"
    );
    expect(calls).not.toBeNull();
    expect(calls!.map((c) => c.name)).toEqual(["Read", "Bash"]);
  });

  test("prose in front returns null — it must not short-circuit the loose patterns", () => {
    expect(
      parseFunctionTagEnvelope("Let me run this: <function=Bash><parameter=command>ls</parameter></function>")
    ).toBeNull();
  });

  test("a model EXPLAINING the format returns null", () => {
    expect(
      parseFunctionTagEnvelope(
        "The format is <function=NAME><parameter=P>value — here's an example."
      )
    ).toBeNull();
  });

  test("empty / whitespace input returns null", () => {
    expect(parseFunctionTagEnvelope("")).toBeNull();
    expect(parseFunctionTagEnvelope("   ")).toBeNull();
  });

  test("extractToolCallsFromText prefers the strict envelope over the loose scan", () => {
    const text = "<function=Bash><parameter=command>ls</parameter></function>";
    const calls = extractToolCallsFromText(text);
    expect(calls.length).toBe(1);
    expect(calls![0].arguments).toEqual({ command: "ls" });
  });

  test("the strict path still runs through the allowlist", () => {
    const text = "<function=Bash><parameter=command>ls</parameter></function>";
    expect(extractToolCallsFromText(text, ["Read"]).length).toBe(0);
    expect(extractToolCallsFromText(text, ["Bash"]).length).toBe(1);
  });
});

describe("S4-b lot B2: schema-validate primitives", () => {
  test("missingRequired: presence is key presence — empty string is PRESENT", () => {
    const schema = {
      required: ["file_path", "new_string"],
      properties: { file_path: { type: "string" }, new_string: { type: "string" } },
    };
    expect(missingRequired(schema, { file_path: "/a", new_string: "" })).toEqual([]);
    expect(missingRequired(schema, { file_path: "/a" })).toEqual(["new_string"]);
  });

  test("renameToDeclaredKeys: moves only undeclared→declared+required+absent", () => {
    const schema = {
      required: ["command"],
      properties: { command: { type: "string" } },
    };
    const moved = renameToDeclaredKeys(schema, { cmd: "ls" });
    expect(moved.renamed).toEqual(["cmd→command"]);
    expect((moved.args as any).command).toBe("ls");
    expect((moved.args as any).cmd).toBeUndefined();
    // A supplied value always wins — never overwritten.
    const kept = renameToDeclaredKeys(schema, { command: "pwd", cmd: "ls" });
    expect(kept.renamed).toEqual([]);
    expect((kept.args as any).command).toBe("pwd");
    // A synonym the schema itself declares means something else — never moves.
    const declaredSynonym = renameToDeclaredKeys(
      { required: ["command"], properties: { command: { type: "string" }, cmd: { type: "string" } } },
      { cmd: "ls" }
    );
    expect(declaredSynonym.renamed).toEqual([]);
  });

  test("applySchemaDefaults: absent required keys take the client's own default", () => {
    const schema = {
      required: ["query", "max_results"],
      properties: { query: { type: "string" }, max_results: { type: "number", default: 5 } },
    };
    const filled = applySchemaDefaults(schema, { query: "q" });
    expect(filled.applied).toEqual(["max_results"]);
    expect((filled.args as any).max_results).toBe(5);
    // Optional keys never get defaults applied here.
    const optional = applySchemaDefaults(
      { required: ["query"], properties: { query: { type: "string" }, max_results: { type: "number", default: 5 } } },
      { query: "q" }
    );
    expect(optional.applied).toEqual([]);
  });

  test("coerceToSchema: full-string numeric — '3abc' never becomes 3; failed coercion keeps the original", () => {
    const schema = { properties: { n: { type: "number" }, b: { type: "boolean" }, s: { type: "string" } } };
    const coerced = coerceToSchema(schema, { n: "42", b: "true", s: 7 });
    expect((coerced.args as any).n).toBe(42);
    expect((coerced.args as any).b).toBe(true);
    expect((coerced.args as any).s).toBe("7");
    const failed = coerceToSchema(schema, { n: "3abc" });
    expect((failed.args as any).n).toBe("3abc");
    expect(failed.coerced).toEqual([]);
  });
});
