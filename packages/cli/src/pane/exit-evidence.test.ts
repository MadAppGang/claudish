import { describe, expect, test } from "bun:test";
import { childExitEvidence } from "./exit-evidence.js";

describe("childExitEvidence", () => {
  test("takes claudish's own Fatal error line over its stack line and frames", () => {
    const capture = [
      "[claudish] Fatal error: boom",
      "[claudish] Stack: Error: boom",
      ...Array.from({ length: 5 }, () => "    at fn (/p/f.ts:1:1)"),
    ].join("\n");
    expect(childExitEvidence([capture], [capture])).toBe("[claudish] Fatal error: boom");
  });

  test("takes a plain Error: line with its leading whitespace trimmed", () => {
    expect(childExitEvidence(["noise\n  Error: Claude Code CLI not found\nmore"], [])).toBe(
      "Error: Claude Code CLI not found"
    );
  });

  test("takes a bare Fatal error: line", () => {
    expect(childExitEvidence(["Fatal error: out of memory"], [])).toBe(
      "Fatal error: out of memory"
    );
  });

  test("with no error line, joins the last five non-empty lines of the first source with text", () => {
    expect(childExitEvidence(["", "a\nb\n\nc\nd\ne\nf\n"], ["", "a\nb\n\nc\nd\ne\nf\n"])).toBe(
      "b | c | d | e | f"
    );
  });

  test("returns an empty string when there is nothing to show", () => {
    expect(childExitEvidence(["", "\n"], ["", " \n"])).toBe("");
  });
});
