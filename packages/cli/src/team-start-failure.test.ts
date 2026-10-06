/**
 * A team run that fails to START: the spawn loop throws after some slots
 * exist. Every pane already started must be STOPPED before the error reaches
 * the caller — SIGTERM, then SIGKILL on the verified pane group — so nothing the
 * `team(mode:"run")` handler records as `failed reason=start-failed` keeps
 * running and billing. A slot that ignores SIGTERM is the case that matters.
 *
 * Ported to panes (architecture §20.2): the EventEmitter child is the pane fake's
 * `ignore_term` scenario in a real headless magmux (it traps SIGTERM and SIGHUP and dies
 * only on SIGKILL), and the spawn throw is a failed status.json write after slot 1's pane
 * started.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readProcessTable } from "./pane/process-identity.js";
import { orphanReport } from "./pane/test-helpers/hermetic-env.js";
import { setupSession, startModels } from "./team-orchestrator.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
  teamDirOf,
  waitUntil,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

let panes: PaneTestEnv;
let sessionPath: string;

beforeEach(() => {
  panes = makePaneTestEnv();
  sessionPath = teamDirOf(panes, "stubborn");
});

afterEach(async () => {
  try {
    chmodSync(join(sessionPath, "status.json"), 0o644);
  } catch {
    // not created
  }
  const report = await finishPaneTest(panes);
  expect(report).toEqual({ processes: [], files: [] });
});

describe.skipIf(!MAGMUX)("team spawn-loop failure", () => {
  it("escalates to SIGKILL for a started pane that ignores SIGTERM, before rethrowing", async () => {
    // Eight slots stagger in over ~2 s, which leaves time for slot 1's child to boot and
    // install its SIGTERM trap before the fault.
    const models = ["fake-ignore_term", ...Array.from({ length: 7 }, (_, i) => `model-${i + 2}`)];
    setupSession(sessionPath, models, "@@HANG@@ hold");
    const marker = join(panes.tmp, "sigterm-marker");

    let settledCalls = 0;
    const run = startModels(sessionPath, {
      ...paneRunOptions(panes, {}, { CONTRACT_FAKE_SIGTERM_MARKER: marker }),
      onSettled: () => {
        settledCalls++;
      },
    }).catch((err: unknown) => err);
    await waitUntil(
      () =>
        readProcessTable().some(
          (r) =>
            r.command.includes("--model fake-ignore_term") && r.command.includes(panes.sockRoot)
        ),
      "slot 1's stubborn child",
      5_000
    );
    await Bun.sleep(600); // its module loads and boot() installs the trap
    // The next slot's STARTING write now throws.
    chmodSync(join(sessionPath, "status.json"), 0o444);
    const error = await run;

    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
    // Stopped BEFORE the error reached us, not after: nothing of any started pane is left.
    expect(orphanReport({ sockRoot: panes.sockRoot })).toEqual({ processes: [], files: [] });
    // A polite signal came first (the trap recorded it and survived it), and the child is
    // gone anyway: only SIGKILL could have ended it. Measured: magmux's forced close_pane
    // sends the pane SIGHUP and then kills it itself, before the reap's own SIGTERM →
    // SIGKILL group backstop is needed, so the marker shows SIGHUP (SIGTERM when the
    // backstop runs).
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toMatch(/^SIG(HUP|TERM)$/m);
    expect(settledCalls).toBe(0);
  }, 30_000);
});
