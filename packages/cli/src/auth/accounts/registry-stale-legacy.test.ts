/**
 * MTL-372 review round 3, R3-1: a failed config read must not combine the
 * last-known-good config (pre-move: 0 rows, no marker) with a FRESH legacy
 * read (absent: the move deleted the file). That combination is an empty
 * Codex account list with no throw, so availability answers false and the
 * composite signs the metered api-key half: a subscription user billed per
 * token. Each scenario runs in its own child under a temp HOME.
 */
import { describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function runChild(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "claudish-registry-stale-legacy-"));
  const worker = fileURLToPath(
    new URL("./registry-stale-legacy-worker.test-helper.ts", import.meta.url)
  );
  const child = Bun.spawn([process.execPath, worker, scenario], {
    env: {
      HOME: home,
      USER: "claudish-test",
      LOGNAME: "claudish-test",
      PATH: dirname(process.execPath),
      TMPDIR: home,
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

describe("a failed config read does not advance the legacy source (R3-1)", () => {
  // Mutation caught: refreshLegacySource re-reads the file from the stale
  // config copy, the snapshot shows 0 Codex accounts without throwing, and the
  // composite signs with the metered canary.
  child(
    "after the move, a failed config read is never 'no accounts' and never signs metered",
    "config-failed-after-move"
  );
  child("control: when config.json reads again the moved row is served", "config-recovers");
  child(
    "control: the Claude scope still ignores an unknown legacy source",
    "claude-scope-ignores-legacy"
  );
});
