/**
 * MTL-372, review round 3: the legacy facade after it dropped its in-memory
 * token (R3-4), and the gate-unavailable path's drop rules (R3-5). Each
 * scenario runs in its own child under a temp HOME with the fake `security`
 * and a refusing `fetch`; nothing touches the real Keychain or ~/.claudish.
 */
import { describe, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function runChild(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "claudish-legacy-move-facade-drop-"));
  mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const worker = fileURLToPath(
    new URL("./legacy-move-facade-drop-worker.test-helper.ts", import.meta.url)
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

describe("requireOAuth on the legacy half after the facade dropped its token (R3-4)", () => {
  // Mutation caught: CodexOAuthHalf throws the terminal MeteredEscapeError for
  // any missing login, including one that moved to the Keychain.
  child("after a move, the latched request answers transient", "require-oauth-after-move-drop");
  child(
    "after a move with the list unreadable, the latched request answers transient",
    "require-oauth-after-move-drop-list-unreadable"
  );
  child("control: a genuine logout stays terminal", "require-oauth-genuine-logout");
});

describe("the gate-unavailable path drops the in-memory token (R3-5)", () => {
  // Mutation caught: the catch never drops the token, so the old bearer keeps signing.
  child(
    "ownership elsewhere: the next getAccessToken rejects",
    "gate-unavailable-move-drops-bearer"
  );
  child(
    "file gone, list readable: the next getAccessToken rejects",
    "gate-unavailable-logout-drops-bearer"
  );
  child("control: an unreadable list keeps the bearer", "gate-unavailable-unreadable-keeps-bearer");
});
