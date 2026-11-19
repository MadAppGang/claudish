import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADVISORY_PART } from "./test-macos.ts";
import { NIGHTLY_PARTS } from "./weekly-macos-tests.ts";

const RELEASE_DOC = readFileSync(join(import.meta.dir, "..", "ai-docs", "release.md"), "utf8");

/** The paragraph of `doc` that names the npm latest canary script, or "" when there is none. */
function canaryParagraph(doc: string): string {
  return doc.split(/\n\s*\n/).find((p) => p.includes("scripts/boot-canary-latest.ts")) ?? "";
}

/** What the canary paragraph leaves unsaid about the step being advisory. */
function advisoryGaps(paragraph: string): string[] {
  const flat = paragraph.replace(/\s+/g, " ");
  const gaps: string[] = [];
  if (!flat.includes("This step is advisory.")) gaps.push("does not say the step is advisory");
  if (!flat.includes("it never makes the gate red")) {
    gaps.push("does not say it never makes the gate red");
  }
  return gaps;
}

describe("release.md on the boot canary", () => {
  test("does not say that no nightly part boots Claude Code", () => {
    expect(RELEASE_DOC).not.toContain("no nightly part");
  });

  test("names the advisory canary on npm's latest Claude Code and the part that runs it", () => {
    expect(RELEASE_DOC).toContain("scripts/boot-canary-latest.ts");
    expect(RELEASE_DOC).toContain(`--part ${ADVISORY_PART}/${NIGHTLY_PARTS}`);
  });

  test("the paragraph that names the canary says it is advisory and never makes the gate red", () => {
    const paragraph = canaryParagraph(RELEASE_DOC);
    expect(paragraph).toContain(`--part ${ADVISORY_PART}/${NIGHTLY_PARTS}`);
    expect(advisoryGaps(paragraph)).toEqual([]);
  });

  test("a canary paragraph without the advisory words is caught", () => {
    const stripped = canaryParagraph(RELEASE_DOC)
      .replace("This step is advisory.", "")
      .replace(/it\s+never\s+makes\s+the\s+gate\s+red/, "it shows the result");
    expect(stripped).toContain("scripts/boot-canary-latest.ts");
    expect(advisoryGaps(stripped)).toEqual([
      "does not say the step is advisory",
      "does not say it never makes the gate red",
    ]);
  });
});
