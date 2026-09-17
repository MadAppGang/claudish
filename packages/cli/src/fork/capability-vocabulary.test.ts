import { describe, expect, test } from "bun:test";
import {
  buildCapabilityQuery,
  isCapabilityVocabEnabled,
  parseCapabilityDeclaration,
  CAPABILITY_VOCAB_FENCE,
} from "./capability-vocabulary";

function fence(json: string): string {
  return "```" + CAPABILITY_VOCAB_FENCE + "\n" + json + "\n```";
}

describe("capability vocabulary — parseCapabilityDeclaration (#83)", () => {
  test("no marker in text → null", () => {
    expect(parseCapabilityDeclaration("plain assistant prose, no fence at all")).toBeNull();
    expect(parseCapabilityDeclaration("```json\n{\"v\":1,\"vision\":true}\n```")).toBeNull();
  });

  test("full valid declaration parses with every field", () => {
    const decl = parseCapabilityDeclaration(
      'Working on it.\n' + fence('{"v":1,"vision":true,"context_tokens_min":200000,"reasoning_depth":"high","tool_call_density":"low","cost_class":"budget"}')
    );
    expect(decl).toEqual({
      v: 1,
      vision: true,
      context_tokens_min: 200000,
      reasoning_depth: "high",
      tool_call_density: "low",
      cost_class: "budget",
    });
  });

  test("subset declaration parses; unknown fields are dropped", () => {
    const decl = parseCapabilityDeclaration(fence('{"v":1,"vision":false,"jailbreak":"please","extra":{"nested":1}}'));
    expect(decl).toEqual({ v: 1, vision: false });
  });

  test("v may be omitted; wrong v is rejected outright", () => {
    expect(parseCapabilityDeclaration(fence('{"vision":true}'))).toEqual({ v: 1, vision: true });
    expect(parseCapabilityDeclaration(fence('{"v":2,"vision":true}'))).toBeNull();
  });

  test("mistyped and out-of-enum fields are dropped, not fatal", () => {
    const decl = parseCapabilityDeclaration(
      fence('{"vision":"true","context_tokens_min":-5,"reasoning_depth":"extreme","cost_class":"free","tool_call_density":"high"}')
    );
    expect(decl).toEqual({ v: 1, tool_call_density: "high" });
  });

  test("float context floor is floored; non-finite rejected", () => {
    expect(parseCapabilityDeclaration(fence('{"context_tokens_min":123.9}'))).toEqual({ v: 1, context_tokens_min: 123 });
    expect(parseCapabilityDeclaration(fence('{"context_tokens_min":Infinity}'))).toBeNull();
  });

  test("last complete block wins (a re-emitted declaration is the newest statement)", () => {
    const text = fence('{"vision":true}') + "\nsummary text\n" + fence('{"vision":false,"cost_class":"any"}');
    expect(parseCapabilityDeclaration(text)).toEqual({ v: 1, vision: false, cost_class: "any" });
  });

  test("unclosed fence does not parse", () => {
    expect(parseCapabilityDeclaration("```" + CAPABILITY_VOCAB_FENCE + '\n{"vision":true}')).toBeNull();
  });

  test("malformed JSON → null", () => {
    expect(parseCapabilityDeclaration(fence('{"vision":'))).toBeNull();
    expect(parseCapabilityDeclaration(fence("not json at all"))).toBeNull();
  });

  test("block holding only unrecognized fields → null (noise, not a declaration)", () => {
    expect(parseCapabilityDeclaration(fence('{"v":1,"mood":"optimistic"}'))).toBeNull();
  });

  test("non-object payloads → null", () => {
    expect(parseCapabilityDeclaration(fence("[1,2,3]"))).toBeNull();
    expect(parseCapabilityDeclaration(fence('"a string"'))).toBeNull();
    expect(parseCapabilityDeclaration(fence("null"))).toBeNull();
  });

  test("non-string input → null, never throws", () => {
    expect(parseCapabilityDeclaration(null as unknown as string)).toBeNull();
    expect(parseCapabilityDeclaration(undefined as unknown as string)).toBeNull();
  });
});

describe("capability vocabulary — buildCapabilityQuery (#83)", () => {
  test("states the [claudish] origin and the fence marker", () => {
    const q = buildCapabilityQuery();
    expect(q).toContain("**[claudish] Capability query");
    expect(q).toContain("`" + CAPABILITY_VOCAB_FENCE + "`");
  });

  test("names every vocabulary field so the channel is self-describing", () => {
    const q = buildCapabilityQuery();
    for (const field of ["vision", "context_tokens_min", "reasoning_depth", "tool_call_density", "cost_class"]) {
      expect(q).toContain('"' + field + '"');
    }
  });

  test("advisory-only contract is stated — doctrine 2026-08-23, no behavioral instruction", () => {
    const q = buildCapabilityQuery();
    expect(q).toContain("advisory inputs to routing only");
    expect(q).toContain("never override proxy-side policy");
    expect(q).not.toContain("risk");
    expect(q).not.toMatch(/resume|undo|revert|clean up/i);
  });

  test("separator shape composes with the failover notice rail", () => {
    const q = buildCapabilityQuery();
    expect(q.startsWith("\n---\n")).toBe(true);
  });

  test("round trip: a declaration written per the query's instruction parses back", () => {
    const q = buildCapabilityQuery();
    // The instruction the query gives, followed to the letter for one field set.
    const declaration = "```" + CAPABILITY_VOCAB_FENCE + '\n{"v":1,"context_tokens_min":200000,"cost_class":"budget"}\n```';
    expect(q).toContain("fenced code block tagged");
    expect(parseCapabilityDeclaration(declaration)).toEqual({ v: 1, context_tokens_min: 200000, cost_class: "budget" });
  });
});

describe("capability vocabulary — isCapabilityVocabEnabled (#83)", () => {
  test("default off — unset or empty is inert", () => {
    expect(isCapabilityVocabEnabled({})).toBe(false);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "" })).toBe(false);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "0" })).toBe(false);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "off" })).toBe(false);
  });

  test("explicit opt-in, case-insensitive, whitespace-tolerant", () => {
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "1" })).toBe(true);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "true" })).toBe(true);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "YES" })).toBe(true);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: " on " })).toBe(true);
  });
});
