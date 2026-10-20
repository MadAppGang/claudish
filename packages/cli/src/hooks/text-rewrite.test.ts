import { describe, expect, it } from "bun:test";
import { act } from "./public.js";
import { type RewriteBlock, applyTextActions, compileMatcher } from "./text-rewrite.js";

const text = (t: string): RewriteBlock => ({ type: "text", text: t });
const thinking: RewriteBlock = { type: "thinking", text: undefined };
const tool = (name: string) => ({ type: "tool_use", id: `toolu_${name}`, name });

/** Output as `type:text` strings, for compact assertions. */
function shape(result: ReturnType<typeof applyTextActions>): string[] {
  return result.blocks.map((b) =>
    b.block.type === "text" ? `text:${b.block.text}` : String(b.block.type)
  );
}

describe("applyTextActions — insert positions", () => {
  it("appendText extends the LAST text block", () => {
    const r = applyTextActions([text("a"), tool("x"), text("b")], [act.appendText("!")]);
    expect(shape(r)).toEqual(["text:a", "tool_use", "text:b!"]);
    expect(r.blocks.map((b) => b.source)).toEqual([0, 1, 2]);
    expect(r.blocks.map((b) => b.changed)).toEqual([false, false, true]);
  });

  it("appendText with no text block inserts before the first tool_use", () => {
    const r = applyTextActions([thinking, tool("a"), tool("b")], [act.appendText("NOTE")]);
    expect(shape(r)).toEqual(["thinking", "text:NOTE", "tool_use", "tool_use"]);
    expect(r.blocks.map((b) => b.source)).toEqual([0, null, 1, 2]);
  });

  it("appendText with only thinking appends after the last block", () => {
    const r = applyTextActions([thinking, thinking], [act.appendText("END")]);
    expect(shape(r)).toEqual(["thinking", "thinking", "text:END"]);
  });

  it("appendText on an empty response inserts the only block", () => {
    expect(shape(applyTextActions([], [act.appendText("x")]))).toEqual(["text:x"]);
  });

  it("prependText extends the FIRST text block", () => {
    const r = applyTextActions([text("a"), text("b")], [act.prependText(">")]);
    expect(shape(r)).toEqual(["text:>a", "text:b"]);
  });

  it("prependText with no text block inserts after leading thinking", () => {
    const r = applyTextActions([thinking, tool("a")], [act.prependText("FIRST")]);
    expect(shape(r)).toEqual(["thinking", "text:FIRST", "tool_use"]);
  });

  it("prependText on a tool-only response lands before the tools", () => {
    const r = applyTextActions([tool("a"), tool("b")], [act.prependText("P")]);
    expect(shape(r)).toEqual(["text:P", "tool_use", "tool_use"]);
  });

  it("locked text blocks are never targets and never rewritten", () => {
    const locked = { type: "text", text: "cited REMOVE", locked: true };
    const r = applyTextActions(
      [locked, tool("a")],
      [act.appendText("+"), act.removeText("REMOVE")]
    );
    expect(shape(r)).toEqual(["text:cited REMOVE", "text:+", "tool_use"]);
    expect(r.blocks[0]?.block).toBe(locked);
  });
});

describe("applyTextActions — replace and remove", () => {
  it("applies each action to each text block independently, in order", () => {
    const r = applyTextActions(
      [text("cat cat"), tool("x"), text("a cat")],
      [act.replaceText("cat", "dog"), act.replaceText("dog", "fox")]
    );
    expect(shape(r)).toEqual(["text:fox fox", "tool_use", "text:a fox"]);
    expect(r.applied.map((a) => a.changed)).toEqual([true, true]);
  });

  it("removes with a regex without leaving a double space", () => {
    const r = applyTextActions(
      [text("KEEP REMOVE-ME KEEP")],
      [act.removeText("\\s*REMOVE-ME", { regex: true })]
    );
    expect(shape(r)).toEqual(["text:KEEP KEEP"]);
  });

  it("drops a text block left empty and reports the shift", () => {
    const r = applyTextActions([text("gone"), tool("a")], [act.removeText("gone")]);
    expect(shape(r)).toEqual(["tool_use"]);
    expect(r.blocks[0]?.source).toBe(1);
  });

  it("passes an originally empty, untouched text block through", () => {
    const empty = text("");
    const r = applyTextActions([empty], [act.replaceText("x", "y")]);
    expect(r.blocks[0]?.block).toBe(empty);
    expect(r.applied[0]?.changed).toBe(false);
  });

  it("keeps a block whose edits cancel out as the original", () => {
    const original = text("abc");
    const r = applyTextActions([original], [act.replaceText("b", "X"), act.replaceText("X", "b")]);
    expect(r.blocks[0]?.block).toBe(original);
    expect(r.blocks[0]?.changed).toBe(false);
  });

  it("inserts a literal replacement verbatim; regex mode expands $1", () => {
    const literal = applyTextActions([text("price: N")], [act.replaceText("N", "$500")]);
    expect(shape(literal)).toEqual(["text:price: $500"]);
    const literalAmp = applyTextActions([text("x")], [act.replaceText("x", "$&$&")]);
    expect(shape(literalAmp)).toEqual(["text:$&$&"]);
    const regex = applyTextActions(
      [text("John Smith")],
      [act.replaceText("(\\w+) (\\w+)", "$2, $1", { regex: true })]
    );
    expect(shape(regex)).toEqual(["text:Smith, John"]);
  });

  it("honours regex flags and defaults them to g", () => {
    expect(
      shape(applyTextActions([text("aAa")], [act.replaceText("a", "x", { regex: true })]))
    ).toEqual(["text:xAx"]);
    expect(
      shape(
        applyTextActions([text("aAa")], [act.replaceText("a", "x", { regex: true, flags: "gi" })])
      )
    ).toEqual(["text:xxx"]);
    // Without g only the first match goes.
    expect(
      shape(
        applyTextActions([text("aaa")], [act.replaceText("a", "x", { regex: true, flags: "i" })])
      )
    ).toEqual(["text:xaa"]);
  });

  it("rejects an invalid regex, bad flags and flags without regex", () => {
    const r = applyTextActions(
      [text("abc")],
      [
        act.replaceText("(", "x", { regex: true }),
        act.replaceText("a", "x", { regex: true, flags: "gq" }),
        act.replaceText("a", "x", { regex: true, flags: "gg" }),
        act.replaceText("a", "x", { flags: "i" }),
        act.appendText("!"),
      ]
    );
    expect(r.rejected.map((x) => [x.index, x.reason])).toEqual([
      [0, "invalid_regex"],
      [1, "invalid_flags"],
      [2, "invalid_flags"],
      [3, "flags_without_regex"],
    ]);
    expect(shape(r)).toEqual(["text:abc!"]);
  });

  it("applies text actions sequentially, each over the previous result", () => {
    const r = applyTextActions(
      [text("hello")],
      [act.appendText(" world"), act.replaceText("world", "there"), act.prependText("> ")]
    );
    expect(shape(r)).toEqual(["text:> hello there"]);
  });
});

describe("compileMatcher", () => {
  it("rejects an empty find", () => {
    expect(compileMatcher(act.removeText(""))).toEqual({ invalid: "empty_find" });
  });

  it("replaces every literal occurrence including regex metacharacters", () => {
    const m = compileMatcher(act.replaceText("a.b", "X"));
    expect("apply" in m && m.apply("a.b axb a.b")).toBe("X axb X");
  });

  it("restarts a global regex for each block", () => {
    const m = compileMatcher(act.replaceText("a", "x", { regex: true }));
    if (!("apply" in m)) throw new Error("expected a matcher");
    expect(m.apply("aa")).toBe("xx");
    expect(m.apply("aa")).toBe("xx");
  });
});
