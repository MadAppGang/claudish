import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionKeepSessionIds } from "./launch.js";
import {
  COMPACTION_RETENTION_MS,
  CompactionStore,
  ensureSessionFolder,
  purgeExpiredSessions,
} from "./store.js";

const ID = "0b8f8c52-6a52-4f0a-9d6e-1a2b3c4d5e6f";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-retention-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("every flag form that names a session keeps that session's folder", () => {
  for (const args of [
    ["--resume", ID],
    ["-r", ID],
    [`--resume=${ID}`],
    ["--session-id", ID],
    [`--session-id=${ID}`],
    ["--fork-session", "--session-id", ID],
  ]) {
    expect(compactionKeepSessionIds(args, null)).toEqual([ID]);
  }
  expect(compactionKeepSessionIds(["--continue"], null)).toEqual([]);
  expect(compactionKeepSessionIds([], null)).toEqual([]);
  expect(compactionKeepSessionIds([], "picked-session")).toEqual(["picked-session"]);
  expect(compactionKeepSessionIds(["--resume", ID], ID)).toEqual([ID]);
});

/** A session folder with one record file, both last touched `days` ago. */
function oldSession(days: number): string {
  const dir = join(root, ID);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const then = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(dir, then, then);
  return dir;
}

test("opening a session's store refreshes its folder's retention", () => {
  const dir = oldSession(8);
  const store = new CompactionStore(root);
  expect(store.list(ID)).toEqual([]);
  expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(COMPACTION_RETENTION_MS);
  expect(purgeExpiredSessions(root)).toEqual([]);
});

test("the launcher's folder setup refreshes an existing folder's retention", () => {
  const dir = oldSession(8);
  ensureSessionFolder(root, ID);
  expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(60_000);
  expect(purgeExpiredSessions(root)).toEqual([]);
});
