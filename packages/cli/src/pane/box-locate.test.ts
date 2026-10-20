import { describe, expect, test } from "bun:test";
import { isRuleRow, locateBox } from "./box-locate.js";
import { type ScreenState, boxTopRow } from "./screen-model.js";
import { loadScreen } from "./test-helpers/fixtures.js";

// Literal row indexes read from the real captures, independent of either locator.
const BOX_SCREENS = [
  ["api-error", 45, 47, 46],
  ["ask-user-question-declined", 45, 47, 46],
  ["background-agent-wait", 45, 47, 46],
  ["bash-running-tip", 45, 47, 46],
  ["interrupted-streaming", 45, 47, 46],
  ["interrupted-tool", 45, 47, 46],
  ["long-bash-running", 45, 47, 46],
  ["menu-at-open", 45, 47, 46],
  ["menu-slash-command", 45, 47, 46],
  ["menu-slash-open", 45, 47, 46],
  ["numbered-prose-bash-running", 45, 47, 46],
  ["permission-write-declined", 45, 47, 46],
  ["prompt-hook-running", 45, 47, 46],
  ["repl-boot-agent", 45, 47, 46],
  ["repl-boot-empty", 45, 47, 46],
  ["repl-boot-placeholder", 45, 47, 46],
  ["repl-just-submitted", 45, 47, 46],
  ["repl-settled", 45, 47, 46],
  ["repl-typed", 45, 47, 46],
  ["repl-typed-multiline", 44, 47, 46],
  ["size-120x40-answer-short", 36, 38, 37],
  ["size-120x40-echo-submitted", 36, 38, 37],
  ["size-120x40-repl-boot-empty", 36, 38, 37],
  ["size-120x40-repl-typed-long", 35, 38, 37],
  ["size-120x40-working", 36, 38, 37],
  ["size-250x60-answer-short", 56, 58, 57],
  ["size-250x60-echo-submitted", 56, 58, 57],
  ["size-250x60-repl-boot-empty", 56, 58, 57],
  ["size-250x60-repl-typed-long", 56, 58, 57],
  ["size-250x60-working", 56, 58, 57],
  ["size-350x80-answer-short", 76, 78, 77],
  ["size-350x80-repl-boot-empty", 76, 78, 77],
  ["size-350x80-repl-typed-long", 75, 78, 77],
  ["size-350x80-working", 76, 78, 77],
  ["size-500x100-answer-short", 96, 98, 97],
  ["size-500x100-repl-boot-empty", 96, 98, 97],
  ["size-500x100-repl-typed-long", 95, 98, 97],
  ["size-500x100-working", 96, 98, 97],
  ["size-80x24-answer-short", 20, 22, 21],
  ["size-80x24-echo-submitted", 20, 22, 21],
  ["size-80x24-echo-wrapped", 20, 22, 21],
  ["size-80x24-repl-boot-empty", 20, 22, 21],
  ["size-80x24-repl-typed-long", 19, 22, 21],
  ["size-80x24-working", 20, 22, 21],
  ["size-80x24-working-tail", 20, 22, 21],
  ["stop-hook-running", 45, 47, 46],
  ["stop-hook-settled", 45, 47, 46],
  ["streaming-answer", 45, 47, 46],
] as const;

const NO_BOX_SCREENS = [
  "agent-rejected",
  "ask-user-question",
  "dialog-bypass",
  "dialog-onboarding",
  "dialog-trust",
  "dialog-unnamed-mcp-server",
  "permission-bash",
  "permission-write",
  "plan-approval",
  "size-120x40-dialog-trust",
  "size-120x40-permission-write-long-path",
  "size-250x60-dialog-trust",
  "size-250x60-permission-write-long-path",
  "size-350x80-ask-user-question",
  "size-350x80-permission-write",
  "size-500x100-ask-user-question",
  "size-500x100-permission-write",
  "size-80x24-dialog-trust",
  "size-80x24-permission-header-wrapped",
  "size-80x24-permission-write-long-path",
  "usage-panel",
] as const;

// Boundary mutations of a capture, not additional screen captures. Retain its
// 160x50 geometry and move the two captured rules around its captured prompt.
function withRuleDistances(above: number, below: number): ScreenState {
  const screen = loadScreen("repl-typed");
  const rule = screen.lines[45]!;
  const prompt = screen.lines[46]!;
  screen.lines[45] = "";
  screen.lines[46] = "";
  screen.lines[47] = "";
  screen.lines[0] = rule;
  screen.lines[1] = prompt;
  if (above > 1) screen.lines[above] = "";
  screen.lines[above + below] = rule;
  screen.cursor = { ...screen.cursor, y: above };
  return screen;
}

describe("U5 locateBox at captured widths", () => {
  test("accounts for all 69 supplied screens without duplicate names", () => {
    const names = [...BOX_SCREENS.map(([name]) => name), ...NO_BOX_SCREENS];
    expect(names).toHaveLength(69);
    expect(new Set(names).size).toBe(69);
  });

  test.each(BOX_SCREENS)("%s: locates the captured REPL box", (name, top, bottom, caretRow) => {
    const screen = loadScreen(name);
    expect(locateBox(screen)).toEqual({ top, bottom, caretRow });
    // Pin the old public behaviour too; agreement alone could hide a shared regression.
    expect(boxTopRow(screen.lines, screen.cols)).toBe(top);
  });

  test.each([...NO_BOX_SCREENS])("%s: does not locate an input box", (name) => {
    expect(locateBox(loadScreen(name))).toBeNull();
  });

  test("returns null when the cursor leaves the box or the screen", () => {
    for (const name of ["repl-typed", "repl-typed-multiline"]) {
      const screen = loadScreen(name);
      const top = name === "repl-typed" ? 45 : 44;
      for (const y of [-1, 0, top, 47, screen.rows - 1, screen.rows, screen.rows + 1]) {
        expect(locateBox({ ...screen, cursor: { ...screen.cursor, y } })).toBeNull();
      }
    }
  });

  test("keeps the caret on a multiline continuation rather than the prompt row", () => {
    const screen = loadScreen("repl-typed-multiline");
    expect(screen.lines[45]).toBe("❯ alpha");
    expect(screen.lines[46]).toBe("  beta");
    expect(locateBox(screen)).toEqual({ top: 44, bottom: 47, caretRow: 46 });
  });

  test("rejects ASCII-space submitted echoes as prompt rows", () => {
    const screen = loadScreen("repl-typed");
    screen.lines[46] = "❯ alpha";
    expect(locateBox(screen)).toBeNull();
  });

  test("accepts bare caret nonbreaking-space and bash-mode prompt prefixes", () => {
    for (const prompt of ["❯", "❯ alpha", "!", "! ls"]) {
      const screen = loadScreen("repl-typed");
      screen.lines[46] = prompt;
      expect(locateBox(screen)).toEqual({ top: 45, bottom: 47, caretRow: 46 });
    }
  });

  test("rejects missing indented or tab-separated prompt prefixes", () => {
    for (const prompt of ["", "alpha", " ❯ alpha", "❯\talpha"]) {
      const screen = loadScreen("repl-typed");
      screen.lines[46] = prompt;
      expect(locateBox(screen)).toBeNull();
    }
  });

  test("rejects numbered options on either the prompt row or the continuation caret", () => {
    for (const row of [45, 46]) {
      const screen = loadScreen("repl-typed-multiline");
      screen.lines[row] = "❯ 1. Red";
      expect(locateBox(screen)).toBeNull();
    }
  });

  test("accepts numbered prompt text after a no-break space", () => {
    const screen = loadScreen("repl-typed-multiline");
    screen.lines[45] = "❯\u00a01. Red";
    expect(locateBox(screen)).toEqual({ top: 44, bottom: 47, caretRow: 46 });
  });

  test("returns null when either bounding rule is absent", () => {
    for (const row of [45, 47]) {
      const screen = loadScreen("repl-typed");
      screen.lines[row] = "";
      expect(locateBox(screen)).toBeNull();
    }
  });

  test("does not skip a nearer rule to reuse an older prompt box", () => {
    const screen = loadScreen("repl-typed-multiline");
    screen.lines[45] = screen.lines[44]!;
    expect(locateBox(screen)).toBeNull();
  });

  test("includes a bounding rule exactly 40 rows from the cursor", () => {
    for (const [above, below] of [
      [40, 1],
      [1, 40],
    ] as const) {
      expect(locateBox(withRuleDistances(above, below))).toEqual({
        top: 0,
        bottom: 41,
        caretRow: above,
      });
    }
  });

  test("does not search beyond 40 rows for either bounding rule", () => {
    for (const [above, below] of [
      [41, 1],
      [1, 41],
    ] as const) {
      expect(locateBox(withRuleDistances(above, below))).toBeNull();
    }
  });
});

describe("U6 isRuleRow without a width test", () => {
  test("accepts a 20-cell rule and the captured agent-labelled rule", () => {
    const plain = loadScreen("repl-typed").lines[45]!;
    const labelled = loadScreen("repl-boot-agent").lines[45]!;
    expect(labelled).toContain("Explore");
    expect(isRuleRow(plain.slice(0, 20))).toBe(true);
    expect(isRuleRow(labelled)).toBe(true);
  });

  test("rejects 19-cell indented dashed empty and missing rows", () => {
    const rule = loadScreen("repl-typed").lines[45]!.slice(0, 20);
    for (const line of [
      rule.slice(0, 19),
      ` ${rule}`,
      `${rule} `,
      "╌".repeat(20),
      "-".repeat(20),
      "",
      undefined,
    ]) {
      expect(isRuleRow(line)).toBe(false);
    }
  });

  test("requires a single complete label tail", () => {
    const rule = loadScreen("repl-typed").lines[45]!.slice(0, 20);
    expect(isRuleRow(`${rule} Explore ─`)).toBe(true);
    for (const line of [`${rule} Explore`, `${rule} Explore ─ More ─`, `${rule} Explore ─ `]) {
      expect(isRuleRow(line)).toBe(false);
    }
  });

  test("locates 20-cell boundaries at every captured width without proportional sizing", () => {
    for (const [name, top, bottom, caretRow] of [
      ["size-80x24-repl-boot-empty", 20, 22, 21],
      ["size-120x40-repl-boot-empty", 36, 38, 37],
      ["repl-boot-empty", 45, 47, 46],
      ["size-250x60-repl-boot-empty", 56, 58, 57],
      ["size-350x80-repl-boot-empty", 76, 78, 77],
      ["size-500x100-repl-boot-empty", 96, 98, 97],
    ] as const) {
      const screen = loadScreen(name);
      screen.lines[top] = screen.lines[top]!.slice(0, 20);
      screen.lines[bottom] = screen.lines[bottom]!.slice(0, 20);
      expect(locateBox(screen)).toEqual({ top, bottom, caretRow });
    }
  });

  test("locating a box never reads cols", () => {
    const screen = loadScreen("repl-typed");
    Object.defineProperty(screen, "cols", {
      get() {
        throw new Error("locateBox read cols");
      },
    });
    expect(locateBox(screen)).toEqual({ top: 45, bottom: 47, caretRow: 46 });
  });
});
