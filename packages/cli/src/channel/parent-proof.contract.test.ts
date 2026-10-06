// packages/cli/src/channel/parent-proof.contract.test.ts
/**
 * Black-box contract tests for channel/parent-proof.ts (design §3.5, §8.1 tests 9-10;
 * amendments 1 and 5). Written from the specification only.
 *
 * Every proof runs over a synthetic Claude config dir in a temp directory. The poll wait is
 * injected (`sleep`), so no test waits for real. INFERRED: a `ProofCandidate` carries
 * `{ sessionId, cwd? }` — the only place the host record's `cwd` can reach the proof, since
 * `proveCallingConversation` takes no host-record argument. Built in `candidate()` only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type TempLayout,
  claudeId,
  fillerLine,
  makeTempLayout,
  sanitisedProjectName,
  transcriptLineWithToolUse,
} from "../test-helpers/contract-records.js";
import {
  CLAUDE_ID_RE,
  MAX_SUBAGENT_FILES,
  PROOF_DEADLINE_MS,
  PROOF_POLL_INTERVAL_MS,
  SUBAGENT_WINDOW_MS,
  TOOL_USE_ID_META_KEY,
  TRANSCRIPT_TAIL_BYTES,
  claudeConfigDir,
  hostPidFrom,
  parentSessionIdFrom,
  projectDirNameFor,
  proveCallingConversation,
  readHostSessionRecord,
} from "./parent-proof.js";
import type { ProofCandidate, ProofFs } from "./parent-proof.js";

// INFERRED candidate shape (see header).
function candidate(sessionId: string, cwd?: string): ProofCandidate {
  return (cwd === undefined ? { sessionId } : { sessionId, cwd }) as unknown as ProofCandidate;
}

let layout: TempLayout;
let sleeps: number[];
const recordSleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

beforeEach(() => {
  layout = makeTempLayout("proof");
  sleeps = [];
});
afterEach(() => layout.cleanup());

const projectsDir = () => join(layout.configDir, "projects");

function writeMainTranscript(project: string, sessionId: string, content: string): string {
  const dir = join(projectsDir(), project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, content);
  return path;
}

function writeSubagentTranscript(
  project: string,
  parent: string,
  name: string,
  content: string,
  mtimeMs?: number
): string {
  const dir = join(projectsDir(), project, parent, "subagents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

/** Wrap every node:fs/promises function so the test can see what the proof touched. */
function countingFs(): { fs: ProofFs; calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = [];
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fsp)) {
    wrapped[name] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            calls.push({ method: name, path: String(args[0]) });
            return (value as (...a: unknown[]) => unknown).apply(fsp, args);
          }
        : value;
  }
  return { fs: wrapped as unknown as ProofFs, calls };
}

const toolUseId = () => `toolu_contract_${crypto.randomUUID().replaceAll("-", "")}`;

describe("REQ-4 constants named by the contract carry the spec's values", () => {
  test("TOOL_USE_ID_META_KEY is the _meta key the dispatcher reads", () => {
    expect(TOOL_USE_ID_META_KEY).toBe("claudecode/toolUseId");
  });

  test("tail, subagent window, subagent cap and proof polling match §3.5", () => {
    expect({
      tail: TRANSCRIPT_TAIL_BYTES,
      window: SUBAGENT_WINDOW_MS,
      cap: MAX_SUBAGENT_FILES,
      poll: PROOF_POLL_INTERVAL_MS,
      deadline: PROOF_DEADLINE_MS,
    }).toEqual({ tail: 256 * 1024, window: 10 * 60 * 1000, cap: 32, poll: 100, deadline: 2000 });
  });

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
    const result = hostPidFrom(env as Record<string, string>, 5000) as {
      hostPid: number;
      launcherPid?: number;
    };

    expect(result.hostPid).toBe(5000);
    expect(result.launcherPid).toBeUndefined();
  });
});

describe("REQ-4 parentSessionIdFrom(env): the env candidate (§3.5 step 2)", () => {
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
    expect(parentSessionIdFrom(env as Record<string, string>) ?? undefined).toBe(expected);
  });
});

describe("REQ-4 readHostSessionRecord: the host's live session record (§3.5 step 2)", () => {
  const hostPid = 424242;
  const R = "host-record-session-0001";

  function writeHostRecord(pid: number, body: string): void {
    mkdirSync(join(layout.configDir, "sessions"), { recursive: true });
    writeFileSync(join(layout.configDir, "sessions", `${pid}.json`), body);
  }

  test("a record whose pid equals hostPid and whose sessionId is valid is used, with its cwd", async () => {
    writeHostRecord(
      hostPid,
      JSON.stringify({ pid: hostPid, sessionId: R, cwd: join(layout.root, "project") })
    );

    const record = await readHostSessionRecord({ configDir: layout.configDir, hostPid });

    expect(record).toMatchObject({ sessionId: R, cwd: join(layout.root, "project") });
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

    expect(record ?? undefined).toBeUndefined();
  });

  test("returns nothing when no record exists for hostPid", async () => {
    const record = await readHostSessionRecord({ configDir: layout.configDir, hostPid });

    expect(record ?? undefined).toBeUndefined();
  });
});

describe("REQ-6 claudeConfigDir follows CLAUDE_CONFIG_DIR, then HOME, then the OS home (amendment 1)", () => {
  function withEnv<T>(
    vars: Record<string, string | undefined>,
    fn: (env: Record<string, string | undefined>) => T
  ): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      // INFERRED: claudeConfigDir(env?) — pass the env and set process.env, so either shape works.
      return fn({ ...process.env });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const call = (env: Record<string, string | undefined>) =>
    (claudeConfigDir as unknown as (e?: unknown) => string)(env);

  test("CLAUDE_CONFIG_DIR wins when set", () => {
    expect(withEnv({ CLAUDE_CONFIG_DIR: layout.configDir, HOME: layout.home }, call)).toBe(
      layout.configDir
    );
  });

  test("without CLAUDE_CONFIG_DIR it is $HOME/.claude", () => {
    expect(withEnv({ CLAUDE_CONFIG_DIR: undefined, HOME: layout.home }, call)).toBe(
      join(layout.home, ".claude")
    );
  });

  test("with HOME empty it is the OS home directory's .claude", () => {
    expect(withEnv({ CLAUDE_CONFIG_DIR: undefined, HOME: "" }, call)).toBe(
      join(homedir(), ".claude")
    );
  });
});

describe("REQ-4 projectDirNameFor: every character outside [A-Za-z0-9] becomes '-'", () => {
  test.each([
    ["/Users/someone/.claude/worktrees/x", "-Users-someone--claude-worktrees-x"],
    ["/srv/my_app v2.1", "-srv-my-app-v2-1"],
  ])("%s → %s", (cwd, expected) => {
    expect(projectDirNameFor(cwd)).toBe(expected);
  });
});

describe("REQ-1/REQ-2/REQ-4 proveCallingConversation (§8.1 test 10)", () => {
  test("returns the candidate whose main transcript holds the quoted tool-use id", async () => {
    const E = claudeId("env");
    const T = toolUseId();
    writeMainTranscript("P", E, fillerLine(1) + transcriptLineWithToolUse(T) + fillerLine(2));

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(E)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBe(E);
    expect(sleeps).toEqual([]);
  });

  test("returns the second candidate when the id is only in one of its fresh subagent transcripts", async () => {
    const E = claudeId("env");
    const R = claudeId("host");
    const T = toolUseId();
    writeMainTranscript("P", E, fillerLine(1));
    writeMainTranscript("Q", R, fillerLine(2));
    writeSubagentTranscript("Q", R, "a.jsonl", transcriptLineWithToolUse(T));

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(E), candidate(R)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBe(R);
  });

  test("skips a candidate with no transcript anywhere and proves the other", async () => {
    const ghost = claudeId("ghost");
    const E = claudeId("env");
    const T = toolUseId();
    writeMainTranscript("P", E, transcriptLineWithToolUse(T));

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(ghost), candidate(E)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBe(E);
  });

  test("returns undefined after polling every 100 ms for 2000 ms when no transcript holds the id", async () => {
    const E = claudeId("env");
    writeMainTranscript("P", E, fillerLine(1));

    const parent = await proveCallingConversation({
      toolUseId: toolUseId(),
      candidates: [candidate(E)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBeUndefined();
    expect(sleeps).toEqual(Array(20).fill(100));
  });

  test("finds an id appended to the transcript during the first poll wait", async () => {
    const E = claudeId("env");
    const T = toolUseId();
    const path = writeMainTranscript("P", E, fillerLine(1));
    const appendDuringWait = async (ms: number) => {
      sleeps.push(ms);
      appendFileSync(path, transcriptLineWithToolUse(T));
    };

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(E)],
      configDir: layout.configDir,
      sleep: appendDuringWait,
    });

    expect(parent).toBe(E);
    expect(sleeps).toEqual([100]);
  });

  test("ignores an id that occurs only before the last 256 KB of the main transcript", async () => {
    const E = claudeId("env");
    const T = toolUseId();
    let padding = "";
    for (let i = 0; padding.length < 300 * 1024; i++) padding += fillerLine(i);
    writeMainTranscript("P", E, transcriptLineWithToolUse(T) + padding);

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(E)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBeUndefined();
  });

  test("finds an id that sits inside the last 256 KB of a transcript larger than 256 KB", async () => {
    const E = claudeId("env");
    const T = toolUseId();
    let head = "";
    for (let i = 0; head.length < 300 * 1024; i++) head += fillerLine(i);
    let tail = "";
    for (let i = 0; tail.length < 200 * 1024; i++) tail += fillerLine(i);
    writeMainTranscript("P", E, head + transcriptLineWithToolUse(T) + tail);

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(E)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBe(E);
  });

  test("matches the quoted id exactly, not as a prefix of a longer id", async () => {
    const E = claudeId("env");
    const T = toolUseId();
    writeMainTranscript("P", E, transcriptLineWithToolUse(`${T}extra`));

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(E)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBeUndefined();
  });

  test.each([
    ["a 7-char id", "toolu_1"],
    ["an id with a space", "toolu has space"],
    ["an id with a quote", 'toolu_"quoted"'],
    ["a 129-char id", `t${"a".repeat(128)}`],
    ["an empty id", ""],
    ["no id at all", undefined],
  ])("%s → undefined, and no file is touched", async (_label, badId) => {
    const E = claudeId("env");
    writeMainTranscript("P", E, transcriptLineWithToolUse(String(badId)));
    const { fs, calls } = countingFs();

    const parent = await proveCallingConversation({
      toolUseId: badId as string,
      candidates: [candidate(E)],
      configDir: layout.configDir,
      fs,
      sleep: recordSleep,
    });

    expect(parent).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("ignores a subagent transcript last modified more than 10 minutes ago", async () => {
    const R = claudeId("host");
    const T = toolUseId();
    writeMainTranscript("Q", R, fillerLine(1));
    writeSubagentTranscript(
      "Q",
      R,
      "old.jsonl",
      transcriptLineWithToolUse(T),
      Date.now() - 11 * 60 * 1000
    );

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(R)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBeUndefined();
  });

  test.each([
    [32, "found"],
    [33, "not found"],
  ])(
    "with %i fresh subagent files and the id only in the oldest, it is %s (newest first, at most 32)",
    async (count, outcome) => {
      const R = claudeId("host");
      const T = toolUseId();
      writeMainTranscript("Q", R, fillerLine(1));
      const now = Date.now();
      for (let i = 0; i < count; i++) {
        const isOldest = i === 0;
        writeSubagentTranscript(
          "Q",
          R,
          `s${String(i).padStart(2, "0")}.jsonl`,
          isOldest ? transcriptLineWithToolUse(T) : fillerLine(i),
          now - 5 * 60 * 1000 + i * 1000
        );
      }

      const parent = await proveCallingConversation({
        toolUseId: T,
        candidates: [candidate(R)],
        configDir: layout.configDir,
        sleep: recordSleep,
      });

      expect(parent).toBe(outcome === "found" ? R : undefined);
    }
  );

  test("fast path: a candidate with a cwd is found under the sanitised-cwd directory with no listing of projects/", async () => {
    const R = claudeId("host");
    const T = toolUseId();
    const cwd = join(layout.root, "work tree", ".claude", "wt_1");
    writeMainTranscript(sanitisedProjectName(cwd), R, transcriptLineWithToolUse(T));
    writeMainTranscript("unrelated-project", claudeId("other"), fillerLine(1));
    const { fs, calls } = countingFs();

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(R, cwd)],
      configDir: layout.configDir,
      fs,
      sleep: recordSleep,
    });

    expect(parent).toBe(R);
    const listings = calls.filter(
      (c) =>
        (c.method === "readdir" || c.method === "opendir") &&
        c.path.replace(/\/+$/, "") === projectsDir()
    );
    expect(listings).toEqual([]);
  });

  test("a cwd that maps to no directory falls back to listing projects/ and still finds the transcript", async () => {
    const R = claudeId("host");
    const T = toolUseId();
    writeMainTranscript("renamed-by-a-future-claude-code", R, transcriptLineWithToolUse(T));

    const parent = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(R, join(layout.root, "no", "such", "project"))],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(parent).toBe(R);
  });

  test("REQ-5 an unproven call caches no project directory: the next call finds the transcript where it now lives", async () => {
    const C = claudeId("moving");
    const stale = writeMainTranscript("P-stale", C, fillerLine(1));

    const first = await proveCallingConversation({
      toolUseId: toolUseId(),
      candidates: [candidate(C)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });
    rmSync(stale);
    const T = toolUseId();
    writeMainTranscript("Q-current", C, transcriptLineWithToolUse(T));
    const second = await proveCallingConversation({
      toolUseId: T,
      candidates: [candidate(C)],
      configDir: layout.configDir,
      sleep: recordSleep,
    });

    expect(first).toBeUndefined();
    expect(second).toBe(C);
  });
});
