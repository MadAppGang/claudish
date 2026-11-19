import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CompactionRecord,
  CompactionStore,
  historyRecordKey,
  toolOutputKey,
} from "./store.js";

const session = "first-writer-session";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-first-writer-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const original: CompactionRecord = {
  kind: "tool-output",
  form: "original",
  reason: "no answer within 1000 ms",
  decidedAt: "2026-11-15T00:00:00.000Z",
};
const compressed: CompactionRecord = {
  kind: "tool-output",
  form: "compressed",
  text: "short",
  originalChars: 100,
  compressedChars: 5,
  decidedAt: "2026-11-15T00:00:01.000Z",
};

test("the first record on disk wins across two store instances loaded before either wrote", () => {
  const key = toolOutputKey(session, "tool-1", "output");
  const a = new CompactionStore(root);
  const b = new CompactionStore(root);
  expect(a.list(session)).toEqual([]);
  expect(b.list(session)).toEqual([]);

  expect(a.put(session, key, original)).toEqual(original);
  expect(b.put(session, key, compressed)).toEqual(original);
  expect(b.get(session, key)).toEqual(original);
  expect(new CompactionStore(root).get(session, key)).toEqual(original);
  // No temporary file is left behind.
  expect(readdirSync(join(root, session))).toEqual([`${key}.json`]);
});

test("the same holds for history records", () => {
  const key = historyRecordKey("history-summary", session, "a".repeat(64));
  const ready: CompactionRecord = {
    kind: "history-summary",
    form: "ready",
    thread: "t",
    prefixHash: "a".repeat(64),
    boundary: 2,
    summary: "FIRST",
    decidedAt: "2026-11-15T00:00:00.000Z",
  };
  const failed: CompactionRecord = {
    kind: "history-summary",
    form: "failed",
    thread: "t",
    prefixHash: "a".repeat(64),
    boundary: 2,
    reason: "HTTP 500",
    decidedAt: "2026-11-15T00:00:01.000Z",
  };
  const a = new CompactionStore(root);
  const b = new CompactionStore(root);
  a.list(session);
  b.list(session);
  b.put(session, key, failed);
  expect(a.put(session, key, ready)).toEqual(failed);
  expect(new CompactionStore(root).get(session, key)).toEqual(failed);
});
