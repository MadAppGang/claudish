import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALT_SPLIT_MARKER,
  MAX_TYPED_LINE,
  READ_LINE_LIMIT,
  SPLIT_MARKER,
  fileTemplate,
  isPlainLine,
  joinSplitLines,
  planDelivery,
  renderTurnFile,
  writeTurnFile,
} from "./prompt-delivery.js";
import { transcriptRecords } from "./test-helpers/transcript-fixtures.js";

const TURN_DIR = "/tmp/claudish-mux-501/launch-Ab3dE9";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("plain lines are typed", () => {
  test("conversational replies", () => {
    for (const t of [
      "yes",
      "continue with option 2",
      "Reply with exactly PEAR and nothing else.",
    ]) {
      expect(planDelivery(t, TURN_DIR, 1, true)).toEqual({
        mode: "typed",
        line: t,
        witness: { kind: "text", text: t },
      });
    }
  });

  test("not plain: leading ! # ? @ & \\, trailing @x or /x, control chars, tab, CR, newline, > 512 chars", () => {
    for (const t of [
      "!ls",
      "#memo",
      "?help",
      "@file look",
      "&bg",
      "\\x",
      "look at @src",
      "open /tmp/x",
      "a\tb",
      "a\rb",
      "a\nb",
      "a\u001bb",
      "a\u007fb",
      "x".repeat(MAX_TYPED_LINE + 1),
    ])
      expect(isPlainLine(t)).toBe(false);
    expect(isPlainLine("x".repeat(MAX_TYPED_LINE))).toBe(true);
    expect(isPlainLine("   ")).toBe(false);
  });
});

describe("slash commands", () => {
  test("a short single-line command is typed and witnessed by its command name or its typed line", () => {
    expect(planDelivery("/pear", TURN_DIR, 1, true)).toEqual({
      mode: "command",
      line: "/pear",
      witness: { kind: "command", name: "pear", line: "/pear" },
    });
    expect(planDelivery("/review\tthe diff", TURN_DIR, 1, true)).toMatchObject({
      mode: "command",
      line: "/review the diff",
    });
    expect(planDelivery("/plugin:cmd arg", TURN_DIR, 1, true)).toMatchObject({
      witness: { kind: "command", name: "plugin:cmd" },
    });
  });

  test("the witness name matches the record the real /pear wrote", () => {
    const rec = transcriptRecords("slash-and-reads").find(
      (r) => r.type === "user" && JSON.stringify(r.message.content).includes("command-name")
    );
    const d = planDelivery("/pear", TURN_DIR, 1, true);
    expect(d.mode).toBe("command");
    if (d.mode === "command" && d.witness.kind === "command")
      expect(rec!.message.content).toContain(`<command-name>/${d.witness.name}</command-name>`);
  });

  test("a multi-line command goes to the file with a pointer line", () => {
    const d = planDelivery("/review\nplease look at\nall of it", TURN_DIR, 3, true);
    expect(d).toMatchObject({
      mode: "command",
      line: `/review — the full arguments are in the file \`${TURN_DIR}/turn-3.md\`; read all of it first.`,
      file: `${TURN_DIR}/turn-3.md`,
      fileContent: "/review\nplease look at\nall of it",
      witness: { kind: "command", name: "review" },
    });
  });

  test("a first line over 512 chars also goes to the file", () => {
    const d = planDelivery(`/review ${"x".repeat(600)}`, TURN_DIR, 1, true);
    expect(d.mode).toBe("command");
    if (d.mode === "command") expect(d.file).toBe(`${TURN_DIR}/turn-1.md`);
  });

  test("/exit and /quit are control deliveries", () => {
    expect(planDelivery("/exit", TURN_DIR, 1, true)).toEqual({ mode: "control", line: "/exit" });
    expect(planDelivery(" /quit ", TURN_DIR, 1, true)).toEqual({ mode: "control", line: "/quit" });
  });
});

describe("everything else is a turn file", () => {
  test("the typed line is exactly the template, and it is the witness", () => {
    const text = "line one\nline two";
    const d = planDelivery(text, TURN_DIR, 2, true);
    expect(d.mode).toBe("file");
    if (d.mode !== "file") return;
    expect(d.file).toBe(`${TURN_DIR}/turn-2.md`);
    expect(d.line).toBe(
      `Your task is in the file \`${TURN_DIR}/turn-2.md\`. Read all of it with the Read tool (in parts if it is long), then do exactly what it says, treating its content as the user's message.`
    );
    expect(d.witness).toEqual({ kind: "text", text: d.line });
    expect(d.fileContent).toBe(text);
    expect(d.lines).toBe(2);
  });

  test("the template the capture typed was witnessed verbatim (s03 t11)", () => {
    const rec = transcriptRecords("tools-session").find(
      (r) =>
        typeof r.message?.content === "string" &&
        r.message.content.startsWith("Your task is in the file")
    );
    const file = (rec!.message.content as string).match(/`([^`]+)`/)![1]!;
    expect(rec!.message.content).toBe(fileTemplate(file, null));
  });

  test("the template is a plain line: ≤ 300 chars, no @, ends with '.', opens no menu", () => {
    const line = fileTemplate(`${TURN_DIR}/turn-99.md`, SPLIT_MARKER);
    expect(line.length).toBeLessThanOrEqual(400);
    expect(fileTemplate(`${TURN_DIR}/turn-99.md`, null).length).toBeLessThanOrEqual(300);
    expect(line.includes("@")).toBe(false);
    expect(line.endsWith(".")).toBe(true);
    expect(isPlainLine(fileTemplate(`${TURN_DIR}/turn-1.md`, null))).toBe(true);
  });

  test("CRLF, tabs, leading ! and a 200 KB prompt keep their bytes in the file", () => {
    for (const text of [
      "a\r\nb\r\n",
      "\tindented\n",
      "!rm -rf /",
      "x".repeat(200_000).replace(/(.{100})/g, "$1\n"),
    ]) {
      const d = planDelivery(text, TURN_DIR, 1, true);
      expect(d.mode).toBe("file");
      if (d.mode === "file") expect(d.fileContent).toBe(text);
    }
  });

  test("without the Read tool, a non-plain prompt is refused with a reason", () => {
    const d = planDelivery("line one\nline two", TURN_DIR, 1, false);
    expect(d.mode).toBe("refused");
    expect(planDelivery("yes", TURN_DIR, 1, false).mode).toBe("typed");
    expect(planDelivery("/review\nmore", TURN_DIR, 1, false).mode).toBe("refused");
  });

  test("an empty prompt is refused", () => {
    expect(planDelivery("  \n ", TURN_DIR, 1, true).mode).toBe("refused");
  });
});

describe("line splitting (Read page budget)", () => {
  test("READ_LINE_LIMIT is 20,000: Read itself returned a 90,005-char line whole (phase-2 s11)", () => {
    expect(READ_LINE_LIMIT).toBe(20_000);
  });

  test("an over-long line is split at whitespace below the bound, marked, and reversible", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
    const tf = renderTurnFile(`head\n${words}\ntail`);
    expect(tf.marker).toBe(SPLIT_MARKER);
    const lines = tf.content.split("\n");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(READ_LINE_LIMIT - 16 + 1);
    expect(
      lines
        .slice(1, -1)
        .every((l, i, a) =>
          i < a.length - 1 ? l.endsWith(SPLIT_MARKER) : !l.endsWith(SPLIT_MARKER)
        )
    ).toBe(true);
    expect(lines[1]!.endsWith(` ${SPLIT_MARKER}`)).toBe(true); // split after the whitespace, kept on the left
    expect(joinSplitLines(tf.content, SPLIT_MARKER)).toBe(`head\n${words}\ntail`);
    expect(tf.lines).toBe(lines.length);
  });

  test("a line with no whitespace is hard-split", () => {
    const tf = renderTurnFile("y".repeat(50_000));
    expect(tf.content.split("\n")[0]!.length).toBe(READ_LINE_LIMIT - 16 + 1);
    expect(joinSplitLines(tf.content, tf.marker!)).toBe("y".repeat(50_000));
  });

  test("an original line already ending in ↩ switches the marker to ⤶, named in the template", () => {
    const text = `ends with arrow ${SPLIT_MARKER}\n${"z ".repeat(15_000)}`;
    const d = planDelivery(text, TURN_DIR, 1, true);
    expect(d.mode).toBe("file");
    if (d.mode !== "file") return;
    expect(d.line).toContain(`Lines ending in ${ALT_SPLIT_MARKER} were split for reading`);
    expect(joinSplitLines(d.fileContent, ALT_SPLIT_MARKER)).toBe(text);
  });

  test("no split, no extra sentence", () => {
    const d = planDelivery("short\nfile", TURN_DIR, 1, true);
    if (d.mode === "file") expect(d.line).not.toContain("were split");
  });
});

describe("writeTurnFile", () => {
  test("writes 0600 with exclusive create", () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-turn-"));
    dirs.push(dir);
    const d = planDelivery("line one\nline two", dir, 1, true);
    writeTurnFile(d);
    if (d.mode !== "file") throw new Error("expected file");
    expect(readFileSync(d.file, "utf8")).toBe("line one\nline two");
    expect(statSync(d.file).mode & 0o777).toBe(0o600);
    expect(() => writeTurnFile(d)).toThrow();
  });
});
