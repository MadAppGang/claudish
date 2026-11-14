import { describe, expect, test } from "bun:test";
import {
  childAuthControl,
  settingsClaudeLoginToken,
  settingsCredentialFindings,
} from "./claude-runner.js";
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

describe("the local settings file Claude Code loads from the Git root", () => {
  const key = {
    env: {
      ANTHROPIC_API_KEY: "sk-ant-git-root-test-not-real",
      ANTHROPIC_BASE_URL: "https://example.invalid",
    },
  };
  const loginToken = { env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-git-root-test-not-real" } };

  /** A fake tree: `dirs` are directories, `files` are file contents. */
  function tree(cwd: string, files: Record<string, unknown>, dirs: string[] = []) {
    return {
      home: "/findings-home",
      cwd,
      readFile: (path: string) => {
        const value = files[path];
        if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return typeof value === "string" ? value : JSON.stringify(value);
      },
      pathKind: (path: string) =>
        dirs.includes(path) ? ("dir" as const) : path in files ? ("file" as const) : undefined,
    };
  }

  test("a launch from a subdirectory reads the repository root's local file", () => {
    const deps = tree("/repo/packages/cli", { "/repo/.claude/settings.local.json": key }, [
      "/repo/.git",
    ]);
    expect(settingsCredentialFindings(config([]), {}, deps)).toEqual([
      { where: "/repo/.claude/settings.local.json", kind: "api-key" },
      { where: "/repo/.claude/settings.local.json", kind: "base-url" },
    ]);
  });

  test("the working directory's own local file is still read beside the root's", () => {
    const deps = tree(
      "/repo/packages/cli",
      {
        "/repo/.claude/settings.local.json": key,
        "/repo/packages/cli/.claude/settings.local.json": key,
      },
      ["/repo/.git"]
    );
    expect(settingsCredentialFindings(config([]), {}, deps).map((f) => f.where)).toEqual([
      "/repo/.claude/settings.local.json",
      "/repo/.claude/settings.local.json",
      "/repo/packages/cli/.claude/settings.local.json",
      "/repo/packages/cli/.claude/settings.local.json",
    ]);
  });

  test("a launch at the repository root reads its local file once", () => {
    const deps = tree("/repo", { "/repo/.claude/settings.local.json": key }, ["/repo/.git"]);
    expect(settingsCredentialFindings(config([]), {}, deps)).toHaveLength(2);
  });

  test("a linked worktree reads the main checkout's local file, not its own", () => {
    const deps = tree("/wt/packages/cli", {
      "/wt/.git": "gitdir: /repo/.git/worktrees/wt\n",
      "/repo/.git/worktrees/wt/commondir": "../..\n",
      "/repo/.claude/settings.local.json": key,
      "/wt/.claude/settings.local.json": key,
    });
    expect(settingsCredentialFindings(config([]), {}, deps).map((f) => f.where)).toEqual([
      "/repo/.claude/settings.local.json",
      "/repo/.claude/settings.local.json",
    ]);
  });

  test("a relative gitdir resolves against the directory holding .git", () => {
    const deps = tree("/repo/trees/wt", {
      "/repo/trees/wt/.git": "gitdir: ../../.git/worktrees/wt\n",
      "/repo/.git/worktrees/wt/commondir": "../..\n",
      "/repo/.claude/settings.local.json": key,
    });
    expect(settingsCredentialFindings(config([]), {}, deps)[0]?.where).toBe(
      "/repo/.claude/settings.local.json"
    );
  });

  test("--setting-sources without local skips the root's local file", () => {
    const deps = tree("/repo/packages/cli", { "/repo/.claude/settings.local.json": key }, [
      "/repo/.git",
    ]);
    expect(
      settingsCredentialFindings(config(["--setting-sources", "user,project"]), {}, deps)
    ).toEqual([]);
  });

  test("a directory outside Git reads only the working directory's local file", () => {
    const deps = tree("/plain/sub", {
      "/plain/.claude/settings.local.json": key,
      "/plain/sub/.claude/settings.local.json": key,
    });
    expect(settingsCredentialFindings(config([]), {}, deps).map((f) => f.where)).toEqual([
      "/plain/sub/.claude/settings.local.json",
      "/plain/sub/.claude/settings.local.json",
    ]);
  });

  test("the login-token reader and childAuthControl see the root's local file", () => {
    const tokenTree = tree(
      "/repo/packages/cli",
      { "/repo/.claude/settings.local.json": loginToken },
      ["/repo/.git"]
    );
    expect(settingsClaudeLoginToken(config([]), {}, tokenTree)).toBe("set");
    const keyTree = tree("/repo/packages/cli", { "/repo/.claude/settings.local.json": key }, [
      "/repo/.git",
    ]);
    const monitor = { claudeArgs: [], monitor: true } as unknown as ClaudishConfig;
    expect(childAuthControl(monitor, {}, keyTree)).toEqual({
      controlled: false,
      reason: "settings-api-key",
      where: "/repo/.claude/settings.local.json",
    });
  });
});
