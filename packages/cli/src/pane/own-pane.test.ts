/**
 * `findOwnPane`: the pane whose process is this process or one of its ancestors
 * (hook-system §7.5; one rule shared by the recovery banner and the interactive driver).
 * The live two-pane case is in `hooks/session/interactive-driver.integration.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestorPids, findOwnPane, panesOfList } from "./own-pane.js";

const mine =
  (...pids: number[]) =>
  async () =>
    new Set(pids);

describe("panesOfList", () => {
  test("reads {panes: [...]} and a bare array; skips entries without a pane number", () => {
    expect(
      panesOfList({ panes: [{ pane: 0, pid: 10 }, { pane: 2, control: true }, { pid: 3 }] })
    ).toEqual([
      { pane: 0, pid: 10 },
      { pane: 2, pid: null },
    ]);
    expect(panesOfList([{ pane: 1, pid: 11 }])).toEqual([{ pane: 1, pid: 11 }]);
    expect(panesOfList(null)).toEqual([]);
    expect(panesOfList({ nope: true })).toEqual([]);
  });
});

describe("findOwnPane", () => {
  const list = async () => ({
    panes: [
      { pane: 0, pid: 100 },
      { pane: 1, pid: 200 },
      { pane: 2, control: true, hidden: true },
    ],
  });

  test("the pane whose pid is an ancestor — never pane 0 by default", async () => {
    expect(await findOwnPane(list, mine(999, 200, 50))).toBe(1);
    expect(await findOwnPane(list, mine(100))).toBe(0);
  });

  test("null when no pane's pid is this process or an ancestor", async () => {
    expect(await findOwnPane(list, mine(1, 2, 3))).toBeNull();
  });

  test("null when list fails or returns nothing", async () => {
    expect(await findOwnPane(async () => null, mine(100))).toBeNull();
    expect(
      await findOwnPane(async () => {
        throw new Error("socket closed");
      }, mine(100))
    ).toBeNull();
  });

  test("ancestorPids starts at this process and walks up through its parent", async () => {
    const pids = await ancestorPids();
    expect(pids.has(process.pid)).toBe(true);
    expect(pids.has(process.ppid)).toBe(true);
  });
});

describe("ancestorPids with a ps whose stdout stays open", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      const pidFile = join(dir, "holder.pid");
      const holders = existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n") : [];
      for (const line of holders) {
        const pid = Number(line.trim());
        try {
          if (pid > 1) process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A `ps` stand-in that prints `answer` and exits at once, leaving a background
   * process that inherited its stdout and holds the pipe's write end for 30 s.
   */
  function heldPipePs(answer: string): string {
    const dir = mkdtempSync(join(tmpdir(), "own-pane-ps-"));
    dirs.push(dir);
    const ps = join(dir, "ps");
    const pidFile = join(dir, "holder.pid");
    writeFileSync(ps, `#!/bin/sh\nsleep 30 &\necho $! >> '${pidFile}'\necho ${answer}\n`);
    chmodSync(ps, 0o755);
    return ps;
  }

  test("answers once ps exits, without waiting for the pipe to close", async () => {
    // every run names the same parent, so the walk visits it and stops at the depth limit
    const parent = 4_242_424;
    const ps = heldPipePs(String(parent));
    const started = performance.now();
    const outcome = await Promise.race([
      ancestorPids(2, ps).then((pids) => ({ pids })),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_500)),
    ]);
    expect(outcome).not.toBe("hung");
    if (outcome === "hung") return;
    // each run answers on its exit plus a short drain, never at a kill deadline
    expect(performance.now() - started).toBeLessThan(800);
    expect([...outcome.pids].sort((a, b) => a - b)).toEqual(
      [process.pid, process.ppid, parent].sort((a, b) => a - b)
    );
  });
});
