import { describe, expect, test } from "bun:test";
import type { ViewItem } from "../pane/view-contract.js";
import { clipText, herdrAgentState, herdrMetadata, shortModel } from "./state-map.js";
import { replayItem, sessionItem } from "./test-helpers/view-items.js";

function withFields(item: ViewItem, fields: Record<string, unknown>): ViewItem {
  return { ...item, ...fields } as ViewItem;
}

describe("herdrAgentState", () => {
  test.each([
    ["STARTING", null, "working"],
    ["RUNNING", "Bash", "working"],
    ["AWAITING_PERMISSION", "Bash", "blocked"],
    ["AWAITING_INPUT", "AskUserQuestion", "blocked"],
    ["AWAITING_INPUT", null, "idle"],
    ["COMPLETED", null, "idle"],
    ["FAILED", null, "idle"],
    ["CANCELLED", null, "idle"],
    ["SOMETHING_NEW", null, "unknown"],
  ] as const)("%s with activity %s → %s", (state, activity, want) => {
    expect(herdrAgentState(withFields(sessionItem("a"), { state, activity }))).toBe(want);
  });

  test("a replay is idle", () => {
    expect(herdrAgentState(replayItem("r1"))).toBe("idle");
  });
});

describe("herdrMetadata", () => {
  test("display name, title from the prompt summary, and tokens", () => {
    const m = herdrMetadata(
      withFields(sessionItem("a", { model: "openai-codex@gpt-6.1-sol" }), {
        activity: "Bash",
        tokens_in: 12_345,
        tokens_out: 678,
        cost_usd: 0.1234,
        turns_completed: 3,
      })
    );
    expect(m.display_agent).toBe("claudish · gpt-6.1-sol");
    expect(m.title).toBe("say hi");
    expect(m.state_labels.working).toBe("Bash");
    expect(m.tokens).toMatchObject({
      model: "gpt-6.1-sol",
      activity: "Bash",
      tokens: "in 12k / out 678",
      cost: "$0.12",
      turns: "3",
      slot: null,
      run: null,
    });
  });

  test("titleMode model keeps the prompt out of herdr", () => {
    expect(herdrMetadata(sessionItem("a"), { titleMode: "model" }).title).toBe("gpt-6");
  });

  test("at most 16 token keys, every value at most 80 characters", () => {
    const m = herdrMetadata(
      withFields(sessionItem("a"), { activity: "x".repeat(300), prompt_summary: "y".repeat(300) })
    );
    expect(Object.keys(m.tokens).length).toBeLessThanOrEqual(16);
    for (const v of Object.values(m.tokens))
      if (v !== null) expect([...v].length).toBeLessThanOrEqual(80);
    expect([...m.title].length).toBeLessThanOrEqual(80);
  });

  test("a terminal state labels idle and done with the state and reason", () => {
    const m = herdrMetadata(withFields(sessionItem("a"), { state: "FAILED", reason: "api_error" }));
    expect(m.state_labels.idle).toBe("FAILED (api_error)");
    expect(m.state_labels.done).toBe("FAILED (api_error)");
  });
});

describe("text helpers", () => {
  test("clipText removes control characters and joins lines", () => {
    expect(clipText("a\nb\x1b[31mc\t d")).toBe("a b [31mc d");
  });
  test("shortModel", () => {
    expect(shortModel("cx@gpt-6")).toBe("gpt-6");
    expect(shortModel("gpt-6")).toBe("gpt-6");
    expect(shortModel(null)).toBe("claudish");
  });
});
