import { test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const thisFile = resolve(import.meta.path);

function filesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile() && resolve(path) !== thisFile) files.push(path);
  }
  return files;
}

test("packages and scripts contain no retired terminology", () => {
  // Mutation target: packages/cli/src/model-selector.ts:336. Restoring its previous
  // wording ("roster") is a representative one-line rename revert and must be
  // reported as file:line.
  const findings: string[] = [];
  for (const root of [join(repositoryRoot, "packages"), join(repositoryRoot, "scripts")]) {
    for (const file of filesUnder(root)) {
      for (const [index, line] of readFileSync(file, "utf-8").split("\n").entries()) {
        if (/\b(roster|served[- ]set)\b/i.test(line)) {
          findings.push(`${relative(repositoryRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
  }

  if (findings.length > 0) {
    throw new Error(`Retired terminology found:\n${findings.join("\n")}`);
  }
});
