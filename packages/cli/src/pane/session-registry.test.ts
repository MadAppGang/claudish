import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry, parseRegistryRecord } from "./session-registry.js";

// Real boot, idle and busy records from the acr2 registry.jsonl capture.
// Only cwd and messagingSocketPath are neutralized in these base fixtures.
const bootRecord = {
  pid: 20259,
  sessionId: "5b97c898-ab53-42be-b866-6389dd321a16",
  cwd: "/tmp/x",
  startedAt: 1791466216838,
  procStart: "Thu Oct  8 13:30:16 2026",
  version: "2.1.294",
  peerProtocol: 1,
  peerFeatures: ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
  kind: "interactive",
  entrypoint: "cli",
  pidDomain: "darwin",
  messagingSocketPath: "/tmp/x.sock",
  name: "acr2-e6",
  nameSource: "derived",
  nameSince: 1791466216838,
};
const idleRecord = {
  ...bootRecord,
  status: "idle",
  updatedAt: 1791466216946,
  statusUpdatedAt: 1791466216946,
};
const busyRecord = {
  ...bootRecord,
  status: "busy",
  updatedAt: 1791466218682,
  statusUpdatedAt: 1791466218682,
};
const expectedIdle = {
  pid: 20259,
  sessionId: bootRecord.sessionId,
  status: "idle",
  statusUpdatedAt: 1791466216946,
  waitingFor: null,
  version: "2.1.294",
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup({ sessions = true, alive = true } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "session-registry-test-"));
  tempDirs.push(configDir);
  const dir = join(configDir, "sessions");
  if (sessions) mkdirSync(dir);
  let now = 10_000;
  const checkedPids: number[] = [];
  const registry = new SessionRegistry({
    configDir,
    sessionUuid: bootRecord.sessionId,
    now: () => now,
    isAlive: (pid) => {
      checkedPids.push(pid);
      return alive;
    },
  });
  return {
    registry,
    checkedPids,
    advance: (ms: number) => {
      now += ms;
    },
    write: (name: string, record: object, suffix = "") =>
      writeFileSync(join(dir, name), JSON.stringify(record) + suffix),
    remove: (name: string) => rmSync(join(dir, name)),
  };
}

describe("parseRegistryRecord", () => {
  test("maps fields from a real status record with absent waitingFor", () => {
    expect(parseRegistryRecord(JSON.stringify(idleRecord))).toEqual(expectedIdle);
  });

  test("returns null status before the first status update", () => {
    expect(parseRegistryRecord(JSON.stringify(bootRecord))).toEqual({
      ...expectedIdle,
      status: null,
      statusUpdatedAt: null,
    });
  });

  test("parses a torn write with an extra trailing brace", () => {
    expect(parseRegistryRecord(JSON.stringify(idleRecord) + "}\n")).toEqual(expectedIdle);
  });

  test("rejects garbage, non-objects and missing identity fields", () => {
    const { pid: _pid, ...withoutPid } = idleRecord;
    const { sessionId: _sessionId, ...withoutSessionId } = idleRecord;
    for (const raw of [
      "garbage",
      "null",
      "42",
      '"text"',
      "true",
      "[]",
      "{}",
      JSON.stringify(withoutPid),
      JSON.stringify(withoutSessionId),
    ]) {
      expect(parseRegistryRecord(raw)).toBeNull();
    }
  });
});

describe("SessionRegistry.read", () => {
  test("finds its session among foreign, torn and non-numeric files", () => {
    const s = setup();
    s.write("100.json", { ...idleRecord, pid: 100, sessionId: "foreign-session" });
    s.write("x.json", { ...idleRecord, pid: 101 });
    s.write("20259.json", idleRecord, "}");
    expect(s.registry.read()).toEqual(expectedIdle);
    expect(s.checkedPids).toEqual([20259]);
  });

  test("ignores a matching record in a non-numeric filename", () => {
    const s = setup();
    s.write("x.json", idleRecord);
    expect(s.registry.read()).toBeNull();
    expect(s.checkedPids).toEqual([]);
  });

  test("returns null for a foreign-only directory", () => {
    const s = setup();
    s.write("20259.json", { ...idleRecord, sessionId: "foreign-session" });
    expect(s.registry.read()).toBeNull();
    expect(s.checkedPids).toEqual([]);
  });

  test("returns null when the record pid is not alive", () => {
    const s = setup({ alive: false });
    s.write("20259.json", idleRecord);
    expect(s.registry.read()).toBeNull();
    expect(s.checkedPids).toEqual([20259]);
  });

  test("rejects a record whose pid differs from its filename", () => {
    const s = setup();
    s.write("20260.json", idleRecord);
    expect(s.registry.read()).toBeNull();
    expect(s.checkedPids).toEqual([]);
  });

  test("reads status changes from the cached pid before the next scan", () => {
    const s = setup();
    s.write("20259.json", idleRecord);
    expect(s.registry.read()).toEqual(expectedIdle);
    s.write("20259.json", busyRecord);
    expect(s.registry.read()).toEqual({
      ...expectedIdle,
      status: "busy",
      statusUpdatedAt: 1791466218682,
    });
    expect(s.checkedPids).toEqual([20259, 20259]);
  });

  test("waits for the scan interval after the cached file disappears", () => {
    const s = setup();
    s.write("20259.json", idleRecord);
    expect(s.registry.read()).toEqual(expectedIdle);
    s.remove("20259.json");
    expect(s.registry.read()).toBeNull();
    s.write("20260.json", { ...idleRecord, pid: 20260 });
    s.advance(999);
    expect(s.registry.read()).toBeNull();
    s.advance(1);
    expect(s.registry.read()).toEqual({ ...expectedIdle, pid: 20260 });
    expect(s.checkedPids).toEqual([20259, 20260]);
  });

  test("returns null without throwing when the sessions directory is missing", () => {
    const s = setup({ sessions: false });
    expect(() => expect(s.registry.read()).toBeNull()).not.toThrow();
  });
});
