import { describe, expect, it } from "bun:test";
import { detectHarnessFacts, extractAvailableSkills, extractSessionId } from "./harness.js";

describe("extractSessionId", () => {
  it("extracts only the session id from Claude Code's JSON-string metadata", () => {
    const deviceId = "abc123";
    const sessionId = "ce7d9e68-f907-444f-9680-69ec3048ce9c";
    const userId = JSON.stringify({
      device_id: deviceId,
      account_uuid: "",
      session_id: sessionId,
    });
    // Reproduce the real wire shape: user_id is a JSON string inside the JSON
    // request, not an already-parsed object.
    const request = JSON.parse(`{"metadata":{"user_id":${JSON.stringify(userId)}}}`);

    const extracted = extractSessionId(request);

    expect(extracted).toBe(sessionId);
    expect(extracted).not.toContain(deviceId);
  });

  const absentCases: Array<[string, unknown]> = [
    ["missing metadata", {}],
    ["missing user_id", { metadata: {} }],
    ["a plain non-JSON string", { metadata: { user_id: "plain-user" } }],
    ["malformed JSON", { metadata: { user_id: '{"session_id":' } }],
    ["JSON without session_id", { metadata: { user_id: JSON.stringify({ device_id: "abc123" }) } }],
    ["an empty session_id", { metadata: { user_id: JSON.stringify({ session_id: "" }) } }],
  ];

  for (const [label, request] of absentCases) {
    it(`returns undefined for ${label}`, () => {
      expect(extractSessionId(request)).toBeUndefined();
    });
  }
});

describe("extractAvailableSkills", () => {
  it("parses entries in listing order, including names with colons and hyphens", () => {
    const systemText = `Before the listing.
The following skills are available for use:
- imagegen: Generate images

- code-review:code-review: Review code carefully
- release-notes-writer: Draft release notes
After the listing, continue with the rest of the system prompt.`;

    expect(extractAvailableSkills(systemText)).toEqual([
      { name: "imagegen", description: "Generate images" },
      { name: "code-review:code-review", description: "Review code carefully" },
      { name: "release-notes-writer", description: "Draft release notes" },
    ]);
  });

  it("stops at the first non-blank non-entry line", () => {
    const systemText = `The following skills are available:
- first-skill: The real listed skill

This is a later system-prompt section.
- not-a-skill: This bullet belongs to that later section`;

    expect(extractAvailableSkills(systemText)).toEqual([
      { name: "first-skill", description: "The real listed skill" },
    ]);
  });

  it("returns an empty list when no skill listing exists", () => {
    expect(extractAvailableSkills("No skills section is present here.")).toEqual([]);
  });

  it("returns an empty list for an empty system prompt", () => {
    expect(extractAvailableSkills("")).toEqual([]);
  });
});

describe("detectHarnessFacts", () => {
  const anchorCases = [
    [
      "You should create your plan at /workspace/.team/plans/assigned-alpha.md before exiting.",
      "/workspace/.team/plans/assigned-alpha.md",
    ],
    [
      "A plan file already exists at /tmp/custom-plan-root/assigned-beta.md and should be updated.",
      "/tmp/custom-plan-root/assigned-beta.md",
    ],
    [
      "Read-only except plan file (/opt/project/private-plans/assigned-gamma.md)",
      "/opt/project/private-plans/assigned-gamma.md",
    ],
  ] as const;

  for (const [reminder, expectedPath] of anchorCases) {
    it(`extracts the assigned path from ${reminder.split(" at ")[0]}`, () => {
      const facts = detectHarnessFacts({ system: reminder, messages: [] });

      expect(facts.planModeActive).toBe(true);
      expect(facts.planFilePath).toBe(expectedPath);
      expect(facts.planDir).toBe(expectedPath.slice(0, expectedPath.lastIndexOf("/")));
    });
  }

  it("honours a non-default plan directory instead of inferring ~/.claude/plans", () => {
    const assignedPath = "/workspace/repo/.custom/approval-plans/session-42.md";
    const facts = detectHarnessFacts({
      system: `Plan mode is active. You should create your plan at ${assignedPath}`,
    });

    expect(facts).toEqual({
      planModeActive: true,
      planFilePath: assignedPath,
      planDir: "/workspace/repo/.custom/approval-plans",
    });
  });

  it("returns inactive facts for ordinary text without a plan anchor", () => {
    const facts = detectHarnessFacts({
      system: "Write a project plan and save useful Markdown documentation.",
      messages: [{ role: "user", content: "Please review docs/plan.md." }],
    });

    expect(facts).toEqual({ planModeActive: false });
  });

  it("finds the latest reminder by scanning a long message array backwards", () => {
    const olderPath = "/tmp/old-plans/old.md";
    const latestPath = "/tmp/latest-plans/current.md";
    const messages = [
      { role: "user", content: `You should create your plan at ${olderPath}` },
      ...Array.from({ length: 2_000 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        content: `ordinary conversation turn ${index}`,
      })),
      {
        role: "user",
        content: `Plan mode still active. A plan file already exists at ${latestPath}`,
      },
    ];

    const facts = detectHarnessFacts({ messages });

    expect(facts.planFilePath).toBe(latestPath);
    expect(facts.planDir).toBe("/tmp/latest-plans");
  });

  it("reads a string system prompt", () => {
    const path = "/tmp/string-system/plan.md";

    expect(detectHarnessFacts({ system: `You should create your plan at ${path}` })).toEqual({
      planModeActive: true,
      planFilePath: path,
      planDir: "/tmp/string-system",
    });
  });

  it("reads text blocks from an array system prompt", () => {
    const path = "/tmp/block-system/plan.md";
    const facts = detectHarnessFacts({
      system: [
        { type: "text", text: "Plan mode is active. " },
        { type: "text", text: `Read-only except plan file (${path})` },
      ],
    });

    expect(facts).toEqual({
      planModeActive: true,
      planFilePath: path,
      planDir: "/tmp/block-system",
    });
  });
});
