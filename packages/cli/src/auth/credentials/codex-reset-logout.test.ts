import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("authority logout uses the reset singleton rather than an orphaned credential store", () => {
  const home = mkdtempSync(join(tmpdir(), "claudish-codex-logout-reset-"));
  const dir = join(home, ".claudish");
  const path = join(dir, "codex-oauth.json");
  mkdirSync(dir);
  // PROVISIONAL test data; the child must never exchange this credential.
  const original = JSON.stringify({
    access_token: "TEST_ACCESS",
    refresh_token: "TEST_REFRESH",
    expires_at: Date.now() + 3_600_000,
  });
  writeFileSync(path, original, { mode: 0o600 });
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
          import { strict as assert } from "node:assert";
          import { existsSync } from "node:fs";
          import { homedir } from "node:os";
          import { join } from "node:path";
          assert.equal(homedir(), process.env.HOME);
          globalThis.fetch = Object.assign(async () => { throw new Error("unexpected network"); }, { preconnect() {} });
          const { credentials } = await import(${JSON.stringify(join(import.meta.dir, "authority.ts"))});
          const { CodexOAuth } = await import(${JSON.stringify(join(import.meta.dir, "../codex-oauth.ts"))});
          CodexOAuth._resetInstanceForTests();
          let logouts = 0;
          CodexOAuth.getInstance().logout = async () => { logouts++; };
          await credentials.logout("openai-codex");
          assert.equal(existsSync(join(homedir(), ".claudish", "codex-oauth.json")), true);
          assert.equal(logouts, 1);
        `,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_ACCOUNTS_DIR: join(home, "accounts"),
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect({ code: child.exitCode, stderr: new TextDecoder().decode(child.stderr) }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
