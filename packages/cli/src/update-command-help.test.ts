import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isolatedHome = mkdtempSync(join(tmpdir(), "claudish-update-help-"));
const cliPath = resolve(import.meta.dir, "index.ts");
const configPath = join(isolatedHome, "config.json");

beforeAll(() => {
  writeFileSync(configPath, "{}");
});

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});

for (const flag of ["--help", "-h"]) {
  test(`update ${flag} prints help without starting the updater`, async () => {
    const child = Bun.spawn([process.execPath, cliPath, "update", flag], {
      cwd: isolatedHome,
      env: {
        PATH: process.env.PATH,
        HOME: isolatedHome,
        BUN_INSTALL: isolatedHome,
        CLAUDISH_CONFIG: configPath,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 25_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode, stderr).toBe(0);
      expect(stdout).toContain("Usage: claudish update");
      for (const message of [
        "Updating...",
        "Unable to fetch latest version from npm registry.",
        "Updated successfully",
        "Already up-to-date!",
      ]) {
        expect(stdout).not.toContain(message);
        expect(stderr).not.toContain(message);
      }
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  }, 30_000);
}
