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

function slotStates(sessionPath: string): string[] {
  try {
    const status = JSON.parse(readFileSync(join(sessionPath, "status.json"), "utf8")) as {
      models: Record<string, { state: string }>;
    };
    return Object.values(status.models).map((m) => m.state);
  } catch {
    return [];
  }
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

      expect(code).toBe(130);
      // ≤ 3 s reap budget, plus process start-up slack.
      expect(Date.now() - sentAt).toBeLessThan(6_000);
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
      if (proc.exitCode !== 130) console.error(stderr.slice(-3000));
    }
  }, 60_000);
});
