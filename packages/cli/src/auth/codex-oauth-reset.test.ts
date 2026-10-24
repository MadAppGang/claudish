import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runResetScenario(scenario: string): void {
  const home = mkdtempSync(join(tmpdir(), "claudish-codex-reset-"));
  const dir = join(home, ".claudish");
  mkdirSync(dir);
  // PROVISIONAL test data, not a captured vendor credential; no exchange is allowed.
  writeFileSync(
    join(dir, "codex-oauth.json"),
    JSON.stringify({
      access_token: "TEST_ACCESS_BEFORE",
      refresh_token: "TEST_REFRESH_BEFORE",
      expires_at: Date.now() + 3_600_000,
    }),
    { mode: 0o600 }
  );
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
          import { strict as assert } from "node:assert";
          import { homedir } from "node:os";
          import { writeFileSync } from "node:fs";
          import { join } from "node:path";
          assert.equal(homedir(), process.env.HOME);
          globalThis.fetch = Object.assign(async () => { throw new Error("unexpected network"); }, { preconnect() {} });
          const { CodexOAuth } = await import(${JSON.stringify(join(import.meta.dir, "codex-oauth.ts"))});
          ${scenario}
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
    expect({ code: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }).toEqual({
      code: 0,
      stderr: "",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("reset preserves the singleton object held by existing consumers", () => {
  runResetScenario(`
    const before = CodexOAuth.getInstance();
    CodexOAuth._resetInstanceForTests();
    assert.equal(CodexOAuth.getInstance(), before);
  `);
});

test("reset re-reads disk credentials and clears a previously injected reader", () => {
  runResetScenario(`
    const before = CodexOAuth.getInstance();
    assert.equal(await before.getAccessToken(), "TEST_ACCESS_BEFORE");
    before._setCredentialFileReaderForTests(() => { throw Object.assign(new Error("test read failed"), { code: "EIO" }); });
    before.reloadCredentials();
    await assert.rejects(() => before.getAccessToken(), /test read failed/);
    writeFileSync(join(homedir(), ".claudish", "codex-oauth.json"), JSON.stringify({
      access_token: "TEST_ACCESS_AFTER", refresh_token: "TEST_REFRESH_AFTER",
      expires_at: Date.now() + 3_600_000,
    }), { mode: 0o600 });
    CodexOAuth._resetInstanceForTests();
    assert.equal(await before.getAccessToken(), "TEST_ACCESS_AFTER");
    assert.equal(CodexOAuth.getInstance(), before);
  `);
});
