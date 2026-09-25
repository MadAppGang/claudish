import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "claudish-host-routing-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * The environment claudish gives a stand-in `claude`, launched with `args` from an
 * environment that grants first-party trust, as a shell inside a trusted session does.
 */
async function childEnvFor(args: string[]): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(root, "case-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const out = join(dir, "env.json");
  const standIn = join(dir, "claude");
  writeFileSync(
    standIn,
    `#!/bin/sh\nexec "${process.execPath}" -e 'require("fs").writeFileSync(process.env.ENV_OUT, JSON.stringify(process.env))'\n`
  );
  chmodSync(standIn, 0o755);
  const proc = spawn(
    process.execPath,
    ["run", join(import.meta.dir, "index.ts"), ...args, "-y", "hi"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: dir,
        CLAUDE_PATH: standIn,
        ENV_OUT: out,
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      },
      stdio: "ignore",
    }
  );
  await new Promise((resolve) => proc.on("exit", resolve));
  return JSON.parse(readFileSync(out, "utf8"));
}

describe.skipIf(process.platform === "win32")("the environment claudish gives Claude Code", () => {
  test("marks a session claudish routes and authenticates as host-managed, without trust", async () => {
    const env = await childEnvFor(["--model", "ollama@llama3.2"]);
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("");
    expect(env.ANTHROPIC_BASE_URL).toStartWith("http://127.0.0.1:");
  }, 30_000);

  test("leaves a --monitor session on the user's login, with the launcher's trust", async () => {
    const env = await childEnvFor(["--monitor"]);
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
  }, 30_000);

  test("leaves a session with a native Claude role on the user's login", async () => {
    const env = await childEnvFor([
      "--model",
      "ollama@llama3.2",
      "--model-opus",
      "claude-opus-4-7",
    ]);
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
  }, 30_000);
});
