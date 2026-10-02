/**
 * `timeout_seconds` is normalised ONCE, in `createSession`, before it reaches
 * `spawn.json` or the timer.
 *
 * The tool schema accepted any number, and the writer persisted
 * `Math.min(value, 3600)` unvalidated: 90.5, 0 and -5 went to disk as-is, and a
 * non-numeric value became NaN, which `JSON.stringify` writes as null. The
 * magus plugin monitor requires an integer in 1..3600 and drops any other
 * record, so the whole run went unreported — and 0 or a negative value also
 * timed the session out at once.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "./session-manager.js";

const FAKE_CLAUDISH_TS = join(
  dirname(fileURLToPath(import.meta.url)),
  "test-helpers",
  "fake-channel-stream-json.ts"
);

const originalClaudishBin = process.env.CLAUDISH_BIN;
let sessionsDir: string;
let manager: SessionManager;

beforeAll(() => {
  process.env.CLAUDISH_BIN = FAKE_CLAUDISH_TS;
});

afterAll(() => {
  if (originalClaudishBin === undefined) delete process.env.CLAUDISH_BIN;
  else process.env.CLAUDISH_BIN = originalClaudishBin;
});

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "claudish-session-timeout-"));
  manager = new SessionManager({ hostPid: 1, sessionsDir, stallSeconds: 0 });
});

afterEach(async () => {
  await manager.shutdownAll();
  rmSync(sessionsDir, { recursive: true, force: true });
});

function spawnRecordTimeout(raw: unknown): unknown {
  const sessionId = manager.createSession({
    model: "fake-model",
    // A promptless session waits for input, so nothing ends it during the test.
    timeoutSeconds: raw as number | undefined,
  });
  const spawn = JSON.parse(readFileSync(join(sessionsDir, sessionId, "spawn.json"), "utf-8"));
  return spawn.timeoutSeconds;
}

describe("createSession timeout normalisation", () => {
  const cases: [unknown, number][] = [
    [90.5, 91],
    [90.4, 90],
    [0, 1],
    [-5, 1],
    [0.2, 1],
    [7200, 3600],
    [Number.NaN, 600],
    [Number.POSITIVE_INFINITY, 600],
    ["600", 600],
    [null, 600],
    [undefined, 600],
  ];

  for (const [raw, expected] of cases) {
    test(`${String(raw)} → ${expected}`, () => {
      expect(spawnRecordTimeout(raw)).toBe(expected);
    });
  }
});
