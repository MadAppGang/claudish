import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const forbidden = [
  "requiresResponsesApi",
  "clampOpenAIEffortByName",
  "clampCodexEffort",
  "SEED_REJECTS",
  "isSakanaFugu",
  "isGpt51Plus",
  "isOSeries",
  "isOriginalGpt5",
  "isCodex51Plus",
  "acceptsXhigh",
  "acceptsMax",
  "isO3Model",
  "lookupModelTokenParam",
  "lookupModelEndpoint",
  "tokenParamName",
];
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)
        ? [path]
        : [];
  });
}
function hits(path: string, needles: string[]): string[] {
  // Decode bytes explicitly: embedded NULs must never make a source file invisible.
  const source = new TextDecoder().decode(readFileSync(path));
  return source
    .split("\n")
    .flatMap((line, index) =>
      needles
        .filter((needle) => line.includes(needle))
        .map((needle) => `${relative(root, path)}:${index + 1}: ${needle}`)
    );
}
test("non-local production sources contain none of the deleted name rules", () => {
  const found = files(root)
    .filter((path) => relative(root, path) !== "adapters/local-adapter.ts")
    .flatMap((path) => hits(path, forbidden));
  expect(found, found.join("\n")).toEqual([]);
});
test("profiles do not select an API by model family", () => {
  const found = hits(
    join(root, "providers/provider-profiles.ts"),
    ["qwen3", "gpt-", "grok-", "minimax-", "claude-"].map((name) => `startsWith("${name}")`)
  );
  expect(found, found.join("\n")).toEqual([]);
});
test("OpenAI transport does not select Responses by codex in the name", () => {
  const found = hits(join(root, "providers/transport/openai.ts"), ['includes("codex")']);
  expect(found, found.join("\n")).toEqual([]);
});
