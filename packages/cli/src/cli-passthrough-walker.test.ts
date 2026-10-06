/**
 * `classifyPassthroughTokens` is a second statement of `parseArgs`'s token rule, kept
 * because the MCP server must judge `claude_flags` without running `parseArgs` (which
 * prints, exits and reads config). Two statements of one rule drift unless something
 * runs both: this file does, on one table of inputs, and also scans `parseArgs`'s
 * source so a flag added there without an arity here fails loudly.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLAUDISH_EXITING_FLAGS,
  CLAUDISH_FLAG_ARITY,
  CLAUDISH_INLINE_VALUE_FLAGS,
  classifyPassthroughTokens,
  parseArgs,
} from "./cli.js";

/**
 * Inputs `parseArgs` can run without exiting, printing or changing global state:
 * no exiting flag, no recovery switch (a process-wide override), no `--monitor`/
 * `--advisor` (which edit `process.env`), and `-v` only where the result is
 * interactive (print mode appends a forwarded `--verbose`).
 */
const CASES: Array<{ name: string; argv: string[] }> = [
  { name: "nothing", argv: [] },
  {
    name: "our own argv shape",
    argv: ["-i", "--model", "x@y", "-y", "--quiet", "--session-id", "u-1", "--add-dir", "/t"],
  },
  { name: "unknown flag with a value", argv: ["--agent", "detective"] },
  { name: "unknown flag with no value", argv: ["--no-session-persistence"] },
  { name: "comma list, one value", argv: ["--allowedTools", "Read,Bash"] },
  { name: "space list, a positional slips in", argv: ["--allowedTools", "Read", "Bash"] },
  { name: "separator then flags", argv: ["--", "--effort", "high"] },
  { name: "separator alone", argv: ["--"] },
  { name: "positional prompt", argv: ["--model", "x", "hello world"] },
  {
    name: "value that looks like a flag is not consumed by a passthrough flag",
    argv: ["--system-prompt", "-be terse"],
  },
  {
    name: "claudish value flag consumes a dash-led value",
    argv: ["--model-opus", "-weird", "--agent", "a"],
  },
  {
    name: "optional value present",
    argv: ["--default-provider", "openrouter", "--effort", "high"],
  },
  { name: "optional value absent", argv: ["--default-provider", "--effort", "high"] },
  {
    name: "inline value forms",
    argv: ["--default-provider=or", "--op-env=env1", "--effort", "low"],
  },
  { name: "value-if-any with no value falls through", argv: ["--agent", "a", "--log-diag"] },
  { name: "value-if-any consumes a dash-led value", argv: ["--log-diag", "-x"] },
  { name: "bare --resume is the picker", argv: ["--resume", "--agent", "a"] },
  { name: "--resume with an id is forwarded", argv: ["--resume", "abc-123"] },
  { name: "verbose stays claudish's in interactive mode", argv: ["-v", "--effort", "high"] },
  { name: "print flag passes through", argv: ["-p", "hello"] },
  {
    name: "team flag consumes its list",
    argv: ["--team", "a,b", "--mode", "json", "--keep", "go"],
  },
  { name: "file flag", argv: ["-f", "prompt.md", "--agent", "a"] },
  {
    name: "ports, profiles, levels",
    argv: [
      "--port",
      "4567",
      "--profile",
      "p",
      "--log-level",
      "minimal",
      "--effort-override",
      "high",
    ],
  },
  {
    name: "flags with values and a trailing positional",
    argv: ["--effort", "high", "--permission-mode", "plan", "do it"],
  },
];

describe("classifyPassthroughTokens ≡ parseArgs", () => {
  for (const { name, argv } of CASES) {
    test(name, async () => {
      const config = await parseArgs([...argv]);
      const walked = classifyPassthroughTokens(argv);
      expect(walked.passthrough).toEqual(config.claudeArgs);
      expect(walked.positionals.length > 0).toBe(Boolean(config._hasPositionalPrompt));
      const picker = walked.tokens.some(
        (t) => t.token === "--resume" && t.kind === "claudish-flag"
      );
      expect(picker).toBe(Boolean(config._resumePicker));
    });
  }
});

describe("classifyPassthroughTokens names the dangerous inputs", () => {
  test("`--allowedTools Read Bash` leaves `Bash` positional", () => {
    expect(classifyPassthroughTokens(["--allowedTools", "Read", "Bash"]).positionals).toEqual([
      "Bash",
    ]);
  });

  test("`-- --effort high` is a separator followed by positionals", () => {
    const walked = classifyPassthroughTokens(["--", "--effort", "high"]);
    expect(walked.separatorAt).toBe(0);
    expect(walked.positionals).toEqual(["--effort", "high"]);
  });

  test("claudish's own value is never a positional, even when dash-led", () => {
    const walked = classifyPassthroughTokens(["--model", "-x"]);
    expect(walked.positionals).toEqual([]);
    expect(walked.tokens.map((t) => t.kind)).toEqual(["claudish-flag", "claudish-value"]);
  });

  test("an exiting flag's values are consumed too", () => {
    const walked = classifyPassthroughTokens(["--probe", "a", "b", "--agent", "x"]);
    expect(walked.tokens.map((t) => t.kind)).toEqual([
      "claudish-flag",
      "claudish-value",
      "claudish-value",
      "passthrough-flag",
      "passthrough-value",
    ]);
  });
});

describe("the arity table covers every flag parseArgs matches", () => {
  const source = readFileSync(resolve(import.meta.dir, "cli.ts"), "utf8");
  const start = source.indexOf("export async function parseArgs(");
  const end = source.indexOf("\n}\n", start);
  // Comments mention flags that are NOT matched (`--effort` is Claude Code's), so strip them.
  const body = source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const exact = new Set([...body.matchAll(/arg === "([^"]+)"/g)].map((m) => m[1] as string));
  const inline = new Set(
    [...body.matchAll(/arg\.startsWith\("(--[^"=]+)="\)/g)].map((m) => m[1] as string)
  );

  test("the scan found the parser", () => {
    expect(start).toBeGreaterThan(-1);
    expect(exact.size).toBeGreaterThan(40);
  });

  // `--` and `--resume` are rules of their own; `-p`/`--print` are Claude Code's flags,
  // which the catch-all forwards and only NOTES (`_hasPrintFlag`).
  const notClaudishFlags = new Set(["--", "--resume", "-p", "--print"]);

  test("every exact flag in parseArgs has an arity", () => {
    const missing = [...exact].filter(
      (f) => !notClaudishFlags.has(f) && !Object.hasOwn(CLAUDISH_FLAG_ARITY, f)
    );
    expect(missing).toEqual([]);
  });

  test("no arity is listed for a flag parseArgs no longer matches", () => {
    const stale = Object.keys(CLAUDISH_FLAG_ARITY).filter((f) => !exact.has(f));
    expect(stale).toEqual([]);
  });

  test("the inline `--flag=value` forms match parseArgs", () => {
    expect([...inline].sort()).toEqual([...CLAUDISH_INLINE_VALUE_FLAGS].sort());
  });

  test("every exiting flag is a known flag", () => {
    for (const f of CLAUDISH_EXITING_FLAGS)
      expect(Object.hasOwn(CLAUDISH_FLAG_ARITY, f)).toBe(true);
  });
});
