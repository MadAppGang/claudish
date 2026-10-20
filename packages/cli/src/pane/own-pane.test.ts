/**
 * `findOwnPane`: the pane whose process is this process or one of its ancestors
 * (hook-system §7.5; one rule shared by the recovery banner and the interactive driver).
 * The live two-pane case is in `hooks/session/interactive-driver.integration.test.ts`.
 */

import { describe, expect, test } from "bun:test";
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
