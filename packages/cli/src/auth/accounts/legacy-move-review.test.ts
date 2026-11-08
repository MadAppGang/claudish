/**
 * MTL-372, second review round: the legacy facade, the deferral detail, the
 * alternate-config login and two coverage cases. Each scenario runs in its own
 * child under a temp HOME with the fake `security` and a refusing `fetch`;
 * nothing touches the real Keychain, the real ~/.claudish or a browser.
 */
import { describe, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function runChild(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "claudish-legacy-move-review-"));
  mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const worker = fileURLToPath(
    new URL("./legacy-move-review-worker.test-helper.ts", import.meta.url)
  );
  const child = Bun.spawn([process.execPath, worker, scenario], {
    env: {
      HOME: home,
      USER: "claudish-test",
      LOGNAME: "claudish-test",
      PATH: dirname(process.execPath),
      TMPDIR: join(home, "tmp"),
      XDG_CONFIG_HOME: join(home, ".config"),
      CLAUDISH_ACCOUNTS_DIR: join(home, ".claudish", "accounts"),
      CLAUDISH_CONFIG: join(home, ".claudish", "config.json"),
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_TEST_UPSTREAM: "http://127.0.0.1:1",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${scenario} child exit ${code}\n${stdout}${stderr}`);
  } finally {
    clearTimeout(timer);
    rmSync(home, { recursive: true, force: true });
  }
}

const child = (name: string, scenario: string) => test(name, () => runChild(scenario), 30_000);

describe("legacy facade after the move published (A, D)", () => {
  // Mutation caught: refreshHoldingGate checks only that the file exists.
  child(
    "A: a file left behind by a published move is not exchanged; the answer is transient",
    "facade-file-left"
  );
  // Mutation caught: no account-list re-check before the post-exchange save.
  child(
    "A: a move published during the exchange stops the save; the answer is transient",
    "facade-moved-during-exchange"
  );
  // Mutation caught: getAccessToken throws the terminal CodexOAuthRefreshError.
  child(
    "D: credentials gone after a failed read, with the login moved, are transient",
    "facade-gone-after-failure"
  );
  child(
    "D: credentials gone after a failed read, on a logout, stay terminal",
    "facade-gone-logout"
  );
  // Mutation caught: the post-exchange absent-file branch throws the terminal error.
  child(
    "D: the file removed during the exchange by a published move is transient",
    "facade-removed-during-exchange"
  );
});

describe("M8 compare-and-delete compares every durable field (C)", () => {
  // Mutation caught: M8 compares only fingerprint and generation.
  child("C: a journal written to the file after the copy keeps the file", "m8-journal");
});

describe("deferral detail never quotes the credential file (E)", () => {
  // Mutation caught: TokenStoreReadError carries the SyntaxError message.
  child("E: a torn file's token-like fragment stays out of the outcome detail", "torn-detail");
});

describe("account login on an alternate config (F)", () => {
  // Mutation caught: the legacy target calls CodexOAuth.getInstance().login().
  child(
    "F: a synthesized legacy target logs in through this instance's Keychain login",
    "alt-config-login"
  );
});

describe("coverage (G)", () => {
  child(
    "G: codexQuotaAdapter.isAvailable() is true for a Keychain row with no file",
    "quota-keychain-row"
  );
  child(
    "G: CodexOAuth.getInstance().login(pkceDeps) saves a Keychain account on a Keychain platform",
    "facade-keychain-login"
  );
});
