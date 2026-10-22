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
 * Keep this file import-light: it must not load production code (see session-env-vars.ts).
 */
import { SESSION_ENV_VARS } from "./session-env-vars.ts";

for (const name of SESSION_ENV_VARS) {
  delete process.env[name];
}
