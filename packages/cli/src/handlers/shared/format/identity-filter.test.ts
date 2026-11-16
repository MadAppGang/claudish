import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_IDENTITY_HEAD,
  NEUTRAL_IDENTITY_HEAD,
  filterIdentity,
  identityHeadFor,
  keepsClaudeIdentity,
  scrubHarnessIdentity,
} from "./identity-filter.js";

// The identity lines Claude Code writes into its system prompt, copied verbatim
// from a captured request.
const CLAUDE_CODE_SYSTEM = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "",
  "You are an agent working with the user toward their goals.",
  "",
  "# Environment",
  " - Primary working directory: /repo",
  " - The most recent Claude models are the Claude 5 family. Model IDs — Fable 5.2: 'claude-fable-5-2', Opus 5.5: 'claude-opus-5-5'. When building AI applications, default to the latest and most capable Claude models.",
  " - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).",
  " - Fast mode for Claude Code gives faster output on this session's model if it supports fast mode, and otherwise switches the session to Claude Opus. It can be toggled with /fast.",
  "",
  "You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.",
  "",
  "Assistant knowledge cutoff is June 2026.",
  "",
  "<claude_background_info>The assistant is Claude, made by Anthropic.</claude_background_info>",
  "",
  "Read memory from `~/.claude/projects/x/memory/` and follow CLAUDE.md.",
  "Use the Anthropic SDK when the user asks for it.",
  "You are Claude Code, Anthropic's official CLI for Claude.",
].join("\n");

const IDENTITY_TELLS = [
  "Claude Code",
  "Anthropic's official CLI",
  "You are NOT Claude",
  "You are powered by the model named",
  "The exact model ID is",
  "Assistant knowledge cutoff",
  "The most recent Claude models",
  "claude.ai/code",
  "claude_background_info",
  "switches the session to Claude Opus",
];

describe("filterIdentity on Claude Code's system prompt", () => {
  test("removes every Claude Code identity line", () => {
    const out = filterIdentity(CLAUDE_CODE_SYSTEM);
    for (const tell of IDENTITY_TELLS) expect(out).not.toContain(tell);
  });

  test("starts with the neutral header, which names neither Claude nor Anthropic", () => {
    const out = filterIdentity(CLAUDE_CODE_SYSTEM);
    expect(out.startsWith(NEUTRAL_IDENTITY_HEAD)).toBe(true);
    expect(NEUTRAL_IDENTITY_HEAD).not.toMatch(/claude|anthropic/i);
  });

  test("keeps the instructions, file paths and product names around the identity lines", () => {
    const out = filterIdentity(CLAUDE_CODE_SYSTEM);
    expect(out).toContain("You are an agent working with the user toward their goals.");
    expect(out).toContain(" - Primary working directory: /repo");
    expect(out).toContain("`~/.claude/projects/x/memory/`");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("Use the Anthropic SDK when the user asks for it.");
  });

  test("removes a model name that itself contains a full stop, with no fragment left", () => {
    const out = filterIdentity(
      "A.\nYou are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.\nB."
    );
    expect(out).not.toContain("5.5");
    expect(out).not.toContain("claude-opus-5-5");
    expect(out).toContain("A.");
    expect(out).toContain("B.");
  });

  test("renames the remaining Claude Code mentions to Agent CLI", () => {
    const out = filterIdentity(
      "This file provides guidance to Claude Code (claude.ai/code) when working with code.\nConfigure the Claude Code harness. Claude Code's settings live in a file."
    );
    expect(out).toContain("This file provides guidance to Agent CLI when working with code.");
    expect(out).toContain("Configure the Agent CLI harness. Agent CLI's settings live in a file.");
  });

  test("is idempotent: a second pass changes nothing and adds no second header", () => {
    const once = filterIdentity(CLAUDE_CODE_SYSTEM);
    expect(filterIdentity(once)).toBe(once);
  });

  test("with the Antigravity header, starts with Antigravity's own identity block", () => {
    const out = filterIdentity(CLAUDE_CODE_SYSTEM, ANTIGRAVITY_IDENTITY_HEAD);
    expect(
      out.startsWith(
        "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding."
      )
    ).toBe(true);
    expect(out).not.toContain(NEUTRAL_IDENTITY_HEAD);
    for (const tell of IDENTITY_TELLS) expect(out).not.toContain(tell);
  });

  test("a later default pass keeps an Antigravity header and adds no neutral one", () => {
    const agy = filterIdentity(CLAUDE_CODE_SYSTEM, ANTIGRAVITY_IDENTITY_HEAD);
    expect(filterIdentity(agy)).toBe(agy);
  });
});

describe("text that addresses the reader as Claude", () => {
  // No identity opener in these texts, so no header is added.
  const scrub = (text: string) => filterIdentity(text);

  test("renames Claude to the assistant where it names the reader", () => {
    expect(scrub("Claude uses it when a page would be clearer.")).toBe(
      "The assistant uses it when a page would be clearer."
    );
    expect(scrub("A page that Claude publishes. Claude never publishes a fake.")).toBe(
      "A page that the assistant publishes. The assistant never publishes a fake."
    );
    expect(scrub("- Claude reads the whole file.\n- It hands Claude the live version.")).toBe(
      "- The assistant reads the whole file.\n- It hands the assistant the live version."
    );
    expect(scrub("**Load it before runtime code.** Claude prefers a capability.")).toBe(
      "**Load it before runtime code.** The assistant prefers a capability."
    );
    expect(scrub("Files go in Claude's scratchpad directory.")).toBe(
      "Files go in the assistant's scratchpad directory."
    );
  });

  test("renames a Claude session to an Agent CLI session", () => {
    expect(scrub("Messages from other Claude sessions and another Claude session.")).toBe(
      "Messages from other Agent CLI sessions and another Agent CLI session."
    );
  });

  test("keeps product, model, tool and file names", () => {
    const kept = [
      "Use Claude Design or Claude Docs.",
      "The Claude API (formerly Anthropic API) and the Claude Agent SDK.",
      "It is not for Claude in Chrome or Claude in Slack.",
      "Access to Claude models on the user's login, such as Claude Opus.",
      "Pick a Claude model in the Claude desktop app.",
      "The prompt names Claude/Anthropic in any form (Claude, Anthropic, Fable, Opus).",
      'Questions such as "Can Claude..." or "Does Claude...".',
      "Tools named mcp__Claude_Browser__* and model id claude-opus-5-5.",
      "Claude-Session: https://claude.ai/code/session_0173",
      "Follow CLAUDE.md under ~/.claude/ and open a claude.ai link.",
    ];
    for (const line of kept) expect(scrub(line)).toBe(line);
  });
});

describe("scrubHarnessIdentity on a whole request", () => {
  const request = () => ({
    model: "gemini-4-carbon",
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "Be brief." },
    ],
    tools: [
      {
        name: "Agent",
        description: "Launch a full Claude Code session.",
        input_schema: { type: "object", properties: { note: { description: "Claude Code" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nClaude Code attached this context automatically.\n</system-reminder>",
          },
          { type: "text", text: "Tell me about Claude Code." },
          {
            type: "text",
            text: "Fix it.<system-reminder>This file provides guidance to Claude Code (claude.ai/code).</system-reminder>",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Claude Code is the harness." }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "const name = 'Claude Code'; // You are Claude Code, Anthropic's official CLI",
          },
        ],
      },
      {
        role: "user",
        content:
          "<system-reminder>Claude Code attached this.</system-reminder>\nWhat is Claude Code?",
      },
    ],
  });

  test("scrubs the system prompt and puts the given header first, keeping the array shape", () => {
    const out = scrubHarnessIdentity(request(), NEUTRAL_IDENTITY_HEAD);
    const system = out.system as Array<{ type: string; text: string }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].text).toBe(NEUTRAL_IDENTITY_HEAD); // header is its own first block
    expect(system[1].text).toBe("Be brief."); // the identity-only block was dropped
    const joined = JSON.stringify(system);
    expect(joined).not.toContain("Claude Code");
    expect(joined).not.toContain("Anthropic");
  });

  test("preserves cache_control and other fields on the surviving system blocks", () => {
    const req = {
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "Project rules.", cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    };
    const system = scrubHarnessIdentity(req, NEUTRAL_IDENTITY_HEAD).system as any[];
    const kept = system.find((b) => b.text === "Project rules.");
    expect(kept.cache_control).toEqual({ type: "ephemeral" });
  });

  test("does not add a header when there is no identity opener to replace", () => {
    const req = { system: [{ type: "text", text: "Be brief." }], messages: [] };
    const system = scrubHarnessIdentity(req, NEUTRAL_IDENTITY_HEAD).system as any[];
    expect(system).toEqual([{ type: "text", text: "Be brief." }]);
  });

  test("leaves a string system prompt that holds no identity opener unchanged", () => {
    const out = scrubHarnessIdentity(
      { system: "SYSTEM-NOTE", messages: [] },
      NEUTRAL_IDENTITY_HEAD
    );
    expect(out.system).toBe("SYSTEM-NOTE");
  });

  test("scrubs system-reminder spans and leaves the user's own words unchanged", () => {
    const out = scrubHarnessIdentity(request(), NEUTRAL_IDENTITY_HEAD);
    const first = out.messages[0].content as Array<{ text: string }>;
    expect(first[0].text).toBe(
      "<system-reminder>\nAgent CLI attached this context automatically.\n</system-reminder>"
    );
    expect(first[1].text).toBe("Tell me about Claude Code.");
    expect(first[2].text).toBe(
      "Fix it.<system-reminder>This file provides guidance to Agent CLI.</system-reminder>"
    );
    expect(out.messages[3].content).toBe(
      "<system-reminder>Agent CLI attached this.</system-reminder>\nWhat is Claude Code?"
    );
  });

  test("never changes assistant turns or tool results", () => {
    const out = scrubHarnessIdentity(request(), NEUTRAL_IDENTITY_HEAD);
    expect(out.messages[1]).toEqual(request().messages[1]);
    expect(out.messages[2]).toEqual(request().messages[2]);
  });

  test("scrubs tool descriptions and schema descriptions, never names, keys or enum values", () => {
    const tool = {
      name: "Claude_Browser",
      description: "Launch a full Claude Code session.",
      input_schema: {
        type: "object",
        properties: {
          Claude: { type: "string", description: "Claude omits it on a redeploy." },
          model: {
            type: "string",
            enum: ["Claude Code", "opus"],
            description: "Model for the Claude Code subagent.",
          },
          list: {
            type: "array",
            items: { type: "object", properties: { a: { description: "Claude passes it." } } },
          },
        },
      },
    };
    const out = scrubHarnessIdentity({ tools: [tool], messages: [] }, NEUTRAL_IDENTITY_HEAD);
    const schema = out.tools[0].input_schema as any;
    expect(out.tools[0].name).toBe("Claude_Browser");
    expect(out.tools[0].description).toBe("Launch a full Agent CLI session.");
    expect(Object.keys(schema.properties)).toEqual(["Claude", "model", "list"]);
    expect(schema.properties.Claude.description).toBe("The assistant omits it on a redeploy.");
    expect(schema.properties.model.enum).toEqual(["Claude Code", "opus"]);
    expect(schema.properties.model.description).toBe("Model for the Agent CLI subagent.");
    expect(schema.properties.list.items.properties.a.description).toBe("The assistant passes it.");
  });

  test("scrubs inline system messages whole, and the tool definitions they add", () => {
    const inline = {
      role: "system",
      content: [
        { type: "text", text: "Each session is an interactive Claude Code. Claude polls it." },
        {
          type: "tool_addition",
          tool: {
            type: "tool_definition",
            definition: {
              name: "SendFeedback",
              description: "Draft feedback about Claude Code.",
              input_schema: {
                type: "object",
                properties: { title: { description: "How Claude responded." } },
              },
            },
          },
        },
      ],
    };
    const out = scrubHarnessIdentity({ messages: [inline] }, NEUTRAL_IDENTITY_HEAD);
    const content = out.messages[0].content as any[];
    expect(content[0].text).toBe(
      "Each session is an interactive Agent CLI. The assistant polls it."
    );
    expect(content[1].tool.definition.name).toBe("SendFeedback");
    expect(content[1].tool.definition.description).toBe("Draft feedback about Agent CLI.");
    expect(content[1].tool.definition.input_schema.properties.title.description).toBe(
      "How the assistant responded."
    );
  });

  test("scrubs the fixed wrappers Claude Code puts around user text, not the text itself", () => {
    const text = [
      "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>",
      "Phase B vote, internal Claude (patch quality), in Claude Code.",
      "",
      "This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.",
      "Another Claude session sent a message:",
      "This came from another Claude session — not typed by your user.",
    ].join("\n");
    const out = scrubHarnessIdentity(
      { messages: [{ role: "user", content: text }] },
      NEUTRAL_IDENTITY_HEAD
    );
    expect(out.messages[0].content).toBe(
      [
        "<local-command-caveat>The command below was run directly in Agent CLI, not sent to you as a request.</local-command-caveat>",
        "Phase B vote, internal Claude (patch quality), in Claude Code.",
        "",
        "This is how Agent CLI surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.",
        "Another Agent CLI session sent a message:",
        "This came from another Agent CLI session — not typed by your user.",
      ].join("\n")
    );
  });

  test("keeps the commit trailer a reminder tells the model to write", () => {
    const reminder =
      "<system-reminder>End commits with:\nClaude-Session: https://claude.ai/code/session_0173\n</system-reminder>";
    const out = scrubHarnessIdentity(
      { messages: [{ role: "user", content: reminder }] },
      NEUTRAL_IDENTITY_HEAD
    );
    expect(out.messages[0].content).toBe(reminder);
  });

  test("does not mutate the request it is given", () => {
    const original = request();
    scrubHarnessIdentity(original, NEUTRAL_IDENTITY_HEAD);
    expect(original).toEqual(request());
  });

  test("a request with no system prompt and no identity gets no synthesized header", () => {
    const out = scrubHarnessIdentity(
      { messages: [] } as Record<string, unknown>,
      ANTIGRAVITY_IDENTITY_HEAD
    );
    expect(out.system).toBeUndefined();
  });
});

describe("which header and whether to scrub", () => {
  test("the antigravity claudish provider gets the Antigravity header, every other one the neutral header", () => {
    expect(identityHeadFor("antigravity")).toBe(ANTIGRAVITY_IDENTITY_HEAD);
    expect(identityHeadFor("devin")).toBe(NEUTRAL_IDENTITY_HEAD);
    expect(identityHeadFor("openrouter")).toBe(NEUTRAL_IDENTITY_HEAD);
  });

  test("a real Claude model keeps its identity; every other model is scrubbed", () => {
    expect(keepsClaudeIdentity({ native: true, vendor: null, model: "x" })).toBe(true);
    expect(keepsClaudeIdentity({ native: false, vendor: "anthropic", model: "x" })).toBe(true);
    expect(
      keepsClaudeIdentity({ native: false, vendor: null, model: "anthropic/claude-sonnet-5" })
    ).toBe(true);
    expect(keepsClaudeIdentity({ native: false, vendor: null, model: "claude-opus-5-5" })).toBe(
      true
    );
    expect(keepsClaudeIdentity({ native: false, vendor: "google", model: "gemini-4-carbon" })).toBe(
      false
    );
    expect(
      keepsClaudeIdentity({ native: false, vendor: "google", model: "claude-named-gemini" })
    ).toBe(false);
    expect(keepsClaudeIdentity({ native: false, vendor: null, model: "gemini-4-carbon" })).toBe(
      false
    );
  });
});

describe("review regressions: text the scrub must not change", () => {
  const scrubUser = (text: string) =>
    scrubHarnessIdentity({ messages: [{ role: "user", content: text }] }, NEUTRAL_IDENTITY_HEAD)
      .messages[0].content;

  test("a wrapper sentence quoted inside a line the user typed stays as typed", () => {
    const typed = [
      'In app.ts, replace the literal "Another Claude session sent a message:" with "Received".',
      "Why does it say: This is how Claude Code surfaces messages the user sends mid-turn?",
      "Note: This came from another Claude session, I think.",
    ];
    for (const line of typed) expect(scrubUser(line)).toBe(line);
  });

  test("the same sentences as whole lines in Claude Code's wording are scrubbed", () => {
    const injected = [
      "do the thing",
      "",
      "This is how Claude Code surfaces messages the user sends mid-turn — within the running turn.",
      "Another Claude session sent a message:",
      "This came from another Claude session, not from the user.",
    ].join("\n");
    const out = scrubUser(injected);
    expect(out).toContain("do the thing");
    expect(out).not.toContain("Claude");
    expect(out).toContain("This is how Agent CLI surfaces messages");
  });

  test("Claude Code inside a path or a quoted literal in a reminder is kept", () => {
    const kept = [
      "<system-reminder>Open /Applications/Claude Code.app first.</system-reminder>",
      '<system-reminder>const label = "Claude Code";</system-reminder>',
      "<system-reminder>Run `Claude Code` from the dock.</system-reminder>",
      '<system-reminder>Run `Claude` or "Claude" in the terminal.</system-reminder>',
      "<system-reminder>Set Claude = true in config.</system-reminder>",
    ];
    for (const line of kept) expect(scrubUser(line)).toBe(line);
  });

  test("prose in a reminder is still renamed, the possessive included", () => {
    expect(
      scrubUser("<system-reminder>Claude Code's hooks run. Claude reads them.</system-reminder>")
    ).toBe("<system-reminder>Agent CLI's hooks run. The assistant reads them.</system-reminder>");
  });

  test("an identity sentence directly before the closing tag is removed", () => {
    const reminder = (text: string) => `<system-reminder>${text}</system-reminder>`;
    for (const sentence of [
      "Assistant knowledge cutoff is June 2026.",
      "You are powered by the model named Opus 5.5.",
      "The exact model ID is claude-opus-5-5.",
      "You are Claude Code, Anthropic's official CLI for Claude.",
    ]) {
      expect(scrubUser(reminder(sentence))).toBe(reminder(""));
    }
    expect(scrubUser(reminder("Note: The exact model ID is claude-opus-5-5."))).toBe(
      reminder("Note: ")
    );
  });

  test("a wrapper line inside a fenced block the user pasted stays as pasted", () => {
    const pasted = [
      "Replace this exact line:",
      "",
      "```text",
      "Another Claude session sent a message:",
      "```",
    ].join("\n");
    expect(scrubUser(pasted)).toBe(pasted);
  });

  test("code and literals in a reminder are never renamed", () => {
    const kept = [
      '<system-reminder>const label = "Ask Claude Code to help";</system-reminder>',
      '<system-reminder>const label = "Ask Claude to help";</system-reminder>',
      "<system-reminder>Run `ask Claude here` now.</system-reminder>",
      "<system-reminder>\n```\nClaude Code runs. Claude reads.\n```\n</system-reminder>",
      "<system-reminder>Read C:\\Users\\Claude\\settings.json and Claude.json.</system-reminder>",
      "<system-reminder>Compare Claude 4 and Claude 3.5 Sonnet.</system-reminder>",
    ];
    for (const line of kept) expect(scrubUser(line)).toBe(line);
  });

  test("a reminder-shaped line inside a fenced block the user pasted stays as pasted", () => {
    const pasted =
      "Here is a file to copy verbatim:\n```xml\n<system-reminder>Claude Code reads. Claude waits.</system-reminder>\n```";
    expect(scrubUser(pasted)).toBe(pasted);
  });

  test("tilde fences, escaped quotes and a path separator after the name are kept", () => {
    const kept = [
      "<system-reminder>\n~~~ts\nconst a = Claude Code;\n~~~\n</system-reminder>",
      String.raw`<system-reminder>const label = "Say \"Ask Claude Code to help\" now";</system-reminder>`,
      String.raw`<system-reminder>Read Claude\settings.json.</system-reminder>`,
      "<system-reminder>Read Claude Code/settings.json.</system-reminder>",
    ];
    for (const line of kept) expect(scrubUser(line)).toBe(line);
  });

  test("a longer fence that holds a shorter one, and a tag inside inline code, stay as pasted", () => {
    const kept = [
      "````md\n```xml\n<system-reminder>Claude Code reads.</system-reminder>\n```\n````",
      "~~~~md\n~~~xml\n<system-reminder>Claude Code reads.</system-reminder>\n~~~\n~~~~",
      "~~~xml\n<system-reminder>Claude Code reads.</system-reminder>\n~~~",
      "Copy `<system-reminder>Claude Code reads.</system-reminder>` verbatim.",
    ];
    for (const text of kept) expect(scrubUser(text)).toBe(text);
  });

  test("tildes inside a prose line do not open a fence: the reminder between them is scrubbed", () => {
    const text =
      "Use ~~~ as a delimiter.\n<system-reminder>You are powered by the model named Opus 5.5.</system-reminder>\nClose with ~~~.";
    expect(scrubUser(text)).toBe(
      "Use ~~~ as a delimiter.\n<system-reminder></system-reminder>\nClose with ~~~."
    );
  });

  test("a fence in a list item or a blockquote, an unclosed fence, a line that does not close it", () => {
    const tag = "<system-reminder>Claude Code reads.</system-reminder>";
    const kept = [
      `- \`\`\`xml\n  ${tag}\n  \`\`\``,
      `1. \`\`\`xml\n   ${tag}\n   \`\`\``,
      `> \`\`\`xml\n> ${tag}\n> \`\`\``,
      `\`\`\`xml\n${tag}`,
      `\`\`\`xml\n${tag}\n\`\`\` not a closing fence`,
      `\`\`\`xml\nkeep\n\`\`\`~~~\n${tag}\n\`\`\``,
      `  \`\`\`xml\r\n  ${tag}\r\n  \`\`\``,
    ];
    for (const text of kept) expect(scrubUser(text)).toBe(text);
  });

  test("a fenced reminder example inside a real reminder does not end the real one", () => {
    const real = [
      "<system-reminder>Claude Code reads.",
      "```xml",
      "<system-reminder>Claude Code source.</system-reminder>",
      "```",
      "Claude Code waits.",
      "You are powered by the model named Opus 5.5.",
      "</system-reminder>",
    ].join("\n");
    expect(scrubUser(real)).toBe(
      [
        "<system-reminder>Agent CLI reads.",
        "```xml",
        "<system-reminder>Claude Code source.</system-reminder>",
        "```",
        "Agent CLI waits.",
        "",
        "</system-reminder>",
      ].join("\n")
    );
  });

  test("two real reminders in one text are both scrubbed, and the text between is kept", () => {
    expect(
      scrubUser(
        "<system-reminder>Claude Code a.</system-reminder> Claude Code user text <system-reminder>Claude Code b.</system-reminder>"
      )
    ).toBe(
      "<system-reminder>Agent CLI a.</system-reminder> Claude Code user text <system-reminder>Agent CLI b.</system-reminder>"
    );
  });

  test("inline code with a run of two or more backticks is code", () => {
    const b = "`";
    const kept = [
      `${b}${b}<system-reminder>Claude Code reads.</system-reminder>${b}${b}`,
      `<system-reminder>Copy ${b}${b}Ask Claude Code now${b}${b} exactly.</system-reminder>`,
      `<system-reminder>Type ${b}${b}a ${b}Claude${b} b${b}${b} there.</system-reminder>`,
    ];
    for (const text of kept) expect(scrubUser(text)).toBe(text);
  });

  test("a fence that never closes inside a real reminder does not hide its closing tag", () => {
    const text = [
      "<system-reminder>Claude Code before.",
      "```text",
      "example",
      "You are powered by the model named Opus 5.5.",
      "</system-reminder>",
    ].join("\n");
    const out = scrubUser(text) as string;
    expect(out.startsWith("<system-reminder>Agent CLI before.")).toBe(true);
    expect(out).not.toContain("You are powered by");
    expect(out.endsWith("</system-reminder>")).toBe(true);
  });

  test("a reminder nested in a reminder: the outer tail is scrubbed too", () => {
    expect(
      scrubUser(
        "<system-reminder>Claude Code outer.<system-reminder>Claude Code inner.</system-reminder>Claude Code tail. You are powered by the model named Opus 5.5.</system-reminder>"
      )
    ).toBe(
      "<system-reminder>Agent CLI outer.<system-reminder>Agent CLI inner.</system-reminder>Agent CLI tail. </system-reminder>"
    );
  });

  test("a dash directly before backticks is prose, so the reminder after it is scrubbed", () => {
    const out = scrubUser(
      "-``` later\n<system-reminder>Claude Code reads.</system-reminder>"
    ) as string;
    expect(out).toContain("Agent CLI reads.");
  });

  test("every pattern stays fast on a prefix repeated with nothing to finish the match", () => {
    // Each of these took 290 ms to 1.1 s at 190 KB before its pattern was bounded
    // or replaced by a scanner. The bound leaves a wide margin for a loaded machine.
    const cap = (text: string) => text.slice(0, 190_000);
    const hostile = [
      '\\"'.repeat(60_000),
      "You are powered by the model named x ".repeat(6_000),
      "Assistant knowledge cutoff is x ".repeat(7_000),
      "<claude_background_info> ".repeat(8_000),
    ];
    for (const body of hostile) {
      const text = `<system-reminder>Claude Code reads. ${cap(body)}</system-reminder>`;
      const started = performance.now();
      const out = scrubUser(text) as string;
      expect(out).toContain("Agent CLI reads.");
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  test("the bounded and scanned patterns still do their job on ordinary text", () => {
    expect(
      scrubUser(
        '<system-reminder>You are powered by the model named Opus 5.5. Say "Ask Claude Code" and \\"Claude Code\\" too. <claude_background_info>The assistant is Claude.</claude_background_info>Claude Code runs.</system-reminder>'
      )
    ).toBe(
      // A name directly beside a quote character is kept, with or without a backslash.
      '<system-reminder> Say "Ask Claude Code" and \\"Claude Code\\" too. Agent CLI runs.</system-reminder>'
    );
  });

  test("a long run of backticks with no closing run is scrubbed in well under a second", () => {
    // 2 to 3 s with a regex for inline code; the scanner reads each character once.
    const text = `<system-reminder>Claude Code reads. x${"`".repeat(25_000)}</system-reminder>`;
    const started = performance.now();
    const out = scrubUser(text) as string;
    expect(out).toContain("Agent CLI reads.");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("many lone backticks on one long line are scrubbed in well under a second", () => {
    const text = `<system-reminder>Claude Code reads. ${"a ` b `` c ".repeat(8_000)}</system-reminder>`;
    const started = performance.now();
    scrubUser(text);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a long run of spaces in a reminder is scrubbed in well under a second", () => {
    const text = `<system-reminder>${" ".repeat(100_000)}Claude Code reads.</system-reminder>`;
    const started = performance.now();
    const out = scrubUser(text) as string;
    expect(out).toContain("Agent CLI reads.");
    // 2 s before the fix; the bound leaves a wide margin for a loaded machine.
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("prose beside a literal is still renamed, and keeps its sentence case", () => {
    expect(
      scrubUser(
        "<system-reminder>Use `x`. Claude reads `Claude Code`; so Claude waits.</system-reminder>"
      )
    ).toBe(
      "<system-reminder>Use `x`. The assistant reads `Claude Code`; so the assistant waits.</system-reminder>"
    );
  });
});

describe("review regressions: identity sentences", () => {
  test("the opener is removed to its real end when the sentence holds a dotted token", () => {
    expect(
      filterIdentity(
        "You are Claude Code, Anthropic's official CLI for Claude, v2.1. Follow rules."
      )
    ).toBe(`${NEUTRAL_IDENTITY_HEAD}\n\nFollow rules.`);
  });

  test("the model id sentence is removed on its own line too", () => {
    const out = filterIdentity(
      "You are powered by the model named Opus 5.5.\nThe exact model ID is claude-opus-5-5.\nBe brief."
    );
    expect(out).toBe("Be brief.");
  });

  test("a prompt with no identity opener gets no header", () => {
    expect(filterIdentity("Be brief.")).toBe("Be brief.");
    expect(filterIdentity("You are a helpful assistant.")).toBe("You are a helpful assistant.");
  });

  test("a prompt with the opener gets the header once, and a second pass changes nothing", () => {
    const once = filterIdentity(
      "You are Claude Code, Anthropic's official CLI for Claude.\n\nBe brief."
    );
    expect(once).toBe(`${NEUTRAL_IDENTITY_HEAD}\n\nBe brief.`);
    expect(filterIdentity(once)).toBe(once);
  });
});

describe("review regressions: schema property names", () => {
  test("a property NAMED default, enum or examples has its description scrubbed", () => {
    const tool = {
      name: "T",
      description: "x",
      input_schema: {
        type: "object",
        properties: {
          default: { type: "string", description: "Claude uses this as fallback." },
          enum: { type: "string", description: "Claude Code reads it." },
          mode: { type: "string", enum: ["Claude Code"], default: "Claude Code" },
        },
      },
    };
    const out = scrubHarnessIdentity({ tools: [tool], messages: [] }, NEUTRAL_IDENTITY_HEAD);
    const props = out.tools[0].input_schema.properties;
    expect(props.default.description).toBe("The assistant uses this as fallback.");
    expect(props.enum.description).toBe("Agent CLI reads it.");
    // Keyword values stay data: the model sends them back verbatim.
    expect(props.mode.enum).toEqual(["Claude Code"]);
    expect(props.mode.default).toBe("Claude Code");
  });
});

describe("review regressions: which model keeps the Claude identity", () => {
  test("the catalog vendor outranks the name-based native flag", () => {
    expect(
      keepsClaudeIdentity({ native: true, vendor: "google", model: "claude-named-gemini" })
    ).toBe(false);
    expect(
      keepsClaudeIdentity({ native: true, vendor: "anthropic", model: "claude-opus-5-5" })
    ).toBe(true);
  });

  test("a dotted cloud id of a Claude model keeps the identity", () => {
    for (const model of [
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
    ]) {
      expect(keepsClaudeIdentity({ native: false, vendor: null, model })).toBe(true);
    }
    expect(keepsClaudeIdentity({ native: false, vendor: null, model: "notclaude-x" })).toBe(false);
  });
});
