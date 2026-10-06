// packages/cli/src/team-orchestrator-settle.contract.test.ts
/**
 * Black-box contract tests for how a team run settles (design §3.3 "startModels changes";
 * §8.1 tests 16b and 17; amendment 4).
 *
 *   - `TeamRunOptions.onSettled` is called exactly once, after the settled `status.txt`
 *     render, for a run that settles at once; a throwing consumer cannot fail the run.
 *   - A throw inside the spawn loop stops every pane already started, rethrows the
 *     ORIGINAL error, and never calls `onSettled`.
 *   - A throw before the loop (unreadable manifest.json) spawns nothing and never settles.
 *
 * Ported to panes (architecture §20.2): every slot is the pane fake (marker mode) in a real
 * headless magmux, reached through `TeamRunOptions.parentEnv` (CLAUDISH_BIN) instead of the
 * deleted `spawnChild` seam. Only the adapters and the fake changed; an assertion that no
 * longer holds is replaced and cites its reason.
 *
 * INFERRED (adapters in test-helpers/contract-adapters.ts): `setupSession(path, models, input)`,
 * `startModels(path, opts)` resolving to a handle with `done`, and the file names
 * `manifest.json` and `status.txt` in the team directory (both named in §3.3).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orphanReport } from "./pane/test-helpers/hermetic-env.js";
import { readTeamStatus, summarise } from "./team-orchestrator.js";
import { setupTeamSession, startModels } from "./test-helpers/contract-adapters.js";
import { type TempLayout, makeTempLayout, waitFor } from "./test-helpers/contract-records.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

const T_TEST = 30_000;
const MODELS = ["contract-fake-a", "contract-fake-b"];

let layout: TempLayout;
let panes: PaneTestEnv;
let teamDir: string;

beforeEach(() => {
  layout = makeTempLayout("settle");
  panes = makePaneTestEnv();
  teamDir = join(layout.root, "team");
});
afterEach(async () => {
  try {
    chmodSync(join(teamDir, "status.json"), 0o644);
  } catch {
    // no status.json in this test
  }
  const report = await finishPaneTest(panes);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
});

async function settledWithin<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every slot that got a pane has its pane id in status.json. */
function panesStarted(): number {
  return Object.values(readTeamStatus(teamDir).models).filter((m) => Boolean(m.pane)).length;
}

describe.skipIf(!MAGMUX)(
  "REQ-21 onSettled: called once, after the settled render, for a run that settles at once",
  () => {
    test(
      "every slot answers at once: onSettled runs exactly once with a completed status",
      async () => {
        await setupTeamSession(teamDir, MODELS, "answer once and exit");
        const calls: Array<{ status: unknown; statusTxtExisted: boolean }> = [];

        const handle = await startModels(teamDir, {
          ...paneRunOptions(panes),
          onSettled: (status: unknown) =>
            calls.push({ status, statusTxtExisted: existsSync(join(teamDir, "status.txt")) }),
        });
        await settledWithin(handle.done, 15_000, "the team run");
        await Bun.sleep(200);

        // was: the spawn seam was called once per model
        expect(panesStarted()).toBe(MODELS.length);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.statusTxtExisted).toBe(true);
        expect(summarise(calls[0]?.status as never)).toEqual({
          status: "completed",
          slots: 2,
          ok: 2,
          failed: 0,
          cancelled: 0,
        });
      },
      T_TEST
    );

    test(
      "a consumer that throws inside onSettled cannot fail the run",
      async () => {
        await setupTeamSession(teamDir, MODELS, "answer once and exit");
        let called = 0;

        const handle = await startModels(teamDir, {
          ...paneRunOptions(panes),
          onSettled: () => {
            called += 1;
            throw new Error("contract: a broken consumer");
          },
        });
        let rejected: unknown;
        await settledWithin(handle.done, 15_000, "the team run").catch((err) => {
          rejected = err;
        });

        expect(rejected).toBeUndefined();
        expect(called).toBe(1);
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX)(
  "REQ-22 a throw inside the spawn loop leaves nothing running (amendment 4)",
  () => {
    test(
      "slot 2's status.json write throws: the original error is rethrown, slot 1's pane is reaped first, onSettled never called",
      async () => {
        await setupTeamSession(teamDir, MODELS, "@@HANG@@ stay alive until signalled");
        let settledCalls = 0;

        const run = startModels(teamDir, {
          ...paneRunOptions(panes),
          onSettled: () => {
            settledCalls += 1;
          },
        }).then(
          () => undefined,
          (err: unknown) => err
        );
        // The fault (§20.2, replacing the spawn seam's throw): once slot 1's pane exists — its
        // pane record is written before anything is spawned — status.json turns read-only,
        // inside the 300 ms boot stagger, so slot 2's STARTING write throws EACCES. (The file,
        // not the directory: an overwrite in place needs write permission on the file.)
        await waitFor(
          () => {
            const recs = join(panes.sockRoot, "panes");
            return existsSync(recs) && readdirSync(recs).length > 0;
          },
          { what: "slot 1's pane record", timeoutMs: 5_000, intervalMs: 5 }
        );
        chmodSync(join(teamDir, "status.json"), 0o444);
        const thrown = await run;

        // was: slot 1 got SIGTERM. Now: every started pane is reaped (no process, socket or
        // record) before the rejection.
        expect(orphanReport({ sockRoot: panes.sockRoot })).toEqual({ processes: [], files: [] });
        expect((thrown as NodeJS.ErrnoException).code).toBe("EACCES");
        expect(String((thrown as Error).message)).toContain("status.json");
        // deleted: "removes the SIGINT handler" — there is no per-run handler any more (§2.11)
        expect(settledCalls).toBe(0);
        expect(summarise(readTeamStatus(teamDir))).toEqual({
          status: "failed",
          slots: 2,
          ok: 0,
          failed: 2,
          cancelled: 0,
        });
      },
      T_TEST
    );

    test(
      "a throw before the loop (unreadable manifest.json): rejects, spawns nothing, never settles",
      async () => {
        await setupTeamSession(teamDir, MODELS, "answer once and exit");
        writeFileSync(join(teamDir, "manifest.json"), "{ this is not json");
        const sigintBefore = process.listenerCount("SIGINT");
        let settledCalls = 0;

        const thrown = await startModels(teamDir, {
          ...paneRunOptions(panes),
          onSettled: () => {
            settledCalls += 1;
          },
        }).then(
          () => undefined,
          (err: unknown) => err
        );
        await Bun.sleep(300);

        expect(thrown).toBeInstanceOf(Error);
        // was: the spawn seam was never called
        expect(existsSync(join(panes.sockRoot, "panes"))).toBe(false);
        expect(settledCalls).toBe(0);
        expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
      },
      T_TEST
    );
  }
);
