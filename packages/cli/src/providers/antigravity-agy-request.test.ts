import { describe, expect, test } from "bun:test";
import { ANTIGRAVITY_IDENTITY_HEAD } from "../handlers/shared/format/identity-filter.js";
import {
  agyDeclarationTemplate,
  agySystemText,
  declaresTools,
  withAgySystem,
  withAgyTools,
} from "./antigravity-agy-request.js";
import recorded from "./antigravity-agy-request.json";

const ENVIRONMENT = { os: "mac", shell: "zsh", workspace: "/work", appDataDir: "/data" };
const RECORDED_NAMES = [
  "read_file",
  "run_command",
  "manage_task",
  "send_message",
  "schedule",
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "write_file",
  "edit_file",
  "search_web",
  "run_workflow",
  "swarm",
  "ask_question",
  "call_mcp_tool",
  "list_resources",
  "read_resource",
];

const namesOf = (tools: unknown) =>
  (tools as Array<{ functionDeclarations: Array<{ name: string }> }>).map(
    (entry) => entry.functionDeclarations[0].name
  );

describe("the recorded agy request data", () => {
  test("holds the 17 declarations in the recorded order", () => {
    expect(recorded.tools.map((declaration) => declaration.name)).toEqual(RECORDED_NAMES);
  });

  test("holds nothing of the machine it was recorded on", () => {
    const text = JSON.stringify(recorded);
    for (const local of ["/Users/", "/home/", ".gemini/config", "@gmail"]) {
      expect(text).not.toContain(local);
    }
  });

  test("the prompt opens with agy's identity block and ends with the user information", () => {
    const text = agySystemText(ENVIRONMENT, "conv-1");
    expect(text.startsWith("<identity>\nYou are Antigravity,")).toBe(true);
    expect(text.endsWith("</user_information>")).toBe(true);
    expect(text).not.toContain("{{");
    expect(text).toContain("The USER's OS version is mac.");
    expect(text).toContain("Active Workspaces:\n- /work\nCommand Working Directory: /work\n");
    expect(text).toContain("Conversation ID: conv-1\n");
    expect(text).toContain("Artifact Directory Path: /data/brain/conv-1\n");
  });
});

describe("withAgyTools", () => {
  const aliased = (name: string) => ({
    name,
    description: agyDeclarationTemplate(name)?.description,
    parameters: { type: "object", properties: {} },
  });

  test("agy's 17 declarations come first, as recorded, and the request's other tools follow", () => {
    const tools = [
      {
        functionDeclarations: [
          { name: "grep_search", description: "g" },
          aliased("run_command"),
          { name: "Skill", description: "s" },
          aliased("read_file"),
        ],
      },
    ];
    const out = withAgyTools(tools, ENVIRONMENT) as Array<{
      functionDeclarations: Array<Record<string, unknown>>;
    }>;
    expect(namesOf(out)).toEqual([...RECORDED_NAMES, "grep_search", "Skill"]);
    expect(out[0].functionDeclarations[0]).toEqual(recorded.tools[0]);
    expect(out[1].functionDeclarations[0].parameters).toEqual(recorded.tools[1].parameters);
    expect(out[1].functionDeclarations[0].description).toContain(
      "Operating System: mac. Shell: zsh."
    );
    expect(JSON.stringify(out)).not.toContain("{{");
  });

  test("a tool of the user's own under an agy name is kept, and agy's is not sent", () => {
    const mine = { name: "swarm", description: "my own swarm", parameters: {} };
    const out = withAgyTools([{ functionDeclarations: [mine] }], ENVIRONMENT);
    expect(namesOf(out)).toEqual([...RECORDED_NAMES.filter((name) => name !== "swarm"), "swarm"]);
    expect((out as any[]).at(-1).functionDeclarations[0]).toEqual(mine);
  });

  test("a renamed tool whose description changed after the alias is kept, placeholders filled", () => {
    const changed = {
      ...aliased("run_command"),
      description: `${agyDeclarationTemplate("run_command")?.description} NOTE`,
    };
    const out = withAgyTools([{ functionDeclarations: [changed] }], ENVIRONMENT) as any[];
    expect(namesOf(out).filter((name) => name === "run_command")).toHaveLength(1);
    const kept = out.at(-1).functionDeclarations[0];
    expect(kept.description.endsWith(" NOTE")).toBe(true);
    expect(kept.description).not.toContain("{{");
  });

  test("an entry that declares no function keeps its place after agy's declarations", () => {
    const out = withAgyTools(
      [{ googleSearch: {} }, { functionDeclarations: [{ name: "Skill" }] }],
      ENVIRONMENT
    ) as any[];
    expect(out[17]).toEqual({ googleSearch: {} });
    expect(out[18].functionDeclarations[0].name).toBe("Skill");
  });

  test("a request with no tool is not an agent request and is returned as given", () => {
    expect(declaresTools(undefined)).toBe(false);
    expect(declaresTools([{ googleSearch: {} }])).toBe(false);
    expect(declaresTools([{ functionDeclarations: [{ name: "Skill" }] }])).toBe(true);
    const tools = [{ googleSearch: {} }];
    expect(withAgyTools(tools, ENVIRONMENT)).toBe(tools);
  });
});

describe("withAgySystem", () => {
  test("agy's prompt, then the harness's text, in one part", () => {
    const out = withAgySystem(
      { parts: [{ text: "first" }, { text: "second" }] },
      ENVIRONMENT,
      "conv-1"
    );
    expect(out.parts).toEqual([
      { text: `${agySystemText(ENVIRONMENT, "conv-1")}\nfirst\n\nsecond` },
    ]);
  });

  test("the two-line identity the scrub wrote is removed: agy's block states it", () => {
    const out = withAgySystem(
      { parts: [{ text: `${ANTIGRAVITY_IDENTITY_HEAD}\n\nharness rules` }] },
      ENVIRONMENT,
      "conv-1"
    );
    const text = (out.parts as Array<{ text: string }>)[0].text;
    expect(text.endsWith("</user_information>\nharness rules")).toBe(true);
    expect(text.match(/You are Antigravity/g)).toHaveLength(1);
  });

  test("a request with no system text carries agy's prompt alone", () => {
    const out = withAgySystem(undefined, ENVIRONMENT, "conv-1");
    expect(out.parts).toEqual([{ text: agySystemText(ENVIRONMENT, "conv-1") }]);
  });
});
