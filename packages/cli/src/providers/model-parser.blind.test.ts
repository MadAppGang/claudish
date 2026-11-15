import { expect, test } from "bun:test";
import { contractConfig, isolatedFile } from "../test-helpers/claude-behaviour.js";
import { useSandbox } from "../test-helpers/model-lineup-blind.js";

await isolatedFile(import.meta, async () => {
  useSandbox();
  const { parseListingEntry, parseModelFlags, parseModelChain } = await import("./model-parser.js");

  // REQ-1
  test.each([
    ["devin@", { shortcut: "devin", scope: "recommended" }],
    ["or@*", { shortcut: "or", scope: "all" }],
    ["OR@", { shortcut: "or", scope: "recommended" }],
    ["or@some-model", null],
    ["some-model", null],
    ["https://example.invalid/model", null],
    ["or@*other", null],
  ] as const)(
    "TEST-01 classifies listing value %s without treating a full spec as a listing",
    (value, expected) => {
      expect(parseListingEntry(String(value))).toEqual(expected);
    }
  );

  // REQ-2, REQ-3
  test("TEST-02 keeps last-wins full specs on the non-lineup path", () => {
    const result = parseModelFlags(["or@first", "ollama@last"]);
    expect(result).toEqual({
      ok: true,
      value: { start: "ollama@last", pinned: [], listings: [], hasLineup: false },
    });
  });

  test("TEST-02 leaves only the final routing chain when there is no listing", () => {
    const result = parseModelFlags(["or@ignored", "ollama@one+lmstudio@two"]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        start: "ollama@one",
        chain: ["ollama@one", "lmstudio@two"],
        pinned: [],
        listings: [],
        hasLineup: false,
      },
    });
  });

  // REQ-4
  test.each([
    "claude@opus",
    "claude-opus-5",
    "arbitrary-bare-model",
    "unknown-vendor/arbitrary",
    "https://example.invalid/v1/model",
  ])("TEST-05 refuses invalid pinned value %s with the value in the diagnostic", (pin) => {
    const result = parseModelFlags([pin, "ollama@start", "devin@"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a pinned-spec refusal");
    expect(result.message).toContain(pin);
    if (pin.startsWith("claude")) {
      expect(result.message).toMatch(/drop|last --model/i);
    } else {
      expect(result.message).toMatch(/@/);
    }
  });

  // REQ-4: provider validation follows endpoint registration, not syntax parsing.
  test("TEST-05 refuses unknown pinned providers at the post-registration launch decision", async () => {
    const pin = "nosuchprovider@arbitrary";
    const parsed = parseModelFlags([pin, "ollama@start", "devin@"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const { decideModelListings } = await import("../launcher/claude-launch.js");
    const config = contractConfig({ model: parsed.value.start, claudeArgs: [], monitor: false });
    const result = decideModelListings(config, parsed.value, {
      isKnownProvider: (name: string) => name === "ollama" || name === "devin",
      keepsLogin: () => false,
      settingsFindings: () => [],
      unreadableSettings: () => [],
      classifierPassthrough: () => false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an unknown-provider refusal");
    expect(result.message).toContain(pin);
  });

  // REQ-6
  test("TEST-06 refuses real chains on lineup launches but preserves the old chain path", () => {
    const chain = "ollama@one+lmstudio@two";
    expect(parseModelChain(chain)).toEqual(["ollama@one", "lmstudio@two"]);
    const result = parseModelFlags([chain, "devin@"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a chain refusal");
    expect(result.message).toMatch(/chain/i);
    expect(parseModelFlags([chain])).toMatchObject({
      ok: true,
      value: { chain: ["ollama@one", "lmstudio@two"], hasLineup: false },
    });
  });

  test("TEST-06 accepts +pro as part of one model on a lineup launch", () => {
    expect(parseModelChain("oai@gpt-6-sol+pro")).toEqual(["oai@gpt-6-sol+pro"]);
    expect(parseModelFlags(["oai@gpt-6-sol+pro", "devin@"])).toMatchObject({
      ok: true,
      value: { start: "oai@gpt-6-sol+pro", pinned: [], hasLineup: true },
    });
  });
});
