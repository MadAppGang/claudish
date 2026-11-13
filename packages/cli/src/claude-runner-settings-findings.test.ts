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
    expect(found).toEqual([{ where: "/missing.json", kind: "unreadable" }]);
  });

  test("the login-token reader still skips the value the merge drops", () => {
    expect(settingsClaudeLoginToken(config(["--settings", "{invalid"]), {}, reads())).toBe(
      "absent"
    );
  });
});

describe("settingsCredentialFindings names a --settings file by its path", () => {
  const key = { env: { ANTHROPIC_API_KEY: "sk-ant-findings-test-not-real" } };

  test("a two-token and an equals file value are named by their paths", () => {
    const found = settingsCredentialFindings(
      config(["--setting-sources", "", "--settings", "/a.json", "--settings=/b.json"]),
      {},
      reads({ "/a.json": key, "/b.json": key })
    );
    expect(found).toEqual([
      { where: "/a.json", kind: "api-key" },
      { where: "/b.json", kind: "api-key" },
    ]);
  });

  test("an unreadable forwarded file is named by its path", () => {
    const found = settingsCredentialFindings(
      config(["--setting-sources", "", "--settings=/missing.json"]),
      {},
      reads()
    );
    expect(found).toEqual([{ where: "/missing.json", kind: "unreadable" }]);
  });

  test("inline JSON is named --settings, never by its content", () => {
    const found = settingsCredentialFindings(
      config(["--setting-sources", "", "--settings", JSON.stringify(key)]),
      {},
      reads()
    );
    expect(found).toEqual([{ where: "--settings", kind: "api-key" }]);
    expect(JSON.stringify(found)).not.toContain("sk-ant-findings-test-not-real");
  });
});
