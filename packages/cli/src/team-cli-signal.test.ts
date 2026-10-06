/**
 * `claudish team run` (json mode) runs every slot as an interactive pane, so Ctrl-C must
 * reap them: SIGINT → every pane closed in ≤ 3 s → exit 130 (128 + SIGINT), with no
 * process and no socket, record or launcher dir left behind (§6.3, D15 layer 3).
 *
 * The real CLI entry under bun, the fake interactive child as every pane (CLAUDISH_BIN),
 * a hermetic environment and its own pane root.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orphanReport } from "./pane/test-helpers/hermetic-env.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  waitUntil,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

const ENTRY = join(import.meta.dir, "index.ts");

let t: PaneTestEnv;

beforeEach(() => {
  t = makePaneTestEnv({ CONTRACT_FAKE_MAX_MS: "60000" });
});

afterEach(async () => {
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

function slotRows(sessionPath: string): Array<{ state: string; error?: { reason?: string } }> {
  try {
    const status = JSON.parse(readFileSync(join(sessionPath, "status.json"), "utf8")) as {
      models: Record<string, { state: string; error?: { reason?: string } }>;
    };
    return Object.values(status.models);
  } catch {
    return [];
  }
}

function slotStates(sessionPath: string): string[] {
  return slotRows(sessionPath).map((m) => m.state);
}

describe.skipIf(!MAGMUX)("claudish team run — signals", () => {
  it("SIGINT reaps every pane and exits 130", async () => {
    // validateSessionPath wants the session under the cwd: run the CLI from the temp dir.
    const cwd = join(t.tmp, "work");
    mkdirSync(cwd, { recursive: true });
    const sessionPath = join(cwd, "review");
    const proc = Bun.spawn(
      [
        process.execPath,
        ENTRY,
        "team",
        "run",
        "--mode",
        "json",
        "--path",
        sessionPath,
        "--models",
        "contract-fake-a,contract-fake-b",
        "--input",
        "@@HANG@@ hold until interrupted",
      ],
      { cwd, env: t.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
    );
    let stderr = "";
    void new Response(proc.stderr).text().then((s) => {
      stderr = s;
    });

    try {
      await waitUntil(
        () => {
          const states = slotStates(sessionPath);
          return states.length === 2 && states.every((s) => s === "RUNNING");
        },
        "both slots RUNNING",
        30_000,
        100
      );
      expect(existsSync(join(t.sockRoot, "panes"))).toBe(true);

      const sentAt = Date.now();
      proc.kill("SIGINT");
      const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "hung")]);
      // Read at once: the pane watchers would clean up after a process that merely died
      // (D15), so only an immediate check proves the CLI's own reap ran.
      const left = orphanReport({ sockRoot: t.sockRoot });

      expect(code).toBe(130);
      // a HANDLED exit: Bun also reports 130 for a process KILLED by SIGINT, with
      // signalCode "SIGINT" and exitCode null
      expect(proc.signalCode).toBeNull();
      expect(proc.exitCode).toBe(130);
      // ≤ 3 s reap budget, plus process start-up slack.
      expect(Date.now() - sentAt).toBeLessThan(6_000);
      expect(left).toEqual({ processes: [], files: [] });
      // the shutdown reap cancelled every slot, and the record says so
      const rows = slotRows(sessionPath);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.state).toBe("CANCELLED");
        expect(r.error?.reason).toBe("cancelled");
      }
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
      if (proc.exitCode !== 130) console.error(stderr.slice(-3000));
    }
  }, 60_000);
});
