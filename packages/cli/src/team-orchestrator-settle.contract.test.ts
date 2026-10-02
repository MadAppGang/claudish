// packages/cli/src/team-orchestrator-settle.contract.test.ts
/**
 * Black-box contract tests for how a team run settles (design §3.3 "startModels changes";
 * §8.1 tests 16b and 17; amendment 4).
 *
 *   - `TeamRunOptions.onSettled` is called exactly once, after the settled `status.txt`
 *     render, for a run that settles at once; a throwing consumer cannot fail the run.
 *   - A throw inside the spawn loop SIGTERMs every child already spawned, removes the SIGINT
 *     handler, rethrows the ORIGINAL error, and never calls `onSettled`.
 *   - A throw before the loop (unreadable manifest.json) spawns nothing and never settles.
 *
 * Children are the contract fake, injected through `TeamRunOptions.spawnChild` (documented).
 * INFERRED (adapters in test-helpers/contract-adapters.ts): `setupSession(path, models, input)`,
 * `startModels(path, opts)` resolving to a handle with `done`, the spawnChild call shape, and
 * the file names `manifest.json` and `status.txt` in the team directory (both named in §3.3).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTeamStatus, summarise } from "./team-orchestrator.js";
import { setupTeamSession, spawnSeam, startModels } from "./test-helpers/contract-adapters.js";
import { type TempLayout, makeTempLayout, waitFor } from "./test-helpers/contract-records.js";

const T_TEST = 30_000;
const MODELS = ["contract-fake-a", "contract-fake-b"];

let layout: TempLayout;
let teamDir: string;

beforeEach(() => {
  layout = makeTempLayout("settle");
  teamDir = join(layout.root, "team");
});
afterEach(() => layout.cleanup());

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

describe("REQ-21 onSettled: called once, after the settled render, for a run that settles at once", () => {
  test(
    "every slot answers and exits at once: onSettled runs exactly once with a completed status",
    async () => {
      await setupTeamSession(teamDir, MODELS, "answer once and exit");
      const seam = spawnSeam({});
      const calls: Array<{ status: unknown; statusTxtExisted: boolean }> = [];

      const handle = await startModels(teamDir, {
        spawnChild: seam.spawnChild,
        onSettled: (status: unknown) =>
          calls.push({ status, statusTxtExisted: existsSync(join(teamDir, "status.txt")) }),
      });
      await settledWithin(handle.done, 15_000, "the team run");
      await Bun.sleep(200);

      expect(seam.calls()).toBe(MODELS.length);
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
      const seam = spawnSeam({});
      let called = 0;

      const handle = await startModels(teamDir, {
        spawnChild: seam.spawnChild,
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
});

describe("REQ-22 a throw inside the spawn loop leaves nothing running (amendment 4)", () => {
  test(
    "slot 2's spawn throws: the original error is rethrown, slot 1 gets SIGTERM, SIGINT handler removed, onSettled never called",
    async () => {
      await setupTeamSession(teamDir, MODELS, "@@HANG@@ stay alive until signalled");
      const injected = new Error("contract: spawn of slot 2 failed");
      const marker = (n: number) => join(layout.root, `sigterm-slot-${n}`);
      const seam = spawnSeam({ throwOn: 2, error: injected, markerFor: marker, hang: true });
      const sigintBefore = process.listenerCount("SIGINT");
      let settledCalls = 0;

      const thrown = await startModels(teamDir, {
        spawnChild: seam.spawnChild,
        onSettled: () => {
          settledCalls += 1;
        },
      }).then(
        () => undefined,
        (err: unknown) => err
      );
      const slot1 = seam.children[0];
      await waitFor(
        () => slot1 !== undefined && (slot1.exitCode !== null || slot1.signalCode !== null),
        {
          what: "slot 1 to exit",
          timeoutMs: 5_000,
        }
      );
      await Bun.sleep(300);
      // The SIGTERM can arrive before the fake child has installed its handler (the loop throws
      // within milliseconds of the first spawn); the default action then ends it by SIGTERM with
      // no marker. Either is proof of SIGTERM; a SIGKILL or a clean exit is not.
      const sigtermProof = slot1?.signalCode === "SIGTERM" || existsSync(marker(1));

      expect(sigtermProof).toBe(true);
      expect(thrown).toBe(injected);
      expect(seam.calls()).toBe(2);
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
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
      const seam = spawnSeam({});
      const sigintBefore = process.listenerCount("SIGINT");
      let settledCalls = 0;

      const thrown = await startModels(teamDir, {
        spawnChild: seam.spawnChild,
        onSettled: () => {
          settledCalls += 1;
        },
      }).then(
        () => undefined,
        (err: unknown) => err
      );
      await Bun.sleep(300);

      expect(thrown).toBeInstanceOf(Error);
      expect(seam.calls()).toBe(0);
      expect(settledCalls).toBe(0);
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    },
    T_TEST
  );
});
