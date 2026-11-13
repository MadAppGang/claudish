import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { isolatedFile, MODEL, KEY, LOGIN, temp, put, contractConfig } from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const { settingsCredentialFindings: findings, settingsClaudeLoginToken: token, childAuthControl } = await import("./claude-runner.js");
  const { prepareClaudeLaunch } = await import("./launcher/claude-launch.js");
  const { CLAUDISH_PLACEHOLDER_AUTH_TOKEN } = await import("./auth/claudish-placeholder.js");
  function tree(files: Record<string, unknown> = {}) {
    const home = "/test-home", cwd = "/test-project";
    const text = new Map(Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? v : JSON.stringify(v)]));
    return { home, cwd, readFile: (p: string) => {
      const s = text.get(p); if (s === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return s;
    } };
  }
  const user = "/test-home/.claude/settings.json", cfg = "/cfg/settings.json";
  const project = "/test-project/.claude/settings.json", local = "/test-project/.claude/settings.local.json";

  test("B-65 finds credential settings only in enabled layers", () => {
    for (const [value, kinds] of [
      [{ env: { ANTHROPIC_API_KEY: KEY } }, ["api-key"]],
      [{ apiKeyHelper: "fake-helper" }, ["api-key-helper"]],
      [{ env: { ANTHROPIC_AUTH_TOKEN: "plainfakevalue0123456789" } }, ["auth-token"]],
      [{ env: { ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN } }, []],
      [{ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }, ["base-url"]],
      [{ env: { ANTHROPIC_AUTH_TOKEN: "plainfakevalue0123456789" }, apiKeyHelper: "fake-helper" }, ["auth-token", "api-key-helper"]],
    ] as const) {
      const result = findings(contractConfig(), {}, tree({ [user]: value }));
      expect(result.map(f => f.kind).sort()).toEqual([...kinds].sort());
      for (const finding of result) expect(finding.where).toBe(user);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
    expect(findings(contractConfig({ claudeArgs: ["--settings", "{invalid"] }), {}, tree())).toContainEqual(expect.objectContaining({ kind: "unreadable" }));
    const layers = tree(Object.fromEntries([user, cfg, project, local, "/extra.json"].map(p => [p, { env: { ANTHROPIC_API_KEY: KEY } }])));
    const env = { CLAUDE_CONFIG_DIR: "/cfg" };
    const paths = (args: string[]) => findings(contractConfig({ claudeArgs: args }), env, layers).map(f => f.where).sort();
    expect(paths(["--setting-sources", ""])).toEqual([]);
    expect(paths(["--setting-sources=user"])).toEqual([user, cfg].sort());
    expect(paths(["--setting-sources", "project,local"])).toEqual([project, local].sort());
    expect(paths(["--setting-sources", "user", "--setting-sources", "project,local"])).toEqual([project, local].sort());
    expect(paths(["--setting-sources", "--x"])).toEqual([user, cfg, project, local].sort());
    expect(paths(["--setting-sources", "", "--settings", "/extra.json"])).toEqual(["/extra.json"]);
    expect(childAuthControl(contractConfig({ claudeArgs: ["--setting-sources", ""] }), {}, layers)).toEqual({ controlled: true });
  });

  test("B-72 resolves settings OAuth token precedence without returning tokens", async () => {
    const layers = tree({ [user]: { env: { CLAUDE_CODE_OAUTH_TOKEN: LOGIN } } });
    expect(token(contractConfig(), {}, layers)).toBe("set");
    expect(token(contractConfig({ claudeArgs: ["--setting-sources", "project"] }), {}, layers)).toBe("absent");
    expect(token(contractConfig({ claudeArgs: ["--setting-sources", ""] }), {}, layers)).toBe("absent");
    expect(token(contractConfig({ claudeArgs: ['--settings={"env":{"CLAUDE_CODE_OAUTH_TOKEN":""}}'] }), {}, layers)).toBe("cleared");
    expect(token(contractConfig({ claudeArgs: ["--settings=/missing"] }), {}, layers)).toBe("unknown");
    expect(token(contractConfig(), {}, tree({ [user]: { env: { CLAUDE_CODE_OAUTH_TOKEN: "" } } }))).toBe("cleared");
    expect(token(contractConfig(), {}, tree())).toBe("absent");
    const home = temp();
    try {
      put(join(home, ".claude", "settings.json"), { env: { CLAUDE_CODE_OAUTH_TOKEN: LOGIN } });
      const config = contractConfig({ model: "claude@" + MODEL, claudeLaunch: "subscription", monitor: true, claudeArgs: ["--setting-sources", "project"] });
      const { readFileSync } = await import("node:fs");
      const cwd = join(home, "project");
      mkdirSync(cwd);
      const d = { home, cwd, readFile: (p: string) => readFileSync(p, "utf8") };
      expect(token(config, { HOME: home }, d)).toBe("absent");
      const out = await prepareClaudeLaunch(config, {
        env: { HOME: home }, settingsFindings: (c, e) => findings(c, e, d),
        settingsLoginToken: (c, e) => token(c, e, d), claudeCodeCredential: () => ({ kind: "none" }),
      });
      expect(out).toMatchObject({ ok: false, message: expect.stringContaining("/login") });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
