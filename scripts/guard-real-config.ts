#!/usr/bin/env bun
/**
 * Run a command and refuse to let it damage the developer's real claudish config.
 *
 *   bun run scripts/guard-real-config.ts -- bun test
 *   bun run test:safe
 *
 * Why this exists: three e2e test files used to sandbox by overwriting the real
 * `~/.claudish/config.json` and restoring it in `afterEach`. A killed or
 * timed-out run skipped the restore, so the fixture became permanent. That
 * destroyed a real user's `onepasswordAccount` and `onepasswordEnvironments`,
 * which silently disabled 1Password for every claudish run on that machine —
 * and because the failure mode is "1Password is never consulted", nothing
 * errored. It just quietly stopped working.
 *
 * Those files now use `setConfigFileOverride`, but the fix is a convention and
 * conventions decay. This guard is the enforcement: it does not care WHICH test
 * misbehaves, only that the file came out the way it went in. Snapshot, run,
 * compare, restore, fail loudly.
 *
 * Restoring rather than only reporting is deliberate. By the time a developer
 * reads the failure their config is already replaced, and — as happened here —
 * the `.bak` alongside it may be a clobbered copy from an earlier run. Putting
 * the bytes back is the part that actually saves them.
 *
 * GUARDED is a list rather than one path because the convention decayed again,
 * in exactly the shape the paragraph above describes. `all-models.json` was the
 * hosted model catalog's disk cache (since contract 3 it is
 * `cloud-models-catalog-v3.json`), and `effort-mapping.test.ts` seeded a
 * fixture into it and restores in a `finally`. That is the same save/restore
 * pattern the config files used, with the same hole: a killed or timed-out run
 * skips the restore and the two-entry fixture becomes the machine's permanent
 * catalog. It fails the way the config damage did — silently, as wrong routing
 * and wrong reasoning decisions rather than an error — because a stale catalog
 * is indistinguishable from a cold one to every caller.
 *
 * The seam that would remove the need is missing, which is why the test writes
 * the real path at all: `findCacheEntry(modelId, cachePath?)` accepts an
 * override, but `BaseApiFormat.lookupReasoningCapability` calls
 * `lookupModelReasoning(this.modelId)` with no way to pass one, so a dialect
 * test cannot redirect the read. `catalog-client.ts` solved the same problem
 * with an in-memory seam (`_setCatalogEntriesForTest`); `model-catalog.ts` has
 * no equivalent. Until it does, this guard is the backstop.
 *
 * A test-only Codex singleton reset later orphaned the credential authority's
 * instance, and a logout through that old instance deleted the real Codex login.
 * The guard did not list credential files, so it neither detected nor restored
 * the deletion. Those files are now guarded too, without plaintext sidecars.
 *
 * A concurrent claudish process may legitimately rotate a refresh token during
 * a run. Restoring the old bytes would reintroduce a consumed token, so valid
 * changed secrets are reported but kept; only deleted or unusable files are restored.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fchmodSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_ENV_VARS } from "./session-env-vars.ts";

/**
 * Every real file a test run must give back unchanged. `label` names it in the
 * failure, and `remedy` states the isolation the author should have used — the
 * files have different answers, so the message cannot be generic.
 */
const GUARDED = [
  {
    path: join(homedir(), ".claudish", "config.json"),
    label: "REAL CONFIG",
    remedy: "isolate with setConfigFileOverride(<temp path>) instead of writing the real file",
  },
  {
    path: join(homedir(), ".claudish", "cloud-models-catalog-v3.json"),
    label: "REAL CLOUD MODELS CATALOG CACHE",
    remedy:
      "pass a temp path to readAllModelsCache/writeAllModelsCache, or seed in memory the way " +
      "catalog-client.ts's _setCatalogEntriesForTest does, instead of writing the real cache",
  },
  {
    // The route registry sidecar (`routeRegistryPathFor`): a test that writes it
    // hands the real request path another generation's base URLs.
    path: join(homedir(), ".claudish", "cloud-models-catalog-v3.routes.json"),
    label: "REAL ROUTE REGISTRY SIDECAR",
    remedy:
      "pass a temp cache path to writeAllModelsCache/writeRouteRegistry, or run the refresh in a " +
      "child process with its own HOME, instead of writing the real sidecar",
  },
  {
    // The efforts sidecar (`effortRecommendationsPathFor`): a test that writes it
    // hands the real request path recommended reasoning efforts nobody published.
    path: join(homedir(), ".claudish", "cloud-models-catalog-v3.efforts.json"),
    label: "REAL EFFORTS SIDECAR",
    remedy:
      "pass a temp `effortsPath` to writeEffortRecommendations / getRecommendedModels, or run " +
      "the refresh in a child process with its own HOME",
  },
  {
    // The pre-v3 cache file. This build no longer writes it, but older builds on the
    // same machine still read it, so a test that touches it breaks them.
    path: join(homedir(), ".claudish", "all-models.json"),
    label: "REAL PRE-V3 MODEL CATALOG CACHE",
    remedy: "nothing in this build writes all-models.json; find the test that still names it",
  },
  {
    path: join(homedir(), ".claudish", "openrouter-models.json"),
    label: "REAL OPENROUTER MODEL LIST",
    remedy: "run the MCP search_models path against a temp HOME instead of the real cache dir",
  },
  {
    path: join(homedir(), ".claudish", "codex-oauth.json"),
    label: "REAL CODEX LOGIN",
    secret: true,
    remedy:
      "set process.env.HOME to a temp home before CodexOAuth._resetInstanceForTests(); " +
      "legacyCodexCredentialsPath() reads process.env.HOME at call time",
  },
  {
    path: join(homedir(), ".claudish", "grok-oauth.json"),
    label: "REAL GROK LOGIN",
    secret: true,
    remedy:
      "run the Grok credential store in a child process spawned with its own HOME; " +
      "the store uses os.homedir(), which Bun fixes at process start",
  },
  {
    path: join(homedir(), ".claudish", "gemini-oauth.json"),
    label: "REAL GEMINI LOGIN",
    secret: true,
    remedy:
      "run the Gemini credential store in a child process spawned with its own HOME; " +
      "the store uses os.homedir(), which Bun fixes at process start",
  },
  {
    path: join(homedir(), ".claudish", "kimi-oauth.json"),
    label: "REAL KIMI LOGIN",
    secret: true,
    remedy:
      "run the Kimi credential store in a child process spawned with its own HOME; " +
      "the store uses os.homedir(), which Bun fixes at process start",
  },
  {
    path: join(homedir(), ".claudish", "accounts", "state.json"),
    label: "REAL ACCOUNT POOL STATE",
    secret: true,
    requireRefreshToken: false,
    remedy:
      "point CLAUDISH_ACCOUNTS_DIR at a temp accounts directory or process.env.HOME at a temp home " +
      "instead of writing the real account pool state",
  },
  {
    // The Muse Code login store. Bun 1.4.0's `os.homedir()` ignores a HOME
    // assigned in-process, so a test that "sets a temp HOME" and then calls
    // `defaultMuseStoreDir()` writes HERE. Measured: a full-suite run left this
    // file and the borrowed copy below in a real home dir, holding TESTTOKEN
    // placeholders, and later files read them as the user's login.
    path: join(homedir(), ".claudish", "meta-muse-oauth.json"),
    label: "REAL MUSE CODE LOGIN",
    secret: true,
    remedy:
      "pass a temp `dir` to the Muse store functions and to setMuseCoreTestDeps, or run in a " +
      "child process spawned with its own HOME; assigning process.env.HOME does not move homedir()",
  },
  {
    // The borrowed 0600 copy of Muse's own Keychain login that team/MCP slots sign with.
    path: join(homedir(), ".claudish", "meta-muse-borrowed.json"),
    label: "REAL MUSE CODE BORROWED LOGIN",
    secret: true,
    remedy:
      "pass a temp `dir` to the Muse store functions and to setMuseCoreTestDeps, or run in a " +
      "child process spawned with its own HOME; assigning process.env.HOME does not move homedir()",
  },
  {
    path: join(homedir(), ".claudish", "catalog-incompatible.json"),
    label: "REAL CATALOG CONTRACT SENTINEL",
    remedy:
      "pass a temp path to markCatalogIncompatible/readCatalogIncompatibility, or run the " +
      "refresh in a child process with its own HOME, instead of writing the real sentinel",
  },
] as const;

interface Snapshot {
  existed: boolean;
  content: string | null;
  mode: number | null;
  /** `existed` is true but the bytes could not be read, so no restore is possible. */
  unreadable: boolean;
}

/**
 * Presence and content are established SEPARATELY, and ONLY `ENOENT` counts as
 * absent. Folding any other failure into "absent" is a data-loss bug, because
 * absence authorises a delete below: a file the guard merely could not STAT
 * would be removed after the run as though the command had created it, and the
 * backup loop skips `existed: false` files, so that is the single branch with no
 * `.guard-backup` to recover from.
 *
 * `existsSync` is wrong here for exactly that reason — it answers `false` on
 * every stat error, not just a missing file. A transient `EACCES` on
 * `~/.claudish` (a macOS TCC denial, a sandbox, a stalled network mount) is
 * enough. `statSync` with an explicit `ENOENT` test is the same check without
 * the conflation; anything else routes to `unreadable`, which refuses to act.
 */
function snapshot(path: string): Snapshot {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { existed: false, content: null, mode: null, unreadable: false };
    }
    // Present-or-unknown. Never absent, so the delete branch cannot fire.
    return { existed: true, content: null, mode: null, unreadable: true };
  }
  try {
    return { existed: true, content: readFileSync(path, "utf-8"), mode, unreadable: false };
  } catch {
    return { existed: true, content: null, mode, unreadable: true };
  }
}

/** Which top-level keys changed — enough to see what a rogue test clobbered. */
function describeDelta(before: string | null, after: string | null, namesOnly = false): string[] {
  const parse = (s: string | null): Record<string, unknown> => {
    if (!s) return {};
    try {
      const value: unknown = JSON.parse(s);
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const a = parse(before);
  const b = parse(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const notes: string[] = [];
  for (const k of [...keys].sort()) {
    const inA = k in a;
    const inB = k in b;
    if (inA && !inB) notes.push(`  - REMOVED  ${k}`);
    else if (!inA && inB) notes.push(`  - added    ${k}`);
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      notes.push(`  - changed  ${k}${namesOnly ? "" : describeSize(a[k], b[k])}`);
  }
  return notes;
}

/**
 * Array lengths either side of a change, because the catalog's damage IS its
 * length: "changed entries" and "changed entries (947 -> 2)" are the same
 * finding, but only the second one reads as a clobbered file at a glance.
 */
function describeSize(before: unknown, after: unknown): string {
  if (!Array.isArray(before) || !Array.isArray(after)) return "";
  if (before.length === after.length) return "";
  return `  (${before.length} -> ${after.length} entries)`;
}

const args = process.argv.slice(2);
// Tolerate the `--` separator npm/bun users reflexively add.
const cmd = args[0] === "--" ? args.slice(1) : args;
if (cmd.length === 0) {
  process.stderr.write("usage: guard-real-config.ts [--] <command> [args...]\n");
  process.exit(2);
}

const before = new Map(GUARDED.map((g) => [g.path, snapshot(g.path)]));
/**
 * A credential store gets no `.guard-backup` sidecar and is restored 0600: a
 * sidecar would be a second plaintext copy of a real login that `claudish
 * logout` never removes. The in-memory snapshot is its only restore path.
 */
function isSecret(g: (typeof GUARDED)[number]): boolean {
  return "secret" in g && g.secret === true;
}

/** Valid changed secrets may be concurrent rotations, never restore old tokens over them. */
function isValidSecret(guarded: (typeof GUARDED)[number], after: Snapshot): boolean {
  if (!after.existed || after.unreadable || after.content === null) return false;
  try {
    const value: unknown = JSON.parse(after.content);
    if ("requireRefreshToken" in guarded && !guarded.requireRefreshToken) return true;
    return (
      value !== null &&
      typeof value === "object" &&
      "refresh_token" in value &&
      typeof value.refresh_token === "string" &&
      value.refresh_token.trim().length > 0
    );
  } catch {
    return false;
  }
}

for (const g of GUARDED) {
  if (!before.get(g.path)?.existed) continue;
  if (isSecret(g)) continue;
  // A sidecar, so the guard's own copy can never overwrite a real backup.
  try {
    copyFileSync(g.path, `${g.path}.guard-backup`);
  } catch {
    // Best effort: the in-memory snapshot is the real restore path.
  }
}

// The developer's real CREDENTIAL STORES are guarded the same way as their
// config file, and for the same reason: a test that reaches one is not
// hermetic, and the damage lands on the machine rather than on the test.
//
// `CLAUDISH_DISABLE_KEYCHAIN=1` makes `hasKeychainSource()` return false, so no
// suite can spawn `security` against the login keychain. This is not
// hypothetical: `keychain.enabled` in a real config was enough to make an
// unrelated test run enumerate it. The keychain is worse than the config file
// in one respect — a mutation there cannot be snapshotted and restored the way
// the bytes of a JSON file can — so it is prevented rather than repaired.
//
// `CLAUDISH_DISABLE_OP=1` is set for the same reason: 1Password arbitrates its
// handshake machine-wide, and a burst of denials from a test run suppresses
// authorization for every process on the machine for 15 seconds.
//
// `CLAUDISH_DISABLE_CATALOG_WARM=1` is the third. `createProxyServer` fires
// `warmCatalog()` on every create, which live-fetches the hosted catalog and
// writes `all-models.json` — so a suite that builds a proxy reads the network
// and rewrites the machine. Prevention beats the snapshot here for the same
// reason it does for the keychain: the restore below puts the bytes back, but
// it cannot put back the hermeticity. A test whose result depends on what the
// hosted catalog said this morning is the failure that turned two DeepSeek
// tests red mid-release.
//
// `CLAUDISH_CATALOG_INCOMPATIBLE_PATH` is the fourth, and it REDIRECTS rather
// than disables. The contract sentinel is state a real build writes on every
// launch against a newer catalog, so on a developer's machine it usually
// EXISTS — and every default-path read in the suite then sees "this catalog is
// unreadable". Measured 2026-09-18: 25 tests failed on that alone, and CI,
// whose home directory never holds the file, stayed green. A fresh directory
// per run means no run can read a sentinel an earlier run wrote either.
const sentinelDir = mkdtempSync(join(tmpdir(), "claudish-guard-sentinel-"));
const childEnv: Record<string, string | undefined> = {
  ...process.env,
  CLAUDISH_DISABLE_KEYCHAIN: "1",
  CLAUDISH_DISABLE_OP: "1",
  CLAUDISH_DISABLE_CATALOG_WARM: "1",
  CLAUDISH_CATALOG_INCOMPATIBLE_PATH: join(sentinelDir, "catalog-incompatible.json"),
};
// The session-identity variables reach everything a claudish-started session runs,
// a test run included (a runner is often such a session). Inherited,
// `CLAUDISH_UPSTREAM_ERROR_LOG` makes the suite append its test doubles to that
// session's upstream-errors.jsonl (D5), the hook and token-file names point the
// suite at the session's other records, and `CLAUDISH_PANE_CHILD` puts every
// claudish child and MCP server the suite spawns into nested mode (four tools,
// model launches refused with exit 64). The bun test preload deletes them from
// `process.env` (first layer), but a child spawned with no `env` option gets the
// ORIGINAL environment back. Deleting them here, from the OS environment of the
// whole run, is the second layer: no descendant of a guarded run can inherit them.
for (const name of SESSION_ENV_VARS) delete childEnv[name];
const child = spawn(cmd[0], cmd.slice(1), {
  stdio: "inherit",
  env: childEnv,
});

/** Put the pre-run bytes back; a credential store is written 0600 whatever the run left. */
function restoreBytes(guarded: (typeof GUARDED)[number], content: string): void {
  if (!isSecret(guarded)) {
    writeFileSync(guarded.path, content, "utf-8");
    return;
  }
  const temp = `${guarded.path}.guard-restore-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, content, "utf-8");
    } finally {
      closeSync(fd);
    }
    renameSync(temp, guarded.path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Where a failed restore's copy is, or that a credential store has none. */
function backupNote(guarded: (typeof GUARDED)[number]): string {
  return isSecret(guarded)
    ? "  No sidecar copy exists for a credential store; log in again if it is lost.\n"
    : `  A copy is at ${guarded.path}.guard-backup\n`;
}

/** Keep current secret bytes, enforcing 0600 without undoing a possible rotation. */
function keepSecret(
  guarded: (typeof GUARDED)[number],
  prior: Snapshot,
  after: Snapshot,
  delta: string[]
): void {
  if (after.mode !== 0o600) {
    chmodSync(guarded.path, 0o600);
    process.stderr.write("\n  Repaired secret file permissions to 0600.\n");
  }
  if (prior.content === after.content) return;
  process.stderr.write(
    `\n  WARNING — kept ${guarded.path}: valid credentials or account state may have been\n` +
      "  saved by another claudish process. Restoring old tokens could reuse a consumed refresh token.\n"
  );
  if (delta.length === 0) process.stderr.write("  No top-level key names changed.\n");
}

/** Report a mutation, repair damage without undoing a valid rotation, and explain the fix. */
function reportAndRestore(guarded: (typeof GUARDED)[number], after: Snapshot): void {
  const prior = before.get(guarded.path) ?? {
    existed: false,
    content: null,
    mode: null,
    unreadable: false,
  };
  const secret = isSecret(guarded);
  const verb = prior.existed ? "changed" : "CREATED";
  process.stderr.write(
    `\n\x1b[31m✗ ${guarded.label} MUTATED\x1b[0m — something in that command ${verb} ${guarded.path}\n`
  );
  const delta = describeDelta(prior.content, after.content, secret);
  for (const line of delta) {
    process.stderr.write(`${line}\n`);
  }
  try {
    if (
      prior.existed &&
      secret &&
      after.content !== null &&
      (prior.content === after.content || isValidSecret(guarded, after))
    ) {
      keepSecret(guarded, prior, after, delta);
    } else if (prior.existed && prior.content !== null) {
      restoreBytes(guarded, prior.content);
      process.stderr.write("\n  Restored it from the pre-run snapshot.\n");
    } else if (prior.existed && prior.unreadable) {
      // Presence was certain, the bytes were not. Writing anything here would
      // invent content; say so instead and leave the file for the developer.
      process.stderr.write(
        "\n  \x1b[31mCANNOT RESTORE\x1b[0m — the file existed before the run but could not be read,\n" +
          "  so there is no snapshot to put back. Its current contents are whatever the run left.\n"
      );
    } else if (secret) {
      // A test-created credential is test data, not another plaintext login to keep.
      rmSync(guarded.path, { force: true });
      process.stderr.write(
        `\n  Deleted test-created secret ${guarded.path}; no sidecar was kept.\n`
      );
    } else {
      // Absent before, present after: the run CREATED a real file. Taking it out
      // of the way is the restore. Leaving it is worse than it looks — on a clean
      // machine a two-entry fixture becomes the catalog, and a cold cache and a
      // poisoned one are indistinguishable to every caller.
      //
      // RENAMED, never deleted, even though the diagnosis says the run made it.
      // The guard exists to prevent irreversible loss, so its own most
      // destructive branch must not be the one place it cannot be wrong: a
      // concurrent writer — a live `claudish serve`, an MCP server, a sibling
      // agent session — can legitimately create this file during a multi-minute
      // run, and that is indistinguishable from a test creating it. Renaming
      // costs a stray file; deleting costs someone's API keys.
      renameSync(guarded.path, `${guarded.path}.guard-created`);
      process.stderr.write(
        "\n  No such file existed before the run, so it was moved aside to\n" +
          `  ${guarded.path}.guard-created rather than deleted.\n` +
          "  If a concurrent process created it legitimately, move it back.\n"
      );
    }
  } catch (err) {
    process.stderr.write(
      `\n  \x1b[31mRESTORE FAILED\x1b[0m (${err instanceof Error ? err.message : String(err)}).\n` +
        backupNote(guarded)
    );
  }
  process.stderr.write(
    `\n  Tests must ${guarded.remedy}.\n` +
      "  See scripts/guard-real-config.ts for the history.\n\n"
  );
}

let finished = false;
let forwardedSignal: NodeJS.Signals | null = null;
function forwardSignal(signal: NodeJS.Signals): void {
  forwardedSignal ??= signal;
  child.kill(signal);
}
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

function finish(code: number | null, signal: NodeJS.Signals | null = null): void {
  if (finished) return;
  finished = true;
  // Every guarded file is checked and restored before the first exit, so one
  // clobbered file cannot mask a second. Reporting only the first would send
  // the author to fix one test while another keeps rewriting the machine.
  let mutated = false;
  for (const g of GUARDED) {
    const prior = before.get(g.path) ?? {
      existed: false,
      content: null,
      mode: null,
      unreadable: false,
    };
    const after = snapshot(g.path);
    // Only a mode THE RUN changed. A login that was already wider than 0600 before
    // the run (an older build wrote some at 0644) is the developer's own state, not
    // test damage; flagging it would fail every run and chmod a file nothing touched.
    const modeChanged = isSecret(g) && prior.existed && after.existed && prior.mode !== after.mode;
    const changed =
      prior.existed !== after.existed ||
      prior.unreadable !== after.unreadable ||
      prior.content !== after.content ||
      modeChanged;
    if (!changed) continue;
    mutated = true;
    reportAndRestore(g, after);
  }
  rmSync(sentinelDir, { recursive: true, force: true });

  if (mutated) process.exit(1);
  const terminationSignal = signal ?? forwardedSignal;
  if (terminationSignal) {
    process.stderr.write(
      `\n[guard] command terminated by ${terminationSignal}; guarded files intact.\n`
    );
    process.exit(1);
  }
  process.exit(code ?? 0);
}

child.on("exit", finish);
child.on("error", (err) => {
  process.stderr.write(`[guard] failed to run command: ${err.message}\n`);
  finish(1);
});
