/**
 * Shared set-up for team tests that start real panes (architecture §12.1). Test-only.
 *
 * Every pane is the fake interactive child (`CLAUDISH_BIN`) inside a real headless
 * magmux, built from a hermetic environment passed as `parentEnv` (X-M9) — the test
 * process's own `process.env` is never mutated. `sockRoot` is per test, so the
 * no-orphan check and the startup sweep stay inside it.
 */

import { join } from "node:path";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type OrphanReport,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import type { TeamRunOptions } from "../team-orchestrator.js";

export { MAGMUX, NO_MAGMUX_MESSAGE, makePaneTestEnv, type PaneTestEnv };

/** No credential resolution: every model spawns bare. */
export const spawnPlanner = async () => ({ pinned: new Map<string, string>() });

/** Orchestrator options for a hermetic pane run. */
export function paneRunOptions(
  t: PaneTestEnv,
  extra: TeamRunOptions = {},
  env: Record<string, string> = {}
): TeamRunOptions {
  return {
    cwd: t.cwd,
    parentEnv: { ...t.env, ...env },
    spawnPlanner,
    paneTimings: { replStableMs: 200 },
    ...extra,
  };
}

/** A team session directory inside the test's temp dir. */
export function teamDirOf(t: PaneTestEnv, name = "team"): string {
  return join(t.tmp, name);
}

/** How long `finishPaneTest` waits for the panes' reap by default. */
export const FINISH_PANE_TEST_MS = 10_000;

/**
 * The timeout of an `afterEach` that awaits `finishPaneTest`: its whole wait plus room for the
 * final sweep. Bun's 5 s hook default ends the hook inside the wait on a loaded machine, where
 * a reap takes 3.5 to 6.4 s at the median (`REAP_DEADLINE_MS`).
 */
export const FINISH_PANE_TEST_HOOK_MS = FINISH_PANE_TEST_MS + 5_000;

/** Wait for every process and file of this test's panes to be gone, then clean up. */
export async function finishPaneTest(
  t: PaneTestEnv,
  ms = FINISH_PANE_TEST_MS
): Promise<OrphanReport> {
  const report = await waitNoOrphans({ sockRoot: t.sockRoot }, ms);
  killLeftovers({ sockRoot: t.sockRoot });
  t.cleanup();
  return report;
}

export async function waitUntil(
  pred: () => boolean,
  what: string,
  ms = 10_000,
  intervalMs = 25
): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(intervalMs);
  }
}
