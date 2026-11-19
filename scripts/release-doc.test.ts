import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADVISORY_PART } from "./test-macos.ts";
import { NIGHTLY_PARTS } from "./weekly-macos-tests.ts";

const RELEASE_DOC = readFileSync(join(import.meta.dir, "..", "ai-docs", "release.md"), "utf8");

describe("release.md on the boot canary", () => {
  test("does not say that no nightly part boots Claude Code", () => {
    expect(RELEASE_DOC).not.toContain("no nightly part");
  });

  test("names the advisory canary on npm's latest Claude Code and the part that runs it", () => {
    expect(RELEASE_DOC).toContain("scripts/boot-canary-latest.ts");
    expect(RELEASE_DOC).toContain(`--part ${ADVISORY_PART}/${NIGHTLY_PARTS}`);
  });
});
