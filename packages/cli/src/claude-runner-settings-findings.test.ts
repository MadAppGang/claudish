import { describe, expect, test } from "bun:test";
import { settingsClaudeLoginToken, settingsCredentialFindings } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

const config = (claudeArgs: string[]) => ({ claudeArgs }) as unknown as ClaudishConfig;

/** Reads only the given files; every other path is missing. */
function reads(files: Record<string, unknown> = {}) {
  return {
    home: "/findings-home",
    cwd: "/findings-project",
    readFile: (path: string) => {
      const value = files[path];
      if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}

describe("settingsCredentialFindings on an unreadable --settings value", () => {
  test("the merged two-token value that cannot be parsed is an unreadable finding", () => {
    const found = settingsCredentialFindings(config(["--settings", "{invalid"]), {}, reads());
    expect(found).toEqual([{ where: "--settings", kind: "unreadable" }]);
    expect(JSON.stringify(found)).not.toContain("{invalid");
  });

  test("the merged two-token file that cannot be read is an unreadable finding", () => {
    const found = settingsCredentialFindings(
      config(["--setting-sources", "", "--settings", "/missing.json"]),
      {},
      reads()
    );
    expect(found.map((f) => f.kind)).toEqual(["unreadable"]);
  });

  test("the login-token reader still skips the value the merge drops", () => {
    expect(settingsClaudeLoginToken(config(["--settings", "{invalid"]), {}, reads())).toBe(
      "absent"
    );
  });
});
