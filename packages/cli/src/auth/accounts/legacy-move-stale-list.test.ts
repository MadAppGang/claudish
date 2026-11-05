/**
 * MTL-372, review round 2: the legacy facade deciding from a STALE account
 * list. `AccountRegistry.snapshot()` throws only when a source read failed and
 * there is no last-known-good copy; a warm registry serves the copy and reports
 * the failure in `snapshot.config.state`. Each scenario runs in its own child
 * under a temp HOME with the fake `security` and a refusing `fetch`; nothing
 * touches the real Keychain, the real ~/.claudish or a browser.
 */
import { describe, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function runChild(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "claudish-legacy-move-stale-list-"));
  mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const worker = fileURLToPath(
    new URL("./legacy-move-stale-list-worker.test-helper.ts", import.meta.url)
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

describe("facade on a stale account list (HIGH 1)", () => {
  // Mutation caught: legacyFileOwnership trusts isSynthesizedLegacyOnly() on
  // the last-known-good copy and exchanges the moved login's refresh token.
  child(
    "a file left by a published move, with the config read failing, is not exchanged",
    "file-left-list-unreadable"
  );
  child(
    "control: a readable synthesized-only list still refreshes and saves",
    "file-present-list-readable"
  );
  child(
    "control: an unreadable list after the exchange keeps the save",
    "list-unreadable-after-exchange-saves"
  );
});

describe("terminal errors from a stale account list (HIGH 2a)", () => {
  // Mutation caught: credentialFileGoneError reads hasConfiguredAccounts() from
  // the last-known-good copy and answers the terminal CodexOAuthRefreshError.
  child(
    "a file deleted by a published move, with the config read failing, is transient",
    "file-gone-list-unreadable"
  );
  child("control: a logout on a readable list stays terminal", "file-gone-logout-warm");
});

describe("facade adoption and the in-memory bearer after the move (G2)", () => {
  // Mutation caught: refreshHoldingGate adopts the leftover file's token
  // before asking who owns it; or the "elsewhere" exit keeps the old bearer.
  child(
    "a forced refresh never adopts from a leftover file, and the old bearer stops signing",
    "forced-refresh-leftover-no-adopt"
  );
  // Mutation caught: the gate-unavailable catch adopts without the ownership check.
  child(
    "with the gate unavailable, a leftover file's token is not adopted",
    "gate-unavailable-leftover-no-adopt"
  );
  // Mutation caught: the pre-exchange `!onDisk` exit keeps the in-memory bearer.
  child(
    "after a logout, the old in-memory bearer stops signing",
    "forced-refresh-logout-drops-bearer"
  );
  child(
    "control: an unreadable list keeps the in-memory bearer",
    "forced-refresh-unreadable-keeps-bearer"
  );
});
