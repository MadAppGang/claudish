import { describe, expect, test } from "bun:test";
import {
  choiceDialog,
  echoHead,
  echoHeadLength,
  hasChoiceDialog,
  hasEcho,
  inputBox,
  isWorking,
  readBoot,
  screenAnswer,
} from "./screen-classifier.js";
import { loadScreen } from "./test-helpers/fixtures.js";

const TYPED_LINE =
  "Please summarise the purpose of this directory in two sentences, then list three improvements you would make to its layout and naming";
const SUBMITTED_PROMPT = "Reply with exactly the word pear and nothing else, thank you.";
const WRAPPED_PROMPT =
  "Reply with exactly the word pear and nothing else; this prompt is padded so its echo wraps past eighty columns.";
const WRITE_LONG_PATH_PROMPT =
  "Use the Write tool to create the file deeply/nested/directory/structure/for/the/resize/fixture/capture/run/with/a/very/long/path/name/hello.txt containing the word hi. Do nothing else.";
const squash = (text: string): string => text.replace(/\s+/g, "");
const STATES = [
  "repl-boot-empty",
  "repl-typed-long",
  "dialog-trust",
  "permission-write-long-path",
  "working",
  "echo-submitted",
  "answer-short",
] as const;

for (const [cols, rows] of [[80, 24], [120, 40], [250, 60]] as const) {
  describe(`${cols}x${rows} real Claude Code captures`, () => {
    test.each([...STATES])("%s", (state) => {
      const screen = loadScreen(`size-${cols}x${rows}-${state}`);
      expect(screen.cols).toBe(cols);
      expect(screen.rows).toBe(rows);
      switch (state) {
        case "repl-boot-empty":
          expect(inputBox(screen)).not.toBeNull();
          expect(readBoot(screen)).toEqual({ kind: "repl" });
          break;
        case "repl-typed-long": {
          const box = inputBox(screen);
          expect(box).not.toBeNull();
          expect(squash(box?.text ?? "")).toContain(squash(TYPED_LINE));
          break;
        }
        case "dialog-trust":
          expect(readBoot(screen)).toMatchObject({ kind: "dialog", name: "trust" });
          break;
        case "permission-write-long-path":
          expect(hasChoiceDialog(screen)).toBe(true);
          expect(choiceDialog(screen)?.kind).toBe("permission");
          break;
        case "working":
          expect(isWorking(screen)).toBe(true);
          break;
        case "echo-submitted":
          expect(hasEcho(screen.lines, echoHead(SUBMITTED_PROMPT, cols))).toBe(true);
          break;
        case "answer-short":
          expect(screenAnswer(screen, SUBMITTED_PROMPT).trim().length).toBeGreaterThan(0);
          break;
      }
    });
  });
}

test("80x24 working-tail", () => {
  expect(isWorking(loadScreen("size-80x24-working-tail"))).toBe(true);
});

test("80x24 wrapped echo matches the submitted prompt", () => {
  const screen = loadScreen("size-80x24-echo-wrapped");
  expect(WRAPPED_PROMPT.length).toBe(111);
  expect(hasEcho(screen.lines, echoHead(WRAPPED_PROMPT, 80))).toBe(true);
  // The 40-character echoHead fits on row one; the full prompt crosses the wrap.
  expect(hasEcho(screen.lines, WRAPPED_PROMPT)).toBe(true);
});

test.each([80, 120])("%i-column wrapped long-path echo matches the submitted prompt", (cols) => {
  const screen = loadScreen(`size-${cols}x${cols === 80 ? 24 : 40}-permission-write-long-path`);
  expect(hasEcho(screen.lines, echoHead(WRITE_LONG_PATH_PROMPT, cols))).toBe(true);
  // At 80 columns the path wraps mid-word beyond echoHead's 40-character cap.
  expect(hasEcho(screen.lines, WRITE_LONG_PATH_PROMPT)).toBe(true);
});

test("80x24 wrapped permission header identifies a permission dialog", () => {
  const screen = loadScreen("size-80x24-permission-header-wrapped");
  expect(hasChoiceDialog(screen)).toBe(true);
  expect(choiceDialog(screen)?.kind).toBe("permission");
});

describe("echoHeadLength", () => {
  test.each([80, 120, 160, 250])("%i columns use min(40, cols - 4)", (cols) => {
    expect(echoHeadLength(cols)).toBe(Math.min(40, cols - 4));
  });

  // Supported pane widths all hit the 40-character cap. Exercise the helper's
  // width-dependent branch separately, without inventing a screen fixture.
  test("32 columns shorten the echo prefix to 28 characters", () => {
    expect(echoHeadLength(32)).toBe(28);
    expect(echoHead(SUBMITTED_PROMPT, 32)).toBe(SUBMITTED_PROMPT.slice(0, 28));
  });
});
