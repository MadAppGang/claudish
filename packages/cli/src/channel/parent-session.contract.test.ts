// packages/cli/src/channel/parent-session.contract.test.ts
/**
 * Contract tests for channel/parent-session.ts: `hostPid`, and the `parentClaudeSessionId` a
 * call records.
 *
 * The parent contract, as measured on Claude Code 2.1.290: the host session record
 * `<configDir>/sessions/<hostPid>.json` carries the window's LIVE conversation (it changes on
 * `/clear` and back on `/resume`), while `CLAUDE_CODE_SESSION_ID` is the id the server started
 * with. So: record present → its id; record missing → the env id; neither → absent; and each
 * call reads the record at its own time. Every case runs over a synthetic Claude config dir in
 * a temp directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type TempLayout, claudeId, makeTempLayout } from "../test-helpers/contract-records.js";
import {
  CLAUDE_ID_RE,
  claudeConfigDir,
  hostPidFrom,
  parentSessionForCall,
  parentSessionIdFrom,
  readHostSessionRecord,
} from "./parent-session.js";

let layout: TempLayout;

beforeEach(() => {
  layout = makeTempLayout("parent");
});
afterEach(() => layout.cleanup());

function writeHostRecord(pid: number, body: string): string {
  mkdirSync(join(layout.configDir, "sessions"), { recursive: true });
  const path = join(layout.configDir, "sessions", `${pid}.json`);
  writeFileSync(path, body);
  return path;
}

describe("CLAUDE_ID_RE is the id shape and the path-safety gate", () => {
  test.each([
    ["8 allowed chars", "abcd_-12", true],
    ["128 chars", "a".repeat(128), true],
    ["7 chars", "abcdefg", false],
    ["129 chars", "a".repeat(129), false],
    ["a space", "abcd efgh", false],
    ["a dot", "abcd.efgh", false],
    ["a slash", "abcd/efgh", false],
  ])("CLAUDE_ID_RE with %s → %p", (_label, id, ok) => {
    expect(CLAUDE_ID_RE.test(id)).toBe(ok);
  });
});

describe("REQ-3 hostPidFrom(env, ppid) picks the launcher branch only on an exact pair (§8.1 test 9)", () => {
  test("a matching launcher pair → hostPid is the launcher's parent, launcherPid is ppid", () => {
    expect(
      hostPidFrom({ CLAUDISH_LAUNCHER_PID: "5000", CLAUDISH_LAUNCHER_PPID: "4000" }, 5000)
    ).toEqual({
      hostPid: 4000,
      launcherPid: 5000,
    });
  });

  test.each([
    [
      "a pair whose CLAUDISH_LAUNCHER_PID is not ppid (leaked from an outer launcher)",
      { CLAUDISH_LAUNCHER_PID: "5001", CLAUDISH_LAUNCHER_PPID: "4000" },
    ],
    ["no pair", {}],
    ["only CLAUDISH_LAUNCHER_PID", { CLAUDISH_LAUNCHER_PID: "5000" }],
    ["a non-integer PPID", { CLAUDISH_LAUNCHER_PID: "5000", CLAUDISH_LAUNCHER_PPID: "abc" }],
    ["a fractional PPID", { CLAUDISH_LAUNCHER_PID: "5000", CLAUDISH_LAUNCHER_PPID: "12.5" }],
    ["a zero PPID", { CLAUDISH_LAUNCHER_PID: "5000", CLAUDISH_LAUNCHER_PPID: "0" }],
    ["a negative PPID", { CLAUDISH_LAUNCHER_PID: "5000", CLAUDISH_LAUNCHER_PPID: "-3" }],
    ["an empty PPID", { CLAUDISH_LAUNCHER_PID: "5000", CLAUDISH_LAUNCHER_PPID: "" }],
  ])("%s → { hostPid: ppid } with no launcherPid", (_label, env) => {
    const result = hostPidFrom(env as Record<string, string>, 5000);

    expect(result.hostPid).toBe(5000);
    expect(result.launcherPid).toBeUndefined();
  });
});

describe("parentSessionIdFrom(env): the environment's id, the fallback", () => {
  const good = "0f9e8d7c-1111-4222-8333-444455556666";

  test.each([
    ["a valid CLAUDE_CODE_SESSION_ID", { CLAUDE_CODE_SESSION_ID: good }, good],
    [
      "a valid id with an empty CLAUDE_CODE_CHILD_SESSION",
      { CLAUDE_CODE_SESSION_ID: good, CLAUDE_CODE_CHILD_SESSION: "" },
      good,
    ],
    [
      "CLAUDE_CODE_CHILD_SESSION=1 (not started by Claude Code directly)",
      { CLAUDE_CODE_SESSION_ID: good, CLAUDE_CODE_CHILD_SESSION: "1" },
      undefined,
    ],
    ["no CLAUDE_CODE_SESSION_ID", {}, undefined],
    ["an empty id", { CLAUDE_CODE_SESSION_ID: "" }, undefined],
    ["a 7-char id", { CLAUDE_CODE_SESSION_ID: "abcdefg" }, undefined],
    ["a 129-char id", { CLAUDE_CODE_SESSION_ID: "a".repeat(129) }, undefined],
    ["an id with a space", { CLAUDE_CODE_SESSION_ID: "abcd efgh" }, undefined],
  ])("%s → %p", (_label, env, expected) => {
    expect(parentSessionIdFrom(env as Record<string, string>)).toBe(expected);
  });
});

describe("readHostSessionRecord: the host's live session record", () => {
  const hostPid = 424242;
  const R = "host-record-session-0001";

  test("a record whose pid equals hostPid and whose sessionId is valid is used", async () => {
    writeHostRecord(
      hostPid,
      JSON.stringify({ pid: hostPid, sessionId: R, cwd: join(layout.root, "project") })
    );

    const record = await readHostSessionRecord({ configDir: layout.configDir, hostPid });

    expect(record).toEqual({ sessionId: R });
  });

  test.each([
    ["its pid is not hostPid", () => JSON.stringify({ pid: hostPid + 1, sessionId: R })],
    ["it is not valid JSON (a write in progress)", () => `{"pid": ${hostPid}, "sessionId": "${R}"`],
    [
      "its sessionId does not match the id pattern",
      () => JSON.stringify({ pid: hostPid, sessionId: "short" }),
    ],
    ["it has no sessionId", () => JSON.stringify({ pid: hostPid })],
  ])("returns nothing when %s", async (_label, body) => {
    writeHostRecord(hostPid, body());

    const record = await readHostSessionRecord({ configDir: layout.configDir, hostPid });

    expect(record).toBeUndefined();
  });

  test("returns nothing when no record exists for hostPid", async () => {
    const record = await readHostSessionRecord({ configDir: layout.configDir, hostPid });

    expect(record).toBeUndefined();
  });
});

describe("REQ-6 claudeConfigDir follows CLAUDE_CONFIG_DIR, then HOME, then the OS home (amendment 1)", () => {
  test("CLAUDE_CONFIG_DIR wins when set", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: layout.configDir, HOME: layout.home })).toBe(
      layout.configDir
    );
  });

  test("without CLAUDE_CONFIG_DIR it is $HOME/.claude", () => {
    expect(claudeConfigDir({ HOME: layout.home })).toBe(join(layout.home, ".claude"));
  });

  test("with HOME empty it is the OS home directory's .claude", () => {
    expect(claudeConfigDir({ HOME: "" })).toBe(join(homedir(), ".claude"));
  });
});

describe("REQ-1/REQ-2 parentSessionForCall: the host record first, the env id second, else absent", () => {
  const hostPid = 515151;
  const env = (extra: Record<string, string> = {}) => ({
    CLAUDE_CONFIG_DIR: layout.configDir,
    ...extra,
  });

  test("record present → its id, even when the env carries a different (stale) id", async () => {
    const R = claudeId("host");
    const E = claudeId("env");
    writeHostRecord(hostPid, JSON.stringify({ pid: hostPid, sessionId: R }));

    expect(await parentSessionForCall({ hostPid, env: env({ CLAUDE_CODE_SESSION_ID: E }) })).toBe(
      R
    );
  });

  test("record missing → the env id", async () => {
    const E = claudeId("env");

    expect(await parentSessionForCall({ hostPid, env: env({ CLAUDE_CODE_SESSION_ID: E }) })).toBe(
      E
    );
  });

  test("record unusable (pid is not hostPid) → the env id", async () => {
    const E = claudeId("env");
    writeHostRecord(hostPid, JSON.stringify({ pid: hostPid + 1, sessionId: claudeId("other") }));

    expect(await parentSessionForCall({ hostPid, env: env({ CLAUDE_CODE_SESSION_ID: E }) })).toBe(
      E
    );
  });

  test.each([
    ["no record and no env id", {}],
    ["no record and a malformed env id", { CLAUDE_CODE_SESSION_ID: "bad id!" }],
    [
      "no record and an env id under CLAUDE_CODE_CHILD_SESSION",
      {
        CLAUDE_CODE_SESSION_ID: "0f9e8d7c-1111-4222-8333-444455556666",
        CLAUDE_CODE_CHILD_SESSION: "1",
      },
    ],
  ])("%s → undefined", async (_label, extra) => {
    expect(await parentSessionForCall({ hostPid, env: env(extra) })).toBeUndefined();
  });

  test("the record's id changes between two calls (/clear) → each call gets the id current at its time", async () => {
    const before = claudeId("before-clear");
    const after = claudeId("after-clear");
    const E = claudeId("env-start");
    const callEnv = env({ CLAUDE_CODE_SESSION_ID: E });
    writeHostRecord(hostPid, JSON.stringify({ pid: hostPid, sessionId: before }));
    const first = await parentSessionForCall({ hostPid, env: callEnv });

    writeHostRecord(hostPid, JSON.stringify({ pid: hostPid, sessionId: after }));
    const second = await parentSessionForCall({ hostPid, env: callEnv });

    rmSync(join(layout.configDir, "sessions", `${hostPid}.json`));
    const third = await parentSessionForCall({ hostPid, env: callEnv });

    expect([first, second, third]).toEqual([before, after, E]);
  });
});
