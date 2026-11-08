/**
 * MTL-372 review round: a crash-resumed move must not publish a stale item.
 *
 * Attempt 1 writes the Keychain item and stops before M6. The file, still
 * authoritative, then changes without a new generation or fingerprint (a
 * refresh journal, a re-issued access token, a new expiry). Attempt 2 used to
 * reuse the item on fingerprint + generation alone, publish it and delete the
 * file, dropping the journal. Each scenario runs in its own child under a temp
 * HOME with the fake `security`; nothing touches the real Keychain or ~/.claudish.
 */
import { describe, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function runChild(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "claudish-legacy-move-resume-"));
  mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const worker = fileURLToPath(
    new URL("./legacy-move-resume-journal-worker.test-helper.ts", import.meta.url)
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

describe("legacy move crash resume compares every durable field", () => {
  test(
    "a journal written to the file after attempt 1 reaches the published Keychain item",
    () => runChild("journal"),
    30_000
  );
  test(
    "a re-issued access token with the same refresh token is not published stale",
    () => runChild("access-token"),
    30_000
  );
  test(
    "a new expiresAt with the same generation is not published stale",
    () => runChild("expires-at"),
    30_000
  );
  // Mutation caught: resume on `fingerprint` + `generation` alone (the
  // pre-fix M5), which publishes attempt 1's item and deletes the file.
});
