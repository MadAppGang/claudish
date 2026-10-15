/**
 * Unit contract for the minimal schema reader.
 *
 * These are assertions about OUR functions, not about any model: no case here
 * claims that some provider emitted some shape. The one behaviour that DOES rest
 * on a real model — an empty-string required argument — is gated separately by a
 * live capture, in `format-translation.test.ts` against
 * `sse-responses/grok-4.6-openai-edit-empty-new-string.sse`.
 */

import { describe, expect, test } from "bun:test";
import {
  applySchemaDefaults,
  coerceToSchema,
  missingRequired,
  renameToDeclaredKeys,
} from "./schema-validate.js";

describe("missingRequired: presence is key presence, not truthiness", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "string" },
      b: { type: "number" },
      c: { type: "boolean" },
      d: { type: "array" },
    },
    required: ["a", "b", "c", "d"],
  };

  test("falsy-but-supplied values are present", () => {
    expect(missingRequired(schema, { a: "", b: 0, c: false, d: [] })).toEqual([]);
  });

  test("an absent key is missing", () => {
    expect(missingRequired(schema, { b: 0, c: false, d: [] })).toEqual(["a"]);
  });

  test("undefined and null are missing; an explicit empty object is not", () => {
    expect(missingRequired({ ...schema, required: ["a"] }, { a: undefined })).toEqual(["a"]);
    expect(missingRequired({ ...schema, required: ["a"] }, { a: null })).toEqual(["a"]);
    expect(missingRequired({ ...schema, required: ["a"] }, { a: {} })).toEqual([]);
  });

  test("a schema with no required list demands nothing", () => {
    expect(missingRequired({ type: "object" }, {})).toEqual([]);
    expect(missingRequired(undefined, {})).toEqual([]);
  });
});

describe("coerceToSchema: declared types, and a failure keeps the value", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      ratio: { type: "number" },
      flag: { type: "boolean" },
      name: { type: "string" },
    },
  };

  test("a full numeric string becomes a number", () => {
    expect(coerceToSchema(schema, { count: "5", ratio: "-1.5e2" }).args).toEqual({
      count: 5,
      ratio: -150,
    });
  });

  test('"3abc" is NOT 3 — a partial parse would invent an argument', () => {
    expect(coerceToSchema(schema, { count: "3abc" }).args).toEqual({ count: "3abc" });
  });

  test("a non-integer string is not forced into an integer field", () => {
    expect(coerceToSchema(schema, { count: "2.5" }).args).toEqual({ count: "2.5" });
  });

  test('only exactly "true"/"false" become booleans', () => {
    expect(coerceToSchema(schema, { flag: "true" }).args).toEqual({ flag: true });
    expect(coerceToSchema(schema, { flag: "False" }).args).toEqual({ flag: false });
    expect(coerceToSchema(schema, { flag: "yes" }).args).toEqual({ flag: "yes" });
  });

  test("a value already of the declared type is untouched", () => {
    const args = { count: 5, name: "x" };
    expect(coerceToSchema(schema, args).args).toBe(args);
  });

  test("an undeclared key is left exactly as it came", () => {
    expect(coerceToSchema(schema, { whatever: "7" }).args).toEqual({ whatever: "7" });
  });
});

/**
 * The `array` and `object` branches, which shipped untested.
 *
 * They are the branches the `<function=NAME><parameter=P>` envelope needs most:
 * that wire has no types at all, so a tool declaring `string[]` receives the
 * JSON text `'["a","b"]'` and a tool declaring an object receives `'{"a":1}'`.
 * Everything here is a call on this tree's own function with argument values —
 * no provider bytes, no fixture.
 */
describe("coerceToSchema: array and object", () => {
  const schema = {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
      sizes: { type: "array", items: { type: "number" } },
      anything: { type: "array" },
      options: { type: "object" },
    },
  };

  test("a JSON array string becomes an array", () => {
    expect(coerceToSchema(schema, { tags: '["a","b"]' }).args).toEqual({ tags: ["a", "b"] });
  });

  test("the declared items type is applied to each element", () => {
    expect(coerceToSchema(schema, { sizes: '["1","2.5"]' }).args).toEqual({ sizes: [1, 2.5] });
  });

  test("an element that cannot be coerced keeps its own value, and its siblings still convert", () => {
    // A failed element is never dropped and never guessed at: the harness
    // re-validates the call, so a wrong type is visible while a missing one is not.
    expect(coerceToSchema(schema, { sizes: '["1","later"]' }).args).toEqual({
      sizes: [1, "later"],
    });
  });

  test("an array with no declared items is parsed but not touched element-wise", () => {
    expect(coerceToSchema(schema, { anything: '["1",true,null]' }).args).toEqual({
      anything: ["1", true, null],
    });
  });

  test("a JSON object string is NOT accepted for an array field", () => {
    // `parseJsonOfKind` keeps the parse only if it decoded to the expected kind.
    // Without that check a tool declaring a list would receive a map.
    expect(coerceToSchema(schema, { tags: '{"a":1}' }).args).toEqual({ tags: '{"a":1}' });
  });

  test("a JSON object string becomes an object", () => {
    expect(coerceToSchema(schema, { options: '{"depth":2}' }).args).toEqual({
      options: { depth: 2 },
    });
  });

  test("a JSON array string is NOT accepted for an object field", () => {
    expect(coerceToSchema(schema, { options: "[1,2]" }).args).toEqual({ options: "[1,2]" });
  });

  test("a string that is not JSON at all keeps its value", () => {
    expect(coerceToSchema(schema, { tags: "a, b", options: "depth=2" }).args).toEqual({
      tags: "a, b",
      options: "depth=2",
    });
  });

  test("a bare scalar is not wrapped into a one-element array", () => {
    // Wrapping would be inventing a shape the model did not write.
    expect(coerceToSchema(schema, { tags: "a" }).args).toEqual({ tags: "a" });
  });

  test("a value already of the declared kind is left alone, elements included", () => {
    // The top-level type already matches, so the branch never runs — the
    // element-wise pass exists for values parsed OUT of a string, not for
    // re-typing an array a structured wire already delivered.
    const args = { sizes: ["1", "2"] };
    expect(coerceToSchema(schema, args).args).toBe(args);
  });

  test("the coerced-key list names exactly the keys that changed", () => {
    const result = coerceToSchema(schema, { tags: '["a"]', options: "not json" });
    expect(result.coerced).toEqual(["tags"]);
  });
});

describe("applySchemaDefaults: the schema's own value, for required keys only", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "integer", default: 5 },
      verbose: { type: "boolean", default: false },
    },
    required: ["query", "max_results"],
  };

  test("an absent required key takes its declared default", () => {
    const { args, applied } = applySchemaDefaults(schema, { query: "x" });
    expect(args).toEqual({ query: "x", max_results: 5 });
    expect(applied).toEqual(["max_results"]);
  });

  test("a supplied value always wins, including a falsy one", () => {
    expect(applySchemaDefaults(schema, { query: "x", max_results: 0 }).args.max_results).toBe(0);
  });

  test("an OPTIONAL key's default is not applied", () => {
    // Deliberate: it would flip `repaired` on calls that were already valid, and
    // `repaired` supersedes an already-streamed tool block in openai-sse.ts.
    expect(applySchemaDefaults(schema, { query: "x" }).args).not.toHaveProperty("verbose");
  });
});

describe("renameToDeclaredKeys: moves a supplied value, never invents one", () => {
  const schema = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };

  test("an undeclared synonym moves onto the declared required key", () => {
    const { args, renamed } = renameToDeclaredKeys(schema, { cmd: "ls -la" });
    expect(args).toEqual({ command: "ls -la" });
    expect(renamed).toEqual(["cmd→command"]);
  });

  test("a supplied target is never overwritten", () => {
    expect(renameToDeclaredKeys(schema, { command: "real", cmd: "other" }).args).toEqual({
      command: "real",
      cmd: "other",
    });
  });

  test("an empty string counts as supplied and blocks the rename", () => {
    expect(renameToDeclaredKeys(schema, { command: "", cmd: "other" }).args.command).toBe("");
  });

  test("a synonym the schema ALSO declares means something else and never moves", () => {
    const declaresBoth = {
      type: "object",
      properties: { command: { type: "string" }, script: { type: "string" } },
      required: ["command"],
    };
    expect(renameToDeclaredKeys(declaresBoth, { script: "x" }).args).toEqual({ script: "x" });
  });

  test("nothing is invented when no synonym was supplied", () => {
    expect(renameToDeclaredKeys(schema, {}).args).toEqual({});
    expect(missingRequired(schema, renameToDeclaredKeys(schema, {}).args)).toEqual(["command"]);
  });

  test("a non-required declared key is not a rename target", () => {
    const optional = {
      type: "object",
      properties: { command: { type: "string" } },
      required: [],
    };
    expect(renameToDeclaredKeys(optional, { cmd: "ls" }).args).toEqual({ cmd: "ls" });
  });
});
