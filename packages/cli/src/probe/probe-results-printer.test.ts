import { describe, expect, test } from "bun:test";
import { type ModelResult, printProbeResults } from "./probe-results-printer.js";

// Keep this in sync with the printer's local ANSI-stripping expression.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control chars
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function render(result: ModelResult): string {
  let output = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    printProbeResults([result], false);
  } finally {
    process.stderr.write = originalWrite;
  }

  return output.replace(ANSI_RE, "");
}

function renderChainSpec(provider: string, modelSpec: string, native = false): string {
  const output = render({
    model: modelSpec,
    routingSource: native ? "native" : "explicit",
    routingExplanation: native
      ? "native · Claude Code's own auth · not probed"
      : `explicit · ${provider}`,
    chain: [
      {
        provider,
        displayName: provider,
        modelSpec,
        label: native ? "Claude Code's own auth" : "gateway",
        hasCredentials: true,
        ...(native ? { notProbed: "native-auth" as const } : {}),
      },
    ],
    dropped: [],
  });

  const cells = output
    .split("\n")
    .map((line) => line.split("│").map((cell) => cell.trim()))
    .find((row) => row[1] === "1" && row[2] === provider);

  expect(cells).toBeDefined();
  return cells?.[4] ?? "";
}

describe("printProbeResults chain Model Spec", () => {
  test("does not double an explicit provider shortcut", () => {
    const spec = renderChainSpec("openrouter", "openrouter@gpt-5.6-sol");

    expect({ spec, atCount: spec.match(/@/g)?.length ?? 0 }).toEqual({
      spec: "openrouter@gpt-5.6-sol",
      atCount: 1,
    });
  });

  test("renders the prepared provider-pinned spec", () => {
    expect(renderChainSpec("openrouter", "openrouter@gpt-5.6-sol")).toBe("openrouter@gpt-5.6-sol");
  });

  test("keeps native-anthropic model inputs bare", () => {
    const spec = renderChainSpec("native-anthropic", "claude-opus-4-7", true);

    expect(spec).toBe("claude-opus-4-7");
    expect(spec).not.toContain("@");
  });

  test("keeps a vendor-qualified id inside an explicit one-item chain", () => {
    expect(renderChainSpec("openrouter", "anthropic/claude-opus-5")).toBe(
      "anthropic/claude-opus-5"
    );
  });
});

describe("printProbeResults calculated-route headings", () => {
  test("uses the first kept hop for o4-mini and never the parser's auto-route provider", () => {
    const result = {
      model: "o4-mini",
      nativeProvider: "auto-route",
      routingSource: "catalog",
      routingExplanation: "catalog · native API first",
      chain: [
        {
          provider: "openai",
          displayName: "OpenAI",
          modelSpec: "oai@o4-mini",
          label: "native API",
          hasCredentials: true,
        },
      ],
      dropped: [],
    } as ModelResult & { nativeProvider: string };

    const output = render(result);
    const heading = output.split("\n").find((line) => line.startsWith("┌─")) ?? "";

    expect(heading).toContain("OpenAI · 0/1 live");
    expect(output).not.toContain("auto-route");
  });

  test("uses the explanation for a bare no-route and never invents an auto-route row", () => {
    const explanation = 'catalog has no entry for "no-such-model-xyz" · no fallback (disabled)';
    const result = {
      model: "no-such-model-xyz",
      nativeProvider: "auto-route",
      routingSource: "catalog",
      routingExplanation: explanation,
      chain: [],
      dropped: [],
      noRoute: {
        reason: 'No provider in the catalog serves "no-such-model-xyz".',
      },
    } as ModelResult & { nativeProvider: string };

    const output = render(result);
    const heading = output.split("\n").find((line) => line.startsWith("┌─")) ?? "";

    expect(heading).toContain(explanation);
    expect(output).not.toContain("auto-route");
    expect(output).not.toContain("auto-route@");
  });
});

test("the Wire line renders the catalog wire summary", () => {
  const wireSummary = "fixture/direct-api · opaque: responses · limit max_output_tokens";
  const output = render({
    model: "fixture@opaque",
    routingSource: "explicit",
    routingExplanation: "explicit · fixture",
    chain: [],
    dropped: [],
    wiring: {
      formatAdapter: "CodexAPIFormat",
      declaredStreamFormat: "openai-responses-sse",
      effectiveStreamFormat: "openai-responses-sse",
      modelTranslator: "wire",
      contextWindow: 100000,
      supportsVision: false,
      transportOverride: null,
      wireSummary,
    },
  });
  expect(output).toContain(wireSummary);
});
