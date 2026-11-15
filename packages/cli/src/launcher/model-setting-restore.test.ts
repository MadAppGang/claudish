import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type RestoreDeps,
  beginModelSettingWatch,
  canonicalSettingsPath,
  realRestoreFs,
  sweepModelSettingLedger,
} from "./model-setting-restore.js";

let home: string;
let settingsFile: string;
let ledgerPath: string;
let lines: string[];

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function deps(extra: RestoreDeps = {}): RestoreDeps {
  return {
    settingsFile,
    ledgerPath,
    env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
    cwd: home,
    report: (line) => {
      lines.push(line);
    },
    ...extra,
  };
}

/** A session row whose launcher is gone: an empty process table never lists it. */
function endedSession(id: string) {
  return {
    id,
    launcher: { pid: 999_999, startedEpochMs: 1 },
    child: "pending",
    settingsArg: null,
    startedAt: 1,
  };
}

/** The other claudish's ledger: a newer copy carrying its own live session row. */
function newerLedger(key: string) {
  return {
    version: 1,
    entries: {
      [key]: {
        original: { present: true, value: "opus" },
        listed: ["or@a", "or@other"],
        sessions: [{ ...endedSession("other-session"), launcher: { pid: 1, startedEpochMs: 1 } }],
      },
    },
  };
}

/**
 * Another claudish takes the ledger lock from this one (a steal after the stale
 * TTL) and writes its newer ledger, while this holder is between its read and
 * its write.
 */
function stealLockAndWriteNewerLedger(key: string): void {
  writeFileSync(
    `${ledgerPath}.lock`,
    `${JSON.stringify({ pid: process.pid, host: hostname(), nonce: "the-thief", at: Date.now() })}\n`
  );
  put(ledgerPath, newerLedger(key));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "model-setting-restore-"));
  settingsFile = join(home, ".claude", "settings.json");
  ledgerPath = join(home, ".claudish", "model-setting-restore.json");
  lines = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("a ledger lock stolen between read and write", () => {
  test("the sweep writes neither the ledger nor settings.json", async () => {
    put(settingsFile, { model: "or@a" });
    const key = canonicalSettingsPath(settingsFile);
    put(ledgerPath, {
      version: 1,
      entries: {
        [key]: {
          original: { present: true, value: "opus" },
          listed: ["or@a"],
          sessions: [endedSession("mine")],
        },
      },
    });
    await sweepModelSettingLedger(
      deps({
        processTable: () => {
          stealLockAndWriteNewerLedger(key);
          return [];
        },
      })
    );
    expect(readJson(ledgerPath)).toEqual(newerLedger(key));
    expect(readJson(settingsFile)).toEqual({ model: "or@a" });
  });

  test("the exit transaction writes neither the ledger nor settings.json", async () => {
    put(settingsFile, { model: "opus" });
    const key = canonicalSettingsPath(settingsFile);
    let steal = false;
    const watch = await beginModelSettingWatch(
      ["or@a"],
      deps({
        processTable: () => {
          if (steal) stealLockAndWriteNewerLedger(key);
          return [];
        },
      })
    );
    expect(watch.registered).toBe(true);
    put(settingsFile, { model: "or@a" });
    steal = true;
    await watch.end();
    expect(readJson(ledgerPath)).toEqual(newerLedger(key));
    expect(readJson(settingsFile)).toEqual({ model: "or@a" });
  });

  test("begin leaves the other session's ledger and stays inert", async () => {
    put(settingsFile, { model: "opus" });
    const key = canonicalSettingsPath(settingsFile);
    const watch = await beginModelSettingWatch(
      ["or@a"],
      deps({
        fs: {
          ...realRestoreFs,
          readFile: (path) => {
            stealLockAndWriteNewerLedger(key);
            return realRestoreFs.readFile(path);
          },
        },
      })
    );
    expect(watch.registered).toBe(false);
    expect(readJson(ledgerPath)).toEqual(newerLedger(key));
  });
});
