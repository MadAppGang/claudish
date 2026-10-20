/**
 * The CLI entry's FIRST import: before the pane child applies its parent's
 * environment (`pane/child-env.ts`) and before any module reads the environment while
 * it is being evaluated, drop every control variable, and every other name the working
 * directory's env files set, when Bun loaded those files for this process. See
 * `launch-env.ts` for the rule. When Bun cannot say which names its files set, claudish
 * does not start.
 *
 * A side effect at import time is the point of this module; only `index.ts` imports it.
 * The stderr line naming what was dropped is printed by `index.ts`, after its own
 * `.env` load, so a provider key that load sets again is not reported as ignored.
 */

import { bunLoadedCwdEnvFiles, dropEnvFileValues, probeFailedNotice } from "./launch-env.js";

function dropAtLaunch(): string[] {
  if (!bunLoadedCwdEnvFiles(process.execArgv, import.meta.path)) return [];
  const result = dropEnvFileValues(process.env, {
    bunPath: process.execPath,
    execArgv: process.execArgv,
    cwd: process.cwd(),
  });
  if (result.ok) return result.dropped;
  process.stderr.write(`${probeFailedNotice()}\n`);
  process.exit(1);
}

/** The names dropped here; `index.ts` reports them and keeps its `.env` notice off them. */
export const droppedAtLaunch: readonly string[] = dropAtLaunch();
