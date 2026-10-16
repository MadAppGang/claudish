import { describe, expect, test } from "bun:test";
import { NESTED_INSTRUCTIONS, NESTED_MCP_TOOL_NAMES } from "./nested-mode.js";

describe("nested MCP mode", () => {
  test("T-U-10: the nested surface has exactly four one-shot and discovery tools", () => {
    expect([...NESTED_MCP_TOOL_NAMES].sort()).toEqual([
      "compare_models",
      "list_models",
      "run_prompt",
      "search_models",
    ]);
  });

  test("T-U-11: instructions describe one-shot calls and the nesting refusal", () => {
    expect(
      NESTED_INSTRUCTIONS.startsWith(
        "Claudish MCP server provides access to external AI models for one-shot calls."
      )
    ).toBe(true);
    expect(NESTED_INSTRUCTIONS).toContain(
      "create_session, team, send_input, get_output, cancel_session, list_sessions, get_diagnostics, capture_session, preflight, report_error"
    );
    expect(NESTED_INSTRUCTIONS).toContain(
      "- run_prompt or compare_models: a one-shot answer from another model."
    );
    expect(NESTED_INSTRUCTIONS).toContain("- list_models, search_models: find a model.");
    expect(NESTED_INSTRUCTIONS).toContain("## Nested mode — no sessions");
    expect(NESTED_INSTRUCTIONS).toContain("nested session refused");
    expect(NESTED_INSTRUCTIONS).not.toContain("Channel Mode");
    expect(NESTED_INSTRUCTIONS).not.toMatch(/^- (?:preflight|report_error):/m);
  });
});
