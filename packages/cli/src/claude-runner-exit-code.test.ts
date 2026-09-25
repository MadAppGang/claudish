import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "claudish-exit-code-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Runs claudish over a stand-in `claude` whose whole behaviour is `body`. */
async function exitCodeWith(body: string): Promise<number | null> {
  const dir = mkdtempSync(join(root, "case-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const standIn = join(dir, "claude");
  writeFileSync(standIn, `#!/bin/sh\n${body}\n`);
  chmodSync(standIn, 0o755);
  const proc = spawn(
    process.execPath,
    ["run", join(import.meta.dir, "index.ts"), "--monitor", "-y", "hi"],
    {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: dir, CLAUDE_PATH: standIn },
      stdio: "ignore",
    }
  );
  return new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
}

describe.skipIf(process.platform === "win32")("claudish's exit code for Claude Code's exit", () => {
  test("is Claude Code's own code when it exits", async () => {
    expect(await exitCodeWith("exit 3")).toBe(3);
  }, 30_000);

  test("is 128 + signum when a signal kills it, for a signal like SIGKILL too", async () => {
    expect(await exitCodeWith("kill -KILL $$")).toBe(137);
  }, 30_000);
});
