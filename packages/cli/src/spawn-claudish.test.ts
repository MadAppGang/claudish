import { describe, expect, test } from "bun:test";
import { CLAUDISH_BIN_ENV, resolveClaudishSpawn } from "./spawn-claudish.js";

describe("resolveClaudishSpawn", () => {
  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace-only", " \t\n "],
  ])("uses the production PATH-resolved command when CLAUDISH_BIN is %s", (_label, value) => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { [CLAUDISH_BIN_ENV]: value };

    expect(resolveClaudishSpawn(env)).toEqual({ command: "claudish", prefixArgs: [] });
  });

  test.each(["ts", "js", "mjs", "cjs", "tsx"])(
    "runs a .%s entry point with the current runtime",
    (extension) => {
      const entry = `/repo/packages/cli/src/index.${extension}`;

      expect(resolveClaudishSpawn({ [CLAUDISH_BIN_ENV]: entry })).toEqual({
        command: process.execPath,
        prefixArgs: ["--no-env-file", "run", entry],
      });
    }
  );

  test("uses a plain executable path verbatim", () => {
    expect(resolveClaudishSpawn({ [CLAUDISH_BIN_ENV]: "/opt/bin/claudish" })).toEqual({
      command: "/opt/bin/claudish",
      prefixArgs: [],
    });
  });

  test("passes a path containing spaces through intact without quoting or splitting", () => {
    const entry = "/repo/worktree with spaces/packages/cli/src/index.ts";

    expect(resolveClaudishSpawn({ [CLAUDISH_BIN_ENV]: entry })).toEqual({
      command: process.execPath,
      prefixArgs: ["--no-env-file", "run", entry],
    });
  });

  test("leaves a bare command name for the caller to resolve through PATH", () => {
    expect(resolveClaudishSpawn({ [CLAUDISH_BIN_ENV]: "my-claudish" })).toEqual({
      command: "my-claudish",
      prefixArgs: [],
    });
  });
});
