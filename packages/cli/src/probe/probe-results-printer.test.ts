import { describe, expect, test } from "bun:test";
import { type ModelResult, printProbeResults } from "./probe-results-printer.js";

// Keep this in sync with the printer's local ANSI-stripping expression.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control chars
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function renderDirectSpec(nativeProvider: string, model: string): string {
  let output = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    // The direct-row path reads only these fields. Keep the fixture minimal so
    // any new dependency in the display path is explicit in this test.
    const result = {
      model,
      nativeProvider,
      routingSource: "direct",
      chain: [],
    } as unknown as ModelResult;

    printProbeResults([result], false);
  } finally {
    process.stderr.write = originalWrite;
  }

  const cells = output
    .replace(ANSI_RE, "")
    .split("\n")
    .map((line) => line.split("│").map((cell) => cell.trim()))
    .find((row) => row[1] === "1" && row[2] === nativeProvider);

  expect(cells).toBeDefined();
  return cells?.[3] ?? "";
}

describe("printProbeResults direct Model Spec", () => {
  test("does not double an explicit provider prefix", () => {
    const spec = renderDirectSpec("openrouter", "openrouter@gpt-5.6-sol");

    expect({ spec, atCount: spec.match(/@/g)?.length ?? 0 }).toEqual({
      spec: "openrouter@gpt-5.6-sol",
      atCount: 1,
    });
  });

  test("prefixes a bare model input", () => {
    expect(renderDirectSpec("openrouter", "gpt-5.6-sol")).toBe("openrouter@gpt-5.6-sol");
  });

  test("keeps native-anthropic model inputs bare", () => {
    const spec = renderDirectSpec("native-anthropic", "claude-opus-4-7");

    // Prefixing this sets hasExplicitProvider=true and routes away from the
    // passthrough, so native-anthropic must remain special-cased.
    expect(spec).toBe("claude-opus-4-7");
    expect(spec).not.toContain("@");
  });

  test("prefixes a slash-qualified vendor model input", () => {
    expect(renderDirectSpec("openrouter", "openai/gpt-5.6-sol")).toBe(
      "openrouter@openai/gpt-5.6-sol"
    );
  });
});
