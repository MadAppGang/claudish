// REGRESSION: team voters in a ps-less sandbox lose their launch dir; proxied pane child hits the API-key dialog — Fixed in /dev:fix session dev-fix-20261021-011007-a7c3

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type PaneRecord,
  type SweepResult,
  sweepOrphanPanes,
  writeRecord,
} from "./pane-registry.js";
import { readProcessTable, recordPathOf, sockPathOf } from "./process-identity.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SANDBOX_PROFILE = '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))';
const HELPER = join(import.meta.dir, "test-helpers", "sweep-in-sandbox.ts");
const noSandbox = process.platform !== "darwin" || !existsSync(SANDBOX_EXEC);
const roots: string[] = [];

interface SandboxSweep {
  processTableRows: number;
  result: SweepResult;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync("/tmp/sw-"));
  roots.push(root);
  chmodSync(root, 0o700);
  mkdirSync(join(root, "panes"), { mode: 0o700 });
  return root;
}

function livePaneId(): string {
  return `c${process.pid}-${Date.now().toString(36)}-t01-abcdef`;
}

function makeLiveRecord(root: string): PaneRecord {
  const paneId = livePaneId();
  const launcherDir = mkdtempSync(join(root, "launch-"));
  const turnDir = mkdtempSync(join(root, "launch-"));
  const ownerStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  })
    .trim()
    .replace(/\s+/g, " ");
  expect(ownerStart.length).toBeGreaterThan(0);
  const rec: PaneRecord = {
    paneId,
    ownerPid: process.pid,
    ownerStart,
    watcherPid: null,
    magmuxPid: null,
    panePid: null,
    sessionUuid: crypto.randomUUID(),
    sockPath: sockPathOf(root, paneId),
    launcherDir,
    turnDir,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(turnDir, "turn-1.md"), "Keep this live owner's prompt.\n");
  writeFileSync(rec.sockPath, "");
  writeRecord(root, rec);
  return rec;
}

function recordFiles(root: string, rec: PaneRecord) {
  return {
    record: existsSync(recordPathOf(root, rec.paneId)),
    launcherDir: existsSync(rec.launcherDir),
    turnDir: existsSync(rec.turnDir),
    turnFile: existsSync(join(rec.turnDir, "turn-1.md")),
    socket: existsSync(rec.sockPath),
  };
}

const allRecordFilesPresent = {
  record: true,
  launcherDir: true,
  turnDir: true,
  turnFile: true,
  socket: true,
};

function sandboxSweep(root: string): SandboxSweep {
  const stdout = execFileSync(
    SANDBOX_EXEC,
    ["-p", SANDBOX_PROFILE, process.execPath, HELPER, root],
    { encoding: "utf8", timeout: 15_000 }
  );
  return JSON.parse(stdout) as SandboxSweep;
}

describe("sweep with an untrusted process table", () => {
  test.skipIf(noSandbox)(
    "A2: denied ps keeps a live owner's record, launch dirs, turn file and socket",
    () => {
      const root = makeRoot();
      const rec = makeLiveRecord(root);
      expect(recordFiles(root, rec)).toEqual(allRecordFilesPresent);

      const swept = sandboxSweep(root);
      expect(swept.processTableRows).toBe(0);
      expect({ files: recordFiles(root, rec), result: swept.result }).toEqual({
        files: allRecordFilesPresent,
        result: { reaped: [], cleaned: [], kept: [rec.paneId] },
      });
    },
    20_000
  );

  test.skipIf(noSandbox)(
    "A3: denied ps keeps a recordless socket whose embedded owner is alive",
    () => {
      const root = makeRoot();
      const paneId = livePaneId();
      const socket = sockPathOf(root, paneId);
      writeFileSync(socket, "");
      expect(existsSync(recordPathOf(root, paneId))).toBe(false);
      expect(existsSync(socket)).toBe(true);

      const swept = sandboxSweep(root);
      expect(swept.processTableRows).toBe(0);
      expect({
        socketExists: existsSync(socket),
        cleaned: swept.result.cleaned,
        reaped: swept.result.reaped,
      }).toEqual({ socketExists: true, cleaned: [], reaped: [] });
    },
    20_000
  );

  test("A4: working ps keeps the same live-owner record, launch dirs, turn file and socket", async () => {
    const root = makeRoot();
    const rec = makeLiveRecord(root);
    expect(recordFiles(root, rec)).toEqual(allRecordFilesPresent);
    expect(readProcessTable()?.some((row) => row.pid === process.pid)).toBe(true);

    const result = await sweepOrphanPanes(root);
    expect({
      files: recordFiles(root, rec),
      cleaned: result.cleaned,
      reaped: result.reaped,
    }).toEqual({
      files: allRecordFilesPresent,
      cleaned: [],
      reaped: [],
    });
  }, 20_000);
});
