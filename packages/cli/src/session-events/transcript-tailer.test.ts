import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_EFFORT_ULTRACODE_STDOUT,
  FIXTURE_ULTRA_EFFORT_ENTER,
  FIXTURE_ULTRA_EFFORT_EXIT,
} from "./test-fixtures.js";
import { TranscriptTailer } from "./transcript-tailer.js";

/** Wait until a predicate returns true, checking every `intervalMs` ms.
 *  Rejects if the predicate hasn't returned true within `timeoutMs`. */
function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

let dir: string;
let tailer: TranscriptTailer | undefined;

function makeTranscript(content: string): string {
  dir = mkdtempSync(join(tmpdir(), "claudish-tailer-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, content);
  return file;
}

afterEach(() => {
  tailer?.dispose();
  tailer = undefined;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("TranscriptTailer", () => {
  test("start() backfills all existing lines from byte 0", () => {
    const file = makeTranscript(
      `${FIXTURE_EFFORT_ULTRACODE_STDOUT}\n${FIXTURE_ULTRA_EFFORT_ENTER}\n`
    );
    const lines: string[] = [];
    tailer = new TranscriptTailer(file, (l) => lines.push(l), { pollIntervalMs: 20 });
    tailer.start();
    // The backfill tick is synchronous — no waiting needed.
    expect(lines).toEqual([FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER]);
  });

  test("polling picks up lines appended after start()", async () => {
    const file = makeTranscript(`${FIXTURE_ULTRA_EFFORT_ENTER}\n`);
    const lines: string[] = [];
    tailer = new TranscriptTailer(file, (l) => lines.push(l), { pollIntervalMs: 20 });
    tailer.start();
    appendFileSync(file, `${FIXTURE_ULTRA_EFFORT_EXIT}\n`);
    await waitUntil(() => lines.length === 2);
    expect(lines[1]).toBe(FIXTURE_ULTRA_EFFORT_EXIT);
  });

  test("partial line stays buffered until its newline arrives; dispose stops ticks", () => {
    const file = makeTranscript("");
    const lines: string[] = [];
    tailer = new TranscriptTailer(file, (l) => lines.push(l), { pollIntervalMs: 60_000 });
    tailer.start();

    const half = Math.floor(FIXTURE_ULTRA_EFFORT_ENTER.length / 2);
    appendFileSync(file, FIXTURE_ULTRA_EFFORT_ENTER.slice(0, half));
    tailer.syncNow();
    expect(lines).toEqual([]); // no newline yet → buffered, not delivered

    appendFileSync(file, `${FIXTURE_ULTRA_EFFORT_ENTER.slice(half)}\n`);
    tailer.syncNow();
    expect(lines).toEqual([FIXTURE_ULTRA_EFFORT_ENTER]); // reassembled exactly

    tailer.dispose();
    appendFileSync(file, `${FIXTURE_ULTRA_EFFORT_EXIT}\n`);
    tailer.syncNow();
    expect(lines).toHaveLength(1); // disposed → syncNow is a no-op
  });
});
