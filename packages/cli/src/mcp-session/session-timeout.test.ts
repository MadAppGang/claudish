/**
 * `timeout_seconds` is normalised ONCE, in `createSession`, before it reaches
 * `spawn.json`, `SessionInfo` or the pane's timer.
 *
 * The tool schema accepted any number, and the writer persisted
 * `Math.min(value, 3600)` unvalidated: 90.5, 0 and -5 went to disk as-is, and a
 * non-numeric value became NaN, which `JSON.stringify` writes as null. The
 * magus plugin monitor requires an integer in 1..3600 and drops any other
 * record, so the whole run went unreported — and 0 or a negative value also
 * timed the session out at once.
 *
 * Each session is a promptless pane session on the fake interactive child, so nothing
 * but its own timeout ends it; a value of 1 expires it during boot (§20.3 item 4), which
 * is the caller's explicit deadline.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import { SessionManager } from "./session-manager.js";

describe.skipIf(!MAGMUX)(
  `createSession timeout normalisation (${MAGMUX ? "magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    let t: PaneTestEnv;
    let sessionsDir: string;
    let manager: SessionManager;

    // One environment for the table: every case starts a pane and cancels it at once.
    beforeAll(() => {
      t = makePaneTestEnv();
      sessionsDir = join(t.tmp, "sessions");
      manager = new SessionManager({
        hostPid: 1,
        sessionsDir,
        parentEnv: t.env,
        paneTimings: { replStableMs: 200 },
      });
    });

    afterAll(async () => {
      await manager.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot }, 15_000);
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    });

    async function spawnRecordTimeout(raw: unknown): Promise<unknown> {
      const sessionId = await manager.createSession({
        model: "fake-answer",
        cwd: t.cwd,
        timeoutSeconds: raw as number | undefined,
      });
      const spawn = JSON.parse(readFileSync(join(sessionsDir, sessionId, "spawn.json"), "utf-8"));
      // the record and the timer cannot disagree: SessionInfo carries the same value
      expect(manager.getSession(sessionId).timeoutSeconds).toBe(spawn.timeoutSeconds);
      manager.cancelSession(sessionId);
      return spawn.timeoutSeconds;
    }

    const cases: [unknown, number][] = [
      [90.5, 91],
      [90.4, 90],
      [0, 1],
      [-5, 1],
      [0.2, 1],
      [7200, 3600],
      [Number.NaN, 600],
      [Number.POSITIVE_INFINITY, 600],
      ["600", 600],
      [null, 600],
      [undefined, 600],
    ];

    for (const [raw, expected] of cases) {
      test(`${String(raw)} → ${expected}`, async () => {
        expect(await spawnRecordTimeout(raw)).toBe(expected);
      }, 30_000);
    }
  }
);
