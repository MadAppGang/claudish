import { describe, expect, test } from "bun:test";
import {
  type ExecOutput,
  clampExecOutputTokens,
  defaultExecOutputTokens,
  formatExecOutput,
  parseExecPragma,
} from "./output.js";

const textOf = (output: ExecOutput, maxOutputTokens = 10000) =>
  formatExecOutput(output, { maxOutputTokens })
    .filter((part) => part.type === "input_text")
    .map((part) => part.text)
    .join("\n");

describe("exec output", () => {
  test.each([
    ["completed", "Script completed"],
    ["failed", "Script failed"],
    ["terminated", "Script terminated"],
  ] as const)("%s output has its status and known wall time", (status, label) => {
    const text = textOf({
      status,
      wallMs: 2000,
      parts: [{ type: "text", text: "visible output" }],
    });
    expect(text).toContain(label);
    expect(text).toMatch(/Wall time[^\n]*2(?:\.0)? seconds/);
    expect(text).toContain("visible output");
  });

  test("unknown wall time is not presented as a measured zero", () => {
    const text = textOf({ status: "failed", wallMs: undefined, parts: [], error: "state lost" });
    expect(text).toContain("Wall time unknown");
    expect(text).toContain("state lost");
  });

  test("output over the token budget is truncated and marked; a larger budget keeps it", () => {
    const body = "abcdefghij".repeat(80);
    const output: ExecOutput = {
      status: "completed",
      wallMs: 0,
      parts: [{ type: "text", text: body }],
    };
    const small = textOf(output, 10);
    const large = textOf(output, 1000);
    expect(small).toContain("Script completed");
    expect(small.toLowerCase()).toContain("truncat");
    expect(small).not.toContain(body);
    expect(small.length).toBeLessThan(large.length);
    expect(large).toContain(body);
    expect(large.toLowerCase()).not.toContain("truncat");
  });

  test("image references resolve to output images only through the caller", () => {
    const ref = { toolUseId: "toolu_image", index: 0 };
    // Structural output parts, not a manufactured Responses request/event capture.
    const output: ExecOutput = { status: "completed", wallMs: 0, parts: [{ type: "image", ref }] };
    const resolved: unknown[] = [];
    const parts = formatExecOutput(output, {
      maxOutputTokens: 1000,
      resolveImage: (value) => {
        resolved.push(value);
        return "data:image/png;base64,captured-image-reference";
      },
    });
    expect(resolved).toEqual([ref]);
    expect(parts.filter((part) => part.type === "input_image")).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,captured-image-reference" },
    ]);
  });
});

describe("exec pragma and output-token policy", () => {
  test("parses max_output_tokens and preserves source line numbering", () => {
    const parsed = parseExecPragma('// @exec: {"max_output_tokens":42}\ntext("hello");');
    expect(parsed.error).toBeUndefined();
    expect(parsed.maxOutputTokens).toBe(42);
    expect(parsed.source).toBe('\ntext("hello");');
  });

  test("source without a pragma is unchanged", () => {
    const source = 'text("hello");\n';
    expect(parseExecPragma(source)).toEqual({ source });
  });

  test("an unknown pragma key fails rather than silently changing execution", () => {
    const parsed = parseExecPragma('// @exec: {"unknown_option":42}\ntext("must not run");');
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("unknown_option");
  });

  test("yield_time_ms is accepted but does not alter the output-token limit", () => {
    const parsed = parseExecPragma(
      '// @exec: {"yield_time_ms":1,"max_output_tokens":17}\ntext("hello");'
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.maxOutputTokens).toBe(17);
  });

  test("token defaults use a discovered token policy, otherwise the caller's fallback", () => {
    expect(defaultExecOutputTokens({ mode: "tokens", limit: 1234 }, 10000)).toBe(1234);
    expect(defaultExecOutputTokens({ mode: "bytes", limit: 1234 }, 10000)).toBe(10000);
    expect(defaultExecOutputTokens(undefined, 10000)).toBe(10000);
    expect(clampExecOutputTokens(0)).toBe(1);
    expect(clampExecOutputTokens(100000)).toBe(50000);
    expect(clampExecOutputTokens(42)).toBe(42);
  });
});
