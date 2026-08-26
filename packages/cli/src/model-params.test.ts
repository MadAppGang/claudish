/**
 * --model-params parsing + deep-merge behavior.
 *
 * Pins the flag's parsing contract: comma-split k=v items, JSON coercion of
 * values, dot-notation nesting, repeat-merge (later flags win), values that
 * contain '=' after the first, and the deep-merge rules used at the
 * ComposedHandler choke point (objects merge recursively, scalars/arrays
 * replace, user params win over adapter defaults).
 */

import { describe, expect, test } from "bun:test";
import { deepMergeParams, parseModelParams } from "./model-params.js";

describe("parseModelParams — JSON coercion", () => {
  test("numbers, booleans, and null coerce", () => {
    expect(parseModelParams("temperature=0.2")).toEqual({ temperature: 0.2 });
    expect(parseModelParams("max_tokens=4096")).toEqual({ max_tokens: 4096 });
    expect(parseModelParams("penalty=-1.5")).toEqual({ penalty: -1.5 });
    expect(parseModelParams("stream=false")).toEqual({ stream: false });
    expect(parseModelParams("enable_thinking=true")).toEqual({ enable_thinking: true });
    expect(parseModelParams("stop=null")).toEqual({ stop: null });
  });

  test("quoted strings unquote", () => {
    expect(parseModelParams('mode="pro"')).toEqual({ mode: "pro" });
    // Quoting forces string type for a value that would otherwise coerce
    expect(parseModelParams('version="1.5"')).toEqual({ version: "1.5" });
  });

  test("non-JSON values stay raw strings", () => {
    expect(parseModelParams("effort=xhigh")).toEqual({ effort: "xhigh" });
  });

  test("value may contain '=' after the first", () => {
    expect(parseModelParams("extra_query=a=b&c=d")).toEqual({ extra_query: "a=b&c=d" });
  });
});

describe("parseModelParams — dot-notation nesting", () => {
  test("deep paths nest recursively", () => {
    expect(parseModelParams("a.b.c=1")).toEqual({ a: { b: { c: 1 } } });
  });

  test("sibling dot-paths in one flag combine instead of clobbering", () => {
    expect(parseModelParams("reasoning.mode=pro,reasoning.effort=max")).toEqual({
      reasoning: { mode: "pro", effort: "max" },
    });
  });
});

describe("parseModelParams — repeat-merge", () => {
  test("later occurrences win on overlap and add nested siblings", () => {
    let params = parseModelParams("temperature=0.2,reasoning.mode=fast");
    params = parseModelParams("reasoning.mode=pro,reasoning.summary=auto", params);
    expect(params).toEqual({
      temperature: 0.2,
      reasoning: { mode: "pro", summary: "auto" },
    });
  });
});

describe("parseModelParams — malformed input", () => {
  test("missing '=', empty key, and empty dot segment all throw", () => {
    expect(() => parseModelParams("temperature")).toThrow(/must be key=value/);
    expect(() => parseModelParams("=0.2")).toThrow(/must be key=value/);
    expect(() => parseModelParams("reasoning..mode=pro")).toThrow(/empty dot segment/);
  });

  test("empty items (stray commas) are skipped", () => {
    expect(parseModelParams("temperature=0.2,,")).toEqual({ temperature: 0.2 });
  });
});

describe("deepMergeParams — choke-point merge rules", () => {
  test("nested keys merge over an existing object: overlap wins, siblings survive, new keys add", () => {
    // The adapter (e.g. CodexAPIFormat) already built reasoning:{effort,summary};
    // user params must win on overlap (effort), keep siblings (summary), and add (mode).
    const payload: Record<string, any> = {
      model: "gpt-5.6-sol",
      reasoning: { effort: "medium", summary: "auto" },
    };
    deepMergeParams(payload, { reasoning: { mode: "pro", effort: "max" }, temperature: 0.2 });
    expect(payload).toEqual({
      model: "gpt-5.6-sol",
      reasoning: { effort: "max", summary: "auto", mode: "pro" },
      temperature: 0.2,
    });
  });

  test("scalars and arrays replace; a source object replaces a target scalar", () => {
    const payload: Record<string, any> = { stop: ["a", "b"], top_p: 0.9, reasoning: "on" };
    deepMergeParams(payload, { stop: ["c"], top_p: 0.5, reasoning: { mode: "pro" } });
    expect(payload).toEqual({ stop: ["c"], top_p: 0.5, reasoning: { mode: "pro" } });
  });

  test("source objects are cloned — later payload mutation can't corrupt the shared params map", () => {
    const params = { reasoning: { mode: "pro" } };
    const payload: Record<string, any> = {};
    deepMergeParams(payload, params);
    payload.reasoning.mode = "mutated";
    expect(params.reasoning.mode).toBe("pro");
  });
});
