import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The parent never imports any runtime product module or edits its own env. */
export async function runIsolated(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "claudish-legacy-move-"));
  mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const worker = fileURLToPath(new URL("./legacy-move-worker.test-helper.ts", import.meta.url));
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
  // Bound a broken test child, not a security process. The product is never run
  // against real services; its own lock timeout is not replaced by this guard.
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(scenario + " child exit " + code + "\n" + stdout + stderr);
  } finally {
    clearTimeout(timer);
    // Only this test's temp HOME is removed. No git/stash/repo cleanup.
    rmSync(home, { recursive: true, force: true });
  }
}
