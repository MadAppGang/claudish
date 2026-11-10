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
 * conventions decay. This guard is the enforcement, in two layers.
 *
 * PREVENTION: the whole run gets a throwaway HOME (the run home) and none of the
 * path overrides that bypass HOME, so a test cannot reach the real files at all.
 * The bun test preload gives every `bun test` process a fresh home of its own
 * inside that, so a guarded name that appears in the run home was written by a
 * process that skipped the preload — most often a child spawned with no `env`
 * option. That is a tripwire hit and the run fails.
 *
 * REPAIR, of damage only. Live claudish sessions on the same machine write these
 * files during a run that takes half an hour: `config.json` on every stats or
 * telemetry save, the catalog caches on refresh, the account files on every
 * pooled request. Those writes are real, and a test write can no longer reach
 * the real file, so a change that leaves the file VALID is kept and reported as
 * a warning; the exit code stays the tests' own. Only a file the run left
 * deleted, empty, unparseable or of the wrong shape is put back, from the pre-run
 * snapshot, through a temp file renamed over it, and that fails the run. By the
 * time a developer reads such a failure their config is already broken, and the
 * `.bak` alongside it may be a clobbered copy from an earlier run, so putting the
 * bytes back is the part that actually saves them. When a kept `config.json` lost
 * top-level keys, the pre-run bytes are also written to a timestamped
 * `config.json.guard-kept-*` copy, because `.guard-backup` is rewritten by the
 * next run.
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
 * changed secrets are kept like every other valid file, forced back to 0600; a
 * valid login created during the run is kept at 0600 too.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fchmodSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SESSION_ENV_VARS } from "./session-env-vars.ts";

/**
 * What a guarded file must look like after the run to be KEPT. A closed set, read
 * through `isValid`'s exhaustive switch, so a new kind cannot be added without
 * stating its rule.
 *
 * - `json-object`: parses to a non-null, non-array object (every non-secret file).
 * - `refresh-token`: a non-empty string `refresh_token` (the login stores).
 * - `parseable`: any parseable JSON, `null` included (the account pool state).
 * - `hex-key`: 64 hex characters, surrounding whitespace ignored as the store's
 *   reader ignores it (the dynamic models catalog key, which is not JSON).
 */
type Validity = "json-object" | "refresh-token" | "parseable" | "hex-key";

interface GuardedFile {
  path: string;
  /** Names the file in every message. */
  label: string;
  /** The isolation a test author should have used; the files have different answers. */
  remedy: string;
  validity: Validity;
  /** A credential store: no `.guard-backup` sidecar, always left 0600. */
  secret?: true;
  /** Keep a timestamped copy of the pre-run bytes when a kept file lost top-level keys. */
  retainOnKeyLoss?: true;
}

/**
 * Every real file a run must not damage. `label` names it in the report, and
 * `remedy` states the isolation the author should have used — the files have
 * different answers, so the message cannot be generic.
 */
const GUARDED: readonly GuardedFile[] = [
  {
    path: join(homedir(), ".claudish", "config.json"),
    label: "REAL CONFIG",
    validity: "json-object",
    retainOnKeyLoss: true,
    remedy: "isolate with setConfigFileOverride(<temp path>) instead of writing the real file",
  },
  {
    path: join(homedir(), ".claudish", "cloud-models-catalog-v3.json"),
    label: "REAL CLOUD MODELS CATALOG CACHE",
    validity: "json-object",
    remedy:
      "pass a temp path to readAllModelsCache/writeAllModelsCache, or seed in memory the way " +
      "catalog-client.ts's _setCatalogEntriesForTest does, instead of writing the real cache",
  },
  {
    // The route registry sidecar (`routeRegistryPathFor`): a test that writes it
    // hands the real request path another generation's base URLs.
    path: join(homedir(), ".claudish", "cloud-models-catalog-v3.routes.json"),
    label: "REAL ROUTE REGISTRY SIDECAR",
    validity: "json-object",
    remedy:
      "pass a temp cache path to writeAllModelsCache/writeRouteRegistry, or run the refresh in a " +
      "child process with its own HOME, instead of writing the real sidecar",
  },
  {
    // The efforts sidecar (`effortRecommendationsPathFor`): a test that writes it
    // hands the real request path recommended reasoning efforts nobody published.
    path: join(homedir(), ".claudish", "cloud-models-catalog-v3.efforts.json"),
    label: "REAL EFFORTS SIDECAR",
    validity: "json-object",
    remedy:
      "pass a temp `effortsPath` to writeEffortRecommendations / getRecommendedModels, or run " +
      "the refresh in a child process with its own HOME",
  },
  {
    // The pre-v3 cache file. This build no longer writes it, but older builds on the
    // same machine still read it, so a test that touches it breaks them.
    path: join(homedir(), ".claudish", "all-models.json"),
    label: "REAL PRE-V3 MODEL CATALOG CACHE",
    validity: "json-object",
    remedy: "nothing in this build writes all-models.json; find the test that still names it",
  },
  {
    path: join(homedir(), ".claudish", "openrouter-models.json"),
    label: "REAL OPENROUTER MODEL LIST",
    validity: "json-object",
    remedy: "run the MCP search_models path against a temp HOME instead of the real cache dir",
  },
  {
    path: join(homedir(), ".claudish", "codex-oauth.json"),
    label: "REAL CODEX LOGIN",
    secret: true,
    validity: "refresh-token",
    remedy:
      "set process.env.HOME to a temp home before CodexOAuth._resetInstanceForTests(); " +
      "legacyCodexCredentialsPath() reads process.env.HOME at call time",
  },
  {
    path: join(homedir(), ".claudish", "grok-oauth.json"),
    label: "REAL GROK LOGIN",
    secret: true,
    validity: "refresh-token",
    remedy:
      "run the Grok credential store in a child process spawned with its own HOME; " +
      "the store uses os.homedir(), which Bun fixes at process start",
  },
  {
    path: join(homedir(), ".claudish", "gemini-oauth.json"),
    label: "REAL GEMINI LOGIN",
    secret: true,
    validity: "refresh-token",
    remedy:
      "run the Gemini credential store in a child process spawned with its own HOME; " +
      "the store uses os.homedir(), which Bun fixes at process start",
  },
  {
    path: join(homedir(), ".claudish", "kimi-oauth.json"),
    label: "REAL KIMI LOGIN",
    secret: true,
    validity: "refresh-token",
    remedy:
      "run the Kimi credential store in a child process spawned with its own HOME; " +
      "the store uses os.homedir(), which Bun fixes at process start",
  },
  {
    path: join(homedir(), ".claudish", "accounts", "state.json"),
    label: "REAL ACCOUNT POOL STATE",
    secret: true,
    validity: "parseable",
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
    validity: "refresh-token",
    remedy:
      "pass a temp `dir` to the Muse store functions and to setMuseCoreTestDeps, or run in a " +
      "child process spawned with its own HOME; assigning process.env.HOME does not move homedir()",
  },
  {
    // The borrowed 0600 copy of Muse's own Keychain login that team/MCP slots sign with.
    path: join(homedir(), ".claudish", "meta-muse-borrowed.json"),
    label: "REAL MUSE CODE BORROWED LOGIN",
    secret: true,
    validity: "refresh-token",
    remedy:
      "pass a temp `dir` to the Muse store functions and to setMuseCoreTestDeps, or run in a " +
      "child process spawned with its own HOME; assigning process.env.HOME does not move homedir()",
  },
  {
    // The allowance model's shared alert memory and announced transition ids.
    path: join(homedir(), ".claudish", "accounts", "allowance-alerts.json"),
    label: "REAL ALLOWANCE ALERT MEMORY",
    validity: "json-object",
    remedy:
      "point CLAUDISH_ACCOUNTS_DIR at a temp accounts directory instead of evaluating alerts " +
      "against the real one",
  },
  {
    // The HMAC secret the stored dynamic models catalogs are keyed under. A test
    // that creates or replaces it orphans every real stored list.
    path: join(homedir(), ".claudish", "dynamic-models-catalog.key"),
    label: "REAL DYNAMIC MODELS CATALOG KEY",
    secret: true,
    validity: "hex-key",
    remedy:
      "set CLAUDISH_DYNAMIC_CATALOG_KEY and CLAUDISH_DYNAMIC_CATALOG_DIR to temp paths " +
      "(Bun ignores an in-process HOME)",
  },
  {
    path: join(homedir(), ".claudish", "catalog-incompatible.json"),
    label: "REAL CATALOG CONTRACT SENTINEL",
    validity: "json-object",
    remedy:
      "pass a temp path to markCatalogIncompatible/readCatalogIncompatibility, or run the " +
      "refresh in a child process with its own HOME, instead of writing the real sentinel",
  },
];

/**
 * Real DIRECTORIES a run must leave as it found them, compared by their file set
 * and sizes. The usage ledger is append-only JSONL written by every pooled
 * request, so a test that drives one without pinning `CLAUDISH_ACCOUNTS_DIR`
 * mixes test rows into the developer's real usage history, where no later
 * reader can tell them apart. Nothing is restored: truncating a segment back
 * to its old size would also delete rows a concurrent real claudish appended
 * during the run, and live sessions append to both directories all the time.
 * The guard reports a change and does not fail on it; a test write is caught by
 * the run-home tripwire instead.
 */
const GUARDED_DIRS = [
  {
    path: join(homedir(), ".claudish", "accounts", "usage"),
    label: "REAL USAGE LEDGER",
    remedy:
      "pin CLAUDISH_ACCOUNTS_DIR to a temp accounts directory before any pooled request or " +
      "exhausted pool runs (Bun ignores an in-process HOME)",
  },
  {
    // One file per claudish provider, each the account-keyed model lists its
    // discovery endpoint answered. A test row here is read back as an account's list.
    path: join(homedir(), ".claudish", "dynamic-models-catalog"),
    label: "REAL DYNAMIC MODELS CATALOG",
    remedy: "set CLAUDISH_DYNAMIC_CATALOG_DIR to a temp dir",
  },
] as const;

/** Relative path → size of every file under `dir`; null when the directory is absent. */
function dirSnapshot(dir: string): Map<string, number> | null {
  const files = new Map<string, number>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else {
        try {
          files.set(rel, lstatSync(abs).size);
        } catch {
          files.set(rel, -1);
        }
      }
    }
  };
  try {
    statSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    files.set("<unreadable>", -1);
    return files;
  }
  try {
    walk(dir, "");
  } catch {
    files.set("<unreadable>", -1);
  }
  return files;
}

/** What changed between two directory snapshots, one line per file. */
function describeDirDelta(
  before: Map<string, number> | null,
  after: Map<string, number> | null
): string[] {
  if (before === null && after === null) return [];
  if (before === null) return ["  - CREATED  the directory", ...describeDirDelta(new Map(), after)];
  if (after === null) return ["  - REMOVED  the directory"];
  const notes: string[] = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(name);
    const b = after.get(name);
    if (a === undefined) notes.push(`  - added    ${name} (${b} bytes)`);
    else if (b === undefined) notes.push(`  - REMOVED  ${name}`);
    else if (a !== b) notes.push(`  - changed  ${name} (${a} -> ${b} bytes)`);
  }
  return notes;
}

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
const dirsBefore = new Map(GUARDED_DIRS.map((g) => [g.path, dirSnapshot(g.path)]));
const ABSENT: Snapshot = { existed: false, content: null, mode: null, unreadable: false };

/**
 * A credential store gets no `.guard-backup` sidecar and is restored 0600: a
 * sidecar would be a second plaintext copy of a real login that `claudish
 * logout` never removes. The in-memory snapshot is its only restore path.
 */
function isSecret(g: GuardedFile): boolean {
  return g.secret === true;
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const HEX_KEY = /^[0-9a-f]{64}$/i;

/** May this entry be left holding `content`? The rule per kind is on `Validity`. */
function isValid(guarded: GuardedFile, content: string): boolean {
  switch (guarded.validity) {
    case "json-object": {
      const parsed = parseJson(content);
      return parsed.ok && isPlainObject(parsed.value);
    }
    case "refresh-token": {
      const parsed = parseJson(content);
      if (!parsed.ok || !isPlainObject(parsed.value)) return false;
      const token = parsed.value.refresh_token;
      return typeof token === "string" && token.trim().length > 0;
    }
    case "parseable":
      return parseJson(content).ok;
    case "hex-key":
      return HEX_KEY.test(content.trim());
    default: {
      const unhandled: never = guarded.validity;
      throw new Error(`guard-real-config: no rule for validity ${String(unhandled)}`);
    }
  }
}

function isValidAfter(guarded: GuardedFile, after: Snapshot): boolean {
  return (
    after.existed && !after.unreadable && after.content !== null && isValid(guarded, after.content)
  );
}

/** The top-level keys of a JSON object document; empty for anything else. */
function topLevelKeys(content: string | null): Set<string> {
  if (content === null) return new Set();
  const parsed = parseJson(content);
  return parsed.ok && isPlainObject(parsed.value) ? new Set(Object.keys(parsed.value)) : new Set();
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
//
// `HOME` is the fifth: the run home, a fresh directory under the system temp
// dir, named again in `CLAUDISH_GUARD_RUN_HOME` so the bun test preload can tell
// it from a throwaway home a parent test made, and replace it with a home per
// `bun test` process. The preload alone covers in-process code and children
// spawned with `env: { ...process.env }`; production code spawned from a test
// with no `env` option gets this process's environment, and before the run home
// that meant the real HOME. The path overrides below would send a write past
// HOME to wherever the developer's shell points them, so they are removed.
const sentinelDir = mkdtempSync(join(tmpdir(), "claudish-guard-sentinel-"));
const runHome = mkdtempSync(join(tmpdir(), "claudish-guard-home-"));
const HOME_BYPASS_OVERRIDES = [
  "CLAUDISH_ACCOUNTS_DIR",
  "CLAUDISH_CONFIG",
  "CLAUDISH_DYNAMIC_CATALOG_DIR",
  "CLAUDISH_DYNAMIC_CATALOG_KEY",
] as const;
const childEnv: Record<string, string | undefined> = {
  ...process.env,
  HOME: runHome,
  CLAUDISH_GUARD_RUN_HOME: runHome,
  CLAUDISH_DISABLE_KEYCHAIN: "1",
  CLAUDISH_DISABLE_OP: "1",
  CLAUDISH_DISABLE_CATALOG_WARM: "1",
  CLAUDISH_CATALOG_INCOMPATIBLE_PATH: join(sentinelDir, "catalog-incompatible.json"),
};
for (const name of HOME_BYPASS_OVERRIDES) delete childEnv[name];
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

/**
 * Put the pre-run bytes back through a same-directory temp file renamed over the
 * path, so a reader never sees a half-written file. The temp file is created 0600
 * before any byte lands; a credential store stays 0600, any other file gets the
 * mode it had before the run.
 */
function restoreBytes(guarded: GuardedFile, content: string, priorMode: number | null): void {
  const temp = `${guarded.path}.guard-restore-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, content, "utf-8");
      if (!isSecret(guarded) && priorMode !== null) fchmodSync(fd, priorMode);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, guarded.path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Where a failed restore's copy is, or that a credential store has none. */
function backupNote(guarded: GuardedFile): string {
  return isSecret(guarded)
    ? "  No sidecar copy exists for a credential store; log in again if it is lost.\n"
    : `  A copy is at ${guarded.path}.guard-backup\n`;
}

/** `20261110T093012.345Z`: sortable, and free of the colons an ISO stamp carries. */
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "");
}

/**
 * What the run left a changed file as, decided before anything is printed or
 * written. Only the last four are damage.
 */
type Verdict =
  | "keep" // valid: kept, reported as a warning
  | "repair-mode" // a credential store with the same bytes and a new mode
  | "restore" // damaged, with a snapshot to put back
  | "cannot-restore" // damaged, and the pre-run bytes were never readable
  | "delete-secret" // a credential store the run created, not valid
  | "move-aside"; // any other file the run created, not valid

function classify(guarded: GuardedFile, prior: Snapshot, after: Snapshot): Verdict {
  if (isSecret(guarded) && prior.content !== null && prior.content === after.content) {
    return "repair-mode";
  }
  if (isValidAfter(guarded, after)) return "keep";
  if (prior.existed && prior.content !== null) return "restore";
  if (prior.existed) return "cannot-restore";
  return isSecret(guarded) ? "delete-secret" : "move-aside";
}

function failureNote(err: unknown, guarded: GuardedFile): string {
  return (
    `\n  \x1b[31mRESTORE FAILED\x1b[0m (${err instanceof Error ? err.message : String(err)}).\n` +
    backupNote(guarded)
  );
}

/** A credential store left wider than 0600 goes back to 0600; true on success. */
function enforceSecretMode(guarded: GuardedFile, after: Snapshot): boolean {
  if (after.mode === 0o600) return true;
  try {
    chmodSync(guarded.path, 0o600);
    process.stderr.write("\n  Repaired secret file permissions to 0600.\n");
    return true;
  } catch (err) {
    process.stderr.write(failureNote(err, guarded));
    return false;
  }
}

/**
 * Keep a valid file the run changed or created, and say so. A live claudish
 * session on this machine writes these files during a run, and a test write can
 * no longer reach them, so the exit code stays the tests' own. Returns true only
 * when a credential store could not be put back to 0600.
 */
function keepValid(guarded: GuardedFile, prior: Snapshot, after: Snapshot): boolean {
  const secret = isSecret(guarded);
  const verb = prior.existed ? "changed" : "created";
  process.stderr.write(
    `\n\x1b[33m! ${guarded.label}: WARNING — kept ${guarded.path}\x1b[0m\n` +
      `  It was ${verb} during the run and is valid, so it was left as it is:\n` +
      "  a live claudish session on this machine may have written it.\n"
  );
  const delta = describeDelta(prior.content, after.content, secret);
  for (const line of delta) process.stderr.write(`${line}\n`);
  if (delta.length === 0 && guarded.validity !== "hex-key") {
    process.stderr.write("  No top-level key names changed.\n");
  }
  let failed = false;
  if (secret) failed = !enforceSecretMode(guarded, after);
  else if (prior.existed) {
    process.stderr.write(
      `  The pre-run copy is at ${guarded.path}.guard-backup until the next run rewrites it.\n`
    );
  }
  if (guarded.retainOnKeyLoss) retainOnKeyLoss(guarded, prior, after);
  process.stderr.write(`  If a test wrote it, tests must ${guarded.remedy}.\n\n`);
  return failed;
}

/**
 * A kept file that lost top-level keys gets its pre-run bytes in a timestamped
 * copy, created exclusively at 0600. `.guard-backup` is not enough: the next run
 * rewrites it with whatever the file holds then. Losing `onepasswordAccount` this
 * way is the incident this guard was written for.
 */
function retainOnKeyLoss(guarded: GuardedFile, prior: Snapshot, after: Snapshot): void {
  if (prior.content === null) return;
  const kept = topLevelKeys(after.content);
  const lost = [...topLevelKeys(prior.content)].filter((key) => !kept.has(key));
  if (lost.length === 0) return;
  const copy = `${guarded.path}.guard-kept-${utcStamp()}`;
  try {
    writeFileSync(copy, prior.content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    process.stderr.write(
      `  It lost top-level keys, so the pre-run bytes are also kept at\n  ${copy}\n`
    );
  } catch (err) {
    process.stderr.write(
      `  It lost top-level keys, and the pre-run copy could not be written to ${copy}\n` +
        `  (${err instanceof Error ? err.message : String(err)}).\n`
    );
  }
}

/** Repair damage the run left, and explain the fix. */
function repairDamage(
  guarded: GuardedFile,
  prior: Snapshot,
  after: Snapshot,
  verdict: Exclude<Verdict, "keep" | "repair-mode">
): void {
  const secret = isSecret(guarded);
  const verb = !prior.existed ? "CREATED" : !after.existed ? "DELETED" : "damaged";
  process.stderr.write(
    `\n\x1b[31m✗ ${guarded.label} MUTATED\x1b[0m — something in that command ${verb} ${guarded.path}\n`
  );
  for (const line of describeDelta(prior.content, after.content, secret)) {
    process.stderr.write(`${line}\n`);
  }
  try {
    switch (verdict) {
      case "restore":
        restoreBytes(guarded, prior.content as string, prior.mode);
        process.stderr.write("\n  Restored it from the pre-run snapshot.\n");
        break;
      case "cannot-restore":
        // Presence was certain, the bytes were not. Writing anything here would
        // invent content; say so instead and leave the file for the developer.
        process.stderr.write(
          "\n  \x1b[31mCANNOT RESTORE\x1b[0m — the file existed before the run but could not be read,\n" +
            "  so there is no snapshot to put back. Its current contents are whatever the run left.\n"
        );
        break;
      case "delete-secret":
        // An unusable test-created credential is test data, not a login to keep.
        rmSync(guarded.path, { force: true });
        process.stderr.write(
          `\n  Deleted test-created secret ${guarded.path}; no sidecar was kept.\n`
        );
        break;
      case "move-aside":
        // Absent before, present and unusable after. RENAMED, never deleted: the
        // guard exists to prevent irreversible loss, so its own most destructive
        // branch must not be the one place it cannot be wrong.
        renameSync(guarded.path, `${guarded.path}.guard-created`);
        process.stderr.write(
          "\n  No such file existed before the run, so it was moved aside to\n" +
            `  ${guarded.path}.guard-created rather than deleted.\n`
        );
        break;
      default: {
        const unhandled: never = verdict;
        throw new Error(`guard-real-config: no repair for ${String(unhandled)}`);
      }
    }
  } catch (err) {
    process.stderr.write(failureNote(err, guarded));
  }
  process.stderr.write(
    `\n  Tests must ${guarded.remedy}.\n` +
      "  See scripts/guard-real-config.ts for the history.\n\n"
  );
}

/** Act on one changed file; true when the run damaged it (or a repair failed). */
function settle(guarded: GuardedFile, prior: Snapshot, after: Snapshot): boolean {
  const verdict = classify(guarded, prior, after);
  switch (verdict) {
    case "keep":
      return keepValid(guarded, prior, after);
    case "repair-mode":
      process.stderr.write(
        `\n\x1b[33m! ${guarded.label}: mode changed during the run\x1b[0m — ${guarded.path}\n`
      );
      return !enforceSecretMode(guarded, after);
    default:
      repairDamage(guarded, prior, after, verdict);
      return true;
  }
}

/** A guarded name in the run home: anything but a clean ENOENT counts as present. */
function presentInRunHome(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code !== "ENOENT";
  }
}

/**
 * Every `bun test` process moves off the run home in the preload, so a guarded
 * name that appears here was written by a process that skipped it, and nothing
 * else on the machine knows this path. Returns true on any hit.
 */
function checkRunHome(): boolean {
  let hit = false;
  for (const g of [...GUARDED, ...GUARDED_DIRS]) {
    const path = join(runHome, relative(homedir(), g.path));
    if (!presentInRunHome(path)) continue;
    hit = true;
    process.stderr.write(
      `\n\x1b[31m✗ ${g.label} WRITTEN IN THE RUN HOME\x1b[0m — ${path}\n` +
        "  The real file was not reached: the run's HOME was a throwaway directory, and every\n" +
        "  `bun test` process moves to a home of its own. This was written by a process that\n" +
        "  skipped the bun test preload, most likely a child spawned with no `env` option,\n" +
        "  which gets the run's environment instead of its test's. On a hand-run `bun test`\n" +
        "  that child would have written the real file.\n" +
        `  Spawn it with \`env: { ...process.env }\`; tests must ${g.remedy}.\n\n`
    );
  }
  return hit;
}

let finished = false;
let forwardedSignal: NodeJS.Signals | null = null;
function forwardSignal(signal: NodeJS.Signals): void {
  forwardedSignal ??= signal;
  child.kill(signal);
}
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

/**
 * Check and settle every guarded file before the first exit, so one damaged file
 * cannot mask a second. Reporting only the first would send the author to fix
 * one test while another keeps rewriting the machine. True when any was damaged.
 */
function settleGuardedFiles(): boolean {
  let damaged = false;
  for (const g of GUARDED) {
    const prior = before.get(g.path) ?? ABSENT;
    const after = snapshot(g.path);
    // Only a mode THE RUN changed. A login that was already wider than 0600 before
    // the run (an older build wrote some at 0644) is the developer's own state, not
    // test damage; flagging it would chmod a file nothing touched.
    const modeChanged = isSecret(g) && prior.existed && after.existed && prior.mode !== after.mode;
    const changed =
      prior.existed !== after.existed ||
      prior.unreadable !== after.unreadable ||
      prior.content !== after.content ||
      modeChanged;
    if (changed && settle(g, prior, after)) damaged = true;
  }
  return damaged;
}

/** A changed real directory is reported, never restored, and never fails the run. */
function reportGuardedDirs(): void {
  for (const g of GUARDED_DIRS) {
    const delta = describeDirDelta(dirsBefore.get(g.path) ?? null, dirSnapshot(g.path));
    if (delta.length === 0) continue;
    process.stderr.write(`\n\x1b[33m! ${g.label} changed during the run\x1b[0m — ${g.path}\n`);
    for (const line of delta) process.stderr.write(`${line}\n`);
    process.stderr.write(
      "\n  Not restored: a live claudish session may have appended real rows during the run.\n" +
        `  If a test wrote it, tests must ${g.remedy}.\n\n`
    );
  }
}

/** Exit rule: damage, a run-home tripwire hit or a termination signal → 1, else the child's code. */
function finish(code: number | null, signal: NodeJS.Signals | null = null): void {
  if (finished) return;
  finished = true;
  const damaged = settleGuardedFiles();
  reportGuardedDirs();
  const tripwireHit = checkRunHome();
  rmSync(sentinelDir, { recursive: true, force: true });
  try {
    rmSync(runHome, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[guard] could not remove the run home ${runHome}: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  const terminationSignal = signal ?? forwardedSignal;
  if (terminationSignal) {
    process.stderr.write(
      `\n[guard] command terminated by ${terminationSignal}; ` +
        `${damaged || tripwireHit ? "see the report above" : "guarded files intact"}.\n`
    );
  }
  if (damaged || tripwireHit || terminationSignal) process.exit(1);
  process.exit(code ?? 0);
}

child.on("exit", finish);
child.on("error", (err) => {
  process.stderr.write(`[guard] failed to run command: ${err.message}\n`);
  finish(1);
});
