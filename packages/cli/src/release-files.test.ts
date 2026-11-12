/**
 * The release job rewrites `files` in packages/cli/package.json before `npm publish`
 * (release.yml, "Prepare for npm publish"). A directory listed in package.json but missing
 * from that rewritten list is in every source-tree test and absent from every install.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(CLI_ROOT, "..", "..");

/** Entries package.json lists that the published package leaves out on purpose. */
const NOT_PUBLISHED: Record<string, string> = {
  // magmux ships in the @claudish/magmux-<platform> optional dependencies, not in this package.
  "native/mtm/mtm-*": "native binaries ship as optional dependencies",
};

function releaseFilesList(): string[] {
  const release = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf-8");
  const match = release.match(/pkg\.files\s*=\s*\[([^\]]*)\]/);
  if (!match) throw new Error("release.yml no longer assigns pkg.files");
  return [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
}

describe("published files", () => {
  test("the release job publishes every entry of package.json files", () => {
    const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf-8")) as {
      files: string[];
    };
    const published = new Set(releaseFilesList());
    const missing = pkg.files.filter((entry) => !(entry in NOT_PUBLISHED) && !published.has(entry));
    expect(missing).toEqual([]);
  });

  test("the release job publishes the Herdr.app mod", () => {
    expect(releaseFilesList()).toContain("herdr-app-mod/");
  });
});
