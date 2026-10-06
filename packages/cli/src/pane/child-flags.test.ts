import { describe, expect, test } from "bun:test";
import { classifyPassthroughTokens } from "../cli.js";
import {
  PRINT_ONLY_FLAGS,
  SUBCOMMAND_WORDS,
  checkChildFlags,
  flagsRemoveRead,
} from "./pane-launch.js";

function refused(flags: string[]): string {
  const r = checkChildFlags(flags);
  if (r.ok) throw new Error(`expected a refusal for ${JSON.stringify(flags)}`);
  return r.message;
}

describe("checkChildFlags — reserved tokens (D18)", () => {
  const RESERVED: string[][] = [
    ["-i"],
    ["--model", "x"],
    ["-m", "x"],
    ["-y"],
    ["--auto-approve"],
    ["--no-auto-approve"],
    ["--quiet"],
    ["--session-id", "u"],
    ["-p"],
    ["--print"],
    ["--stdin"],
    ["--output-format", "json"],
    ["--output-format=json"],
    ["--input-format", "stream-json"],
    ["--bg"],
    ["--background"],
    ["--resume", "abc"],
    ["--continue"],
    ["--from-pr", "1"],
    ["--teleport"],
    ["--fork-session"],
    ["-w"],
    ["--worktree", "x"],
    ["--no-session-persistence"],
    ["--team", "a,b"],
    ["--file", "x"],
    ["--probe", "m"],
    ["--monitor"],
    ["--advisor", "m"],
    ["--version"],
    ["--help"],
    ["-h"],
  ];
  test("every reserved token is refused", () => {
    for (const flags of RESERVED) expect(checkChildFlags(flags).ok).toBe(false);
  });

  test("--no-auto-approve is reserved: it defeats -y (phase-2 s09); --permission-mode default is not", () => {
    expect(refused(["--no-auto-approve"])).toContain("set by claudish itself");
    expect(checkChildFlags(["--permission-mode", "default"]).ok).toBe(true);
    expect(checkChildFlags(["--permission-mode", "plan"]).ok).toBe(true);
  });

  test("print-only flags are refused naming the loss", () => {
    for (const f of PRINT_ONLY_FLAGS)
      expect(refused([f, "3"])).toBe(
        `${f} works only with --print; team slots and sessions are interactive panes, so it would be silently ignored`
      );
  });

  test("allowed: --add-dir, --agent, --allowedTools with one comma value, -v", () => {
    expect(
      checkChildFlags(["--add-dir", "/x", "--agent", "rev", "--allowedTools", "Read,Bash", "-v"]).ok
    ).toBe(true);
  });
});

describe("checkChildFlags — positionals and subcommand words", () => {
  test("two values for one flag would become a -p prompt: refused with the hint", () => {
    expect(refused(["--allowedTools", "Read", "Bash"])).toContain(
      "write `--allowedTools Read,Bash`"
    );
  });

  test("a -- separator is refused", () => {
    expect(refused(["--", "--effort", "high"])).toContain("`--`");
  });

  test("a subcommand word as a flag value would dispatch that subcommand", () => {
    for (const w of SUBCOMMAND_WORDS) expect(refused(["--agent", w])).toContain("subcommand");
  });

  test("the walker the check uses agrees with classifyPassthroughTokens", () => {
    for (const flags of [
      ["--agent", "x"],
      ["--allowedTools", "Read", "Bash"],
      ["-v", "--settings", "/s.json"],
    ]) {
      const c = classifyPassthroughTokens(flags);
      expect(checkChildFlags(flags).ok).toBe(c.positionals.length === 0 && c.separatorAt === null);
    }
  });
});

describe("flagsRemoveRead (§2.3 rule 4)", () => {
  test("--disallowedTools containing Read, or a --tools list without it", () => {
    expect(flagsRemoveRead(["--disallowedTools", "Bash,Read"])).toBe(true);
    expect(flagsRemoveRead(["--disallowedTools=Read"])).toBe(true);
    expect(flagsRemoveRead(["--tools", "Bash,Edit"])).toBe(true);
    expect(flagsRemoveRead(["--tools", "Read,Bash"])).toBe(false);
    expect(flagsRemoveRead(["--disallowedTools", "ReadMcpResource"])).toBe(false);
    expect(flagsRemoveRead([])).toBe(false);
  });
});
