/**
 * Tests for the `files` parameter shared by run_prompt and compare_models:
 * appendFilesToPrompt reads local files and appends them to the prompt as
 * labeled fenced blocks, without failing the call on an unreadable path.
 *
 * Run: bun test packages/cli/src/mcp-files.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFilesToPrompt } from "./mcp-server.js";

let dir: string;
let fileA: string;
let fileB: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-mcp-files-"));
  fileA = join(dir, "a.txt");
  fileB = join(dir, "b.ts");
  writeFileSync(fileA, "alpha contents", "utf-8");
  writeFileSync(fileB, "export const b = 1;", "utf-8");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("appendFilesToPrompt", () => {
  test("returns the prompt unchanged when no files are given", () => {
    expect(appendFilesToPrompt("hi", undefined)).toBe("hi");
    expect(appendFilesToPrompt("hi", [])).toBe("hi");
  });

  test("appends readable files as labeled fenced code blocks, in order", () => {
    const out = appendFilesToPrompt("review these", [fileA, fileB]);
    expect(out).toBe(
      "review these\n\n" +
        `--- ${fileA} ---\n\`\`\`\nalpha contents\n\`\`\`\n\n` +
        `--- ${fileB} ---\n\`\`\`\nexport const b = 1;\n\`\`\``
    );
    // The original prompt is preserved as the leading text.
    expect(out.startsWith("review these\n\n")).toBe(true);
  });

  test("an unreadable path becomes a warning line, readable files still append", () => {
    const missing = join(dir, "does-not-exist.txt");
    const out = appendFilesToPrompt("go", [missing, fileA]);
    // The call did not throw; the readable file is present in full.
    expect(out).toContain(`--- ${fileA} ---\n\`\`\`\nalpha contents\n\`\`\``);
    // The missing file is named in a warning, without a code block for it.
    expect(out).toContain(`--- ${missing} (could not be read:`);
    // Only the one readable file contributes a fenced block (one open, one close).
    expect((out.match(/```/g) || []).length).toBe(2);
  });
});
