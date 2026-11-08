// REGRESSION: team voters in a ps-less sandbox lose their launch dir; proxied pane child hits the API-key dialog — Fixed in /dev:fix session dev-fix-20261021-011007-a7c3

import { describe, expect, test } from "bun:test";
import { type PsRow, processTableTrusted, readProcessTable } from "./process-identity.js";

function row(pid: number): PsRow {
  return { pid, ppid: 0, pgid: 0, lstart: "", command: "" };
}

describe("processTableTrusted", () => {
  test("A1: an empty process table is untrusted", () => {
    expect(processTableTrusted([])).toBe(false);
  });

  test("A1: a nonempty table without this process is untrusted", () => {
    expect(processTableTrusted([row(process.pid + 1), row(process.pid + 2)])).toBe(false);
  });

  test("A1: a table containing this process is trusted", () => {
    expect(processTableTrusted([row(process.pid)])).toBe(true);
    expect(processTableTrusted([row(process.pid + 1), row(process.pid)])).toBe(true);
  });

  test("A1: the real process table is trusted in an unsandboxed run", () => {
    const table = readProcessTable() ?? [];
    expect(table.some((entry) => entry.pid === process.pid)).toBe(true);
    expect(processTableTrusted(table)).toBe(true);
  });
});
