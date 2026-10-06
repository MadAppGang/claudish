import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/**
 * Pane fixtures are real captures (phase2-captures.md). They must carry no private
 * content: no home path, no credential, no e-mail address. A hit here means a fixture
 * was copied from the wrong place or redacted badly (scripts/redact-transcript-fixture.ts).
 */

const ROOT = import.meta.dir;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (!name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Claude Code's own commit attribution, part of its system prompt in every capture. */
const ALLOWED_ADDRESS = "noreply@anthropic.com";

const PATTERNS: Array<[string, RegExp]> = [
  ["/Users/ path", /\/Users\//],
  ["/home/ path", /\/home\/[a-z]/],
  ["Anthropic key or token", /\bsk-ant-[A-Za-z0-9_-]{6,}/],
  ["sk- secret", /\bsk-[A-Za-z0-9]{20,}/],
  ["GitHub token", /\bghp_[A-Za-z0-9]{10,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{6,}/],
  ["AWS key id", /\bAKIA[0-9A-Z]{12,}/],
  ["PEM block", /-----BEGIN /],
  ["e-mail address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|au|io|org|net|dev)\b/],
];

describe("pane test fixtures carry no private content", () => {
  const all = files(ROOT);

  test("there are fixtures to check", () => {
    expect(all.length).toBeGreaterThan(40);
  });

  for (const [label, re] of PATTERNS) {
    test(`no ${label}`, () => {
      const hits = all
        .filter((f) => re.test(readFileSync(f, "utf8").replaceAll(ALLOWED_ADDRESS, "")))
        .map((f) => relative(ROOT, f));
      expect(hits).toEqual([]);
    });
  }

  test("no real home directory", () => {
    const home = homedir();
    const hits = all
      .filter((f) => readFileSync(f, "utf8").includes(home))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  test("no fixture is git-ignored", () => {
    const r = spawnSync("git", ["check-ignore", ...all], { cwd: ROOT, encoding: "utf8" });
    expect(r.stdout.trim()).toBe("");
  });
});
