/**
 * bun test preload: runs once per `bun test` process, before the first test file loads.
 *
 * It removes the variables that point a process at a real claudish session
 * (`SESSION_ENV_VARS`), so a suite run inside a claudish pane cannot append its test
 * doubles to that session's records (D5). Registered by three bunfig.toml files: the
 * repo root, packages/cli and packages/macos-bridge, because bun reads bunfig.toml
 * from the working directory only and never walks up (measured on 1.3.10 and 1.4.0).
 *
 * What this covers, measured: in-process writers, and children spawned with an
 * explicit `env: { ...process.env }`. What it does NOT cover: a child spawned with no
 * `env` option. `Bun.spawn`/`Bun.spawnSync` (1.3.10 and 1.4.0) and `node:child_process`
 * (1.3.10, the CI pin) hand such a child the ORIGINAL environment, deletions undone.
 * `scripts/spawn-env.test.ts` requires the `env` option in test code for that reason,
 * and `scripts/guard-real-config.ts` deletes the same names from the OS environment
 * of a `test:safe` run.
 *
 * ## The home guard (MTL-372 review round 4)
 *
 * A plain `bun test` once ran the legacy Codex file move against the developer's REAL
 * `~/.claudish` and Keychain: the credential request path starts the move on every
 * Codex sign, and `codex-pool-legacy-2a.test.ts` set neither `HOME` nor
 * `CLAUDISH_DISABLE_KEYCHAIN`. So, before any test file loads:
 *
 * - The three prevention flags `test:safe` sets (`scripts/guard-real-config.ts`), each
 *   unless the environment already states a value: `CLAUDISH_DISABLE_KEYCHAIN=1` (a
 *   test that exercises the Keychain path deletes it and injects a fake `security`, as
 *   those tests already do), `CLAUDISH_DISABLE_OP=1` and
 *   `CLAUDISH_DISABLE_CATALOG_WARM=1`. The last one matters once `HOME` is empty: a
 *   proxy test that fired the hosted-catalog warm used to read the developer's cached
 *   catalog, and against an empty cache it live-fetches past its 5 s timeout.
 * - `HOME` becomes a fresh temporary directory, unless the inherited `HOME` is already
 *   under a temporary directory (a parent test that spawned this `bun test` with its
 *   own throwaway home keeps it). The guard's run home (`CLAUDISH_GUARD_RUN_HOME`) is
 *   always replaced: it is shared by every `bun test` process of a `test:safe` run.
 * - `os.homedir()` follows `process.env.HOME`. Bun (measured on 1.4.0) reads the
 *   environment the process STARTED with, so assigning `process.env.HOME` alone leaves
 *   every `import { homedir } from "node:os"` at the real home; `profile-config.ts`
 *   builds its config path from it at module load. `mock.module` reaches ESM imports
 *   and the patched CJS object reaches `require("os")`; `userInfo().homedir` follows
 *   too. Proven by `scripts/test-preload-home.test.ts`.
 *
 * Keep this file import-light: it must not load production code (see session-env-vars.ts).
 */
import { mock } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodeOs from "node:os";
import { join, sep } from "node:path";
import { SESSION_ENV_VARS } from "./session-env-vars.ts";

for (const name of SESSION_ENV_VARS) {
  delete process.env[name];
}

for (const flag of [
  "CLAUDISH_DISABLE_KEYCHAIN",
  "CLAUDISH_DISABLE_OP",
  "CLAUDISH_DISABLE_CATALOG_WARM",
]) {
  if (process.env[flag] === undefined) process.env[flag] = "1";
}

// A test must not read the developer's LM Link machines or change their preferred
// device. A path that does not exist answers like an install without `lms`.
process.env.CLAUDISH_LMS_BIN ??= "/nonexistent/claudish-test-lms";

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Is `home` inside a temporary directory, i.e. a throwaway a parent test made? */
function isTemporaryHome(home: string): boolean {
  const resolved = canonical(home);
  const roots = [nodeOs.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  return roots.some((root) => {
    const base = canonical(root);
    return resolved.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

/**
 * The run home `scripts/guard-real-config.ts` gives a whole `test:safe` run. It is
 * under the temp dir, but it is shared by every `bun test` process of the run, so
 * keeping it would let one process read another's files. A process left on it is
 * one that skipped this preload, which is what the guard's tripwire detects.
 */
function isGuardRunHome(home: string): boolean {
  const runHome = process.env.CLAUDISH_GUARD_RUN_HOME;
  if (!runHome) return false;
  return home === runHome || canonical(home) === canonical(runHome);
}

const inherited = process.env.HOME;
if (!inherited || !isTemporaryHome(inherited) || isGuardRunHome(inherited)) {
  const home = mkdtempSync(join(nodeOs.tmpdir(), "claudish-test-home-"));
  process.env.HOME = home;
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort: the directory is under the system temp dir
    }
  });
}
const fallbackHome = process.env.HOME as string;

// The stored dynamic models catalogs and their HMAC secret, pinned under the
// temporary home for the whole run, unless the environment already names them.
// Both are read at call time, so this holds for every test file.
for (const [name, leaf] of [
  ["CLAUDISH_DYNAMIC_CATALOG_DIR", "dynamic-models-catalog"],
  ["CLAUDISH_DYNAMIC_CATALOG_KEY", "dynamic-models-catalog.key"],
] as const) {
  if (process.env[name] === undefined) process.env[name] = join(fallbackHome, ".claudish", leaf);
}

// Capture the originals before any replacement: `nodeOs` is a live namespace.
const originalUserInfo = nodeOs.userInfo;
const homedir = (): string => {
  const home = process.env.HOME;
  return home && home.length > 0 ? home : fallbackHome;
};
const userInfo = ((options?: Parameters<typeof nodeOs.userInfo>[0]) => ({
  ...originalUserInfo(options as never),
  homedir: homedir(),
})) as typeof nodeOs.userInfo;

// CJS: `require("os")` and `require("node:os")` share one mutable object.
const cjsOs = createRequire(import.meta.url)("node:os") as typeof nodeOs;
const replaced = { ...cjsOs, homedir, userInfo };
cjsOs.homedir = homedir;
cjsOs.userInfo = userInfo;

// ESM: named imports are bound to the module record, so replace the module.
mock.module("node:os", () => ({ ...replaced, default: cjsOs }));
mock.module("os", () => ({ ...replaced, default: cjsOs }));
