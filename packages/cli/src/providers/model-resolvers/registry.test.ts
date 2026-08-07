import { describe, expect, test } from "bun:test";
import { collapseRoster, expandSelection, getModelResolver } from "./registry.js";
import type { RosterEntry } from "./types.js";

describe("model resolver registry", () => {
  test("registers only providers that opt in", () => {
    expect(getModelResolver("devin")?.provider).toBe("devin");
    // Antigravity is deliberately NOT a member — see registry.ts.
    expect(getModelResolver("antigravity")).toBeUndefined();
    expect(getModelResolver("openrouter")).toBeUndefined();
  });

  test("uses identity collapse for an unregistered provider", () => {
    const roster: RosterEntry[] = [
      { wireId: "first", displayName: "First", contextWindow: 100_000 },
      { wireId: "second", displayName: "Second", costFactor: 2 },
      { wireId: "third" },
    ];

    const choices = collapseRoster("openrouter", roster);
    expect(choices.map((choice) => choice.id)).toEqual(["first", "second", "third"]);
    expect(choices.map((choice) => choice.displayName)).toEqual(["First", "Second", "third"]);
    expect(choices.map((choice) => choice.variants)).toEqual([
      [{ wireId: "first", modifiers: [] }],
      [{ wireId: "second", modifiers: [] }],
      [{ wireId: "third", modifiers: [] }],
    ]);
  });

  test("uses identity expand for an unregistered provider", () => {
    const roster: RosterEntry[] = [{ wireId: "served-model" }];
    expect(expandSelection("openrouter", "unlisted-selection", roster, { effort: "max" })).toBe(
      "unlisted-selection"
    );
  });
});
