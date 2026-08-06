import { describe, expect, test } from "bun:test";
import { DevinAPIFormat } from "../../adapters/devin-api-format.js";
import {
  DEVIN_TOOL_DESCRIPTIONS,
  applyDevinToolDescriptions,
  buildDevinToolDescriptions,
} from "./tool-descriptions.js";

type SubstitutedToolName = "Read" | "TaskOutput" | "WebSearch";

function shippedDescription(name: SubstitutedToolName): string {
  const description = DEVIN_TOOL_DESCRIPTIONS.get(name);
  if (description === undefined) throw new Error(`Missing shipped description for ${name}`);
  return description;
}

describe("applyDevinToolDescriptions", () => {
  test("substitutes the three OpenAI-shaped tools and preserves every other reference", () => {
    const read = {
      type: "function",
      function: {
        name: "Read",
        description: "original Read description",
        parameters: { type: "object", properties: { file_path: { type: "string" } } },
      },
    };
    const taskOutput = {
      type: "function",
      function: {
        name: "TaskOutput",
        description: "original TaskOutput description",
        parameters: { type: "object", properties: { task_id: { type: "string" } } },
      },
    };
    const webSearch = {
      type: "function",
      function: {
        name: "WebSearch",
        description: "original WebSearch description",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    };
    const bash = {
      type: "function",
      function: {
        name: "Bash",
        description: "runs a command",
        parameters: { type: "object", properties: {} },
      },
    };
    const mcp = {
      type: "function",
      function: {
        name: "mcp__claudish__run_prompt",
        description: "Read a prompt and run it",
        parameters: { type: "object", properties: {} },
      },
    };

    const result = applyDevinToolDescriptions([read, taskOutput, webSearch, bash, mcp]);

    expect(result[0]).not.toBe(read);
    expect(result[0]?.function.description).toBe(shippedDescription("Read"));
    expect(result[1]).not.toBe(taskOutput);
    expect(result[1]?.function.description).toBe(shippedDescription("TaskOutput"));
    expect(result[2]).not.toBe(webSearch);
    expect(result[2]?.function.description).toBe(shippedDescription("WebSearch"));
    expect(result[3]).toBe(bash);
    expect(result[4]).toBe(mcp);
  });

  test("substitutes flat-shaped tools", () => {
    const read = {
      name: "Read",
      description: "different Read description",
      parameters: { type: "object", properties: {} },
    };
    const bash = {
      name: "Bash",
      description: "runs a command",
      parameters: { type: "object", properties: {} },
    };

    const result = applyDevinToolDescriptions([read, bash]);

    expect(result[0]).not.toBe(read);
    expect(result[0]?.description).toBe(shippedDescription("Read"));
    expect(result[0]?.parameters).toBe(read.parameters);
    expect(result[1]).toBe(bash);
  });

  test("does not mutate the input tools", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "Read",
          description: "pre-call description",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "Bash",
          description: "runs a command",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const before = structuredClone(tools);

    const result = applyDevinToolDescriptions(tools);

    expect(tools).toEqual(before);
    expect(tools[0]?.function.description).toBe("pre-call description");
    expect(result).not.toBe(tools);
  });

  test("matches by tool name even when the existing description is different", () => {
    const read = {
      name: "Read",
      description: "custom text that does not resemble Claude Code's description",
      parameters: { type: "object", properties: {} },
    };

    expect(applyDevinToolDescriptions([read])[0]?.description).toBe(shippedDescription("Read"));
  });

  test("passes missing names, undefined names, and null through without throwing", () => {
    const missingName = { description: "unnamed", parameters: {} };
    const undefinedName = { name: undefined, description: "undefined name", parameters: {} };
    const tools = [missingName, undefinedName, null] as const;

    const result = applyDevinToolDescriptions(tools);

    expect(result[0]).toBe(missingName);
    expect(result[1]).toBe(undefinedName);
    expect(result[2]).toBeNull();
  });

  test("returns a new empty array for empty input", () => {
    const tools: unknown[] = [];

    const result = applyDevinToolDescriptions(tools);

    expect(result).toEqual([]);
    expect(result).not.toBe(tools);
  });

  test("honours an explicitly supplied description map", () => {
    const read = { name: "Read", description: "old", parameters: {} };
    const bash = { name: "Bash", description: "old Bash", parameters: {} };
    const descriptions = new Map([
      ["Read", "custom Read replacement"],
      ["Bash", "custom Bash replacement"],
    ]);

    const result = applyDevinToolDescriptions([read, bash], descriptions);

    expect(result[0]?.description).toBe("custom Read replacement");
    expect(result[1]?.description).toBe("custom Bash replacement");
  });
});

describe("DEVIN_TOOL_DESCRIPTIONS semantic fidelity", () => {
  test("contains exactly the three non-empty substitutions", () => {
    expect([...DEVIN_TOOL_DESCRIPTIONS.keys()].sort()).toEqual(["Read", "TaskOutput", "WebSearch"]);
    expect(DEVIN_TOOL_DESCRIPTIONS.size).toBe(3);
    for (const description of DEVIN_TOOL_DESCRIPTIONS.values()) {
      expect(description.trim().length).toBeGreaterThan(0);
    }
  });

  // These assertions stop a future Read rewrite from dropping a functional requirement.
  test("preserves every load-bearing Read constraint", () => {
    const description = DEVIN_TOOL_DESCRIPTIONS.get("Read") ?? "";

    expect(description).toMatch(/fully-qualified absolute path/i);
    expect(description).toMatch(/relative path will not be accepted/i);
    expect(description).toMatch(/first 2000 lines/i);
    expect(description).toMatch(/cat -n/i);
    expect(description).toMatch(/numbering begins at 1/i);
    expect(description).toMatch(/region of the file matters[\s\S]*region alone[\s\S]*large files/i);
    expect(description).toMatch(/image files work/i);
    expect(description).toMatch(/PDF documents work/i);
    expect(description).toMatch(/past ten pages[\s\S]*`pages` argument becomes REQUIRED/i);
    expect(description).toMatch(/pages: "1-5"/i);
    expect(description).toMatch(/twenty pages at most/i);
    expect(description).toMatch(/Jupyter notebooks \(`\.ipynb`\)/i);
    expect(description).toMatch(/every cell together with the output/i);
    expect(description).toMatch(/files only, never directories/i);
    expect(description).toMatch(/file that exists but holds nothing[\s\S]*system-reminder/i);
    expect(description).toMatch(/do not re-open a file[\s\S]*edit you have already made/i);
  });

  // These assertions stop a future TaskOutput rewrite from dropping a functional requirement.
  test("preserves every load-bearing TaskOutput constraint", () => {
    const description = DEVIN_TOOL_DESCRIPTIONS.get("TaskOutput") ?? "";

    expect(description).toMatch(/DEPRECATED/i);
    expect(description).toMatch(/output file[\s\S]*tool result/i);
    expect(description).toContain("<task-notification>");
    expect(description).toMatch(/bash tasks[\s\S]*output path with Read/i);
    expect(description).toMatch(/local_agent tasks[\s\S]*answer[\s\S]*Agent tool returned/i);
    expect(description).toMatch(/\b(?:NEVER|DO NOT)\b[\s\S]{0,100}\bRead\b/i);
    expect(description).toContain("`.output`");
    expect(description).toMatch(/symlink/i);
    expect(description).toMatch(/JSONL/i);
    expect(description).toMatch(/context window/i);
    expect(description).toMatch(/remote_agent tasks[\s\S]*output path with Read/i);
    expect(description).toContain("`task_id`");
    expect(description).toMatch(/`block=true` is the default/i);
    expect(description).toMatch(/`block=false` returns straight away/i);
    expect(description).toContain("`/tasks`");
  });

  // These assertions stop a future WebSearch rewrite from dropping a functional requirement.
  test("preserves every load-bearing WebSearch constraint", () => {
    const description = DEVIN_TOOL_DESCRIPTIONS.get("WebSearch") ?? "";

    expect(description).toContain("Sources:");
    expect(description).toMatch(/MANDATORY/i);
    expect(description).toMatch(/MUST carry a section[\s\S]*`Sources:`/i);
    expect(description).toContain("[Title](URL)");
    expect(description).toContain("`allowed_domains`");
    expect(description).toContain("`blocked_domains`");
    expect(description).toMatch(/served only within the United States/i);
    expect(description).toMatch(/live sources[\s\S]*current events/i);
    expect(description).toMatch(/knowledge cutoff/i);
    expect(description).toMatch(
      /recent material, current documentation or[\s\S]*ongoing events MUST be qualified with that year/i
    );
    expect(description).toMatch(/current\s+year, not the one before it/i);
  });

  // This assertion stops a future WebSearch rewrite from hardcoding stale date guidance.
  test("derives WebSearch's current month and year from the clock", () => {
    const future = buildDevinToolDescriptions(new Date("2031-03-04T00:00:00Z"));
    const currentDescription = DEVIN_TOOL_DESCRIPTIONS.get("WebSearch") ?? "";

    expect(future.get("WebSearch")).toContain("March 2031");
    expect(currentDescription).toContain(String(new Date().getFullYear()));
  });
});

describe("DevinAPIFormat tool-description integration", () => {
  test("puts the substituted Read description into the payload while preserving Bash", () => {
    const format = new DevinAPIFormat("claude-sonnet-5");
    const bashDescription = "Run a shell command exactly as supplied.";
    const payload = format.buildPayload(
      {},
      [{ role: "user", content: "inspect the repository" }],
      [
        {
          type: "function",
          function: {
            name: "Read",
            description: "original Read description",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function",
          function: {
            name: "Bash",
            description: bashDescription,
            parameters: { type: "object", properties: {} },
          },
        },
      ]
    );

    expect(payload.tools?.find((tool) => tool.name === "Read")?.description).toBe(
      shippedDescription("Read")
    );
    expect(payload.tools?.find((tool) => tool.name === "Bash")?.description).toBe(bashDescription);
  });
});
