import { describe, expect, test } from "bun:test";
import {
  agentRejectedLine,
  choiceDialog,
  hasChoiceDialog,
  inputBox,
  isWorking,
  readBoot,
  screenAnswer,
  screenErrorRows,
  stopHookRunning,
  transcriptSavingOff,
} from "./screen-classifier.js";
import { loadScreen } from "./test-helpers/fixtures.js";

/** Every fixture screen, all real 2.1.290 captures (phase2-captures.md §3). */
const REPL_SCREENS = [
  "repl-boot-empty",
  "repl-boot-placeholder",
  "repl-typed",
  "repl-typed-multiline",
  "menu-at-open",
  "menu-slash-open",
  "menu-slash-command",
  "repl-just-submitted",
  "repl-settled",
  "long-bash-running",
  "numbered-prose-bash-running",
  "background-agent-wait",
  "ask-user-question-declined",
  "bash-running-tip",
  "interrupted-tool",
  "streaming-answer",
  "interrupted-streaming",
  "permission-write-declined",
  "stop-hook-running",
  "stop-hook-settled",
  "prompt-hook-running",
  "api-error",
];
const DIALOG_SCREENS = [
  "ask-user-question",
  "permission-write",
  "permission-bash",
  "plan-approval",
];

describe("readBoot", () => {
  test("the empty REPL box reads repl", () => {
    expect(readBoot(loadScreen("repl-boot-empty"))).toEqual({ kind: "repl" });
  });

  test("the fresh-boot placeholder (faint cells) reads as an empty box (X-M14)", () => {
    const s = loadScreen("repl-boot-placeholder");
    // the box prompt is ❯ + NO-BREAK SPACE (U+00A0); echo rows above the box use a plain space
    expect(s.lines.some((l) => l.startsWith('❯\u00a0Try "how does <filepath> work?"'))).toBe(true);
    expect(inputBox(s)?.text).toBe("");
    expect(readBoot(s)).toEqual({ kind: "repl" });
  });

  test("typed text is not an empty box", () => {
    expect(inputBox(loadScreen("repl-typed"))?.text).toBe("alpha");
    expect(inputBox(loadScreen("repl-typed-multiline"))?.text).toBe("alpha\nbeta");
    expect(readBoot(loadScreen("repl-typed")).kind).toBe("booting");
  });

  for (const [screen, name, marker] of [
    ["dialog-onboarding", "onboarding", "Choose the text style"],
    ["dialog-trust", "trust", "Is this a project you created or one you trust"],
    ["dialog-bypass", "bypass", "running in Bypass Permissions mode"],
  ] as const) {
    test(`names the ${name} dialog from its verbatim capture`, () => {
      const s = loadScreen(screen);
      expect(s.alt).toBe(false); // 2.1.290 draws boot dialogs on the primary screen
      const r = readBoot(s);
      expect(r.kind).toBe("dialog");
      if (r.kind === "dialog") {
        expect(r.name).toBe(name);
        expect(r.text).toContain(marker);
      }
    });
  }

  test("an unnumbered dialog outside the closed list reads as an unnamed choice", () => {
    const r = readBoot(loadScreen("dialog-unnamed-mcp-server"));
    expect(r.kind).toBe("choice");
    if (r.kind === "choice") expect(r.text).toContain("New MCP server found in this project");
  });

  test("the agent-rejection screen is neither a REPL nor a dialog", () => {
    expect(readBoot(loadScreen("agent-rejected"))).toEqual({ kind: "booting" });
  });
});

describe("inputBox", () => {
  test("every REPL screen has a box; every turn dialog replaces it", () => {
    for (const n of REPL_SCREENS) expect(inputBox(loadScreen(n))).not.toBeNull();
    for (const n of DIALOG_SCREENS) expect(inputBox(loadScreen(n))).toBeNull();
    expect(inputBox(loadScreen("usage-panel"))).toBeNull();
  });

  test("the box sits on rows 45-47 of the 50-row pane", () => {
    const b = inputBox(loadScreen("repl-settled"))!;
    expect([b.top, b.bottom]).toEqual([45, 47]);
    expect(b.text).toBe("");
  });

  test("menus open above the top rule: slash command, slash list, @ list", () => {
    const pear = inputBox(loadScreen("menu-slash-command"))!;
    expect(pear).toMatchObject({ text: "/pear", menuOpen: true, menuItem: "/pear" });
    const slash = inputBox(loadScreen("menu-slash-open"))!;
    expect(slash).toMatchObject({ text: "/", menuOpen: true, menuItem: "/add-dir" });
    const at = inputBox(loadScreen("menu-at-open"))!;
    expect(at.text).toBe("look at @");
    expect(at.menuOpen).toBe(true);
    expect(at.menuItem).toBeNull();
    expect(inputBox(loadScreen("repl-settled"))!.menuOpen).toBe(false);
    expect(inputBox(loadScreen("repl-typed"))!.menuOpen).toBe(false);
  });
});

describe("hasChoiceDialog — the closed list (R3-H1)", () => {
  test("permission dialogs (Write and Bash) are permission choices", () => {
    expect(choiceDialog(loadScreen("permission-write"))).toMatchObject({ kind: "permission" });
    expect(choiceDialog(loadScreen("permission-write"))!.text).toContain(
      "Do you want to create hello.txt?"
    );
    expect(choiceDialog(loadScreen("permission-bash"))).toMatchObject({ kind: "permission" });
  });

  test("plan approval (no No row, no (esc) row) is a plan choice", () => {
    const d = choiceDialog(loadScreen("plan-approval"))!;
    expect(d.kind).toBe("plan");
    expect(d.text).toContain("Would you like to proceed?");
  });

  test("AskUserQuestion is a question choice", () => {
    const d = choiceDialog(loadScreen("ask-user-question"))!;
    expect(d.kind).toBe("question");
    expect(d.text).toContain("Which fruit do you prefer?");
  });

  test("NEGATIVE: numbered prose containing a No… row above a running Bash is not a dialog", () => {
    const s = loadScreen("numbered-prose-bash-running");
    expect(
      s.lines.some((l) => l.includes("2. No, and tell Claude what to do differently (esc)"))
    ).toBe(true);
    expect(hasChoiceDialog(s)).toBe(false);
  });

  test("NEGATIVE: a working spinner row is not a dialog", () => {
    for (const n of [
      "long-bash-running",
      "bash-running-tip",
      "stop-hook-running",
      "prompt-hook-running",
      "streaming-answer",
    ])
      expect(hasChoiceDialog(loadScreen(n))).toBe(false);
  });

  test("NEGATIVE: no REPL screen, boot dialog or panel reads as a turn dialog", () => {
    for (const n of REPL_SCREENS) expect(hasChoiceDialog(loadScreen(n))).toBe(false);
    for (const n of [
      "dialog-onboarding",
      "dialog-trust",
      "dialog-bypass",
      "dialog-unnamed-mcp-server",
      "usage-panel",
      "agent-rejected",
    ])
      expect(hasChoiceDialog(loadScreen(n))).toBe(false);
  });
});

describe("isWorking / stopHookRunning", () => {
  test("the 2.1.290 working rows read as working", () => {
    for (const n of [
      "long-bash-running",
      "numbered-prose-bash-running",
      "bash-running-tip",
      "stop-hook-running",
      "prompt-hook-running",
    ])
      expect(isWorking(loadScreen(n))).toBe(true);
  });

  test("finished rows (no ellipsis) and idle screens do not", () => {
    for (const n of [
      "repl-boot-empty",
      "repl-settled",
      "stop-hook-settled",
      "interrupted-tool",
      "api-error",
      "ask-user-question-declined",
    ])
      expect(isWorking(loadScreen(n))).toBe(false);
  });

  test("the Stop-hook working row is recognised", () => {
    expect(stopHookRunning(loadScreen("stop-hook-running"))).toBe(true);
    expect(stopHookRunning(loadScreen("stop-hook-settled"))).toBe(false);
    expect(stopHookRunning(loadScreen("prompt-hook-running"))).toBe(false);
  });
});

describe("screenErrorRows", () => {
  test("the API error is a ⏺ row", () => {
    expect(screenErrorRows(loadScreen("api-error"))).toEqual([
      "⏺ Please run /login · API Error: 401 OAuth access token is invalid.",
    ]);
  });

  test("no error rows on ordinary screens", () => {
    for (const n of REPL_SCREENS.filter((x) => x !== "api-error"))
      expect(screenErrorRows(loadScreen(n))).toEqual([]);
  });
});

describe("screenAnswer (degraded mode)", () => {
  test("the settled PEAR answer", () => {
    expect(
      screenAnswer(loadScreen("repl-settled"), "Reply with exactly PEAR and nothing else.")
    ).toBe("PEAR");
  });

  test("a multi-line prose answer keeps its continuation rows and drops the running tool rows", () => {
    const echo =
      "First write, as plain text, a numbered list with exactly these three items: 1. Yes, it ran  2. No, and tell Claude what to do differently (esc)  3. Maybe";
    expect(screenAnswer(loadScreen("numbered-prose-bash-running"), echo)).toBe(
      "1. Yes, it ran\n2. No, and tell Claude what to do differently (esc)\n3. Maybe later"
    );
  });

  test("tool header rows (Bash description, Agent, Background command) are not answer text", () => {
    const s = loadScreen("long-bash-running");
    expect(
      screenAnswer(
        s,
        "Run this exact command with the Bash tool: sleep 12; echo LONGDONE — then reply with its output only."
      )
    ).toBe("");
    const bg = loadScreen("background-agent-wait");
    const echo =
      "Use the Agent tool with run_in_background set to true, subagent_type general-purpose, description fruit, and prompt: Reply with the word OK and nothing else.";
    expect(screenAnswer(bg, echo)).toBe("LAUNCHED");
  });

  test("an error row is not an answer", () => {
    expect(screenAnswer(loadScreen("api-error"), "Reply with exactly PEAR and nothing else.")).toBe(
      ""
    );
  });

  test("no echo, no answer", () => {
    expect(screenAnswer(loadScreen("repl-boot-empty"), "anything")).toBe("");
  });
});

describe("agentRejectedLine", () => {
  test("reads the full line from the final screen", () => {
    const text = loadScreen("agent-rejected").lines.join("\n");
    expect(agentRejectedLine(text)).toBe(
      "--agent 'zzz-not-real' not found. Available agents: claude, claude-code-guide, Explore, general-purpose, Plan, statusline-setup"
    );
  });

  test("matches magmux's truncated exit.lastLine (captured verbatim)", () => {
    expect(agentRejectedLine("--agent 'zzz-not-real' not found. Avail…")).toBe(
      "--agent 'zzz-not-real' not found."
    );
  });

  test("no match on ordinary text", () => {
    expect(agentRejectedLine("[claudish] Model: haiku")).toBeNull();
  });
});

describe("transcriptSavingOff", () => {
  test("is false on every captured screen (F4 strips its cause)", () => {
    for (const n of [...REPL_SCREENS, ...DIALOG_SCREENS])
      expect(transcriptSavingOff(loadScreen(n))).toBe(false);
  });
});
