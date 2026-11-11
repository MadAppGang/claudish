import { describe, expect, test } from "bun:test";
import type { SessionViewItem } from "../pane/view-contract.js";
import { hcStatus, herdrAgentState, herdrMetadata } from "./state-map.js";
import { replayItem, sessionItem } from "./test-helpers/placer-harness.js";

describe("host-neutral status and metadata", () => {
  test.each([
    ["STARTING", null, "working", "working"],
    ["RUNNING", "Bash", "working", "working"],
    ["AWAITING_PERMISSION", "Bash", "blocked", "blocked"],
    ["AWAITING_INPUT", "AskUserQuestion", "blocked", "blocked"],
    ["AWAITING_INPUT", null, "idle", "idle"],
    ["COMPLETED", null, "idle", "done"],
    ["FAILED", null, "idle", "error"],
    ["TIMEOUT", null, "idle", "error"],
  ] as const)(
    "TEST-23 REQ-16 REQ-21 %s/%s maps to terminal %s and hc %s",
    (state, activity, terminal, hc) => {
      const item = { ...sessionItem("a"), state, activity } as SessionViewItem;

      expect(herdrAgentState(item)).toBe(terminal);
      expect(hcStatus(item).state).toBe(hc);
    }
  );

  test("TEST-23 REQ-16 REQ-21 replay row is idle in terminal while available", () => {
    expect(herdrAgentState(replayItem("replay-a"))).toBe("idle");
  });

  test("TEST-25 REQ-16 REQ-21 REQ-28 REQ-37 reports are bounded and sparse update clears tokens", () => {
    const rich = {
      ...sessionItem("a"),
      prompt_summary: "private summary ".repeat(30),
      model: "openai-codex@test-model",
      activity: "Bash",
      tokens_in: 123,
      tokens_out: 45,
      cost_usd: 0.25,
      turns_completed: 2,
    } as SessionViewItem;
    const sparse = {
      ...rich,
      activity: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
    };

    const before = herdrMetadata(rich);
    const after = herdrMetadata(sparse);

    expect(before.display_agent).toBe("claudish · test-model");
    expect(before.tokens.tokens).not.toBeNull();
    expect(before.tokens.cost).not.toBeNull();
    expect(after.tokens).toMatchObject({ activity: null, tokens: null, cost: null });
    expect(Object.keys(after.tokens).sort()).toEqual(Object.keys(before.tokens).sort());
    for (const report of [before, after]) {
      expect(Object.keys(report.tokens).length).toBeLessThanOrEqual(16);
      for (const value of [
        report.title,
        report.display_agent,
        ...Object.values(report.tokens),
        ...Object.values(report.state_labels),
      ]) {
        if (typeof value === "string") {
          expect([...value].length).toBeLessThanOrEqual(80);
          // biome-ignore lint/suspicious/noControlCharactersInRegex: the test checks that no control character reaches herdr
          expect(value).not.toMatch(/[\u0000-\u001f\u007f]/);
        }
      }
    }
    expect(herdrMetadata(rich, { titleMode: "model" }).title).toBe("test-model");
    expect(hcStatus(rich, { titleMode: "model" }).title).toBe("test-model");
    expect(JSON.stringify(herdrMetadata(rich, { titleMode: "model" }))).not.toContain(
      "private summary"
    );
  });
});
