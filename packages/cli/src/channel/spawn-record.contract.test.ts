// packages/cli/src/channel/spawn-record.contract.test.ts
/**
 * Black-box contract tests for the start-time record `spawn.json` and the proven parent
 * conversation, end to end through a real claudish MCP server over stdio
 * (design §3.3 "spawn.json", §3.4, §3.5; §8.1 tests 10b, 11-14b, 19; amendments 1 and 2).
 *
 * Every session is an interactive pane: the pane fake (marker mode) via CLAUDISH_BIN, in a
 * real headless magmux under the test's own CLAUDISH_PANE_ROOT (ported per architecture
 * §20.2; every assertion kept). After each test no pane process or file may remain.
 *
 * The test process stands in for Claude Code: it spawns `bun src/index.ts --mcp`, so the
 * correct `hostPid` is `process.pid` and the host's live session record lives at
 * `<CLAUDE_CONFIG_DIR>/sessions/<process.pid>.json`. The tool-use id travels in
 * `params._meta["claudecode/toolUseId"]`, exactly as Claude Code sends it.
 *
 * INFERRED (adapters in test-helpers/contract-mcp.ts): create_session returns the id as
 * `session_id`. The server exposes no `get_session` MCP tool, so a session read back from disk
 * is observed through the public `SessionManager.getSession(id)` (documented to fall back to
 * `<sessionsDir>/<id>/meta.json`), via test-helpers/contract-adapters.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newSessionManager } from "../test-helpers/contract-adapters.js";
import {
  FAKE_MODEL,
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  createSession,
  paneOrphans,
  serverEnv,
  sessionTool,
} from "../test-helpers/contract-mcp.js";
import {
  type TempLayout,
  claudeId,
  entries,
  fillerLine,
  makeTempLayout,
  readJson,
  sanitisedProjectName,
  spawnRecordViolations,
  transcriptLineWithToolUse,
  waitFor,
} from "../test-helpers/contract-records.js";

const T_TEST = 30_000;

let layout: TempLayout;
const servers: McpServer[] = [];

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

beforeEach(() => {
  layout = makeTempLayout("spawn");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  const report = await paneOrphans(layout);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
}, 40_000);

async function startServer(extraEnv: Record<string, string | undefined> = {}): Promise<McpServer> {
  const server = await McpServer.start({ env: serverEnv(layout, extraEnv), cwd: layout.cwd });
  servers.push(server);
  return server;
}

const toolUseId = () => `toolu_contract_${crypto.randomUUID().replaceAll("-", "")}`;

function writeTranscript(
  configDir: string,
  project: string,
  sessionId: string,
  content: string
): string {
  const dir = join(configDir, "projects", project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, content);
  return path;
}

function writeHostRecord(configDir: string, record: Record<string, unknown>): void {
  mkdirSync(join(configDir, "sessions"), { recursive: true });
  writeFileSync(join(configDir, "sessions", `${process.pid}.json`), JSON.stringify(record));
}

function spawnRecord(sessionsDir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sessionsDir, id, "spawn.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function terminalMeta(sessionsDir: string, id: string): Promise<Record<string, unknown>> {
  return waitFor(
    () => {
      const meta = readJson(join(sessionsDir, id, "meta.json"));
      return meta && ["completed", "failed", "timeout", "cancelled"].includes(String(meta.status))
        ? meta
        : undefined;
    },
    { what: `a terminal meta.json for ${id}`, timeoutMs: 10_000 }
  );
}

async function createdId(
  server: McpServer,
  args: Parameters<typeof createSession>[1],
  tuid?: string
): Promise<string> {
  const { sessionId, result } = await createSession(server, args, tuid);
  expect(result.isError).toBe(false);
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
}

describe.skipIf(!MAGMUX_AVAILABLE)("REQ-7 spawn.json: the start-time record of a session", () => {
  test(
    "exists when create_session returns, satisfies every schema rule, and names this host and this server",
    async () => {
      const server = await startServer();

      const id = await createdId(server, { prompt: "hello" });
      const dir = join(layout.sessionsDir, id);
      const text = readFileSync(join(dir, "spawn.json"), "utf8");
      const rec = JSON.parse(text) as Record<string, unknown>;

      expect(spawnRecordViolations(text, id)).toEqual([]);
      expect(rec).toMatchObject({
        schema: 1,
        kind: "session",
        sessionId: id,
        model: FAKE_MODEL,
        timeoutSeconds: 600,
      });
      expect({ hostPid: rec.hostPid, mcpPid: rec.mcpPid }).toEqual({
        hostPid: process.pid,
        mcpPid: server.pid,
      });
      expect("launcherPid" in rec).toBe(false);
      expect("parentClaudeSessionId" in rec).toBe(false);
      expect(existsSync(join(dir, "spawn.json.tmp"))).toBe(false);
    },
    T_TEST
  );

  test(
    "is never removed or rewritten: after the session ends it is byte-identical, beside meta.json",
    async () => {
      const server = await startServer();
      const id = await createdId(server, { prompt: "hello" });
      const before = readFileSync(join(layout.sessionsDir, id, "spawn.json"), "utf8");

      await terminalMeta(layout.sessionsDir, id);

      expect(readFileSync(join(layout.sessionsDir, id, "spawn.json"), "utf8")).toBe(before);
      expect(entries(join(layout.sessionsDir, id)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    },
    T_TEST
  );

  test(
    "REQ-23 nothing is written under <sessionsDir>/.hosts/",
    async () => {
      const server = await startServer();
      const id = await createdId(server, { prompt: "hello" });

      await terminalMeta(layout.sessionsDir, id);

      expect(existsSync(join(layout.sessionsDir, ".hosts"))).toBe(false);
    },
    T_TEST
  );

  test(
    "REQ-6 without CLAUDISH_SESSIONS_DIR the record is written under $HOME/.claudish/sessions",
    async () => {
      const server = await startServer({ CLAUDISH_SESSIONS_DIR: undefined });

      const id = await createdId(server, { prompt: "hello" });
      const homeSessions = join(layout.home, ".claudish", "sessions");

      expect(
        spawnRecordViolations(readFileSync(join(homeSessions, id, "spawn.json"), "utf8"), id)
      ).toEqual([]);
      expect(entries(layout.sessionsDir)).toEqual([]);
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-8 timeoutSeconds is the effective timeout, an integer in 1..3600 (amendment 2)",
  () => {
    test(
      "a request above 3600 seconds is recorded as 3600",
      async () => {
        const server = await startServer();

        const id = await createdId(server, { prompt: "hello", timeout_seconds: 99_999 });

        expect(spawnRecord(layout.sessionsDir, id).timeoutSeconds).toBe(3600);
      },
      T_TEST
    );

    test.each([
      [0, 1],
      [-5, 1],
      [1.4, 1],
      [2.6, 3],
      [3600.4, 3600],
    ])(
      "timeout_seconds %p is either refused by the tool or recorded as %p",
      async (requested, effective) => {
        const server = await startServer();

        const { sessionId, result } = await createSession(server, {
          prompt: "hello",
          timeout_seconds: requested,
        });

        if (result.isError) {
          expect(
            entries(layout.sessionsDir).filter((d) =>
              existsSync(join(layout.sessionsDir, d, "spawn.json"))
            )
          ).toEqual([]);
        } else {
          expect(spawnRecord(layout.sessionsDir, sessionId as string).timeoutSeconds).toBe(
            effective
          );
        }
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)("REQ-1 the parent conversation is recorded when proven", () => {
  test(
    "env candidate: the tool-use id in E's transcript → spawn.json and meta.json carry parentClaudeSessionId E",
    async () => {
      const E = claudeId("env");
      const T = toolUseId();
      writeTranscript(layout.configDir, "P", E, fillerLine(1) + transcriptLineWithToolUse(T));
      const server = await startServer({ CLAUDE_CODE_SESSION_ID: E });

      const id = await createdId(server, { prompt: "hello" }, T);
      const spawn = spawnRecord(layout.sessionsDir, id);
      const meta = await terminalMeta(layout.sessionsDir, id);

      expect(spawn.parentClaudeSessionId).toBe(E);
      expect(spawn.hostPid).toBe(process.pid);
      expect(meta.parentClaudeSessionId).toBe(E);
    },
    T_TEST
  );

  test(
    "host-record candidate: with no env id, the host's live record (pid = hostPid) and its cwd lead to R",
    async () => {
      const R = claudeId("host");
      const T = toolUseId();
      const cwd = join(layout.root, "the project");
      writeHostRecord(layout.configDir, { pid: process.pid, sessionId: R, cwd });
      writeTranscript(layout.configDir, sanitisedProjectName(cwd), R, transcriptLineWithToolUse(T));
      const server = await startServer({ CLAUDE_CODE_SESSION_ID: undefined });

      const id = await createdId(server, { prompt: "hello" }, T);

      expect(spawnRecord(layout.sessionsDir, id).parentClaudeSessionId).toBe(R);
      expect((await terminalMeta(layout.sessionsDir, id)).parentClaudeSessionId).toBe(R);
    },
    T_TEST
  );

  test(
    "REQ-6 without CLAUDE_CONFIG_DIR the proof reads $HOME/.claude",
    async () => {
      const E = claudeId("env");
      const T = toolUseId();
      writeTranscript(join(layout.home, ".claude"), "P", E, transcriptLineWithToolUse(T));
      const server = await startServer({ CLAUDE_CONFIG_DIR: undefined, CLAUDE_CODE_SESSION_ID: E });

      const id = await createdId(server, { prompt: "hello" }, T);

      expect(spawnRecord(layout.sessionsDir, id).parentClaudeSessionId).toBe(E);
    },
    T_TEST
  );

  test(
    "the server stays responsive while a proof waits: list_sessions sent later returns first, and the late-written id is still proven",
    async () => {
      const E = claudeId("env");
      const T = toolUseId();
      const transcript = writeTranscript(layout.configDir, "P", E, fillerLine(1));
      const server = await startServer({ CLAUDE_CODE_SESSION_ID: E });
      const order: string[] = [];

      const creating = createSession(server, { prompt: "hello" }, T).then((r) => {
        order.push("create_session");
        return r;
      });
      await Bun.sleep(50);
      const listing = server.callTool("list_sessions", {}).then((r) => {
        order.push("list_sessions");
        return r;
      });
      await Bun.sleep(100);
      appendFileSync(transcript, transcriptLineWithToolUse(T));
      const [{ sessionId }] = await Promise.all([creating, listing]);

      expect(order).toEqual(["list_sessions", "create_session"]);
      expect(spawnRecord(layout.sessionsDir, sessionId as string).parentClaudeSessionId).toBe(E);
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-2 the parent field is absent, never wrong, when nothing is proven",
  () => {
    async function expectNoParentAnywhere(
      server: McpServer,
      tuid: string | undefined
    ): Promise<void> {
      const id = await createdId(server, { prompt: "hello" }, tuid);
      const spawn = spawnRecord(layout.sessionsDir, id);
      const meta = await terminalMeta(layout.sessionsDir, id);
      expect("parentClaudeSessionId" in spawn).toBe(false);
      expect("parentClaudeSessionId" in meta).toBe(false);
    }

    test(
      "the tool-use id is in no transcript",
      async () => {
        const E = claudeId("env");
        writeTranscript(layout.configDir, "P", E, fillerLine(1));
        const server = await startServer({ CLAUDE_CODE_SESSION_ID: E });

        await expectNoParentAnywhere(server, toolUseId());
      },
      T_TEST
    );

    test(
      "the call carries no _meta tool-use id",
      async () => {
        const E = claudeId("env");
        writeTranscript(layout.configDir, "P", E, transcriptLineWithToolUse(toolUseId()));
        const server = await startServer({ CLAUDE_CODE_SESSION_ID: E });

        await expectNoParentAnywhere(server, undefined);
      },
      T_TEST
    );

    test(
      "the _meta tool-use id is malformed, even though the transcript holds it",
      async () => {
        const E = claudeId("env");
        const bad = "bad id!";
        writeTranscript(layout.configDir, "P", E, transcriptLineWithToolUse(bad));
        const server = await startServer({ CLAUDE_CODE_SESSION_ID: E });

        await expectNoParentAnywhere(server, bad);
      },
      T_TEST
    );

    test(
      "the env id is ignored under CLAUDE_CODE_CHILD_SESSION, even though its transcript holds the id",
      async () => {
        const E = claudeId("env");
        const T = toolUseId();
        writeTranscript(layout.configDir, "P", E, transcriptLineWithToolUse(T));
        const server = await startServer({
          CLAUDE_CODE_SESSION_ID: E,
          CLAUDE_CODE_CHILD_SESSION: "1",
        });

        await expectNoParentAnywhere(server, T);
      },
      T_TEST
    );

    test(
      "a host record whose pid is not hostPid is ignored, even though its transcript holds the id",
      async () => {
        const R = claudeId("host");
        const T = toolUseId();
        const cwd = join(layout.root, "proj");
        writeHostRecord(layout.configDir, { pid: process.pid + 1, sessionId: R, cwd });
        writeTranscript(
          layout.configDir,
          sanitisedProjectName(cwd),
          R,
          transcriptLineWithToolUse(T)
        );
        const server = await startServer({ CLAUDE_CODE_SESSION_ID: undefined });

        await expectNoParentAnywhere(server, T);
      },
      T_TEST
    );
  }
);

describe("REQ-15 a session read back from disk carries parentClaudeSessionId only when meta.json has a real one", () => {
  function writeDiskSession(id: string, parent: string | undefined): void {
    const dir = join(layout.sessionsDir, id);
    mkdirSync(dir, { recursive: true });
    const meta: Record<string, unknown> = {
      sessionId: id,
      model: FAKE_MODEL,
      status: "completed",
      pid: 999_999,
      startedAt: "2026-10-02T10:00:00.000Z",
      completedAt: "2026-10-02T10:01:00.000Z",
      exitCode: 0,
      turnsCompleted: 1,
      tokensUsed: 2,
      toolCallCount: 0,
      idleSeconds: 0,
      costUsd: 0,
      terminalReason: "completed",
      claudeSessionId: "3a4b5c6d-0000-4000-8000-000000000001",
    };
    if (parent !== undefined) meta.parentClaudeSessionId = parent;
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  }

  test.each([
    ["a valid id", "parent-conversation-0001", "parent-conversation-0001"],
    ["an empty string", "", undefined],
    ["no key", undefined, undefined],
  ])(
    "meta.json with %s → SessionManager.getSession reports %p",
    async (_label, stored, expected) => {
      writeDiskSession("c0ffee01", stored);
      const sm = newSessionManager(process.pid, { sessionsDir: layout.sessionsDir });

      const r = sm.getSession("c0ffee01");
      await sm.dispose();

      expect(r.error).toBeUndefined();
      expect(r.info?.sessionId).toBe("c0ffee01");
      expect(r.info?.parentClaudeSessionId).toBe(expected);
    },
    T_TEST
  );
});

describe("REQ-16 a team record id is answered exactly like an id that never existed", () => {
  const TEAM_ID = "team-0a1b2c3d";
  const NEVER = "f00dfeed";

  function writeTeamRecord(): string {
    const dir = join(layout.sessionsDir, TEAM_ID);
    mkdirSync(dir, { recursive: true });
    const spawn = {
      schema: 1,
      kind: "team",
      sessionId: TEAM_ID,
      hostPid: process.pid,
      mcpPid: 999_998,
      startedAt: "2026-10-02T10:00:00.000Z",
      teamPath: join(layout.root, "team-run"),
      slots: 2,
    };
    writeFileSync(join(dir, "spawn.json"), JSON.stringify(spawn, null, 2));
    const meta = JSON.stringify(
      {
        kind: "team",
        status: "completed",
        startedAt: spawn.startedAt,
        completedAt: "2026-10-02T10:05:00.000Z",
        elapsedSeconds: 300,
        slots: 2,
        ok: 2,
        failed: 0,
        cancelled: 0,
      },
      null,
      2
    );
    writeFileSync(join(dir, "meta.json"), meta);
    return meta;
  }

  test(
    "SessionManager.getSession on a team-* id gives the never-existed answer, never a model: unknown record",
    async () => {
      const metaBefore = writeTeamRecord();
      const sm = newSessionManager(process.pid, { sessionsDir: layout.sessionsDir });

      const forTeam = sm.getSession(TEAM_ID);
      const forNever = sm.getSession(NEVER);
      await sm.dispose();

      expect(forNever.info).toBeUndefined();
      expect({ info: forTeam.info, error: forTeam.error?.replaceAll(TEAM_ID, "<ID>") }).toEqual({
        info: undefined,
        error: forNever.error?.replaceAll(NEVER, "<ID>"),
      });
      expect(readFileSync(join(layout.sessionsDir, TEAM_ID, "meta.json"), "utf8")).toBe(metaBefore);
    },
    T_TEST
  );

  test.each(["get_output", "get_diagnostics", "cancel_session"])(
    "%s on a team-* id gives the never-existed answer, never a model: unknown record",
    async (tool) => {
      const metaBefore = writeTeamRecord();
      const server = await startServer();

      const forTeam = await sessionTool(server, tool, TEAM_ID);
      const forNever = await sessionTool(server, tool, NEVER);

      expect({ isError: forTeam.isError, text: forTeam.text.replaceAll(TEAM_ID, "<ID>") }).toEqual({
        isError: forNever.isError,
        text: forNever.text.replaceAll(NEVER, "<ID>"),
      });
      expect(forTeam.text).not.toMatch(/"model"\s*:\s*"unknown"/);
      expect(readFileSync(join(layout.sessionsDir, TEAM_ID, "meta.json"), "utf8")).toBe(metaBefore);
    },
    T_TEST
  );
});
